#!/usr/bin/env node
// scripts/test-compose.js — the Composer's Phase 1 exit test (headless).
//
// The Composer's invariant is "every canvas is a widget YAML document", which
// stands or falls on the ROUND-TRIP: definition file -> canonical re-emit
// (orderDefinition + yaml.dump) -> reparse -> SAME validated model. This
// script proves it for every bundled widget and every widget-library widget
// it can find, against the LIVE cp.padi.io registry, plus synthetic checks:
// the additive meta block, and preservation of unknown rule clauses (a v33
// gate/is/else widget must survive a v32-era Composer untouched).
//
// Run: npm run test:compose   (needs network to cp.padi.io)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { validateDefinition, orderDefinition, PRIMITIVES } from '../core/widget-spec.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let pass = 0;
let fail = 0;
const bad = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; bad.push(name + (detail ? ' — ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

const profileCache = new Map();
async function fetchProfile(name) {
  if (profileCache.has(name)) return profileCache.get(name);
  try {
    const res = await fetch('https://cp.padi.io/profiles/' + encodeURIComponent(name), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    const json = res.ok ? await res.json() : null;
    profileCache.set(name, json);
    return json;
  } catch (e) {
    profileCache.set(name, null);
    return null;
  }
}

async function profilesFor(raw) {
  const out = {};
  for (const c of Array.isArray(raw?.capabilities) ? raw.capabilities : []) {
    const n = c && c.profile;
    if (n && !(n in out)) out[n] = await fetchProfile(n);
  }
  return out;
}

const dump = (raw) => yaml.dump(orderDefinition(raw), { lineWidth: 120, noRefs: true });

async function roundTrip(file) {
  const raw = yaml.load(fs.readFileSync(file, 'utf8'));
  const profiles = await profilesFor(raw);
  const v1 = validateDefinition(raw, profiles);
  const base = path.basename(file);
  if (!v1.ok) {
    check(`${base}: validates`, false, v1.errors[0]);
    return;
  }
  const text1 = dump(raw);
  const raw2 = yaml.load(text1);
  const v2 = validateDefinition(raw2, profiles);
  const same = v2.ok && JSON.stringify(v1.model) === JSON.stringify(v2.model);
  check(`${base}: round-trips to an identical model`, same, v2.ok ? 'model drift' : v2.errors[0]);
  // Canonical form is a fixed point: emitting the reparse changes nothing.
  check(`${base}: canonical YAML is stable`, dump(raw2) === text1);
}

function* yamlFiles(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir).sort(); } catch (_) { return; }
  for (const f of entries) if (/\.ya?ml$/i.test(f)) yield path.join(dir, f);
}

// ---------------------------------------------------------------- run
console.log('— Composer round-trip: bundled widgets —');
for (const f of yamlFiles(path.join(ROOT, 'widgets'))) await roundTrip(f);

const libDir = process.env.WL_DIR || path.join(ROOT, '..', 'widget-library', 'widgets');
if (fs.existsSync(libDir)) {
  console.log('— Composer round-trip: widget-library —');
  for (const f of yamlFiles(libDir)) await roundTrip(f);
} else {
  console.log('(widget-library not found next to the repo — skipping library round-trip)');
}

console.log('— spec additions —');
{
  // meta block: accepted, carried on the model, additive.
  const raw = yaml.load(dump({
    widget: 'local.meta-test',
    title: 'Meta test',
    meta: { author: 'Anto', created: '2026-07-21', composed: true },
    capabilities: [{ profile: 'padi.light', role: 'consumer' }],
    view: [{ type: 'lamp', bind: 'sOut', on: '1' }],
  }));
  const v = validateDefinition(raw, { 'padi.light': await fetchProfile('padi.light') });
  check('meta block accepted', v.ok, v.errors[0]);
  check('meta carried on the model', v.ok && v.model.meta.author === 'Anto' && v.model.meta.composed === true);

  const vBad = validateDefinition({ ...raw, meta: ['nope'] }, { 'padi.light': await fetchProfile('padi.light') });
  check('meta must be a mapping', !vBad.ok);
}
{
  // Unknown rule clauses (gate/is/else — UI v33) survive the round-trip
  // verbatim: the Composer must never destroy clauses it doesn't know.
  const raw = {
    widget: 'local.gate-test',
    title: 'Gate preservation',
    capabilities: [
      { profile: 'padi.light', role: 'consumer' },
      { profile: 'padi.lease.basic', role: 'consumer' },
    ],
    view: [{ type: 'lamp', bind: 'sOut', on: '1' }],
    behavior: {
      rules: [{ when: 'sOut', set: 'cState', aggregate: 'average', gate: 'status', is: 'Approved', else: '0' }],
    },
  };
  const raw2 = yaml.load(dump(raw));
  const r2 = raw2.behavior.rules[0];
  check('gate/is/else preserved through canonical re-emit',
    r2.gate === 'status' && r2.is === 'Approved' && r2.else === '0');
  check('known clause order leads the rule',
    JSON.stringify(Object.keys(r2)) === JSON.stringify(['when', 'set', 'aggregate', 'gate', 'is', 'else']));
  const profiles = {
    'padi.light': await fetchProfile('padi.light'),
    'padi.lease.basic': await fetchProfile('padi.lease.basic'),
  };
  const v = validateDefinition(raw2, profiles);
  check('gate widget still validates under this spec version', v.ok, v.errors[0]);
}
{
  // Canonical key order: widget leads, unknown top-level keys survive at the end.
  const raw = { view: [{ bind: 'sOut', type: 'lamp' }], widget: 'local.order', futureKey: 42, capabilities: [{ role: 'consumer', profile: 'padi.light' }] };
  const o = orderDefinition(raw);
  const keys = Object.keys(o);
  check('top-level canonical order', keys[0] === 'widget' && keys[keys.length - 1] === 'futureKey');
  check('view item canonical order', JSON.stringify(Object.keys(o.view[0])) === JSON.stringify(['type', 'bind']));
  check('capability canonical order', JSON.stringify(Object.keys(o.capabilities[0])) === JSON.stringify(['profile', 'role']));
}
check('PRIMITIVES exported for authoring surfaces', Array.isArray(PRIMITIVES) && PRIMITIVES.length === 12);

console.log(`\n${pass + fail} checks — ${pass} passed, ${fail} failed.`);
if (fail) {
  console.log(bad.map((b) => '  FAILED: ' + b).join('\n'));
  process.exit(1);
}
