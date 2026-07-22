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
      return { profile: c && c.profile, role: c && c.role, ok: !!parsed, title: parsed ? parsed.title : '', props: parsed ? parsed.props : {} };
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
};

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

// add a capability: padi.light consumer
$('cmpCaps').querySelector('button.ghost:last-child, button.ghost').click(); // "+ Add capability" is the only ghost when list empty
await sleep(450);
const capBox = $('cmpCaps').querySelector('.cmp-cap');
check('capability row appears', !!capBox);
const capInput = capBox.querySelector('input');
capInput.value = 'padi.light';
capInput.dispatchEvent(new window.Event('change', { bubbles: true }));
await sleep(600);
check('draft becomes VALID with padi.light consumer', $('cmpStatus').classList.contains('ok'));
check('registry props table lists sOut', $('cmpCaps').textContent.includes('sOut'));

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

console.log(`\n${pass + fail} checks — ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
