// scripts/test-ping.js — LIVE E2E for cp:padi.ping and the addressed reply
// channel: TWO Ping Senders + ONE Ping Responder in a shared context. Each
// sender sends a distinct message; the responder's reply rule must answer
// each one ON ITS OWN CONNECTION — sender A sees A's echo, sender B sees B's,
// and the non-propagated `response` never appears on the responder's
// capability broadcast path.
//
//   node scripts/test-ping.js            (public test realm)
//   ARETE_HOST=... node scripts/test-ping.js

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { installSystemIdPatch } from '../electron/arete-system-id.js';
import { AreteService } from '../electron/arete-service.js';
import { WidgetManager } from '../electron/widget-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
installSystemIdPatch('test-ping-' + crypto.randomUUID());

const opts = {
  protocol: process.env.ARETE_PROTOCOL || 'wss:',
  host: process.env.ARETE_HOST || 'dashboard.test.cns.dev',
  port: Number(process.env.ARETE_PORT || 443),
  username: process.env.ARETE_USER || '',
  password: process.env.ARETE_PASS || '',
  allowSelfSigned: (process.env.ARETE_ALLOW_SELF_SIGNED || '0') === '1',
  timeout: 10000,
  systemName: 'Ping Test (headless)',
};

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arete-ping-test-'));
const service = new AreteService();
const profileCache = new Map();
async function fetchProfile(name) {
  if (profileCache.has(name)) return profileCache.get(name);
  const res = await fetch('https://cp.padi.io/profiles/' + encodeURIComponent(name), { headers: { accept: 'application/json' } }).catch(() => null);
  const json = res && res.ok ? await res.json() : null;
  profileCache.set(name, json);
  return json;
}
const manager = new WidgetManager({ service, dataDir, bundledDir: path.join(ROOT, 'widgets'), libraryUrl: '', fetchProfile });
manager.on('log', (e) => { if (e.level !== 'info') console.log(`  [${e.level}] ${e.message}`); });
service.on('keys', (k) => manager.onKeys(k));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(desc, fn, ms = 90000, step = 500) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(step); }
  throw new Error('Timed out waiting for: ' + desc);
}

let code = 1;
try {
  console.log('1) Validating definitions (incl. ping pair) against cp.padi.io ...');
  const defs = await manager.loadDefinitions();
  const bad = defs.filter((d) => !d.ok);
  if (bad.length) throw new Error('Invalid definitions: ' + bad.map((d) => d.id + ': ' + d.errors[0]).join(' | '));

  console.log(`2) Connecting to ${opts.host} ...`);
  await service.connect(opts);

  console.log('3) Creating Responder + TWO Senders in one context ...');
  const resp = await manager.addInstance({ widgetId: 'ping-responder', name: 'Responder' });
  const sendA = await manager.addInstance({ widgetId: 'ping-sender', name: 'Sender A', contextId: resp.contextId, contextName: resp.contextName });
  const sendB = await manager.addInstance({ widgetId: 'ping-sender', name: 'Sender B', contextId: resp.contextId, contextName: resp.contextName });

  console.log('4) Waiting for the broker to bind (responder: 2 connections) ...');
  await waitFor('bind', () => {
    const r = manager.getInstance(resp.id);
    const a = manager.getInstance(sendA.id);
    const b = manager.getInstance(sendB.id);
    return r && a && b && r.connections === 2 && a.connections > 0 && b.connections > 0;
  }, 120000);
  console.log('   bound ✔');

  console.log('5) Each sender pings with its own message ...');
  const msgA = 'ping-A-' + crypto.randomBytes(3).toString('hex');
  const msgB = 'ping-B-' + crypto.randomBytes(3).toString('hex');
  await manager.putProperty(sendA.id, 'sendP', msgA);
  await manager.putProperty(sendB.id, 'sendP', msgB);

  console.log('6) Waiting for ADDRESSED echoes (each sender sees its own) ...');
  await waitFor('addressed echoes', () => {
    const a = manager.getInstance(sendA.id);
    const b = manager.getInstance(sendB.id);
    return a && b && a.state.response === msgA && b.state.response === msgB;
  }, 60000);
  console.log(`   Sender A got "${msgA}" ✔   Sender B got "${msgB}" ✔`);

  // Cross-check: A must NOT carry B's echo anywhere in its per-connection view
  const a = manager.getInstance(sendA.id);
  const leaked = Object.values(a.perConn).some((c) => c.response === msgB);
  if (leaked) throw new Error("Sender A's connection carries Sender B's response — addressing failed");
  console.log('   no cross-talk between connections ✔');

  // The responder's own capability must NOT broadcast `response`
  // (non-propagated: written per-connection only, never at capability level).
  const r = manager.getInstance(resp.id);
  const keys = service.getKeys();
  const capKey = `cns/${r.systemId}/nodes/${r.nodeId}/contexts/${r.contextId}/consumer/padi.ping/properties/response`;
  const capVal = keys[capKey];
  if (capVal === msgA || capVal === msgB) throw new Error('response leaked onto the capability broadcast path');
  console.log('   response stayed off the capability broadcast path ✔');

  console.log('\n✅ PASS — cp:padi.ping round trip works, and every reply is addressed');
  console.log('   to the connection that carried the ping. Broadcast (sendP) out,');
  console.log('   addressed (response) back — exactly the CP\'s design.');
  code = 0;
} catch (e) {
  console.error('\n❌ FAIL —', e && e.message ? e.message : e);
  code = 1;
} finally {
  await service.disconnect().catch(() => {});
  fs.rmSync(dataDir, { recursive: true, force: true });
  setTimeout(() => process.exit(code), 400);
}
