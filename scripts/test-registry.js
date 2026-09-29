#!/usr/bin/env node
// test-registry.js — the Widget app's Profile lookup, spec parsing, Composer
// list rules and the running-widget version check, against canon's RECORDED
// answers (registry-fixtures/, recorded 29 Sept 2026) through a fake fetch.
// No network, no realm, no display.
//
// Run: npm run test:registry

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import yaml from 'js-yaml';
import { validateDefinition, parseProfile, whyProfileRefused } from '../core/widget-spec.js';
import { createProfiles, pickability } from '../electron/profiles.js';
import { WidgetManager } from '../electron/widget-manager.js';

const require = createRequire(import.meta.url);
const { fakeRegistry, FIX, parseHeaders } = require('./registry-fixtures/fake-registry.cjs');

let pass = 0;
let fail = 0;
const bad = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; bad.push(name + (detail ? ' — ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

function newProfiles(reg) {
  return createProfiles({ fetch: reg.fetch, retryGap: 0, absentTtl: 0 });
}
// what main.js hands the validator: the contract, or { __unresolved: why }
const lookup = (profiles) => async (name, version) => {
  const got = await profiles.getProfile(name, version);
  return got.ok ? got.profile : { __unresolved: got.kind };
};

const def = (profile, role, view, extra = {}) => ({
  widget: 'probe', title: 'Probe', capabilities: [{ profile, role }], view, ...extra,
});

// ---------------------------------------------------------------- W1
console.log('— W1: padi.light (grandfathered 2022 contract) reads as before —');
{
  const reg = fakeRegistry();
  const P = newProfiles(reg);
  const got = await P.getProfile('padi.light');
  check('padi.light resolves', got.ok && got.profile.version === 1);
  const parsed = parseProfile(got.profile);
  check('sOut: provider writes, propagates', parsed.props.sOut && parsed.props.sOut.writer === 'server' && parsed.props.sOut.propagate === true);
  check('cState: consumer writes', parsed.props.cState && parsed.props.cState.writer === 'client');
  check('required flag survives (mandatory)', parsed.props.sOut.required === true);
  check('role words come from the Header', parsed.roles.provider === 'A Controller' && parsed.roles.consumer === 'A Light being controlled', JSON.stringify(parsed.roles));

  const ok = validateDefinition(def('padi.light', 'consumer', [{ type: 'value', bind: 'sOut' }, { type: 'toggle', bind: 'cState' }]), { 'padi.light': got.profile });
  check('a padi.light consumer definition validates', ok.ok, ok.errors.join('; '));
  check('model capability carries the version', ok.model && ok.model.capabilities[0].version === 1);
  const wrong = validateDefinition(def('padi.light', 'consumer', [{ type: 'toggle', bind: 'sOut' }]), { 'padi.light': got.profile });
  check('a consumer may not write the provider\'s property', !wrong.ok && /written by the provider side/.test(wrong.errors.join(' ')), wrong.errors.join('; '));
}

// ---------------------------------------------------------------- W2
console.log('— W2: padi.lighting (v1 Deprecated, v2 current) validates against v2 —');
{
  const reg = fakeRegistry();
  const P = newProfiles(reg);
  const got = await P.getProfile('padi.lighting');
  check('no version asked → v2, published', got.ok && got.profile.version === 2 && got.profile.status === 'published', JSON.stringify(got.ok ? { v: got.profile.version, s: got.profile.status } : got));
  const ok = validateDefinition(def('padi.lighting', 'consumer', [{ type: 'value', bind: 'level' }, { type: 'value', bind: 'actual' }]), { 'padi.lighting': got.profile });
  check('definition validates', ok.ok, ok.errors.join('; '));
  check('the model records v2', ok.model && ok.model.capabilities[0].version === 2);
  check('the consumer writes actual, not level', ok.model && ok.model.writable.includes('actual') && !ok.model.writable.includes('level'), JSON.stringify(ok.model && ok.model.writable));
  const wrong = validateDefinition(def('padi.lighting', 'consumer', [{ type: 'toggle', bind: 'level' }]), { 'padi.lighting': got.profile });
  check('a consumer write to level is refused', !wrong.ok, wrong.errors.join('; '));
  const v1 = await P.getProfile('padi.lighting', 1);
  check('a pinned v1 answers as Deprecated', v1.ok && v1.profile.version === 1 && v1.profile.status === 'deprecated');
  check('the surface was asked, and the contract by exact version', reg.log.some((r) => r.path === '/padi.lighting:2'));
}

// ---------------------------------------------------------------- W3/W4 lookups
console.log('— W4: v3 published later; a widget running at v2 keeps v2 —');
{
  const reg = fakeRegistry();
  const surface = JSON.parse(fs.readFileSync(path.join(FIX, 'padi.lighting.body'), 'utf8'));
  surface.versions.push({ ...surface.versions[1], version: 3, href: '/padi.lighting:3', content_hash: 'v3hash' });
  const v2doc = JSON.parse(fs.readFileSync(path.join(FIX, 'padi.lighting_2.body'), 'utf8'));
  const v3doc = JSON.parse(JSON.stringify(v2doc));
  v3doc.Header.Version = '3';
  v3doc.Properties.Provider.push({ Name: 'dim', Mandatory: 'no', Propagate: 'yes', Description: 'A property v2 does not have.' });
  const h = (f) => Object.fromEntries(parseHeaders(fs.readFileSync(path.join(FIX, f), 'utf8')).headers);
  reg.overrides.set('padi.lighting', { body: JSON.stringify(surface), headers: h('padi.lighting.headers') });
  reg.overrides.set('padi.lighting:3', { body: JSON.stringify(v3doc), headers: { ...h('padi.lighting_2.headers'), etag: '"v3hash-spec2026"' } });
  const P = newProfiles(reg);

  const cur = await P.getProfile('padi.lighting');
  check('a new definition sees v3', cur.ok && cur.profile.version === 3 && !!cur.profile.properties.dim, JSON.stringify(cur.ok ? cur.profile.version : cur));
  const pinned = await P.getProfile('padi.lighting', 2);
  check('the recorded v2 still answers v2 (no "dim")', pinned.ok && pinned.profile.version === 2 && !pinned.profile.properties.dim);

  const d = def('padi.lighting', 'provider', [{ type: 'value', bind: 'level' }, { type: 'value', bind: 'dim' }]);
  const onV3 = validateDefinition(d, { 'padi.lighting': cur.profile });
  const onV2 = validateDefinition(d, { 'padi.lighting': pinned.profile });
  check('the definition validates against v3', onV3.ok, onV3.errors.join('; '));
  check('…and does not validate against v2 (nothing merged in from v3)', !onV2.ok && /dim/.test(onV2.errors.join(' ')), onV2.errors.join('; '));

  // ---- W3: the manager re-checks a running widget at the version the realm recorded
  console.log('— W3: a running widget is checked against the version the realm recorded —');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arete-widget-registry-'));
  const bundled = path.join(tmp, 'bundled'); fs.mkdirSync(bundled);
  fs.writeFileSync(path.join(bundled, 'probe.yaml'), yaml.dump({
    widget: 'probe', title: 'Probe',
    capabilities: [{ profile: 'padi.lighting', role: 'provider' }],
    view: [{ type: 'value', bind: 'level' }],
  }));
  const logs = [];
  async function attachWith(recordedVersion) {
    const dataDir = path.join(tmp, 'data-' + recordedVersion); fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'instances.json'), JSON.stringify([{ id: 'i1', widgetId: 'probe', name: 'Probe 1', nodeId: 'N1', contexts: [{ id: 'C1', name: 'Ctx' }], initDone: true }]));
    const keys = { [`cns/SYS/nodes/N1/contexts/C1/provider/padi.lighting/version`]: String(recordedVersion) };
    const service = {
      getKeys: () => keys,
      instantiate: async () => ({ systemId: 'SYS', caps: {}, capsByCtx: {} }),
    };
    const m = new WidgetManager({ service, dataDir, bundledDir: bundled, libraryUrl: '', fetchProfile: lookup(P) });
    m.on('log', (e) => logs.push(e.message));
    logs.length = 0;
    await m.loadDefinitions(false);
    await m.attachAll();
    return m;
  }
  await attachWith(3);
  check('recorded v3 = validated v3: the loaded model stands', !logs.some((l) => /recorded/.test(l)), logs.join(' | '));
  await attachWith(2);
  check('recorded v2 ≠ validated v3: re-checked against v2', logs.some((l) => /padi\.lighting:2/.test(l)), logs.join(' | '));
}

// ---------------------------------------------------------------- staleness
console.log('— a version published while the tool is open —');
{
  const mk = () => {
    const reg = fakeRegistry();
    const surface = JSON.parse(fs.readFileSync(path.join(FIX, 'padi.lighting.body'), 'utf8'));
    const v2doc = JSON.parse(fs.readFileSync(path.join(FIX, 'padi.lighting_2.body'), 'utf8'));
    const h = (f) => Object.fromEntries(parseHeaders(fs.readFileSync(path.join(FIX, f), 'utf8')).headers);
    const publishV3 = () => {
      const s3 = JSON.parse(JSON.stringify(surface));
      s3.versions.push({ ...s3.versions[1], version: 3, href: '/padi.lighting:3', content_hash: 'v3hash' });
      const d3 = JSON.parse(JSON.stringify(v2doc)); d3.Header.Version = '3';
      reg.overrides.set('padi.lighting', { body: JSON.stringify(s3), headers: h('padi.lighting.headers') });
      reg.overrides.set('padi.lighting:3', { body: JSON.stringify(d3), headers: { ...h('padi.lighting_2.headers'), etag: '"v3hash-spec2026"' } });
    };
    return { reg, publishV3 };
  };
  const a = mk();
  const P0 = createProfiles({ fetch: a.reg.fetch, retryGap: 0, absentTtl: 0, staleAfter: 0 });
  check('before: current is v2', (await P0.getProfile('padi.lighting')).profile.version === 2);
  a.publishV3();
  check('stale (staleAfter 0): a new definition sees v3 at once', (await P0.getProfile('padi.lighting')).profile.version === 3);
  const b = mk();
  const P1 = createProfiles({ fetch: b.reg.fetch, retryGap: 0, absentTtl: 0 });
  await P1.getProfile('padi.lighting');
  b.publishV3();
  const before = b.reg.log.length;
  const again = await P1.getProfile('padi.lighting');
  check('fresh (within 30 s): no extra round trip, still v2', again.profile.version === 2 && b.reg.log.length === before);
  check('a pinned version is never re-asked (a published contract never changes)', (await P1.getProfile('padi.lighting', 2)).profile.version === 2 && b.reg.log.length === before);
}

// ---------------------------------------------------------------- refusals
console.log('— the five kinds of "no", in words —');
{
  const reg = fakeRegistry();
  const P = newProfiles(reg);
  const kinds = {};
  for (const n of ['padi.no.such.name.xyz', 'padi.appliance', 'padi.test.claude-demo']) kinds[n] = await P.getProfile(n);
  check('unregistered → not registered', !kinds['padi.no.such.name.xyz'].ok && kinds['padi.no.such.name.xyz'].kind === 'not registered');
  check('registered, nothing published → nothing published', kinds['padi.appliance'].kind === 'nothing published', kinds['padi.appliance'].kind);
  check('only Deprecated versions → deprecated', kinds['padi.test.claude-demo'].kind === 'deprecated', kinds['padi.test.claude-demo'].kind);
  const wordsOf = (n) => whyProfileRefused(n, { __unresolved: kinds[n].kind });
  check('validator words: not registered', /NOT in the CP registry \(cp\.cnscp\.io\/padi\.no\.such\.name\.xyz\)/.test(wordsOf('padi.no.such.name.xyz')));
  check('validator words: nothing published', /no published version/.test(wordsOf('padi.appliance')));
  check('validator words: deprecated', /only Deprecated/.test(wordsOf('padi.test.claude-demo')));
  const v = validateDefinition(def('padi.appliance', 'consumer', [{ type: 'label', bind: 'x' }]), { 'padi.appliance': { __unresolved: 'nothing published' } });
  check('a definition on it is refused, with the reason', !v.ok && /no published version/.test(v.errors[0]), v.errors[0]);
}

// ---------------------------------------------------------------- W7
console.log('— W7: registry unavailable is never remembered —');
{
  const reg = fakeRegistry();
  const P = newProfiles(reg);
  reg.offline = true;
  const a = await P.getProfile('padi.light');
  check('offline → registry unavailable', !a.ok && a.kind === 'registry unavailable', JSON.stringify(a));
  const list = await P.listProfiles();
  check('the list, offline → not ok, with a reason', !list.ok && !!list.error);
  check('validator words say unreachable', /unreachable/.test(whyProfileRefused('padi.light', { __unresolved: a.kind })));
  reg.offline = false;
  const b = await P.getProfile('padi.light');
  check('back online → the same name resolves, no restart', b.ok);
  const list2 = await P.listProfiles();
  check('the list recovers too', list2.ok && Array.isArray(list2.entries));
}

// ---------------------------------------------------------------- W5 / W6
console.log('— W5/W6: the Composer list —');
{
  const reg = fakeRegistry();
  const P = newProfiles(reg);
  const list = await P.listProfiles();
  check('the list is read through the paged /profiles', reg.log.some((r) => /^\/profiles\?/.test(r.path) && /limit=/.test(r.path)), reg.log.map((r) => r.path).join(' '));
  const light = (list.entries || []).find((e) => e.name === 'padi.light');
  const lighting = (list.entries || []).find((e) => e.name === 'padi.lighting');
  check('list entries are summaries: versions with status, no properties', !!(light && light.versions[0].status && !('properties' in light)));
  check('padi.lighting: pickable, current v2 (v1 is Deprecated)', pickability(lighting).pickable && pickability(lighting).current === 2);
  const demo = JSON.parse(fs.readFileSync(path.join(FIX, 'padi.test.claude-demo.body'), 'utf8'));
  const appliance = JSON.parse(fs.readFileSync(path.join(FIX, 'padi.appliance.body'), 'utf8'));
  const pd = pickability(demo);
  const pa = pickability(appliance);
  check('only-Deprecated: shown, not offered', !pd.pickable && pd.why === 'deprecated');
  check('nothing published: shown, not offered', !pa.pickable && pa.why === 'nothing published');
  check('all 73 registered names come back', list.entries.length === 73, String(list.entries.length));

  // paging: a registry that serves 25 at a time → every page is read, none twice
  const all = JSON.parse(fs.readFileSync(path.join(FIX, 'profiles_limit_100_offset_0.body'), 'utf8'));
  const paged = fakeRegistry();
  const asked = [];
  const pagedFetch = (url, init) => {
    const u = new URL(url);
    if (u.pathname !== '/profiles') return paged.fetch(url, init);
    const limit = Math.min(25, Number(u.searchParams.get('limit') || 25));
    const offset = Number(u.searchParams.get('offset') || 0);
    asked.push(offset);
    const entries = all.entries.slice(offset, offset + limit);
    const body = JSON.stringify({ query: { limit, offset }, total: all.total, count: entries.length, entries, next: offset + limit < all.total ? '/profiles?offset=' + (offset + limit) : null });
    return Promise.resolve({ status: 200, headers: { get: (k) => ({ 'content-type': 'application/cp+json; profile="2026"' })[k.toLowerCase()] || null }, text: () => Promise.resolve(body) });
  };
  const P2 = createProfiles({ fetch: pagedFetch, retryGap: 0, absentTtl: 0 });
  const pg = await P2.listProfiles(25);
  check('paged list: every page read (offsets ' + asked.join(',') + ')', pg.ok && pg.entries.length === 73 && asked.join(',') === '0,25,50', asked.join(','));
  check('paged list: no name twice', new Set(pg.entries.map((e) => e.name)).size === 73);

  const before = reg.log.length;
  await P.getProfile('padi.light');
  check('a Profile\'s contract is fetched when picked, not in the list', reg.log.slice(before).some((r) => /^\/padi\.light/.test(r.path)));
}

console.log(`\n${pass + fail} checks — ${pass} passed, ${fail} failed.`);
if (fail) { console.log(bad.map((b) => '  FAILED: ' + b).join('\n')); process.exit(1); }
process.exit(0);
