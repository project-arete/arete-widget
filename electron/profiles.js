// profiles.js — the Widget app's Profile lookup, in the main process.
// Copyright 2026 Padi, Inc. All Rights Reserved.
//
// One place that reads the CP Registry (cp.cnscp.io, through cp-resolver).
//
//   getProfile(name, version)  ->  { ok: true, profile }  the contract, tool shape
//                                  { ok: false, kind }    'not registered' | 'nothing published' |
//                                                         'no such version' | 'deprecated' |
//                                                         'registry unavailable'
//   listProfiles()             ->  { ok, entries, error? } every registered name, paged, summaries only
//
// With no version, the version cns-cli would pick at Declare is used (the
// highest published, non-Deprecated one). With a version (the one the realm
// recorded on a running capability) that exact contract is used, Deprecated or
// not. Nothing is taken from the last entry of a list and nothing is merged.
//
// "registry unavailable" is never remembered: the next ask goes back to the
// registry (the resolver spaces repeated asks a couple of seconds apart).

import '../core/cp-resolver.js';

const R = globalThis.CPResolver;

export function createProfiles(opts) {
  const resolver = R.createResolver(opts || {});

  // A held selection surface is what says which version is current. For a NEW
  // definition (no version asked), if it has not been checked for `staleAfter`
  // ms, it is revalidated first (a conditional GET: 304 when nothing changed),
  // so a version published while the tool is open is seen without a restart.
  // A running widget (a version asked) never needs this: a published contract
  // never changes.
  const staleAfter = opts && Number.isFinite(opts.staleAfter) ? opts.staleAfter : 30000;
  const checked = new Map();

  async function getProfile(name, version) {
    if (!name) return { ok: false, kind: R.UNREGISTERED, name };
    try {
      let v = version;
      if (v === undefined || v === null || String(v) === '') {
        const last = checked.get(name);
        if (last === undefined || Date.now() - last > staleAfter) {
          try { await resolver.surface(name); checked.set(name, Date.now()); } catch (_) { /* current() answers from what is held, or says why not */ }
        }
        const cur = await resolver.current(name);
        if (cur.version === null) return { ok: false, kind: cur.reason, name };
        v = cur.version;
      }
      return { ok: true, profile: await resolver.contract(name, v) };
    } catch (e) {
      return { ok: false, kind: (e && e.kind) || R.UNAVAILABLE, name, version, message: e && e.message };
    }
  }

  // Every page of the registry's list. The list carries summaries only (name,
  // title, versions and their status), so a Profile's properties are asked for
  // when it is picked, not here.
  async function listProfiles(pageSize) {
    const limit = pageSize || 100;
    const entries = [];
    try {
      let offset = 0;
      for (let guard = 0; guard < 200; guard++) {
        const page = await resolver.search('', { limit, offset });
        const got = Array.isArray(page.entries) ? page.entries : [];
        entries.push(...got);
        if (!got.length || page.next === null || page.next === undefined) break;
        offset += got.length;
        if (typeof page.total === 'number' && offset >= page.total) break;
      }
      return { ok: true, entries };
    } catch (e) {
      return { ok: false, entries, error: (e && e.message) || String(e), kind: (e && e.kind) || R.UNAVAILABLE };
    }
  }

  return { getProfile, listProfiles, origin: resolver.origin, counts: resolver.counts, resolver };
}

/** What a Composer row may do, from the versions the list reports. */
export function pickability(entry) {
  const vs = Array.isArray(entry && entry.versions) ? entry.versions : [];
  const published = vs.filter((v) => v && v.status === 'published');
  if (published.length) return { pickable: true, current: Math.max(...published.map((v) => v.version)), why: '' };
  if (vs.some((v) => v && v.status === 'deprecated')) return { pickable: false, current: null, why: 'deprecated' };
  return { pickable: false, current: null, why: 'nothing published' };
}
