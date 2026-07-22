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

// drop a lamp from the palette — should auto-bind to the first readable prop
const lampBtn = [...$('cmpPalette').querySelectorAll('button')].find((b) => b.textContent === 'lamp');
lampBtn.click();
await sleep(600);
check('lamp lands on the canvas stack', [...$('cmpViewList').querySelectorAll('.cmp-vrow .t')].some((t) => t.textContent === 'lamp'));
check('still a valid widget after the drop', $('cmpStatus').classList.contains('ok'));
check('inspector shows the lamp fields', $('cmpInspector').textContent.includes('lamp'));

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
ruleAdd.click();
await sleep(600);
check('a rule card appears', $('cmpRules').querySelectorAll('.cmp-rule-edit').length === rulesBefore + 1);
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
  liveBtn.click();
  await sleep(300);
  check('go-live sends the draft with canvas identity', window.__goLive.length === 1 && !!window.__goLive[0].nodeId && !!window.__goLive[0].contextId);
  const ids1 = { n: window.__goLive[0].nodeId, c: window.__goLive[0].contextId };
  liveBtn.click(); // back to draft
  await sleep(200);
  check('back-to-draft stops the live run', (window.__liveStops || 0) >= 1);
  liveBtn.click(); // live again
  await sleep(300);
  check('SAME canvas identity on every go-live (no re-mint)', window.__goLive.length === 2 && window.__goLive[1].nodeId === ids1.n && window.__goLive[1].contextId === ids1.c);
  check('second go-live never repeats init', window.__goLive[0].applyInit === true ? window.__goLive[1].applyInit === false : window.__goLive[1].applyInit === false);
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
