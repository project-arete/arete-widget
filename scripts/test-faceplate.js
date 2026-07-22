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

// ===========================================================================
// PART 2 — per-CP pill groups (UI v37). A multi-CP widget (Tenant Light
// shape: one light + one lease connection) gets NO strip at all — a group
// only exists for a CP with 2+ of its own connections — and writes always
// resolve against the property's OWN CP group, never another CP's pill.
// ===========================================================================
console.log('\n— part 2: per-CP groups (multi-capability widget) —');
const dom2 = new JSDOM(html, { runScripts: 'outside-only', url: 'file:///faceplate.html', pretendToBeVisual: true });
const w2 = dom2.window;
const d2 = w2.document;
const subs2 = { state: [], theme: [], info: [] };
w2.__actions = [];
const PEERS_A = [
  { connId: 'c1', system: 'Anto', node: 'West', profile: 'padi.light' },
  { connId: 'l1', system: 'Anto', node: 'Landlord', profile: 'padi.lease.basic' },
];
w2.faceplate = {
  instanceId: 'instB',
  load: async () => ({
    id: 'instB',
    name: 'Tenant Light',
    contextName: 'SUITE',
    widgetId: 'lease-bulb',
    title: 'Tenant Light',
    icon: '🏠',
    color: '#4cc36a',
    view: [
      { type: 'toggle', bind: 'sOut', on: '1', off: '0', caption: 'light' },
      { type: 'value', bind: 'status', caption: 'lease status' },
      { type: 'field', bind: 'rent', caption: 'rent' },
    ],
    writable: ['sOut', 'rent'],
    localOnly: [],
    bindProfile: { sOut: 'padi.light', status: 'padi.lease.basic', rent: 'padi.lease.basic' },
    hasRules: true,
    state: { sOut: '0', status: 'Offer' },
    connections: 2,
    peers: PEERS_A,
    perConn: { c1: { sOut: '0' }, l1: { status: 'Offer' } },
    attached: true,
    pinned: false,
    theme: 'dark',
  }),
  action: async (property, value, connId) => w2.__actions.push({ property, value, connId: connId ?? null }),
  setPinned: async (p) => p,
  adjustHeight: () => {},
  onState: (cb) => subs2.state.push(cb),
  onTheme: (cb) => subs2.theme.push(cb),
  onInfo: (cb) => subs2.info.push(cb),
};
w2.__errors = [];
w2.addEventListener('error', (e) => w2.__errors.push(String(e.message)));
w2.eval(fpjs);
await new Promise((r) => setTimeout(r, 50));
const q2 = (sel) => [...d2.querySelectorAll(sel)];

// 1 light + 1 lease connection: nothing to disambiguate -> NO strip
assert('multi-CP 1+1: strip HIDDEN', d2.getElementById('fpStrip').hidden);
assert('footer lists both peers', d2.getElementById('fpPeers').textContent === 'bound to West · Landlord');
d2.querySelector('.toggle').click();
await new Promise((r) => setTimeout(r, 10));
assert('1+1 write is a clean broadcast (the old misaddress bug)',
  w2.__actions.length === 1 && w2.__actions[0].connId === null && w2.__actions[0].property === 'sOut');

// second LEASE connection arrives: exactly one group (lease), light stays groupless
const PEERS_B = [
  PEERS_A[0],
  PEERS_A[1],
  { connId: 'l2', system: 'Anto', node: 'Acme', profile: 'padi.lease.basic' },
];
for (const cb of subs2.state) cb({ id: 'instB', state: { sOut: '1', status: 'Offer' }, connections: 3, peers: PEERS_B, perConn: { c1: { sOut: '1' }, l1: { status: 'Offer' }, l2: { status: 'Approved' } } });
assert('lease gains a group, strip appears', !d2.getElementById('fpStrip').hidden);
assert('one group: All + 2 lease pills, no CP tag needed',
  q2('#fpStrip .peer').length === 3 && q2('#fpStrip .gtag').length === 0);
assert('lease disagreement shows mixed on status', q2('.value')[0].textContent === 'mixed');
assert('light prop NOT mixed across unrelated CPs', !d2.querySelector('.toggle').classList.contains('mixed'));

// select the Acme lease pill: lease reads scope, light writes stay broadcast
q2('#fpStrip .peer')[2].click();
assert('lease selection scopes the status read', q2('.value')[0].textContent === 'Approved');
d2.querySelector('.toggle').click();
await new Promise((r) => setTimeout(r, 10));
assert('light write ignores the LEASE selection (broadcast)',
  w2.__actions.length === 2 && w2.__actions[1].connId === null);
const rentInput = d2.querySelector('.field input');
rentInput.value = '100';
rentInput.dispatchEvent(new w2.Event('blur'));
await new Promise((r) => setTimeout(r, 10));
assert('lease write IS scoped to the selected lease connection',
  w2.__actions.length === 3 && w2.__actions[2].property === 'rent' && w2.__actions[2].connId === 'l2');

// second LIGHT connection arrives too: two tagged groups, independent selections
const PEERS_C = [...PEERS_B, { connId: 'c2', system: 'Anto', node: 'East', profile: 'padi.light' }];
for (const cb of subs2.state) cb({ id: 'instB', state: { sOut: '1', status: 'Offer' }, connections: 4, peers: PEERS_C, perConn: { c1: { sOut: '1' }, c2: { sOut: '0' }, l1: { status: 'Offer' }, l2: { status: 'Approved' } } });
assert('two multi-connection CPs: two tagged groups on one row',
  q2('#fpStrip .peer-group').length === 2 && q2('#fpStrip .gtag').map((t) => t.textContent).join('|') === 'light|lease.basic');
assert('light disagreement now mixed (within its own group)', d2.querySelector('.toggle').classList.contains('mixed'));
q2('#fpStrip .peer-group')[0].querySelectorAll('.peer')[1].click(); // West in the LIGHT group
d2.querySelector('.toggle').click();
await new Promise((r) => setTimeout(r, 10));
assert('light write scoped by the LIGHT group selection',
  w2.__actions.length === 4 && w2.__actions[3].connId === 'c1');
rentInput.value = '200';
rentInput.dispatchEvent(new w2.Event('blur'));
await new Promise((r) => setTimeout(r, 10));
assert('lease selection survived independently (still l2)',
  w2.__actions.length === 5 && w2.__actions[4].connId === 'l2');

if (w2.__errors.length) failures.push('part2 uncaught errors: ' + w2.__errors);

// ===========================================================================
// PART 3 — multi-context attach (UI v43). A LANDLORD widget: one node, its
// lease provider capability declared into each unit's context. Pills label
// by PLACE (the context name), and a pill-scoped write is routed by connId —
// the manager maps connId -> context, the faceplate needn't know the paths.
// ===========================================================================
console.log('\n— part 3: multi-context pills (landlord across suites) —');
const dom3 = new JSDOM(html, { runScripts: 'outside-only', url: 'file:///faceplate.html', pretendToBeVisual: true });
const w3 = dom3.window;
const d3 = w3.document;
const subs3 = { state: [], theme: [], info: [] };
w3.__actions = [];
const PEERS_MC = [
  { connId: 't1', system: 'Acme', node: 'Matt', profile: 'padi.lease.basic', ctxId: 'CA', context: 'Suite 200' },
  { connId: 't2', system: 'Tina Co', node: 'Tina', profile: 'padi.lease.basic', ctxId: 'CB', context: 'Suite 310' },
];
w3.faceplate = {
  instanceId: 'instC',
  load: async () => ({
    id: 'instC',
    name: 'Maple House',
    contextName: 'Suite 200 +1',
    contexts: [{ id: 'CA', name: 'Suite 200' }, { id: 'CB', name: 'Suite 310' }],
    widgetId: 'landlord',
    title: 'Landlord',
    icon: '🏢',
    color: '',
    view: [
      { type: 'field', bind: 'rate', caption: 'rate' },
      { type: 'value', bind: 'rent', caption: 'rent' },
    ],
    writable: ['rate'],
    localOnly: [],
    bindProfile: { rate: 'padi.lease.basic', rent: 'padi.lease.basic' },
    hasRules: false,
    state: { rate: '30' },
    connections: 2,
    peers: PEERS_MC,
    perConn: { t1: { rent: '4500' }, t2: { rent: '5200' } },
    attached: true,
    pinned: false,
    theme: 'dark',
  }),
  action: async (property, value, connId) => w3.__actions.push({ property, value, connId: connId ?? null }),
  setPinned: async (p) => p,
  adjustHeight: () => {},
  onState: (cb) => subs3.state.push(cb),
  onTheme: (cb) => subs3.theme.push(cb),
  onInfo: (cb) => subs3.info.push(cb),
};
w3.__errors = [];
w3.addEventListener('error', (e) => w3.__errors.push(String(e.message)));
w3.eval(fpjs);
await new Promise((r) => setTimeout(r, 50));
const q3 = (sel) => [...d3.querySelectorAll(sel)];

assert('multi-context strip appears at 2 suite connections', !d3.getElementById('fpStrip').hidden);
assert('pills label by PLACE (context names, not peer nodes)',
  q3('#fpStrip .peer').map((p) => p.textContent).join('|') === 'All · 2|Suite 200|Suite 310');
assert('kind line shows the multi-context title', d3.getElementById('fpKind').textContent.includes('Suite 200 +1'));
assert('All view shows per-suite disagreement as mixed', q3('.value')[0].textContent === 'mixed');
q3('#fpStrip .peer')[2].click(); // Suite 310
assert('suite pill scopes the read', q3('.value')[0].textContent === '5200');
const rateInput = d3.querySelector('.field input');
rateInput.value = '33';
rateInput.dispatchEvent(new w3.Event('blur'));
await new Promise((r) => setTimeout(r, 10));
assert('suite-scoped write addresses that suite\'s connection',
  w3.__actions.length === 1 && w3.__actions[0].connId === 't2' && w3.__actions[0].property === 'rate');
q3('#fpStrip .peer')[0].click(); // back to All
rateInput.value = '35';
rateInput.dispatchEvent(new w3.Event('blur'));
await new Promise((r) => setTimeout(r, 10));
assert('All-view write is unscoped (manager fans out per context)',
  w3.__actions.length === 2 && w3.__actions[1].connId === null);

// Instant hover card (UI v44): synchronous on mouseenter — no OS delay —
// and carries context, node, system, CP, conn id, and the live values.
{
  const pill310 = q3('#fpStrip .peer')[2];
  assert('pills carry NO native title (delay killer)', !pill310.title);
  pill310.dispatchEvent(new w3.Event('mouseenter'));
  const tip = d3.querySelector('.fp-tip');
  assert('hover card appears IMMEDIATELY on mouseenter', !!tip && !tip.hidden);
  const t = tip.textContent;
  assert('card names the context', t.includes('Suite 310'));
  assert('card names the node + system', t.includes('Tina') && t.includes('Tina Co'));
  assert('card names the CP + connection', t.includes('padi.lease.basic') && t.includes('t2'));
  assert('card shows that connection\'s LIVE values', t.includes('rent') && t.includes('5200'));
  pill310.dispatchEvent(new w3.Event('mouseleave'));
  assert('card hides on mouseleave', tip.hidden);
  q3('#fpStrip .peer')[0].dispatchEvent(new w3.Event('mouseenter'));
  const tAll = d3.querySelector('.fp-tip').textContent;
  assert('All-pill card summarizes places + write semantics',
    tAll.includes('2 connections') && tAll.includes('Suite 200, Suite 310') && tAll.includes('broadcast'));
  q3('#fpStrip .peer')[0].dispatchEvent(new w3.Event('mouseleave'));
}

if (w3.__errors.length) failures.push('part3 uncaught errors: ' + w3.__errors);
if (failures.length) { console.error('\n❌ FAIL —', failures.join('; ')); process.exit(1); }
console.log('\n✅ PASS — scoped control, mixed own-props, identity sync, per-CP pill groups, and multi-context place pills all work.');
process.exit(0);
