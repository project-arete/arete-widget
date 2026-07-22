// scripts/test-compose-live.js
// THE COMPOSER'S PHASE 3 EXIT TEST (design doc §10): rebuild the Tenant
// Light as a COMPOSED DRAFT — the exact artifact the Compose tab emits — and
// pass the lease-gating scenario live on the realm, with the draft running
// under ComposeRunner (go-live) instead of a saved widget definition.
//
// Also proves the draft-instance discipline end-to-end: stop + re-go-live
// with the SAME canvas identity re-attaches value-preserving (no wiper, no
// orphan): state survives the cycle.
//
// Default host is the public no-auth test realm (same as test-lease.js).

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { installSystemIdPatch } from '../electron/arete-system-id.js';
import { AreteService } from '../electron/arete-service.js';
import { WidgetManager } from '../electron/widget-manager.js';
import { ComposeRunner } from '../electron/compose-runner.js';
import { validateDefinition, orderDefinition } from '../core/widget-spec.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

installSystemIdPatch('test-compose-live-' + crypto.randomUUID());

const opts = {
  protocol: process.env.ARETE_PROTOCOL || 'wss:',
  host: process.env.ARETE_HOST || 'dashboard.test.cns.dev',
  port: Number(process.env.ARETE_PORT || 443),
  username: process.env.ARETE_USER || '',
  password: process.env.ARETE_PASS || '',
  allowSelfSigned: (process.env.ARETE_ALLOW_SELF_SIGNED || '0') === '1',
  timeout: Number(process.env.ARETE_TIMEOUT || 10000),
  systemName: process.env.ARETE_SYSTEM_NAME || 'Arete Widget (compose-live test)',
};

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arete-compose-live-'));
const service = new AreteService();
service.on('log', (e) => console.log(`  [${e.level}] ${e.message}`));

const profileCache = new Map();
async function fetchProfile(name) {
  if (profileCache.has(name)) return profileCache.get(name);
  try {
    const res = await fetch('https://cp.padi.io/profiles/' + encodeURIComponent(name), { headers: { accept: 'application/json' } });
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
  libraryUrl: '',
  fetchProfile,
});
manager.on('log', (e) => console.log(`  [${e.level}] ${e.message}`));

const runner = new ComposeRunner({ service });
let draftState = null; // latest runner payload
runner.on('state', (p) => { draftState = p; });
runner.on('log', (e) => console.log(`  [${e.level}] ${e.message}`));
service.on('keys', (k) => { manager.onKeys(k); runner.onKeys(k); });

const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const b62 = (len = 22) => { const b = crypto.randomBytes(len); let o = ''; for (let i = 0; i < len; i++) o += B62[b[i] % 62]; return o; };

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
async function holds(desc, fn, ms = 6000, step = 500) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (!fn()) throw new Error('Violated: ' + desc);
    await sleep(step);
  }
}
const draftLight = () => (draftState ? draftState.state.cState : undefined);

let code = 1;
try {
  console.log('1) Composing the Tenant Light as a DRAFT (the artifact the Compose tab emits) ...');
  const draft = {
    widget: 'local.composed-tenant-light',
    title: 'Composed Tenant Light',
    icon: '🏠',
    color: '#4cc36a',
    meta: { composed: true, author: 'compose-live test' },
    capabilities: [
      { profile: 'padi.light', role: 'consumer' },
      { profile: 'padi.lease.basic', role: 'consumer' },
    ],
    view: [
      { type: 'lamp', bind: 'cState', on: '1', caption: 'light' },
      { type: 'value', bind: 'status', caption: 'lease status' },
    ],
    behavior: {
      init: { tenant: 'Composed Tenant Light' },
      rules: [{ when: 'sOut', set: 'cState', aggregate: 'average', gate: 'status', is: 'Approved', else: '0' }],
    },
  };
  // The Composer's exact pipeline: canonical YAML -> reparse -> validate.
  const text = yaml.dump(orderDefinition(draft), { lineWidth: 120, noRefs: true });
  const raw = yaml.load(text);
  const profiles = { 'padi.light': await fetchProfile('padi.light'), 'padi.lease.basic': await fetchProfile('padi.lease.basic') };
  const res = validateDefinition(raw, profiles);
  if (!res.ok) throw new Error('Composed draft failed validation: ' + res.errors.join('; '));
  const gated = res.model.behavior.rules[0];
  if (!(gated.gate === 'status' && gated.is === 'Approved' && gated.else === '0' && gated.aggregate === 'average')) {
    throw new Error('Gate clause did not survive the Composer pipeline: ' + JSON.stringify(gated));
  }
  console.log('   canonical YAML round-trip + gate clause ✔');

  console.log('2) Loading bundled definitions (landlord + switch) ...');
  await manager.loadDefinitions(false);

  console.log(`3) Connecting to ${opts.protocol}//${opts.host}:${opts.port} ...`);
  await service.connect(opts);

  console.log('4) Landlord + Switch via the manager; the COMPOSED light goes live via ComposeRunner ...');
  const landlord = await manager.addInstance({ widgetId: 'lease-landlord', name: 'CL Landlord' });
  const ctx = { contextId: landlord.contextId, contextName: landlord.contextName };
  const sw = await manager.addInstance({ widgetId: 'switch', name: 'CL Switch', ...ctx });
  const ids = { nodeId: b62(22), contextId: landlord.contextId }; // canvas-stable identity, JOINING the shared context
  await runner.goLive({
    model: res.model,
    name: 'Composed Tenant Light',
    nodeId: ids.nodeId,
    contextId: ids.contextId,
    contextName: landlord.contextName,
    applyInit: true,
  });
  console.log('   context:', landlord.contextId);

  console.log('5) Waiting for the broker (landlord 1 lease conn, switch 1 light conn, draft 2) ...');
  await waitFor('broker bindings', () => {
    const l = manager.getInstance(landlord.id);
    const s = manager.getInstance(sw.id);
    return l && s && l.connections === 1 && s.connections === 1 && draftState && draftState.connections === 2;
  });
  console.log('   bound ✔');

  console.log('6) Switch ON before any lease status — the composed light must stay dark ...');
  await manager.putProperty(sw.id, 'sOut', '1');
  await waitFor('draft sees sOut=1', () => draftState && draftState.state.sOut === '1');
  await holds('composed light stays dark with no lease status', () => draftLight() !== '1');
  console.log('   dark ✔ (gate closed: status undefined)');

  console.log('7) Offer — still dark ...');
  await manager.putProperty(landlord.id, 'status', 'Offer');
  await waitFor('draft sees status=Offer', () => draftState && draftState.state.status === 'Offer');
  await holds('still dark at Offer', () => draftLight() !== '1');
  console.log('   dark ✔');

  console.log('8) Approved — the pending switch-on actualizes THROUGH THE DRAFT RUNNER ...');
  await manager.putProperty(landlord.id, 'status', 'Approved');
  await waitFor('composed light turns on', () => draftLight() === '1');
  await waitFor('switch sees the composed light on', () => {
    const pc = Object.values(manager.getInstance(sw.id).perConn);
    return pc.length === 1 && pc[0].cState === '1';
  });
  console.log('   ON ✔ (switch perConn agrees)');

  console.log('9) Delinquent while lit — forced off, switch untouched ...');
  await manager.putProperty(landlord.id, 'status', 'Delinquent');
  await waitFor('composed light forced dark', () => draftLight() === '0');
  if (manager.getInstance(sw.id).state.sOut !== '1') throw new Error('switch should still say ON');
  console.log('   forced off ✔');

  console.log('10) Re-Approved — light returns; landlord sees the composed tenant name ...');
  await manager.putProperty(landlord.id, 'status', 'Approved');
  await waitFor('light back on', () => draftLight() === '1');
  const tenants = Object.values(manager.getInstance(landlord.id).perConn).map((c) => c.tenant);
  if (!tenants.includes('Composed Tenant Light')) throw new Error('landlord should see the init tenant name, got ' + JSON.stringify(tenants));
  console.log('   back ON ✔ · tenant name visible ✔ (init put worked)');

  console.log('11) Stop + re-go-live with the SAME canvas identity — values must SURVIVE (v29, no wiper) ...');
  runner.stop();
  await sleep(1500);
  draftState = null;
  await runner.goLive({
    model: res.model,
    name: 'Composed Tenant Light',
    nodeId: ids.nodeId,
    contextId: ids.contextId,
    contextName: landlord.contextName,
    applyInit: false, // init already done for this canvas — never repeated
  });
  await waitFor('re-attached with both connections and cState intact', () =>
    draftState && draftState.connections === 2 && draftState.state.cState === '1');
  console.log('   re-attach value-preserving ✔ (same node, same context, state intact)');

  console.log('\n✅ PASS — a COMPOSED draft passed the full lease-gating scenario live:');
  console.log('   built canvas-style, canonical-YAML round-tripped, gated + aggregated,');
  console.log('   went live with stable identity, and survived a go-live cycle unwiped.');
  code = 0;
} catch (e) {
  console.error('\n❌ FAIL —', e && e.message ? e.message : e);
  console.error('   draft state at failure:', JSON.stringify(draftState));
  code = 1;
} finally {
  runner.stop(); // drop draft handles BEFORE the socket closes (clean teardown)
  await service.disconnect().catch(() => {});
  fs.rmSync(dataDir, { recursive: true, force: true });
  setTimeout(() => process.exit(code), 400);
}
