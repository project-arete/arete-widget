// diag-startup.js — does a widget REJOINING existing realm state see the values?
// Phase 1: create switch + bulb, bind, set sOut=1, wait for cState=1, DISCONNECT.
// Phase 2: fresh service + manager over the SAME persisted instances (the app's
// cold-start path: loadDefinitions -> connect -> attachAll), then sample each
// instance's derived state over time WITHOUT writing anything.
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
installSystemIdPatch('diag-startup-' + crypto.randomUUID());

const opts = {
  protocol: 'wss:',
  host: process.env.ARETE_HOST || 'dashboard.test.cns.dev',
  port: 443,
  username: process.env.ARETE_USER || '',
  password: process.env.ARETE_PASS || '',
  allowSelfSigned: (process.env.ARETE_ALLOW_SELF_SIGNED || '0') === '1',
  timeout: 10000,
  systemName: 'Startup Diag',
};

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arete-diag-'));
const profileCache = new Map();
async function fetchProfile(name) {
  if (profileCache.has(name)) return profileCache.get(name);
  if (name && name.startsWith('local.')) {
    // internal prototype profiles live in the app's profiles/ folder
    try {
      const json = JSON.parse(fs.readFileSync(path.join(ROOT, 'profiles', name + '.json'), 'utf8'));
      profileCache.set(name, json);
      return json;
    } catch (_) { profileCache.set(name, null); return null; }
  }
  const res = await fetch('https://cp.padi.io/profiles/' + encodeURIComponent(name), { headers: { accept: 'application/json' } }).catch(() => null);
  const json = res && res.ok ? await res.json() : null;
  profileCache.set(name, json);
  return json;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(desc, fn, ms = 30000, step = 400) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(step); }
  throw new Error('Timed out: ' + desc);
}
function mkStack() {
  const service = new AreteService();
  const manager = new WidgetManager({ service, dataDir, bundledDir: path.join(ROOT, 'widgets'), libraryUrl: '', fetchProfile });
  service.on('keys', (k) => manager.onKeys(k));
  return { service, manager };
}

let code = 1;
let s1 = null, s2 = null;
try {
  // ---------------- Phase 1: build the rig, leave values on the realm --------
  console.log('=== PHASE 1: create rig, set values, disconnect ===');
  s1 = mkStack();
  await s1.manager.loadDefinitions();
  await s1.service.connect(opts);
  const sw = await s1.manager.addInstance({ widgetId: 'switch', name: 'Diag Switch' });
  const bulb = await s1.manager.addInstance({ widgetId: 'bulb', name: 'Diag Bulb', contextId: sw.contextId, contextName: sw.contextName });
  await waitFor('bind', () => {
    const a = s1.manager.getInstance(sw.id), b = s1.manager.getInstance(bulb.id);
    return a && b && a.connections > 0 && b.connections > 0;
  }, 90000);
  await s1.manager.putProperty(sw.id, 'sOut', '1');
  await s1.manager.putProperty(sw.id, 'sLabel', 'Diag Label');
  await waitFor('bulb actualizes cState=1', () => s1.manager.getInstance(bulb.id)?.state.cState === '1');
  console.log('rig live: sOut=1, sLabel set, cState=1. Disconnecting (values persist on realm).');
  await s1.service.disconnect();
  await sleep(1500);

  // ---------------- Phase 2: cold start over existing realm state ------------
  console.log('\n=== PHASE 2: fresh service+manager, SAME instances (app cold start) ===');
  s2 = mkStack();
  await s2.manager.loadDefinitions();
  const t0 = Date.now();
  await s2.service.connect(opts);
  await s2.manager.attachAll(); // what arete:connect does after connect
  const tAttach = Date.now() - t0;

  // Sample derived state over 10s with NO writes at all.
  const seen = {};
  const props = [['switch', sw.id, 'sOut'], ['switch', sw.id, 'sLabel'], ['switch', sw.id, 'cState'], ['bulb', bulb.id, 'sOut'], ['bulb', bulb.id, 'cState']];
  for (let t = 0; t <= 10000; t += 250) {
    for (const [label, id, prop] of props) {
      const v = s2.manager.getInstance(id)?.state?.[prop];
      const key = label + '.' + prop;
      if (v !== undefined && seen[key] === undefined) seen[key] = { value: v, atMs: Date.now() - t0 };
    }
    if (Object.keys(seen).length === props.length) break;
    await sleep(250);
  }
  console.log('attachAll completed at +' + tAttach + 'ms after connect start');
  for (const [label, id, prop] of props) {
    const k = label + '.' + prop;
    console.log((seen[k] ? 'POPULATED  ' : 'NEVER      ') + k.padEnd(16) + (seen[k] ? `= "${seen[k].value}" at +${seen[k].atMs}ms` : '(still undefined after 10s, no writes)'));
  }

  // Ground truth: what does the realm snapshot actually hold for this context?
  const keys = s2.service.getKeys();
  const ctx = sw.contextId;
  console.log('\nRealm keys for the rig context (ground truth):');
  for (const k in keys) if (k.includes(ctx) && /properties/.test(k)) console.log('  ' + k + ' = ' + keys[k]);

  const allPopulated = Object.keys(seen).length === props.length;
  console.log(allPopulated
    ? '\n>>> App-side startup chain POPULATES values from existing realm state <<<'
    : '\n>>> REPRODUCED: values present on realm but NOT populated at startup <<<');
  code = allPopulated ? 0 : 2;
} catch (e) {
  console.error('DIAG ERROR:', e && e.message ? e.message : e);
} finally {
  try { await s1?.service.disconnect(); } catch {}
  try { await s2?.service.disconnect(); } catch {}
  fs.rmSync(dataDir, { recursive: true, force: true });
  setTimeout(() => process.exit(code), 400);
}
