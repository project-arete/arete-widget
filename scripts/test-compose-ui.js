#!/usr/bin/env node
// scripts/test-compose-ui.js — drive the REAL renderer/compose.js in jsdom
// with a stubbed window.arete whose compose calls run the REAL core
// (widget-spec + behavior engine + js-yaml), against the live cp.padi.io
// profile for padi.light. Companion to test-compose.js: that one proves the
// data invariant; this one proves the Compose tab actually drives it.
//
// Run: npm run test:compose-ui

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { validateDefinition, parseProfile, orderDefinition } from '../core/widget-spec.js';
import { computeActions } from '../core/behavior-engine.js';

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch (_) {
  console.log('jsdom not installed — skipping Compose UI test.');
  process.exit(0);
}

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(ROOT + '/renderer/index.html', 'utf8');
const composejs = fs.readFileSync(ROOT + '/renderer/compose.js', 'utf8');

// ---- live profile (single fetch; the composer stub serves it from cache) ----
async function fetchProfile(name) {
  try {
    const res = await fetch('https://cp.padi.io/profiles/' + encodeURIComponent(name), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    return res.ok ? await res.json() : null;
  } catch (_) {
    return null;
  }
}
const PROFILES = { 'padi.light': await fetchProfile('padi.light') };
if (!PROFILES['padi.light']) {
  console.log('cp.padi.io unreachable — skipping Compose UI test (needs the live registry).');
  process.exit(0);
}

// live registry index, slimmed the way main.js serves it to the picker
async function fetchIndex() {
  try {
    const res = await fetch('https://cp.padi.io/profiles', { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    const list = res.ok ? await res.json() : null;
    if (!Array.isArray(list)) return null;
    for (const p of list) if (p && p.name) PROFILES[p.name] = p;
    return list.map((p) => {
      const parsed = parseProfile(p);
      return { name: p.name, title: p.title || '', comment: p.comment || '', company: p.company || '', modified: p.modified || '', roles: parsed ? parsed.roles : { provider: '', consumer: '' }, props: parsed ? parsed.props : null };
    }).filter((p) => p.name);
  } catch (_) {
    return null;
  }
}
const INDEX = await fetchIndex();
if (!INDEX) {
  console.log('cp.padi.io index unreachable — skipping Compose UI test.');
  process.exit(0);
}

const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://localhost/index.html' });
const { window } = dom;
const { document } = window;

// ---- stub window.arete: compose calls run the REAL core ----
const saved = [];
async function profilesFor(raw) {
  const out = {};
  for (const c of Array.isArray(raw?.capabilities) ? raw.capabilities : []) {
    if (c && c.profile && !(c.profile in out)) {
      out[c.profile] = PROFILES[c.profile] !== undefined ? PROFILES[c.profile] : await fetchProfile(c.profile);
      PROFILES[c.profile] = out[c.profile];
    }
  }
  return out;
}
window.arete = {
  widgetDefs: async () => [
    { id: 'bulb', source: 'library', title: 'Virtual Bulb' },
    { id: 'local.mine', source: 'local', title: 'Mine' },
  ],
  composeCheck: async (draft) => {
    let raw = draft;
    if (typeof draft === 'string') {
      try { raw = yaml.load(draft); } catch (e) { return { ok: false, errors: ['YAML parse error: ' + e.message], model: null, raw: null, yaml: '', caps: [] }; }
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['Definition is not a mapping.'], model: null, raw: null, yaml: '', caps: [] };
    const profiles = await profilesFor(raw);
    const res = validateDefinition(raw, profiles);
    const caps = (Array.isArray(raw.capabilities) ? raw.capabilities : []).map((c) => {
      const parsed = parseProfile(profiles[c && c.profile]);
      return { profile: c && c.profile, role: c && c.role, ok: !!parsed, title: parsed ? parsed.title : '', roles: parsed ? parsed.roles : { provider: '', consumer: '' }, props: parsed ? parsed.props : {} };
    });
    return { ok: res.ok, errors: res.errors, model: res.model, raw, yaml: yaml.dump(orderDefinition(raw), { lineWidth: 120, noRefs: true }), caps };
  },
  composeSimulate: async ({ model, state }) => {
    const s = { ...(state || {}) };
    for (let i = 0; i < 8; i++) {
      const actions = computeActions(model, s, {}, {});
      if (!actions.length) break;
      for (const a of actions) s[a.property] = String(a.value);
    }
    return { state: s, fired: [] };
  },
  composeSaveLocal: async ({ yamlText }) => { saved.push(yamlText); return { ok: true, errors: [], file: 'x.yaml' }; },
  composeReadDef: async (id) => (id === 'bulb'
    ? { id, source: 'library', text: fs.readFileSync(path.join(ROOT, 'widgets', 'bulb.yaml'), 'utf8') }
    : null),
  composeFaceplateHtml: async () => fs.readFileSync(ROOT + '/renderer/faceplate.html', 'utf8'),
  composeProfileIndex: async () => ({ ok: true, profiles: INDEX }),
  composeGoLive: async (spec) => { window.__goLive.push(spec); return { ok: true, systemId: 'SYS', nodeId: spec.nodeId, contextId: spec.contextId }; },
  composeLiveAction: async (a) => window.__liveActions.push(a),
  composeLiveStop: async () => { window.__liveStops = (window.__liveStops || 0) + 1; },
  onComposeLive: (cb) => { window.__liveCb = cb; return () => {}; },
};
window.__goLive = [];
window.__liveActions = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => document.getElementById(id);
let pass = 0;
let fail = 0;
function check(name, ok) {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}`);
  ok ? pass++ : fail++;
}

// app.js global (same window in the real app): smart-match context join.
// One realm context with a complementary (provider) padi.light capability.
window.contextsMatching = () => [
  { id: 'ctxJOIN', name: 'Landlord hall', partnersText: '1 padi.light provider, 1 unbound', waiting: 1, declarations: 2, roles: { 'provider|padi.light': 1 }, also: [] },
];

// ---- boot the real compose.js ----
window.eval(composejs);
await sleep(600); // initial debounce + check

check('palette renders all 12 primitives', $('cmpPalette').querySelectorAll('button').length === 12);
check('a default draft exists in the picker', $('cmpDraftSel').options.length >= 1);
check('empty-capability draft reports issues', $('cmpStatus').classList.contains('bad'));

// add a capability THROUGH THE REGISTRY PICKER (Phase 2)
$('cmpCapAdd').click();
await sleep(300);
check('picker opens with the registry index', !!$('cmpPkSearch') && $('cmpPkList').querySelectorAll('.cmp-pk-row').length >= 40);
const search = $('cmpPkSearch');
search.value = 'padi.light';
search.dispatchEvent(new window.Event('input', { bubbles: true }));
await sleep(150);
const rows0 = $('cmpPkList').querySelectorAll('.cmp-pk-row');
check('search narrows to padi.light', rows0.length === 1 && rows0[0].textContent.includes('padi.light'));
rows0[0].dispatchEvent(new window.Event('click', { bubbles: true }));
await sleep(150);
const prev = $('cmpCaps').querySelector('.cmp-pk-prev');
check('preview asks for the role FIRST (no property table yet)', !!prev && !prev.textContent.includes('sOut'));
check('role buttons carry the CP use-case descriptions', prev.textContent.includes('A Light being controlled') && prev.textContent.includes('A Controller'));
const addBtn = [...$('cmpCaps').querySelectorAll('.cmp-pk-add button')].find((b) => b.textContent.startsWith('Add as consumer'));
addBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
await sleep(600);
const capBox = $('cmpCaps').querySelector('.cmp-cap');
check('capability row appears from the picker', !!capBox && capBox.querySelector('input').value === 'padi.light');
check('draft becomes VALID with padi.light consumer', $('cmpStatus').classList.contains('ok'));
check('registry props table lists sOut', $('cmpCaps').textContent.includes('sOut'));
check('card shows role-resolved writable / read only (no propagate flag)',
  $('cmpCaps').textContent.includes('writable') && $('cmpCaps').textContent.includes('read only') && !$('cmpCaps').textContent.includes('propagate'));

// ---- connection graph (UI v50): potential wiring in draft mode ----
{
  const g = $('cmpGraph');
  check('wiring graph rendered under the preview', !!g && g.querySelectorAll('.gc').length === 1 && g.textContent.includes('padi.light'));
  check('graph shows the smart-match candidate context (dashed)',
    g.querySelectorAll('.gx.cand').length === 1 && g.textContent.includes('Landlord hall'));
  check('draft candidate edge is dashed (maybe), none bound yet',
    g.querySelectorAll('.ge.maybe').length === 1 && g.querySelectorAll('.ge.bound').length === 0);
  check('graph note explains draft mode', $('cmpGraphNote').textContent.includes('potential'));
}

// drop a lamp from the palette — should auto-bind to the first readable prop
const lampBtn = [...$('cmpPalette').querySelectorAll('button')].find((b) => b.textContent === 'lamp');
lampBtn.click();
await sleep(600);
check('lamp lands on the canvas stack', [...$('cmpViewList').querySelectorAll('.cmp-vrow .t')].some((t) => t.textContent === 'lamp'));
check('still a valid widget after the drop', $('cmpStatus').classList.contains('ok'));
check('inspector shows the lamp fields', $('cmpInspector').textContent.includes('lamp'));

// the re-render rule (UI v42): the debounced refresh must NOT rebuild the
// panel being typed in — that replaced the focused input mid-word.
{
  const cap = $('cmpInspector').querySelector('[data-f="caption"]');
  cap.focus();
  cap.value = 'My la';
  cap.dispatchEvent(new window.Event('input', { bubbles: true }));
  await sleep(600); // debounce + refresh land while still focused
  const cap2 = $('cmpInspector').querySelector('[data-f="caption"]');
  check('typing in the inspector keeps focus through the refresh',
    document.activeElement === cap && cap2 === cap && cap.value === 'My la');
  cap.blur();
  await sleep(50);
}

check('lamp inspector has NO read-only checkbox (already display-only)', !$('cmpInspector').querySelector('[data-f="readonly"]'));

// drop a toggle — interactive, so the read-only override applies (UI v40)
const togBtn = [...$('cmpPalette').querySelectorAll('button')].find((b) => b.textContent === 'toggle');
togBtn.click();
await sleep(600);
const roBox = $('cmpInspector').querySelector('[data-f="readonly"]');
check('toggle inspector offers the read-only checkbox', !!roBox);
roBox.checked = true;
roBox.dispatchEvent(new window.Event('input', { bubbles: true }));
await sleep(600);
check('read-only toggle lands in the YAML', $('cmpYaml').value.includes('readonly: true'));
check('read-only toggle draft stays valid', $('cmpStatus').classList.contains('ok'));
// clean up: remove the toggle so the rest of the walkthrough sees the original canvas
[...$('cmpViewList').querySelectorAll('.cmp-vrow')].filter((r) => r.querySelector('.t')?.textContent === 'toggle')
  .forEach((r) => r.querySelector('[data-a="rm"]')?.click());
await sleep(600);

// YAML is the same document
const yamlText = $('cmpYaml').value;
check('YAML panel carries the canvas (widget/capability/lamp)',
  yamlText.includes('widget:') && yamlText.includes('padi.light') && yamlText.includes('type: lamp'));

// preview iframe got the real faceplate + injected bridge
check('preview srcdoc is faceplate.html with the bridge injected',
  String($('cmpPreview').srcdoc || '').includes('compose-fp-bridge.js'));

// id collision: library id blocks, local id warns
const idInput = $('cmpFid');
idInput.value = 'bulb';
idInput.dispatchEvent(new window.Event('input', { bubbles: true }));
await sleep(600);
check('library id collision blocks (error note)', ($('cmpIdNote') || {}).innerHTML?.includes('cmp-err'));
idInput.value = 'local.mine';
idInput.dispatchEvent(new window.Event('input', { bubbles: true }));
await sleep(600);
check('local id collision warns (overwrite note)', ($('cmpIdNote') || {}).innerHTML?.includes('cmp-warn'));
idInput.value = 'local.smoke';
idInput.dispatchEvent(new window.Event('input', { bubbles: true }));
await sleep(600);

// apply YAML edits: retitle via the YAML panel — canvas follows
const edited = $('cmpYaml').value.replace(/title: .*/, 'title: Retitled by YAML');
$('cmpYaml').value = edited;
$('cmpYamlApply').click();
await sleep(600);
check('YAML apply retitles the draft', $('cmpFtitle').value === 'Retitled by YAML');

// reorder + remove keep the document consistent
const rows = $('cmpViewList').querySelectorAll('.cmp-vrow');
check('view list has label + lamp rows', rows.length === 2);
rows[1].querySelector('[data-a="up"]').click();
await sleep(500);
check('reorder moves lamp first',
  $('cmpViewList').querySelector('.cmp-vrow .t').textContent === 'lamp');

// save as local widget goes through main's gate
$('cmpSave').click();
await sleep(400);
check('save-as-widget hands canonical YAML to main', saved.length === 1 && saved[0].includes('local.smoke'));

// open an existing widget onto the canvas
$('cmpOpenDef').click();
await sleep(100);
const openSel = document.querySelector('.cmp-opensel');
check('open-widget picker appears with sources', !!openSel && openSel.querySelectorAll('optgroup').length >= 1);
openSel.value = 'bulb';
openSel.dispatchEvent(new window.Event('change', { bubbles: true }));
await sleep(700);
check('bulb.yaml lands on the canvas as a new draft',
  $('cmpFid').value === 'bulb' && [...$('cmpViewList').querySelectorAll('.cmp-vrow .t')].some((t) => t.textContent === 'lamp'));
check('imported draft is valid', $('cmpStatus').classList.contains('ok'));

// ---- rule builder (Phase 3a) — driven on the CURRENT draft (bulb import) ----
document.querySelector('#cmpRight details:nth-of-type(4)').open = true;
const ruleAdd = $('cmpRuleAdd');
check('rule builder offers + Add rule', !!ruleAdd && !ruleAdd.disabled);
const rulesBefore = (window.eval('(' + JSON.stringify(null) + ')'), $('cmpRules').querySelectorAll('.cmp-rule-edit').length);
// Real Chromium FOCUSES a clicked button — the IBB-call bug: the focus guard
// then swallowed the re-render and the panel looked dead. Reproduce that.
ruleAdd.focus();
ruleAdd.click();
await sleep(600);
check('a rule card appears EVEN when the click focused the button', $('cmpRules').querySelectorAll('.cmp-rule-edit').length === rulesBefore + 1);
const initAdd = [...$('cmpRules').querySelectorAll('button')].find((b) => b.textContent === '+ init value');
initAdd.focus();
initAdd.click();
await sleep(600);
check('+ init value works under click-focus too', !!$('cmpRules').querySelector('.cmp-initrow'));
$('cmpRules').querySelector('.cmp-initrow button.danger').click();
await sleep(400);
const card = [...$('cmpRules').querySelectorAll('.cmp-rule-edit')].pop();
const aggSel = card.querySelector('[data-f="aggregate"]');
aggSel.value = 'average';
aggSel.dispatchEvent(new window.Event('change', { bubbles: true }));
await sleep(600);
check('aggregate lands in the YAML', $('cmpYaml').value.includes('aggregate: average'));
const card2 = [...$('cmpRules').querySelectorAll('.cmp-rule-edit')].pop();
const gateSel = card2.querySelector('[data-f="gate"]');
check('gate picker excludes the rule\'s own set property', ![...gateSel.options].some((o) => o.value === card2.querySelector('[data-f="set"]').value));
gateSel.value = [...gateSel.options].map((o) => o.value).find((v) => v && v !== '');
gateSel.dispatchEvent(new window.Event('change', { bubbles: true }));
await sleep(400);
const card3 = [...$('cmpRules').querySelectorAll('.cmp-rule-edit')].pop();
const isInp = card3.querySelector('[data-f="is"]');
check('choosing a gate reveals is/else fields', !!isInp && !!card3.querySelector('[data-f="else"]'));
isInp.value = 'Approved';
isInp.dispatchEvent(new window.Event('input', { bubbles: true }));
isInp.blur && isInp.blur();
await sleep(600);
check('gate clause lands in the YAML', /gate: /.test($('cmpYaml').value) && $('cmpYaml').value.includes('is: Approved'));

// ---- go-live (Phase 3b) — stable identity + stop-on-edit ----
const liveBtn = $('cmpLiveBtn');
check('Go live button present', !!liveBtn && !liveBtn.hidden);
await sleep(600); // let validation settle
if ($('cmpStatus').classList.contains('ok')) {
  // UI v49: Go live asks WHERE with CHECKBOXES (same as the install dialog) —
  // join several matching contexts and/or the canvas's own, any combination.
  liveBtn.click();
  await sleep(200);
  const pick1 = $('cmpLivePick');
  check('go-live opens the context chooser', !!pick1 && window.__goLive.length === 0);
  const joinBox = pick1.querySelector('.cmp-lp-box[data-id="ctxJOIN"]');
  check('matching context offered as a checkbox, preselected', !!joinBox && joinBox.checked);
  check('canvas-own context offered as a checkbox, unchecked (a match exists)',
    !!pick1.querySelector('#cmpLpCanvas') && !pick1.querySelector('#cmpLpCanvas').checked);
  pick1.querySelector('#cmpLpCanvas').checked = true; // BOTH: join AND canvas
  $('cmpLpGo').click();
  await sleep(300);
  check('go-live carries BOTH contexts (join + canvas) with the canvas nodeId',
    window.__goLive.length === 1 && window.__goLive[0].contexts?.length === 2 &&
    window.__goLive[0].contexts[0].id === 'ctxJOIN' && window.__goLive[0].contexts[0].name === 'Landlord hall' &&
    window.__goLive[0].contexts[1].id && window.__goLive[0].contexts[1].id !== 'ctxJOIN' &&
    !!window.__goLive[0].nodeId);
  check('legacy single-context fields mirror contexts[0]', window.__goLive[0].contextId === 'ctxJOIN');
  const ids1 = { n: window.__goLive[0].nodeId, canvasCtx: window.__goLive[0].contexts[1].id };
  liveBtn.click(); // back to draft
  await sleep(200);
  check('back-to-draft stops the live run', (window.__liveStops || 0) >= 1);
  liveBtn.click(); // live again — chooser remembers the combination
  await sleep(200);
  const pick2 = $('cmpLivePick');
  check('chooser reopens with the previous combination preselected',
    !!pick2 && pick2.querySelector('.cmp-lp-box[data-id="ctxJOIN"]').checked && pick2.querySelector('#cmpLpCanvas').checked);
  pick2.querySelector('.cmp-lp-box[data-id="ctxJOIN"]').checked = false; // this time: canvas only
  $('cmpLpGo').click();
  await sleep(300);
  check('canvas-only go-live keeps the SAME canvas identity (no re-mint)',
    window.__goLive.length === 2 && window.__goLive[1].nodeId === ids1.n &&
    window.__goLive[1].contexts?.length === 1 && window.__goLive[1].contexts[0].id === ids1.canvasCtx);
  check('second go-live never repeats init', window.__goLive[0].applyInit === true && window.__goLive[1].applyInit === false);

  // ---- connection graph, LIVE mode: real wiring + traffic flash ----
  check('live graph shows the joined context, awaiting broker',
    $('cmpGraph').textContent.includes('awaiting broker') && $('cmpGraphNote').textContent.includes('live wiring'));
  window.__liveCb({
    state: { sOut: '1' }, connections: 1,
    peers: [{ connId: 'cc1', profile: 'padi.light', ctxId: ids1.canvasCtx, context: 'Edited while live', system: 'S', node: 'Switchy' }],
    perConn: { cc1: { sOut: '1' } },
  });
  await sleep(50);
  const liveEdge = document.getElementById(`ge-padi.light-${ids1.canvasCtx}`);
  check('a broker binding turns the edge SOLID (bound) and names the peer',
    !!liveEdge && liveEdge.classList.contains('bound') && $('cmpGraph').textContent.includes('Switchy'));
  check('traffic flashes the edge', liveEdge.classList.contains('on'));
  await sleep(600);
  check('flash decays', !document.getElementById(`ge-padi.light-${ids1.canvasCtx}`)?.classList.contains('on') );
  const stopsBefore = window.__liveStops || 0;
  const t = $('cmpFtitle');
  t.value = 'Edited while live';
  t.dispatchEvent(new window.Event('input', { bubbles: true }));
  await sleep(200);
  check('editing while live drops back to draft', (window.__liveStops || 0) > stopsBefore);
} else {
  check('go-live flow (draft valid)', false);
}

console.log(`\n${pass + fail} checks — ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
