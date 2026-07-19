// scripts/test-widget.js
// HEADLESS end-to-end test of the whole widget pipeline WITHOUT Electron:
// AreteService + WidgetManager + real registry validation + a live realm.
//
// It creates a Virtual Switch (provider) and a Virtual Bulb (consumer) in the
// SAME context, waits for the broker to bind them, flips the switch, and
// asserts the bulb auto-actualizes (cState follows sOut).
//
// Default host is the public no-auth test realm. Against your own host:
//   ARETE_HOST=my.realm.example.com ARETE_USER=... ARETE_PASS=... \
//     ARETE_ALLOW_SELF_SIGNED=1 node scripts/test-widget.js

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

installSystemIdPatch('test-widget-' + crypto.randomUUID());

const opts = {
  protocol: process.env.ARETE_PROTOCOL || 'wss:',
  host: process.env.ARETE_HOST || 'dashboard.test.cns.dev',
  port: Number(process.env.ARETE_PORT || 443),
  username: process.env.ARETE_USER || '',
  password: process.env.ARETE_PASS || '',
  allowSelfSigned: (process.env.ARETE_ALLOW_SELF_SIGNED || '0') === '1',
  timeout: Number(process.env.ARETE_TIMEOUT || 10000),
  systemName: process.env.ARETE_SYSTEM_NAME || 'Arete Widget (headless test)',
};

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arete-widget-test-'));
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
  widgetDirs: [path.join(ROOT, 'widgets')],
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
  console.log('1) Loading + validating widget definitions against cp.padi.io ...');
  const defs = await manager.loadDefinitions();
  const bad = defs.filter((d) => !d.ok);
  if (bad.length) throw new Error('Invalid definitions: ' + bad.map((d) => d.id).join(', '));
  console.log('   defs:', defs.map((d) => `${d.id}(${d.ok ? 'ok' : 'INVALID'})`).join(', '));

  console.log(`2) Connecting to ${opts.protocol}//${opts.host}:${opts.port} ...`);
  await service.connect(opts);

  console.log('3) Creating Virtual Switch + Virtual Bulb in ONE context ...');
  const sw = await manager.addInstance({ widgetId: 'switch', name: 'Headless Switch' });
  const bulb = await manager.addInstance({
    widgetId: 'bulb',
    name: 'Headless Bulb',
    contextId: sw.contextId,
    contextName: sw.contextName,
  });
  console.log('   context:', sw.contextId);

  console.log('4) Waiting for the broker to bind provider <-> consumer ...');
  await waitFor('broker binding (connections > 0 on both)', () => {
    const s = manager.getInstance(sw.id);
    const b = manager.getInstance(bulb.id);
    return s && b && s.connections > 0 && b.connections > 0;
  });
  console.log('   bound ✔');

  console.log('5) Flipping the switch ON (sOut=1) ...');
  await manager.putProperty(sw.id, 'sOut', '1');
  await waitFor('bulb auto-actualizes cState=1 and switch sees it', () => {
    const s = manager.getInstance(sw.id);
    const b = manager.getInstance(bulb.id);
    return b && b.state.cState === '1' && s && s.state.cState === '1';
  });
  console.log('   bulb reports cState=1 ✔ (auto-actualize rule fired)');

  console.log('6) Flipping the switch OFF (sOut=0) ...');
  await manager.putProperty(sw.id, 'sOut', '0');
  await waitFor('bulb follows back to cState=0', () => {
    const b = manager.getInstance(bulb.id);
    return b && b.state.cState === '0';
  });
  console.log('   bulb reports cState=0 ✔');

  console.log('7) Verifying the realm shows the CUSTOM system name (not the hostname) ...');
  // Both addInstance calls above went through registerSystem paths; the realm
  // name must still be the custom one (client.system() resets it to
  // os.hostname() when called — the service must prevent/heal that).
  const sysId = service.systemId;
  const nameKey = `cns/${sysId}/name`;
  const finalName = await waitFor('realm system name to settle on the custom name', () => {
    const n = service.getKeys()[nameKey];
    return n === opts.systemName ? n : null;
  }, 15000);
  console.log(`   realm name: "${finalName}" ✔`);

  console.log('\n✅ PASS — definitions validated, instances registered, broker bound,');
  console.log('   and the bulb auto-actualized the switch commands end-to-end.');
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
