// scripts/test-spec.js
// Offline unit tests for the portable core: widget-spec validation and the
// behavior engine. Uses a FIXTURE copy of the padi.light registry JSON (shape
// verified against cp.padi.io) so this runs with no network.

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { validateDefinition, parseProfile } from '../core/widget-spec.js';
import { deriveState, computeActions, reconcilePending } from '../core/behavior-engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// Fixture: padi.light as served by cp.padi.io (server-key props = provider side).
const PADI_LIGHT = {
  name: 'padi.light',
  title: 'Simple light control profile',
  versions: [{
    properties: [
      { name: 'sOut', description: 'The output state of the controller 0=off, 1=on', server: null },
      { name: 'sLabel', description: 'Controller label', server: null },
      { name: 'cState', description: 'State of the light 0=off, 1=on' },
      { name: 'cLabel', description: 'Label of the Light' },
    ],
  }],
};
const PROFILES = { 'padi.light': PADI_LIGHT };

let n = 0;
const ok = (name) => console.log(`  ✔ ${name}`) || n++;

// ---- parseProfile ----
{
  const p = parseProfile(PADI_LIGHT);
  assert.equal(p.props.sOut.writer, 'server');
  assert.equal(p.props.cState.writer, 'client');
  ok('parseProfile: server/client direction from the "server" key');
}

// ---- the shipped widgets validate ----
for (const f of ['bulb.yaml', 'switch.yaml']) {
  const raw = yaml.load(fs.readFileSync(path.join(ROOT, 'widgets', f), 'utf8'));
  const res = validateDefinition(raw, PROFILES);
  assert.ok(res.ok, `${f} should validate: ${res.errors.join('; ')}`);
  ok(`${f} validates against the registry fixture`);
}

// ---- rejections ----
{
  const res = validateDefinition({
    widget: 'x', title: 'X',
    capabilities: [{ profile: 'padi.unregistered', role: 'consumer' }],
    view: [{ type: 'value', bind: 'foo' }],
  }, { 'padi.unregistered': null });
  assert.ok(!res.ok && res.errors.some((e) => e.includes('NOT in the CP registry')));
  ok('unregistered CP is refused (hard rule)');
}
{
  const res = validateDefinition({
    widget: 'x', title: 'X',
    capabilities: [{ profile: 'padi.light', role: 'consumer' }],
    view: [{ type: 'toggle', bind: 'sOut' }], // consumer may not write sOut
  }, PROFILES);
  assert.ok(!res.ok && res.errors.some((e) => e.includes('may not write')));
  ok('wrong-direction write is refused');
}
{
  const res = validateDefinition({
    widget: 'x', title: 'X',
    capabilities: [{ profile: 'padi.light', role: 'consumer' }],
    view: [{ type: 'value', bind: 'nope' }],
  }, PROFILES);
  assert.ok(!res.ok && res.errors.some((e) => e.includes('does not exist')));
  ok('unknown property bind is refused');
}

// ---- behavior engine ----
{
  const raw = yaml.load(fs.readFileSync(path.join(ROOT, 'widgets', 'bulb.yaml'), 'utf8'));
  const { model } = validateDefinition(raw, PROFILES);
  const inst = { systemId: 'SYS', nodeId: 'NODE', contextId: 'CTX' };
  const base = `cns/SYS/nodes/NODE/contexts/CTX/consumer/padi.light/`;

  // controller says ON via a connection property; bulb hasn't actualized yet
  const keys = {
    [base + 'properties/cState']: '0',
    [base + 'connections/abc/properties/sOut']: '1',
    [base + 'connections/abc/properties/cState']: '0',
  };
  const { state, connections } = deriveState(keys, inst, model);
  assert.equal(state.sOut, '1');
  assert.equal(connections, 1);
  ok('deriveState: connection props overlay capability props');

  const pending = {};
  let actions = computeActions(model, state, pending);
  assert.deepEqual(actions, [{ property: 'cState', value: '1' }]);
  ok('computeActions: bulb converges cState -> sOut');

  // put issued -> pending guard stops re-issue on the next (unchanged) update
  pending.cState = '1';
  actions = computeActions(model, state, pending);
  assert.equal(actions.length, 0);
  ok('pending guard prevents duplicate puts');

  // echo arrives -> pending reconciled, no further action
  keys[base + 'properties/cState'] = '1';
  keys[base + 'connections/abc/properties/cState'] = '1';
  const d2 = deriveState(keys, inst, model);
  reconcilePending(d2.state, pending);
  assert.ok(!('cState' in pending));
  assert.equal(computeActions(model, d2.state, pending).length, 0);
  ok('converged state produces no actions (idempotent)');
}

// ---- multi-connection derivation ----
{
  const raw = yaml.load(fs.readFileSync(path.join(ROOT, 'widgets', 'switch.yaml'), 'utf8'));
  const { model } = validateDefinition(raw, PROFILES);
  const inst = { systemId: 'SYS', nodeId: 'NODE', contextId: 'CTX' };
  const base = `cns/SYS/nodes/NODE/contexts/CTX/provider/padi.light/`;
  // a switch commanding TWO bulbs that currently disagree
  const keys = {
    [base + 'properties/sOut']: '1',
    [base + 'connections/aaa/properties/cState']: '1',
    [base + 'connections/bbb/properties/cState']: '0',
  };
  const d = deriveState(keys, inst, model);
  assert.equal(d.connections, 2);
  assert.equal(d.perConn.aaa.cState, '1');
  assert.equal(d.perConn.bbb.cState, '0');
  assert.ok(d.state.cState === '1' || d.state.cState === '0'); // merged view is last-write-wins
  ok('deriveState: perConn exposes each connection; merged view still present');
}

console.log(`\n✅ PASS — ${n} spec/engine checks.`);
