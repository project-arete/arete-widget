// Drive the REAL renderer/app.js in jsdom with a stubbed window.arete bridge.
// Regression-tests the add-widget flow: open form, New-context feedback,
// Join radio + dropdown (incl. empty-realm recovery), selection survival,
// create. Added after the UI v2-v4 form bugs.
// Original: open Add form -> click "Join existing" -> use the dropdown.
import fs from 'node:fs';
let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch (_) {
  console.log('jsdom not installed (run `npm install` to get devDependencies) — skipping UI test.');
  process.exit(0);
}

import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(ROOT + '/renderer/index.html', 'utf8');
const appjs = fs.readFileSync(ROOT + '/renderer/app.js', 'utf8');

const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'file:///index.html' });
const { window } = dom;
const { document } = window;

// ---- stub bridge ----
const KEYS = {
  'cns/S1/name': 'Black Switch',
  'cns/S1/nodes/N1/name': 'Switch Node',
  'cns/S1/nodes/N1/contexts/Ctx000000000000000001/name': 'Light 1',
  'cns/S2/name': 'White Bulb',
  'cns/S2/nodes/N2/name': 'bulb-node',
  'cns/S2/nodes/N2/contexts/Ctx000000000000000001/name': 'light1',
  'cns/S2/nodes/N2/contexts/Ctx000000000000000002/name': 'Office 41-B',
};
const DEFS = [
  { id: 'bulb', file: 'widgets/bulb.yaml', ok: true, errors: [], title: 'Virtual Bulb', description: 'A light.', capabilities: [{ profile: 'padi.light', role: 'consumer', title: 'x' }], hasBehavior: true },
  { id: 'switch', file: 'widgets/switch.yaml', ok: true, errors: [], title: 'Virtual Switch', description: 'A controller.', capabilities: [{ profile: 'padi.light', role: 'provider', title: 'x' }], hasBehavior: false },
];
const subs = { keys: [], log: [], status: [], wdefs: [], winst: [], wstate: [] };
window.arete = {
  getDefaults: async () => ({ protocol: 'wss:', host: 'h', port: 443, username: 'u', password: '', allowSelfSigned: true, rememberPassword: false, autoConnect: false, canRememberPassword: true, systemName: "Arete Widget", userWidgetsDir: '/tmp/w' }),
  connect: async () => ({}),
  disconnect: async () => ({}),
  getStatus: async () => ({ state: 'connected', isOpen: true, version: '1', stats: {}, identity: { system: 'S9' }, lastError: null }),
  setAutoConnect: async () => ({}),
  openExternal: async () => {},
  getKeys: async () => KEYS,
  getProfile: async () => null,
  onKeys: (cb) => subs.keys.push(cb),
  onLog: (cb) => subs.log.push(cb),
  onStatus: (cb) => subs.status.push(cb),
  widgetDefs: async () => DEFS,
  widgetReload: async () => DEFS,
  widgetInstances: async () => [],
  widgetAdd: async (spec) => { window.__added = spec; return { id: 'inst1', ...spec }; },
  widgetRemove: async () => {},
  widgetOpen: async (id) => { window.__opened = id; },
  onWidgetDefs: (cb) => subs.wdefs.push(cb),
  onWidgetInstances: (cb) => subs.winst.push(cb),
  onWidgetState: (cb) => subs.wstate.push(cb),
};
window.__errors = [];
if (!window.CSS) window.CSS = {};
if (!window.CSS.escape) window.CSS.escape = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
window.addEventListener('error', (e) => window.__errors.push(String(e.message)));

// run app.js
window.eval(appjs);
await new Promise((r) => setTimeout(r, 50)); // let init() settle

const $ = (sel) => document.querySelector(sel);
const fire = (el, type) => el.dispatchEvent(new window.Event(type, { bubbles: true }));
const report = (label, val) => console.log(label.padEnd(46), val);

// 1) open the bulb Add form
$('[data-add="bulb"]').click();
report('add form rendered:', !!$('[data-form="bulb"]'));
report('pending ctx id shown:', ($('#af-ctxinfo-new')?.textContent || '').includes('matching space'));

const joinRadio = $('#af-ctx-join');
report('join radio exists:', !!joinRadio);
report('join radio DISABLED:', joinRadio?.disabled);
const sel = $('#af-ctxsel');
report('select option count:', sel?.options.length);

// 2) click "Join existing"
joinRadio.checked = true;
$('#af-ctx-new').checked = false;
fire(joinRadio, 'change');
report('after join click — select row visible:', !$('#af-ctxsel-row').hidden);
report('after join click — name row hidden:', $('#af-ctxname-row').hidden);
report('join info populated:', ($('#af-ctxinfo-join')?.textContent || '').includes('matching space'));

// 3) pick the second option, then simulate live keys pushes
if (sel.options.length > 1) {
  sel.selectedIndex = 1;
  fire(sel, 'change');
}
const before = sel.value;
for (const cb of subs.keys) cb({ ...KEYS, 'cns/S1/nodes/N1/contexts/Ctx000000000000000001/provider/padi.light/properties/sOut': '1' });
for (const cb of subs.keys) cb({ ...KEYS });
report('selection survives keys pushes:', sel.value === before && sel.value !== '');

// 4) create
$('#af-create').click();
await new Promise((r) => setTimeout(r, 20));
report('widgetAdd called with contextId:', window.__added && window.__added.contextId);
report('faceplate opened:', window.__opened);
report('uncaught errors:', JSON.stringify(window.__errors));

// 5) The suspected field scenario: form opened while keys are EMPTY.
for (const cb of subs.keys) cb({});                  // realm looks empty
document.querySelector('[data-add="bulb"]').click(); // open (form was closed after create)
const jr = document.querySelector('#af-ctx-join');
report('empty-keys open — join disabled:', jr.disabled);
report('empty-keys open — hint visible:', !document.querySelector('#af-join-hint').hidden);
for (const cb of subs.keys) cb(KEYS); // realm data arrives
report('keys arrive — join re-enabled:', !jr.disabled);
report('keys arrive — hint hidden:', document.querySelector('#af-join-hint').hidden);
jr.checked = true; document.querySelector('#af-ctx-new').checked = false; fire(jr, 'change');
report('join then usable — select visible:', !document.querySelector('#af-ctxsel-row').hidden);
report('join then usable — options:', document.querySelector('#af-ctxsel').options.length);

const failures = [];
// re-run critical booleans as hard assertions
if (window.__errors.length) failures.push('uncaught errors: ' + window.__errors);
if (!window.__added || !window.__added.contextId) failures.push('widgetAdd not called correctly');
if (failures.length) { console.error('\n❌ FAIL —', failures.join('; ')); process.exit(1); }
console.log('\n✅ PASS — add-widget UI flow works end-to-end in DOM.');
