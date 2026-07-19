// core/behavior-engine.js
// ---------------------------------------------------------------------------
// PORTABLE (no Electron, no Node APIs). The auto-actualize engine.
//
// Design: rather than reacting to individual watch events (the SDK's .watch has
// a null-match crash bug, and events can be missed across reconnects), the
// engine is a CONVERGENCE function over derived state. After every keys update:
//     actions = computeActions(model, state, pending)
// puts the returned {property, value} list, and the widget converges on its
// declared behavior no matter what happened while it was offline. Idempotent:
// once state reflects the rule outcome, no further actions are produced.
//
// `pending` guards the put-echo window: a put we issued but whose echo hasn't
// come back yet must not be re-issued on every intermediate update. The caller
// owns the pending map (property -> value) and clears entries when state
// confirms them (also done here in reconcilePending).
// ---------------------------------------------------------------------------

/**
 * Derive the faceplate/rule state for one instance from the flat CNS keys.
 * Capability properties first, overlaid by connection properties (connections
 * mirror BOTH sides' props, so this is where the peer's writes appear).
 *
 * @param {Object<string,string>} keys flat CNS namespace
 * @param {object} inst {systemId, nodeId, contextId}
 * @param {object} model validated widget model (capabilities: [{profile, role}])
 * @returns {{state:Object<string,string>, connections:number}}
 */
export function deriveState(keys, inst, model) {
  const state = {};
  let connections = 0;
  for (const cap of model.capabilities) {
    const prefix = `cns/${inst.systemId}/nodes/${inst.nodeId}/contexts/${inst.contextId}/${cap.role}/${cap.profile}/`;
    const connIds = new Set();
    // pass 1: capability properties
    for (const k in keys) {
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      if (rest.startsWith('properties/')) {
        state[rest.slice('properties/'.length)] = keys[k];
      } else if (rest.startsWith('connections/')) {
        connIds.add(rest.split('/')[1]);
      }
    }
    // pass 2: connection properties overlay (peer writes live here)
    for (const k in keys) {
      if (!k.startsWith(prefix + 'connections/')) continue;
      const m = k.slice(prefix.length).match(/^connections\/[^/]+\/properties\/(.+)$/);
      if (m) state[m[1]] = keys[k];
    }
    connections += connIds.size;
  }
  return { state, connections };
}

/**
 * Compute the puts needed to converge on the widget's behavior rules.
 * @param {object} model validated widget model ({behavior:{rules}})
 * @param {Object<string,string>} state derived state
 * @param {Object<string,string>} pending puts already in flight (prop -> value)
 * @returns {Array<{property:string, value:string}>}
 */
export function computeActions(model, state, pending = {}) {
  const actions = [];
  for (const rule of model.behavior.rules) {
    const input = state[rule.when];
    if (input === undefined || input === null) continue; // nothing to react to yet
    const out = rule.map ? (rule.map[String(input)] ?? String(input)) : String(input);
    if (state[rule.set] === out) continue;      // already converged
    if (pending[rule.set] === out) continue;    // put in flight, waiting for echo
    actions.push({ property: rule.set, value: out });
  }
  return actions;
}

/**
 * Drop pending entries that the state now confirms (echo arrived).
 * Mutates and returns `pending`.
 */
export function reconcilePending(state, pending) {
  for (const p in pending) {
    if (state[p] === pending[p]) delete pending[p];
  }
  return pending;
}
