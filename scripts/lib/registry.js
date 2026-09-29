// scripts/lib/registry.js — how the test scripts reach the CP Registry.
// None of them fetches a registry URL itself: they go through cp-resolver, as
// the app does. Origin: CP_REGISTRY_URL if set (a local stub), else cp.cnscp.io.
//
//   fetchProfile(name[, version]) -> the contract (tool shape), or null
//   listProfiles()               -> every registered name, all pages, summaries only

import '../../core/cp-resolver.js';

const R = globalThis.CPResolver;
const resolver = R.createResolver(process.env.CP_REGISTRY_URL ? { origin: process.env.CP_REGISTRY_URL } : {});

export const registryOrigin = resolver.origin;

export async function fetchProfile(name, version) {
  try {
    let v = version;
    if (v === undefined || v === null) {
      const cur = await resolver.current(name);
      if (cur.version === null) return null;
      v = cur.version;
    }
    return await resolver.contract(name, v);
  } catch (_) {
    return null;
  }
}

export async function listProfiles() {
  const entries = [];
  try {
    let offset = 0;
    for (let guard = 0; guard < 200; guard++) {
      const page = await resolver.search('', { limit: 100, offset });
      const got = Array.isArray(page.entries) ? page.entries : [];
      entries.push(...got);
      if (!got.length || page.next === null || page.next === undefined) break;
      offset += got.length;
      if (typeof page.total === 'number' && offset >= page.total) break;
    }
    return entries;
  } catch (_) {
    return null;
  }
}
