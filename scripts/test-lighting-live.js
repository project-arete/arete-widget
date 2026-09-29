// scripts/test-lighting-live.js — LIVE E2E for the registry cut-over (W3):
// widgets on cp:padi.lighting (v1 Deprecated, v2 current) validate against v2,
// go live, the realm records v2, and the value flows provider -> consumer.
//
//   ARETE_PROTOCOL=ws: ARETE_HOST=127.0.0.1 ARETE_PORT=35003 node scripts/test-lighting-live.js
//
// Reads the registry through cp-resolver (CP_REGISTRY_URL, default cp.cnscp.io).

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

import { installSystemIdPatch } from '../electron/arete-system-id.js';
import { AreteService } from '../electron/arete-service.js';
import { WidgetManager } from '../electron/widget-manager.js';
import { fetchProfile as registryFetch } from './lib/registry.js';

installSystemIdPatch('test-lighting-' + crypto.randomUUID());

const opts = {
  protocol: process.env.ARETE_PROTOCOL || 'wss:',
  host: process.env.ARETE_HOST || 'dashboard.test.cns.dev',
  port: Number(process.env.ARETE_PORT || 443),
  username: process.env.ARETE_USER || '',
  password: process.env.ARETE_PASS || '',
  allowSelfSigned: (process.env.ARETE_ALLOW_SELF_SIGNED || '0') === '1',
  timeout: 10000,
  systemName: 'Lighting Test (headless)',
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arete-lighting-test-'));
const bundled = path.join(tmp, 'defs');
fs.mkdirSync(bundled);
fs.writeFileSync(path.join(bundled, 'lighting-ctl.yaml'), yaml.dump({
  widget: 'lighting-ctl', title: 'Lighting controller',
  capabilities: [{ profile: 'padi.lighting', role: 'provider' }],
  view: [{ type: 'value', bind: 'level', caption: 'level' }, { type: 'value', bind: 'actual', caption: 'actual' }],
  behavior: { init: { level: '0.5' } },
}));
fs.writeFileSync(path.join(bundled, 'lighting-lamp.yaml'), yaml.dump({
  widget: 'lighting-lamp', title: 'Luminaire',
  capabilities: [{ profile: 'padi.lighting', role: 'consumer' }],
  view: [{ type: 'value', bind: 'level', caption: 'level' }, { type: 'value', bind: 'actual', caption: 'actual' }],
  behavior: { rules: [{ when: 'level', set: 'actual' }] },
}));

const service = new AreteService();
const logs = [];
const manager = new WidgetManager({
  service, dataDir: path.join(tmp, 'data'), bundledDir: bundled, libraryUrl: '',
  fetchProfile: async (name, version) => (await registryFetch(name, version)) || { __unresolved: 'not registered' },
});
manager.on('log', (e) => { logs.push(e.message); if (e.level !== 'info') console.log(`  [${e.level}] ${e.message}`); });
service.on('keys', (k) => manager.onKeys(k));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(desc, fn, ms = 90000, step = 500) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(step); }
  throw new Error('Timed out waiting for: ' + desc);
}

let code = 1;
try {
  console.log('1) Validating the padi.lighting widgets (against the current version) ...');
  const defs = await manager.loadDefinitions(false);
  const bad = defs.filter((d) => !d.ok);
  if (bad.length) throw new Error('Invalid definitions: ' + bad.map((d) => d.id + ': ' + d.errors[0]).join(' | '));
  const model = manager.getModel('lighting-lamp');
  const validated = model.capabilities[0].version;
  console.log(`   validated against padi.lighting:${validated} ✔`);
  if (validated !== 2) throw new Error(`expected the current version to be 2, got ${validated}`);

  console.log(`2) Connecting to ${opts.host} ...`);
  await service.connect(opts);

  console.log('3) Controller + luminaire in one context ...');
  const ctl = await manager.addInstance({ widgetId: 'lighting-ctl', name: 'Lighting ctl' });
  const lamp = await manager.addInstance({ widgetId: 'lighting-lamp', name: 'Luminaire', contextId: ctl.contextId, contextName: ctl.contextName });

  console.log('4) Waiting for the broker to bind ...');
  await waitFor('bind', () => {
    const c = manager.getInstance(ctl.id);
    const l = manager.getInstance(lamp.id);
    return c && l && c.connections > 0 && l.connections > 0;
  }, 120000);
  console.log('   bound ✔');

  console.log('5) The realm recorded v2 for both capabilities ...');
  const keys = service.getKeys();
  const recorded = Object.entries(keys).filter(([k]) => /\/(provider|consumer)\/padi\.lighting\/version$/.test(k)).map(([k, v]) => `${k.split('/').slice(-3, -2)[0]}=v${v}`);
  console.log('   ' + recorded.join('  '));
  if (recorded.length < 2 || !recorded.every((r) => r.endsWith('=v2'))) throw new Error('the realm did not record v2 for both ends: ' + recorded.join(', '));
  console.log('   recorded v2 ✔');

  console.log('6) The controller\'s level reaches the luminaire, and it reports actual back ...');
  await manager.putProperty(ctl.id, 'level', '0.75');
  await waitFor('level to the luminaire', () => manager.getInstance(lamp.id).state.level === '0.75', 30000);
  await waitFor('actual back to the controller', () => manager.getInstance(ctl.id).state.actual === '0.75', 30000);
  console.log('   level 0.75 → luminaire; actual 0.75 → controller ✔');

  console.log('7) Attach checked the running widgets against the recorded version ...');
  const drift = logs.filter((l) => /recorded/.test(l));
  console.log('   no re-check needed (validated = recorded) ' + (drift.length ? '— but saw: ' + drift.join(' | ') : '✔'));

  console.log('\n✅ PASS — padi.lighting widgets validate against v2, the realm records v2, values flow.');
  code = 0;
} catch (e) {
  console.log('\n❌ FAIL — ' + (e.message || e));
} finally {
  try { await manager.removeAllInstances(); } catch (_) {}
  try { await service.disconnect(); } catch (_) {}
  process.exit(code);
}
