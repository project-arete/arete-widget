// Drive the REAL renderer/app.js in jsdom with a stubbed window.arete bridge.
// Regression-tests the tile-grid home page + add/edit dialog (UI v31):
// open dialog from the + tile, filter the picker, configure (Join is the
// DEFAULT when a complementary context exists; a NEW context requires a typed
// name — never prefixed from the widget), create, the unbound tile badge,
// and the edit flow (⋯ menu → Edit → keep-context save via widgetUpdate).
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
  // capability declarations: Ctx..01 holds a padi.light PROVIDER (a match for
  // the bulb widget = consumer); Ctx..02 holds only another CONSUMER (no match).
  'cns/S1/nodes/N1/contexts/Ctx000000000000000001/provider/padi.light/version': '1',
  'cns/S2/nodes/N2/contexts/Ctx000000000000000002/consumer/padi.light/version': '1',
};
const DEFS = [
  { id: 'bulb', file: 'widgets/bulb.yaml', ok: true, errors: [], title: 'Virtual Bulb', description: 'A light.', icon: '💡', color: '#f5b34c', capabilities: [{ profile: 'padi.light', role: 'consumer', title: 'x' }], hasBehavior: true },
  { id: 'switch', file: 'widgets/switch.yaml', ok: true, errors: [], title: 'Virtual Switch', description: 'A controller.', icon: '🎚', color: '', capabilities: [{ profile: 'padi.light', role: 'provider', title: 'x' }], hasBehavior: false },
];
const subs = { keys: [], log: [], status: [], wdefs: [], winst: [], wstate: [] };
window.arete = {
  getDefaults: async () => ({ protocol: 'wss:', host: 'h', port: 443, username: 'u', password: '', allowSelfSigned: true, rememberPassword: false, autoConnect: false, canRememberPassword: true, systemName: "Arete Widget", userWidgetsDir: '/tmp/w', libraryUrl: '', libraryUrlDefault: 'https://example.test', appVersion: '0.1.2' }),
  connect: async () => ({}),
  disconnect: async () => ({}),
  getStatus: async () => ({ state: 'connected', isOpen: true, version: '1', stats: {}, identity: { system: 'S9' }, lastError: null }),
  setAutoConnect: async () => ({}),
  saveSettings: async () => ({}),
  libraryInfo: async () => ({ url: '', updatedAt: null, count: 0 }),
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
  widgetUpdate: async (spec) => { window.__updated = spec; return { id: spec.id, ...spec }; },
  widgetRemove: async (id) => { window.__removed = id; },
  widgetRemoveAll: async () => { window.__removedAll = true; },
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
const $$ = (sel) => [...document.querySelectorAll(sel)];
const fire = (el, type) => el.dispatchEvent(new window.Event(type, { bubbles: true }));
const report = (label, val) => console.log(label.padEnd(46), val);
const failures = [];
const assert = (label, ok) => { report(label + ':', ok); if (!ok) failures.push(label); };

// 0) the app (release) version is surfaced in the header
assert('app version shown in header', $('#appVersion')?.textContent === 'v0.1.2');

// 1) the home page is a tile grid with a + tile
assert('plus tile rendered', !!$('[data-plus]'));
assert('no instance tiles yet', $$('.tile[data-open]').length === 0);

// 2) + opens the dialog on the filterable picker
$('[data-plus]').click();
assert('dialog opened', !$('#dlgOverlay').hidden);
assert('picker shows all widgets', $$('#dlgPickList .pick-row').length === 2);

// 3) typing filters the list (and the input is never rebuilt)
const search = $('#dlgSearch');
search.value = 'controller';
fire(search, 'input');
assert('filter narrows to 1', $$('#dlgPickList .pick-row').length === 1);
assert('filter matched the switch', $('#dlgPickList [data-pick]').dataset.pick === 'switch');
for (const cb of subs.wdefs) cb(DEFS); // defs refresh while the dialog is open
assert('search value survives defs refresh', $('#dlgSearch').value === 'controller');
search.value = 'light';
fire(search, 'input');
assert('"light" finds both', $$('#dlgPickList .pick-row').length === 2);

// 4) picking a widget moves to configuration
$('#dlgPickList [data-pick="bulb"]').click();
assert('chosen summary shown', ($('.dlg-chosen')?.textContent || '').includes('Virtual Bulb'));
assert('name prefilled', $('#af-name').value === 'Virtual Bulb');
assert('pending ctx id shown', ($('#af-ctxinfo-new')?.textContent || '').includes('matching space'));
assert('back button present (create mode)', !!$('[data-back]'));

// v43: contexts are a composable CHECKBOX list — every checked box is one
// presence (multi-context attach).
const matchBox = $('.af-ctx-match');
assert('matching context offered as a checkbox', !!matchBox);
assert('only complementary contexts listed', $$('.af-ctx-match').length === 1);
assert('matched ctx is the provider one', matchBox?.dataset.id === 'Ctx000000000000000001');
assert('row mentions the partner', (matchBox?.parentElement.textContent || '').includes('1 padi.light provider'));

// 4a) v31: with a match on the realm, JOIN is the DEFAULT — and the
// new-context name is never prefilled from the widget title
assert('join is the default when a match exists', matchBox.checked && !$('#af-ctx-new').checked);
assert('ctx name has no widget-title prefill', $('#af-ctxname').value === '');
assert('name row hidden while new unchecked', $('#af-ctxname-row').hidden);
assert('row flags the unbound partner', (matchBox?.parentElement.textContent || '').includes('unbound'));

// 6) checked state survives live keys pushes
for (const cb of subs.keys) cb({ ...KEYS, 'cns/S1/nodes/N1/contexts/Ctx000000000000000001/provider/padi.light/properties/sOut': '1' });
for (const cb of subs.keys) cb({ ...KEYS });
assert('checked state survives keys pushes', $('.af-ctx-match')?.checked === true);

// 7) create
$('#af-create').click();
await new Promise((r) => setTimeout(r, 20));
assert('widgetAdd carries the joined context', window.__added?.contexts?.length === 1 && window.__added.contexts[0].id === 'Ctx000000000000000001');
assert('faceplate opened', window.__opened === 'inst1');
assert('dialog closed after create', $('#dlgOverlay').hidden);

// 7a) v31: a NEW context requires a typed name — no silent default
window.__added = null;
$('[data-plus]').click();
$('#dlgSearch').value = ''; fire($('#dlgSearch'), 'input');
$('#dlgPickList [data-pick="bulb"]').click();
$('.af-ctx-match').checked = false;
$('#af-ctx-new').checked = true;
fire($('#af-ctx-new'), 'change');
assert('new-context name row appears', !$('#af-ctxname-row').hidden);
assert('new-context name starts empty', $('#af-ctxname').value === '');
$('#af-create').click();
await new Promise((r) => setTimeout(r, 20));
assert('empty ctx name blocks create', window.__added === null && !$('#dlgOverlay').hidden);
assert('missing name field flagged', $('#af-ctxname').classList.contains('field-missing'));
$('#af-ctxname').value = 'Kitchen Lights';
fire($('#af-ctxname'), 'input');
assert('typing clears the flag', !$('#af-ctxname').classList.contains('field-missing'));
$('#af-create').click();
await new Promise((r) => setTimeout(r, 20));
assert('typed ctx name creates', window.__added?.contexts?.[0]?.name === 'Kitchen Lights');
assert('dialog closed after named create', $('#dlgOverlay').hidden);

// 7b) v43: MULTI-context create — join the match AND mint a new context
window.__added = null;
$('[data-plus]').click();
$('#dlgSearch').value = ''; fire($('#dlgSearch'), 'input');
$('#dlgPickList [data-pick="bulb"]').click();
assert('match pre-checked again', $('.af-ctx-match').checked);
$('#af-ctx-new').checked = true;
fire($('#af-ctx-new'), 'change');
$('#af-ctxname').value = 'Second Home';
$('#af-create').click();
await new Promise((r) => setTimeout(r, 20));
assert('create carries BOTH contexts (join + new)',
  window.__added?.contexts?.length === 2 &&
  window.__added.contexts[0].id === 'Ctx000000000000000001' &&
  window.__added.contexts[1].name === 'Second Home');
assert('dialog closed after multi create', $('#dlgOverlay').hidden);

// 8) empty-realm open: no join rows with hint, recovers when keys arrive
for (const cb of subs.keys) cb({});
$('[data-plus]').click();
$('#dlgPickList [data-pick="bulb"]').click();
assert('empty keys — no join rows', $$('.af-ctx-match').length === 0);
assert('empty keys — hint visible', !$('#af-join-hint').hidden);
for (const cb of subs.keys) cb(KEYS);
assert('keys arrive — join row appears', $$('.af-ctx-match').length === 1);
assert('keys arrive — hint hidden', $('#af-join-hint').hidden);
$('#dlgClose').click();
assert('close button closes dialog', $('#dlgOverlay').hidden);

// 9) instances render as tiles with live state
const INST = {
  id: 'instA', widgetId: 'bulb', name: 'My Bulb', widgetTitle: 'Virtual Bulb',
  contextId: 'Ctx000000000000000001', contextName: 'Light 1',
  attached: true, connections: 1, state: { power: 'on' },
  peers: [{ connId: 'c1', profile: 'padi.light', system: 'Black Switch', node: 'Switch Node' }],
  perConn: {}, widgetOk: true,
};
for (const cb of subs.winst) cb([INST]);
const tile = $('.tile[data-open="instA"]');
assert('instance tile rendered', !!tile);
assert('tile shows live state', (tile?.textContent || '').includes('power'));
assert('tile shows bound chip', (tile?.textContent || '').includes('bound'));
assert('tile shows peer NODE name', (tile?.textContent || '').includes('Switch Node'));

// 10) tile click opens the faceplate
window.__opened = null;
tile.click();
assert('tile click opens faceplate', window.__opened === 'instA');

// 10a) v31: a zero-connection instance is "awaiting broker" during the grace
// period, then badged "unbound" with a hint naming the missing partner role
{
  const INST0 = { ...INST, id: 'instB', name: 'Lonely', connections: 0, peers: [], contextId: 'CtxLonely', contextName: 'Lonely Ctx' };
  for (const cb of subs.winst) cb([INST, INST0]);
  let tileB = $('.tile[data-open="instB"]');
  assert('grace period shows awaiting broker', (tileB?.textContent || '').includes('awaiting broker'));
  const origNow = window.Date.now.bind(window.Date);
  window.Date.now = () => origNow() + 60000; // fast-forward past the grace
  for (const cb of subs.winst) cb([INST, INST0]);
  tileB = $('.tile[data-open="instB"]');
  assert('stuck instance badged unbound', !!tileB?.querySelector('.chip.bad') && (tileB.textContent || '').includes('unbound'));
  assert('badge hint names the missing partner', (tileB?.querySelector('.chip.bad')?.title || '').includes('provider of padi.light'));
  window.Date.now = origNow;
  for (const cb of subs.winst) cb([INST]); // restore for the sections below
}

// 11) ⋯ menu → Edit: pre-filled, type locked, keep-context save
$('[data-menu="instA"]').click();
assert('menu opened', !!$('[data-menu-panel]'));
$('[data-edit="instA"]').click();
assert('edit dialog opened', !$('#dlgOverlay').hidden);
assert('edit title', $('#dlgTitle').textContent === 'Edit widget');
assert('edit — name prefilled', $('#af-name').value === 'My Bulb');
assert('edit — type locked (no back button)', !$('[data-back]'));
assert('edit — current context listed + checked', !!$('.af-ctx-cur') && $('.af-ctx-cur').checked);
assert('edit — current ctx excluded from join rows', $$('.af-ctx-match').length === 0);
$('#af-name').value = 'Kitchen Bulb';
$('#af-create').click();
await new Promise((r) => setTimeout(r, 20));
assert('widgetUpdate called', !!window.__updated);
assert('update keeps context id', window.__updated?.contexts?.[0]?.id === 'Ctx000000000000000001');
assert('update carries new name', window.__updated?.name === 'Kitchen Bulb');
assert('dialog closed after save', $('#dlgOverlay').hidden);

// 12) remove flow: ⋯ → Remove… → confirm view → Remove
$('[data-menu="instA"]').click();
$('[data-remove="instA"]').click();
assert('confirm view shown', !!$('.tile-menu.confirm'));
assert('confirm names the widget', ($('.tile-menu.confirm')?.textContent || '').includes('My Bulb'));
assert('confirm has cancel + remove', !!$('[data-remove-cancel]') && !!$('[data-remove-yes]'));
$('[data-remove-cancel]').click();
assert('cancel returns to menu', !$('.tile-menu.confirm') && !!$('[data-remove="instA"]'));
$('[data-remove="instA"]').click();
$('[data-remove-yes="instA"]').click();
assert('widgetRemove called', window.__removed === 'instA');

// 12a) header "Remove all…" flow: hidden when empty, armed confirm, cancel, yes
{
  const btn = () => $('#removeAllWrap [data-ra-arm]');
  assert('remove-all button visible with instances', !!btn());
  btn().click();
  assert('remove-all confirm shown', !!$('[data-ra-panel]'));
  assert('confirm counts the widgets', ($('[data-ra-panel] .menu-q')?.textContent || '').includes('1 widget'));
  assert('confirm mentions realm nodes kept', ($('[data-ra-panel] .menu-note')?.textContent || '').includes('left as-is'));
  $('[data-ra-cancel]').click();
  assert('cancel hides the confirm', !$('[data-ra-panel]'));
  btn().click();
  $('[data-ra-yes]').click();
  assert('confirm triggers widgetRemoveAll', window.__removedAll === true);
  for (const cb of subs.winst) cb([]); // main pushes the now-empty list
  assert('empty list hides remove-all', !btn() && $$('.tile[data-open]').length === 0);
  for (const cb of subs.winst) cb([INST]); // restore for the next sections
}

// 12b) the picker filter is remembered across dialog opens (this session)
$('[data-plus]').click();
$('#dlgSearch').value = 'switch';
fire($('#dlgSearch'), 'input');
$('#dlgClose').click();
$('[data-plus]').click();
assert('filter retained on reopen', $('#dlgSearch').value === 'switch');
assert('retained filter pre-applies', $$('#dlgPickList .pick-row').length === 1);
$('#dlgSearch').value = '';
fire($('#dlgSearch'), 'input');
$('#dlgClose').click();

// 13) the "change" system-name link jumps to Config
window.__removed = null;
const chg = $('#changeSystemName');
assert('change link present', !!chg);
chg.click();
assert('change link opens Config', !$('#panel-config') || document.querySelector('#tab-config').classList.contains('active'));

if (window.__errors.length) failures.push('uncaught errors: ' + window.__errors);
if (failures.length) { console.error('\n❌ FAIL —', failures.join('; ')); process.exit(1); }
console.log('\n✅ PASS — tile grid + add/edit dialog + remove/confirm work end-to-end in DOM.');
process.exit(0);
