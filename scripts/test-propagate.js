// scripts/test-propagate.js
// THE PROPAGATE EXPERIMENT — empirically establishes how the control plane
// treats the per-property propagate flag, using cp:padi.test.propagate.
//
// Method: register a Propagate Sender (provider) and Propagate Receiver
// (consumer) in one context, write BOTH flavors of property on BOTH sides,
// then inspect the raw key namespace and report where every value did — and
// did not — land:
//   propagated (sShared, cShared, sPing, cPong) -> must appear as CONNECTION
//     properties on both endpoints;
//   non-propagated (sLocal, cLocal)             -> must exist ONLY under the
//     writer's capability properties, and appear in NO connection anywhere.
//
// Skips cleanly (exit 0) while padi.test.propagate is not yet registered.
//
// Usage: node scripts/test-propagate.js   (env: ARETE_HOST/USER/PASS/... as usual)

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

const CP = 'padi.test.propagate';
const profile = await (async () => {
  try {
    const res = await fetch('https://cp.padi.io/profiles/' + CP, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    return res.ok ? await res.json() : null;
  } catch (_) {
    return null;
  }
})();
if (!profile || !Array.isArray(profile.versions)) {
  console.log(`⏭  ${CP} is not in the registry yet — register it (rig/propagate/cp-${CP}.json), then re-run.`);
  process.exit(0);
}
console.log(`Registry has ${CP}. Flags:`);
for (const p of profile.versions.at(-1).properties) {
  console.log(`   ${p.name.padEnd(9)} ${'server' in p ? 'server' : 'client'}  propagate=${'propagate' in p}`);
}

installSystemIdPatch('test-propagate-' + crypto.randomUUID());

const opts = {
  protocol: process.env.ARETE_PROTOCOL || 'wss:',
  host: process.env.ARETE_HOST || 'dashboard.test.cns.dev',
  port: Number(process.env.ARETE_PORT || 443),
  username: process.env.ARETE_USER || '',
  password: process.env.ARETE_PASS || '',
  allowSelfSigned: (process.env.ARETE_ALLOW_SELF_SIGNED || '0') === '1',
  timeout: Number(process.env.ARETE_TIMEOUT || 10000),
  systemName: 'Propagate Experiment',
};

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arete-propagate-'));
const service = new AreteService();
service.on('log', (e) => console.log(`  [${e.level}] ${e.message}`));

const profileCache = new Map([[CP, profile]]);
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
  bundledDir: path.join(ROOT, 'rig', 'propagate'),
  libraryUrl: '',
  fetchProfile,
});
manager.on('log', (e) => console.log(`  [${e.level}] ${e.message}`));
service.on('keys', (k) => manager.onKeys(k));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(desc, fn, ms = 30000, step = 500) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = fn();
    if (v) return v;
    await sleep(step);
  }
  throw new Error('Timed out waiting for: ' + desc);
}

let code = 1;
try {
  console.log('\n1) Validating the rig widget definitions ...');
  const defs = await manager.loadDefinitions();
  const bad = defs.filter((d) => !d.ok);
  if (bad.length) throw new Error('Invalid rig definitions: ' + bad.map((d) => d.id + ': ' + d.errors[0]).join(' | '));
  console.log('   defs:', defs.map((d) => d.id).join(', '));

  console.log(`2) Connecting to ${opts.protocol}//${opts.host}:${opts.port} ...`);
  await service.connect(opts);

  console.log('3) Creating Sender (provider) + Receiver (consumer) in one context ...');
  const tx = await manager.addInstance({ widgetId: 'propagate-sender', name: 'Experiment Sender' });
  const rx = await manager.addInstance({
    widgetId: 'propagate-receiver',
    name: 'Experiment Receiver',
    contextId: tx.contextId,
    contextName: tx.contextName,
  });

  console.log('4) Waiting for the broker to bind ...');
  await waitFor('binding', () => {
    const a = manager.getInstance(tx.id);
    const b = manager.getInstance(rx.id);
    return a && b && a.connections > 0 && b.connections > 0;
  });
  console.log('   bound ✔');

  console.log('5) Writing BOTH flavors on BOTH sides ...');
  await manager.putProperty(tx.id, 'sShared', 'from-sender');
  await manager.putProperty(tx.id, 'sLocal', 'sender-secret');
  await manager.putProperty(rx.id, 'cShared', 'from-receiver');
  await manager.putProperty(rx.id, 'cLocal', 'receiver-secret');
  await manager.putProperty(tx.id, 'sPing', '7');

  console.log('6) Waiting for propagated values (and the cPong echo) to land ...');
  await waitFor('propagated values visible on the OTHER side + echo', () => {
    const a = manager.getInstance(tx.id);
    const b = manager.getInstance(rx.id);
    return (
      b && b.state.sShared === 'from-sender' && b.state.sPing === '7' &&
      a && a.state.cShared === 'from-receiver' && a.state.cPong === '7'
    );
  });
  console.log('   propagated values arrived; sPing=7 echoed back as cPong=7 ✔');

  console.log('7) Inspecting the RAW key namespace ...');
  await sleep(1500); // let any stragglers settle
  const keys = service.getKeys();
  const connKeys = Object.keys(keys).filter((k) => k.includes('/connections/') && k.includes('/properties/'));
  const inConn = (prop) => connKeys.filter((k) => k.endsWith('/' + prop));
  const capKey = (inst, role, prop) =>
    keys[`cns/${manager.getInstance(inst.id).systemId}/nodes/${inst.nodeId}/contexts/${inst.contextId}/${role}/${CP}/properties/${prop}`];

  const findings = [];
  const expect = (label, cond) => {
    findings.push(`${cond ? '✔' : '✘'} ${label}`);
    if (!cond) code = 2;
  };

  expect('sShared (propagated) present in connection properties', inConn('sShared').length >= 2);
  expect('cShared (propagated) present in connection properties', inConn('cShared').length >= 2);
  expect('sPing/cPong (propagated) present in connection properties', inConn('sPing').length >= 2 && inConn('cPong').length >= 2);
  expect('sLocal (NOT propagated) present on the SENDER capability', capKey(tx, 'provider', 'sLocal') === 'sender-secret');
  expect('cLocal (NOT propagated) present on the RECEIVER capability', capKey(rx, 'consumer', 'cLocal') === 'receiver-secret');
  expect('sLocal appears in NO connection anywhere', inConn('sLocal').length === 0);
  expect('cLocal appears in NO connection anywhere', inConn('cLocal').length === 0);
  expect("receiver's merged state never saw sLocal", manager.getInstance(rx.id).state.sLocal === undefined);
  expect("sender's merged state never saw cLocal", manager.getInstance(tx.id).state.cLocal === undefined);

  console.log('\n===== PROPAGATE EXPERIMENT FINDINGS =====');
  for (const f of findings) console.log('  ' + f);
  if (code !== 2) {
    console.log('\n✅ CONFIRMED — the control plane propagates flagged properties into');
    console.log('   connections and keeps non-propagated properties node-local.');
    code = 0;
  } else {
    console.log('\n⚠️  Some expectations FAILED — the control plane behaves differently');
    console.log('   than the model predicts. The findings above are the actual behavior.');
  }
} catch (e) {
  console.error('\n❌ FAIL —', e && e.message ? e.message : e);
  code = 1;
} finally {
  await service.disconnect().catch(() => {});
  fs.rmSync(dataDir, { recursive: true, force: true });
  setTimeout(() => process.exit(code), 400);
}
