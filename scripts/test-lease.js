// scripts/test-lease.js
// HEADLESS live E2E of the GATED rule (gate/is/else) via the lease-bulb
// widget: a Lease Landlord (provider padi.lease.basic), a Virtual Switch
// (provider padi.light) and TWO Tenant Lights (consumer of BOTH profiles)
// in ONE context. The lights must follow the switch ONLY while the
// landlord-written lease `status` is "Approved".
//
// Default host is the public no-auth test realm (same as test-widget.js).

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

installSystemIdPatch('test-lease-' + crypto.randomUUID());

const opts = {
  protocol: process.env.ARETE_PROTOCOL || 'wss:',
  host: process.env.ARETE_HOST || 'dashboard.test.cns.dev',
  port: Number(process.env.ARETE_PORT || 443),
  username: process.env.ARETE_USER || '',
  password: process.env.ARETE_PASS || '',
  allowSelfSigned: (process.env.ARETE_ALLOW_SELF_SIGNED || '0') === '1',
  timeout: Number(process.env.ARETE_TIMEOUT || 10000),
  systemName: process.env.ARETE_SYSTEM_NAME || 'Arete Widget (lease test)',
};

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arete-lease-test-'));
const service = new AreteService();
service.on('log', (e) => console.log(`  [${e.level}] ${e.message}`));

const profileCache = new Map();
async function fetchProfile(name) {
  if (profileCache.has(name)) return profileCache.get(name);
  try {
    const res = await fetch('https://cp.padi.io/profiles/' + encodeURIComponent(name), {
      headers: { accept: 'application/json' },
    });
    const json = res.ok ? await res.json() : null;
    profileCache.set(name, json);
    return json;
  } catch (_) {
    return null;
  }
}

const manager = new WidgetManager({
  service,
  dataDir,
  bundledDir: path.join(ROOT, 'widgets'),
  libraryUrl: '', // exercises the realm, not the online library
  fetchProfile,
});
manager.on('log', (e) => console.log(`  [${e.level}] ${e.message}`));
service.on('keys', (k) => manager.onKeys(k));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(desc, fn, ms = 90000, step = 500) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = fn();
    if (v) return v;
    await sleep(step);
  }
  throw new Error('Timed out waiting for: ' + desc);
}
// Assert a condition HOLDS for a window (the "must NOT happen" side of gating).
async function holds(desc, fn, ms = 6000, step = 500) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (!fn()) throw new Error('Violated: ' + desc);
    await sleep(step);
  }
}

const lightOf = (id) => manager.getInstance(id).state.cState;

let code = 1;
try {
  console.log('1) Loading + validating definitions (incl. lease-bulb) against cp.padi.io ...');
  const defs = await manager.loadDefinitions();
  const lb = defs.find((d) => d.id === 'lease-bulb');
  if (!lb || !lb.ok) throw new Error('lease-bulb failed validation: ' + (lb ? (lb.errors || []).join('; ') : 'not found'));
  console.log('   lease-bulb ok ✔ (capabilities: ' + lb.capabilities.map((c) => `${c.role} of ${c.profile}`).join(', ') + ')');

  console.log(`2) Connecting to ${opts.protocol}//${opts.host}:${opts.port} ...`);
  await service.connect(opts);

  console.log('3) Creating Landlord + Switch + TWO Tenant Lights in ONE context ...');
  const landlord = await manager.addInstance({ widgetId: 'lease-landlord', name: 'Test Landlord' });
  const ctx = { contextId: landlord.contextId, contextName: landlord.contextName };
  const sw = await manager.addInstance({ widgetId: 'switch', name: 'Unit Switch', ...ctx });
  const lightA = await manager.addInstance({ widgetId: 'lease-bulb', name: 'Tenant Light A', ...ctx });
  const lightB = await manager.addInstance({ widgetId: 'lease-bulb', name: 'Tenant Light B', ...ctx });
  console.log('   context:', landlord.contextId);

  console.log('4) Waiting for the broker to bind (landlord 2 lease conns, switch 2 light conns, each light 2) ...');
  await waitFor('broker bindings', () => {
    const l = manager.getInstance(landlord.id);
    const s = manager.getInstance(sw.id);
    const a = manager.getInstance(lightA.id);
    const b = manager.getInstance(lightB.id);
    return l && s && a && b
      && l.connections === 2 && s.connections === 2
      && a.connections === 2 && b.connections === 2;
  });
  console.log('   bound ✔');

  console.log('5) NO lease status yet — flipping the switch ON must NOT light the tenant lights ...');
  await manager.putProperty(sw.id, 'sOut', '1');
  await waitFor('lights see the switch (sOut=1 in state)', () => {
    const a = manager.getInstance(lightA.id);
    const b = manager.getInstance(lightB.id);
    return a.state.sOut === '1' && b.state.sOut === '1';
  });
  await holds('lights stay dark with no lease status', () => lightOf(lightA.id) !== '1' && lightOf(lightB.id) !== '1');
  console.log('   dark ✔ (gate closed: status undefined)');

  console.log('6) Landlord walks the lifecycle to Offer — still dark ...');
  await manager.putProperty(landlord.id, 'status', 'Offer');
  await waitFor('lights see status=Offer', () => manager.getInstance(lightA.id).state.status === 'Offer'
    && manager.getInstance(lightB.id).state.status === 'Offer');
  await holds('lights stay dark at Offer despite switch ON', () => lightOf(lightA.id) !== '1' && lightOf(lightB.id) !== '1');
  console.log('   dark ✔ (gate closed: Offer)');

  console.log('7) Landlord sets status=Approved — the pending switch-on must now actualize ...');
  await manager.putProperty(landlord.id, 'status', 'Approved');
  await waitFor('BOTH lights turn on (cState=1)', () => lightOf(lightA.id) === '1' && lightOf(lightB.id) === '1');
  const swView = Object.values(manager.getInstance(sw.id).perConn).map((c) => c.cState);
  if (!(swView.length === 2 && swView.every((v) => v === '1'))) {
    throw new Error('switch perConn should see both lights on, got ' + JSON.stringify(swView));
  }
  console.log('   both lights ON ✔ (switch perConn agrees)');

  console.log('8) Lease turns Delinquent while lit — lights must be FORCED off (switch still ON) ...');
  await manager.putProperty(landlord.id, 'status', 'Delinquent');
  await waitFor('both lights forced dark', () => lightOf(lightA.id) === '0' && lightOf(lightB.id) === '0');
  const sNow = manager.getInstance(sw.id).state.sOut;
  if (sNow !== '1') throw new Error('switch should still say ON, got ' + JSON.stringify(sNow));
  await holds('lights stay dark while Delinquent with switch ON', () => lightOf(lightA.id) === '0' && lightOf(lightB.id) === '0');
  console.log('   forced off ✔ (else "0" converged; switch still sOut=1)');

  console.log('9) Re-Approved — lights come straight back (switch never touched) ...');
  await manager.putProperty(landlord.id, 'status', 'Approved');
  await waitFor('both lights back on', () => lightOf(lightA.id) === '1' && lightOf(lightB.id) === '1');
  console.log('   back ON ✔');

  console.log('10) Landlord sees each light as a tenant (per-connection tenant name) ...');
  const tenants = Object.values(manager.getInstance(landlord.id).perConn).map((c) => c.tenant);
  console.log('   landlord perConn tenants:', JSON.stringify(tenants));

  console.log('\n✅ PASS — lease-gated lighting verified end-to-end on the live realm:');
  console.log('   switch-on is inert until Approved, actualizes on approval, and is');
  console.log('   revoked the moment the lease leaves Approved.');
  code = 0;
} catch (e) {
  console.error('\n❌ FAIL —', e && e.message ? e.message : e);
  const s = manager.listInstances();
  console.error('   instances at failure:', JSON.stringify(s.map((i) => ({ n: i.name, att: i.attached, conns: i.connections, state: i.state })), null, 2));
  code = 1;
} finally {
  await service.disconnect().catch(() => {});
  fs.rmSync(dataDir, { recursive: true, force: true });
  setTimeout(() => process.exit(code), 400);
}
