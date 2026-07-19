// scripts/test-library.js
// Tests the ONLINE LIBRARY pipeline headlessly (no Electron, no realm):
//   1. fetch a catalog from a (local, fake) library server into the cache
//   2. source precedence: local folder > online library > bundled
//   3. offline resilience: server gone -> cached library copies still load
//   4. the real published catalog serves and validates end-to-end
//
// Needs network only for CP-registry validation (cp.padi.io) and step 4.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WidgetManager } from '../electron/widget-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arete-lib-test-'));
const userDir = path.join(tmp, 'local');
const cacheDir = path.join(tmp, 'cache');
fs.mkdirSync(userDir, { recursive: true });

// A LOCAL override of the bundled/library "bulb" widget.
fs.writeFileSync(path.join(userDir, 'my-bulb.yaml'), `
widget: bulb
title: Local Bulb
description: Overrides the library bulb.
capabilities: [{ profile: padi.light, role: consumer }]
view: [{ type: lamp, bind: sOut, on: "1" }]
`);

// A fake ONLINE catalog: a library-only widget + a library override of "switch".
const LIB_FILES = {
  'lib-meter.yaml': `
widget: lib-meter
title: Library Meter
description: Only exists in the online library.
capabilities: [{ profile: padi.light, role: consumer }]
view: [{ type: value, bind: cState, caption: state }]
`,
  'switch.yaml': `
widget: switch
title: Library Switch
description: Library version overrides the bundled one.
capabilities: [{ profile: padi.light, role: provider }]
view: [{ type: toggle, bind: sOut, on: "1", off: "0" }]
`,
};
const INDEX = {
  catalog: 'arete-widget-library',
  version: 1,
  widgets: Object.keys(LIB_FILES).map((f) => ({ id: f.replace('.yaml', ''), file: 'widgets/' + f })),
};
const server = http.createServer((req, res) => {
  if (req.url === '/index.json') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(INDEX));
  } else if (req.url.startsWith('/widgets/') && LIB_FILES[path.basename(req.url)]) {
    res.end(LIB_FILES[path.basename(req.url)]);
  } else {
    res.statusCode = 404;
    res.end('nope');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const libUrl = `http://127.0.0.1:${server.address().port}`;

const mk = (url) => new WidgetManager({
  service: {},
  dataDir: tmp,
  bundledDir: path.join(ROOT, 'widgets'),
  userDir,
  libraryCacheDir: cacheDir,
  libraryUrl: url,
  fetchProfile,
});

let code = 1;
try {
  const manager = mk(libUrl);
  manager.on('log', (e) => console.log(`  [${e.level}] ${e.message}`));

  console.log('1) Fetch catalog + precedence (local > library > bundled) ...');
  const defs = await manager.loadDefinitions();
  const by = Object.fromEntries(defs.map((d) => [d.id, d]));
  const assert = (cond, msg) => { if (!cond) throw new Error(msg); console.log('   ✔ ' + msg); };
  assert(by['lib-meter'] && by['lib-meter'].source === 'library' && by['lib-meter'].ok, 'library-only widget appears (source: library)');
  assert(by['switch'].source === 'library' && by['switch'].title === 'Library Switch', 'library overrides bundled (switch)');
  assert(by['bulb'].source === 'local' && by['bulb'].title === 'Local Bulb', 'local overrides library/bundled (bulb)');
  assert(by['trust-provider'] && by['trust-provider'].source === 'bundled', 'bundled widgets still present');
  const info = manager.libraryInfo();
  assert(info.count === 2 && info.updatedAt, 'libraryInfo reports 2 library widgets + freshness');

  console.log('2) Offline: kill the server, reload with refresh ...');
  await new Promise((r) => server.close(r));
  const defs2 = await manager.loadDefinitions(true); // refresh fails -> cache serves
  const by2 = Object.fromEntries(defs2.map((d) => [d.id, d]));
  assert(by2['lib-meter'] && by2['lib-meter'].source === 'library', 'cached library widgets survive the server dying');

  console.log('3) The REAL published catalog ...');
  const freshCache = path.join(tmp, 'live-cache');
  const live = new WidgetManager({
    service: {},
    dataDir: tmp,
    bundledDir: path.join(ROOT, 'widgets'),
    libraryCacheDir: freshCache,
    libraryUrl: 'https://project-arete.github.io/widget-library',
    fetchProfile,
  });
  const defs3 = await live.loadDefinitions();
  const libCount = defs3.filter((d) => d.source === 'library').length;
  const allOk = defs3.filter((d) => d.source === 'library').every((d) => d.ok);
  assert(libCount >= 8, `live catalog delivers ${libCount} widgets (≥8)`);
  assert(allOk, 'every live library widget validates against the CP registry');

  console.log('\n✅ PASS — online library fetch, precedence, offline cache, and live catalog.');
  code = 0;
} catch (e) {
  console.error('\n❌ FAIL —', e && e.message ? e.message : e);
  code = 1;
} finally {
  try { server.close(); } catch (_) {}
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(code);
}
