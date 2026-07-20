// Drive the REAL renderer/faceplate.js in jsdom with a stubbed
// window.faceplate bridge. Regression-tests (UI v25–v26):
//   - bootstrap render: header name, kind line, document title, chip, value
//   - live state push updates values
//   - IDENTITY PUSH (v25): Edit rename / context change while open updates
//     the header name, kind line, and document title in place
//   - PER-CONNECTION CONTROL (v26): with a peer chip selected, control writes
//     carry that connection's id (scoped); All = broadcast (no id). Own-
//     written props show 'mixed' in the All view when connections disagree.
import fs from 'node:fs';
let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch (_) {
  console.log('jsdom not installed (run `npm install` to get devDependencies) — skipping faceplate test.');
  process.exit(0);
}

import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(ROOT + '/renderer/faceplate.html', 'utf8');
const fpjs = fs.readFileSync(ROOT + '/renderer/faceplate.js', 'utf8');

const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'file:///faceplate.html', pretendToBeVisual: true });
const { window } = dom;
const { document } = window;

const PEERS = [
  { connId: 'c1', system: 'Anto', node: 'West', profile: 'padi.light' },
  { connId: 'c2', system: 'Anto', node: 'East', profile: 'padi.light' },
];

// ---- stub bridge (mirrors preload-faceplate.cjs surface) ----
const subs = { state: [], theme: [], info: [] };
window.__actions = [];
window.faceplate = {
  instanceId: 'instA',
  load: async () => ({
    id: 'instA',
    name: 'SW1',
    contextName: 'LIGHT',
    widgetId: 'switch',
    title: 'Virtual Switch',
    icon: '🎚',
    color: '#f5b34c',
    view: [
      { type: 'toggle', bind: 'sOut', on: '1', off: '0', caption: 'power' },
      { type: 'value', bind: 'sOut', caption: 'output' },
      { type: 'value', bind: 'cState', caption: 'light reports' },
    ],
    writable: ['sOut'],
    localOnly: [],
    hasRules: false,
    state: { sOut: '0', cState: '0' },
    connections: 2,
    peers: PEERS,
    perConn: { c1: { sOut: '0', cState: '0' }, c2: { sOut: '0', cState: '0' } },
    attached: true,
    pinned: false,
    theme: 'dark',
  }),
  action: async (property, value, connId) => window.__actions.push({ property, value, connId: connId ?? null }),
  setPinned: async (p) => p,
  adjustHeight: () => {},
  onState: (cb) => subs.state.push(cb),
  onTheme: (cb) => subs.theme.push(cb),
  onInfo: (cb) => subs.info.push(cb),
};
window.__errors = [];
window.addEventListener('error', (e) => window.__errors.push(String(e.message)));

// run faceplate.js
window.eval(fpjs);
await new Promise((r) => setTimeout(r, 50)); // let init() settle

const $ = (id) => document.getElementById(id);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const report = (label, val) => console.log(label.padEnd(50), val);
const failures = [];
const assert = (label, ok) => { report(label + ':', ok); if (!ok) failures.push(label); };
const values = () => $$('.value').map((v) => v.textContent);

// 1) bootstrap render (multi-connection)
assert('name rendered', $('fpName').textContent === 'SW1');
assert('kind line rendered', $('fpKind').textContent === 'Virtual Switch · LIGHT');
assert('document title set', document.title === 'SW1');
assert('chip shows bound · 2', $('fpChip').textContent === 'bound · 2');
assert('peer strip rendered', !$('fpStrip').hidden && $$('#fpStrip .peer').length === 3);
assert('strip labels are node names', $$('#fpStrip .peer').map((b) => b.textContent).join('|') === 'All · 2|West|East');

// 2) All view: toggle write is a BROADCAST (no connection id)
document.querySelector('.toggle').click();
await new Promise((r) => setTimeout(r, 10));
assert('All-view write has no connId', window.__actions.length === 1 && window.__actions[0].connId === null);
assert('All-view write toggles value', window.__actions[0].property === 'sOut' && window.__actions[0].value === '1');

// 3) select West chip: write is SCOPED to c1
$$('#fpStrip .peer')[1].click(); // West
document.querySelector('.toggle').click();
await new Promise((r) => setTimeout(r, 10));
assert('West-selected write carries connId c1', window.__actions.length === 2 && window.__actions[1].connId === 'c1');

// 4) echo: West's connection now differs -> All view shows mixed on OWN prop
for (const cb of subs.state) cb({ id: 'instA', state: { sOut: '1', cState: '0' }, connections: 2, peers: PEERS, perConn: { c1: { sOut: '1', cState: '0' }, c2: { sOut: '0', cState: '0' } } });
assert('West overlay shows the scoped value', values()[0] === '1');
$$('#fpStrip .peer')[0].click(); // back to All
assert('All view: own prop shows mixed', values()[0] === 'mixed');
assert('toggle gets mixed class', document.querySelector('.toggle').classList.contains('mixed'));
assert('mixed tooltip breakdown', /1× "1"/.test(document.querySelector('.toggle').title) && /1× "0"/.test(document.querySelector('.toggle').title));

// 5) select East: clean per-connection view, no mixed
$$('#fpStrip .peer')[2].click(); // East
assert('East overlay shows its own value', values()[0] === '0');
assert('East view: toggle not mixed', !document.querySelector('.toggle').classList.contains('mixed'));

// 6) broadcast reconverges: All view mixed clears
$$('#fpStrip .peer')[0].click(); // All
for (const cb of subs.state) cb({ id: 'instA', state: { sOut: '1', cState: '1' }, connections: 2, peers: PEERS, perConn: { c1: { sOut: '1', cState: '1' }, c2: { sOut: '1', cState: '1' } } });
assert('agreement clears mixed', values()[0] === '1' && !document.querySelector('.toggle').classList.contains('mixed'));

// 7) identity push (v25 regression): rename while open
assert('info channel subscribed', subs.info.length === 1);
for (const cb of subs.info) cb({ id: 'instA', name: 'Main Switch', contextName: 'Hall' });
assert('rename updates header name', $('fpName').textContent === 'Main Switch');
assert('rename updates kind line', $('fpKind').textContent === 'Virtual Switch · Hall');
assert('rename updates document title', document.title === 'Main Switch');
assert('values untouched by identity push', values()[0] === '1');

if (window.__errors.length) failures.push('uncaught errors: ' + window.__errors);
if (failures.length) { console.error('\n❌ FAIL —', failures.join('; ')); process.exit(1); }
console.log('\n✅ PASS — scoped per-connection control, mixed own-props, and identity sync all work.');
process.exit(0);
