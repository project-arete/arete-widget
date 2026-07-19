// arete-system-id.js
// ---------------------------------------------------------------------------
// The Arete Node SDK derives a "System ID" from Raspberry Pi devicetree files
// and THROWS off-Pi, inside the `new Client()` constructor. We fix that at the
// SDK source (see scripts/patch-sdk.js, run on postinstall), which adds a
// fallback that reads `process.env.ARETE_SYSTEM_SEED`.
//
// This module's only job is to set that env var to a STABLE per-install seed
// BEFORE the SDK is imported. uuidv5-hashing a stable seed yields a stable
// System ID across restarts, which the control plane requires.
//
// Why not patch `fs` at runtime instead? Because inside Electron the SDK's
// `import * as fs from 'fs'` resolves to an fs module facade whose named exports
// are already snapshotted (and may be a different fs object entirely), so a
// runtime fs shim silently does nothing. An env var is immune to all of that.
// ---------------------------------------------------------------------------

/**
 * Set the stable System-ID seed the (patched) SDK will read.
 * Named `installSystemIdPatch` for backward compatibility with existing callers.
 * @param {string} [seed] A stable per-install string. If omitted, any previously
 *   set seed is left untouched.
 */
export function installSystemIdPatch(seed) {
  if (seed) process.env.ARETE_SYSTEM_SEED = String(seed);
}
