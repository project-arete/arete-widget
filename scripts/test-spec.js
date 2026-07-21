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
      // registry convention: flags are encoded by KEY PRESENCE (value null)
      { name: 'sOut', description: 'The output state of the controller 0=off, 1=on', server: null, propagate: null },
      { name: 'sLabel', description: 'Controller label', server: null, propagate: null },
      { name: 'cState', description: 'State of the light 0=off, 1=on', propagate: null },
      { name: 'cLabel', description: 'Label of the Light', propagate: null },
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
  assert.equal(p.props.sOut.propagate, true);
  ok('parseProfile: server/client direction + propagate from key presence');
}

// ---- the propagate flag ----
{
  // A profile with non-propagated properties on both sides.
  const P = {
    name: 'x.test',
    versions: [{
      properties: [
        { name: 'shared', description: '', server: null, propagate: null },
        { name: 'hidden', description: '', server: null },   // server-written, NOT propagated
        { name: 'note', description: '' },                    // client-written, NOT propagated
      ],
    }],
  };
  const PR = { 'x.test': P };

  // Reading a peer-written non-propagated property is LEGAL: it is not
  // broadcast, but the peer can deliver it on the addressed per-connection
  // channel (2026-07-20 semantics refinement).
  let res = validateDefinition({
    widget: 'a', title: 'A',
    capabilities: [{ profile: 'x.test', role: 'consumer' }],
    view: [{ type: 'value', bind: 'hidden' }],
  }, PR);
  assert.ok(res.ok, res.errors.join('; '));
  ok('reading a peer-written non-propagated property is allowed (addressed channel)');

  // ...and a rule may listen to it (it fires when the peer addresses us).
  res = validateDefinition({
    widget: 'b', title: 'B',
    capabilities: [{ profile: 'x.test', role: 'consumer' }],
    view: [{ type: 'value', bind: 'shared' }],
    behavior: { rules: [{ when: 'hidden', set: 'note' }] },
  }, PR);
  assert.ok(res.ok, res.errors.join('; '));
  ok('rule when: on a non-propagated peer property is allowed');

  // Your OWN non-propagated property stays writable and bindable (local).
  res = validateDefinition({
    widget: 'c', title: 'C',
    capabilities: [{ profile: 'x.test', role: 'consumer' }],
    view: [{ type: 'field', bind: 'note' }, { type: 'value', bind: 'shared' }],
  }, PR);
  assert.ok(res.ok);
  assert.equal(res.model.resolve.note.propagate, false);
  assert.equal(res.model.resolve.shared.propagate, true);
  ok('own non-propagated property remains writable/bindable (marked local)');
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

// ---- aggregate rules (TWO switches -> one bulb) ----
{
  const raw = yaml.load(fs.readFileSync(path.join(ROOT, 'widgets', 'bulb.yaml'), 'utf8'));
  const { model } = validateDefinition(raw, PROFILES);
  assert.equal(model.behavior.rules[0].aggregate, 'average');
  ok('shipped bulb.yaml declares aggregate: average');

  const inst = { systemId: 'SYS', nodeId: 'NODE', contextId: 'CTX' };
  const base = `cns/SYS/nodes/NODE/contexts/CTX/consumer/padi.light/`;
  // two controllers that disagree: one on, one off
  const keys = {
    [base + 'properties/cState']: '0',
    [base + 'connections/aaa/properties/sOut']: '1',
    [base + 'connections/bbb/properties/sOut']: '0',
  };
  const d = deriveState(keys, inst, model);
  let actions = computeActions(model, d.state, {}, d.perConn);
  assert.deepEqual(actions, [{ property: 'cState', value: '0.5' }]);
  ok('aggregate average: one of two controllers on -> cState "0.5"');

  // agreement collapses to the plain value and converges
  keys[base + 'connections/bbb/properties/sOut'] = '1';
  keys[base + 'properties/cState'] = '1';
  const d2 = deriveState(keys, inst, model);
  assert.equal(computeActions(model, d2.state, {}, d2.perConn).length, 0);
  ok('aggregate average: agreement converges to "1" (no action)');

  // single connection behaves exactly like the plain mirror rule
  const keys1 = {
    [base + 'properties/cState']: '0',
    [base + 'connections/aaa/properties/sOut']: '1',
  };
  const d1 = deriveState(keys1, inst, model);
  assert.deepEqual(computeActions(model, d1.state, {}, d1.perConn), [{ property: 'cState', value: '1' }]);
  ok('aggregate average: single connection = plain mirror');

  // the validator refuses an unknown aggregate
  const bad = validateDefinition({
    widget: 'x', title: 'X',
    capabilities: [{ profile: 'padi.light', role: 'consumer' }],
    view: [{ type: 'value', bind: 'sOut' }],
    behavior: { rules: [{ when: 'sOut', set: 'cState', aggregate: 'median' }] },
  }, PROFILES);
  assert.ok(!bad.ok && bad.errors.some((er) => er.includes('aggregate')));
  ok('validator refuses unknown aggregate');
}

// ---- addressed reply rules (cp:padi.ping) ----
{
  // Fixture mirrors the REAL cp.padi.io registry entry for padi.ping.
  const PADI_PING = {
    name: 'padi.ping',
    title: 'Simple connection ping',
    versions: [{
      properties: [
        { name: 'send', server: null, description: 'Send the message' },
        { name: 'sendP', description: 'Send with propagate', server: null, propagate: null },
        { name: 'response', description: 'Response from Responder' },
      ],
    }],
  };
  const PR2 = { 'padi.ping': PADI_PING, 'padi.light': PADI_LIGHT };

  // both shipped ping widgets validate
  for (const f of ['ping-sender.yaml', 'ping-responder.yaml']) {
    const raw = yaml.load(fs.readFileSync(path.join(ROOT, 'widgets', f), 'utf8'));
    const res = validateDefinition(raw, PR2);
    assert.ok(res.ok, `${f}: ${res.errors.join('; ')}`);
    ok(`${f} validates (incl. reading non-propagated response / reply rule)`);
  }

  // the validator rejects bad reply usage
  const bad = validateDefinition({
    widget: 'x', title: 'X',
    capabilities: [{ profile: 'padi.ping', role: 'consumer' }],
    view: [{ type: 'value', bind: 'sendP' }],
    behavior: { rules: [{ when: 'sendP', set: 'response', reply: 'yes' }] },
  }, PR2);
  assert.ok(!bad.ok && bad.errors.some((er) => er.includes('reply')));
  ok('validator refuses reply: values other than true');

  // ---- the rtt view primitive ----
  const rttBase = {
    widget: 'x', title: 'X',
    capabilities: [{ profile: 'padi.ping', role: 'provider' }],
  };
  const good = validateDefinition({
    ...rttBase,
    view: [{ type: 'rtt', send: 'sendP', echo: 'response', caption: 'round trip' }],
  }, PR2);
  assert.ok(good.ok, good.errors.join('; '));
  assert.deepEqual(good.model.view[0], { type: 'rtt', caption: 'round trip', send: 'sendP', echo: 'response' });
  ok('rtt primitive validates (send writable, echo readable)');

  const rttNoSend = validateDefinition({ ...rttBase, view: [{ type: 'rtt', echo: 'response' }] }, PR2);
  assert.ok(!rttNoSend.ok && rttNoSend.errors.some((er) => er.includes('send')));
  ok('rtt refuses a missing send:');

  // the sender role may not write `response` (consumer-side prop) — so a
  // sender using response as SEND must be rejected, as must send===echo
  const rttBadSend = validateDefinition({ ...rttBase, view: [{ type: 'rtt', send: 'response', echo: 'sendP' }] }, PR2);
  assert.ok(!rttBadSend.ok);
  ok('rtt refuses a send: the widget cannot write');

  const rttSame = validateDefinition({ ...rttBase, view: [{ type: 'rtt', send: 'sendP', echo: 'sendP' }] }, PR2);
  assert.ok(!rttSame.ok && rttSame.errors.some((er) => er.includes('different')));
  ok('rtt refuses send === echo');

  // ENGINE: reply rule answers per connection, on that connection
  const raw = yaml.load(fs.readFileSync(path.join(ROOT, 'widgets', 'ping-responder.yaml'), 'utf8'));
  const { model } = validateDefinition(raw, PR2);
  const perConn = {
    c1: { sendP: 'hello-from-A' },
    c2: { sendP: 'hello-from-B', response: 'hello-from-B' }, // c2 already answered
  };
  const pending = {};
  let actions = computeActions(model, { sendP: 'hello-from-B' }, pending, perConn);
  assert.deepEqual(actions, [{ property: 'response', value: 'hello-from-A', connId: 'c1' }]);
  ok('reply rule: answers ONLY the unanswered connection, addressed to it');

  // pending guard is connection-scoped
  pending['c1|response'] = 'hello-from-A';
  actions = computeActions(model, { sendP: 'hello-from-B' }, pending, perConn);
  assert.equal(actions.length, 0);
  ok('reply rule: connection-scoped pending prevents duplicate replies');

  // echo arrives on c1 -> pending reconciled via perConn
  const perConn2 = { ...perConn, c1: { sendP: 'hello-from-A', response: 'hello-from-A' } };
  reconcilePending({}, pending, perConn2);
  assert.ok(!('c1|response' in pending));
  assert.equal(computeActions(model, { sendP: 'hello-from-B' }, pending, perConn2).length, 0);
  ok('reply rule: converges once every connection carries its answer');
}

console.log(`\n✅ PASS — ${n} spec/engine checks.`);
