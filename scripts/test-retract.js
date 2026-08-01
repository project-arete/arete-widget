// Live retraction test for AreteService.retractNode.
//
// Written after two false positives in one day: a cleanup script that reported
// removing 294 keys while doing nothing, and a probe that "passed" having
// created zero keys. Both asserted the postcondition without checking the
// precondition, so a silently failed setup looked like success.
//
// So this test asserts, in order:
//   1. the setup ACTUALLY produced keys on the realm (else abort loudly);
//   2. retraction removes them;
//   3. the guard refuses to claim success when the key cache is not alive —
//      because absence from a blanked cache is not evidence of absence on the
//      realm, and that is exactly how a widget gets forgotten locally while
//      its node lives on.
//
// Usage: E2E_REALM=test.aretehosting.com node scripts/test-retract.js

import { AreteService } from '../electron/arete-service.js';

const HOST = process.env.E2E_REALM ?? 'test.aretehosting.com';
const PROTOCOL = process.env.E2E_PROTOCOL ?? 'wss:';
const PORT = Number(process.env.E2E_PORT ?? 443);

let pass = 0, fail = 0;
function check(ok, label, detail) {
  if (ok) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '  — ' + detail : '')); }
}

process.env.ARETE_SYSTEM_SEED = 'widget-retract-suite-' + Date.now();

const svc = new AreteService();
svc.on('log', (l) => { if (l.level === 'error') console.log(`   [${l.level}] ${l.message}`); });

const stamp = Date.now().toString(36);
const nodeId = `retract-suite-${stamp}`;
let systemId = null;

try {
  await svc.connect({ protocol: PROTOCOL, host: HOST, port: PORT, systemName: 'Widget Retract Suite' });

  const res = await svc.instantiate({
    nodeId,
    nodeName: 'Retract Suite',
    contextId: `retract-ctx-${stamp}`,
    contextName: 'Retract Suite Ctx',
    capabilities: [{ role: 'consumer', profile: 'padi.light' }],
  });
  systemId = res.systemId;

  const prefix = `cns/${systemId}/nodes/${nodeId}`;
  const count = () => Object.keys(svc.getKeys() || {})
    .filter((k) => k === prefix || k.startsWith(prefix + '/')).length;

  // 1. PRECONDITION — the thing the earlier probe forgot to check.
  const started = Date.now();
  while (Date.now() - started < 15000 && count() === 0) {
    await new Promise((r) => setTimeout(r, 300));
  }
  const before = count();
  check(before > 0, 'setup actually created keys on the realm', `saw ${before}`);
  if (before === 0) {
    console.log('\n  ABORTING: nothing was created, so nothing below would mean anything.');
    console.log(`\n=== retract: ${pass}/${pass + fail} passed ===`);
    await svc.disconnect();
    process.exit(1);
  }

  // 2. retraction removes them
  // getKeys() redacts '/token' keys, so the service's own count is a superset
  // of what this test can see. Assert the relationship, not equality.
  const removed = await svc.retractNode(nodeId);
  check(removed >= before && removed > 0,
    'retractNode reports at least the keys we could see', `${removed} removed vs ${before} visible`);
  check(count() === 0, 'subtree is gone from the realm', `${count()} remaining`);

  // 3. the guard: realm state we cannot see must NOT be read as "already gone".
  //
  // Reproduce the real condition rather than faking it — getKeys() returns a
  // copy, so mutating that proves nothing. Removing our own system record puts
  // the cache in the same state a blanking would: no evidence either way. That
  // is exactly when a naive check reports "nothing to retract" and the caller
  // forgets a node that still exists on the realm.

  // Sanity first: retracting an absent node IS allowed while the cache is alive.
  let allowedWhileAlive = true;
  try {
    await svc.retractNode(`never-existed-${stamp}`);
  } catch {
    allowedWhileAlive = false;
  }
  check(allowedWhileAlive, 'retracting a node with no realm presence succeeds while the cache is alive');

  // Now remove the system record and wait for the cache to reflect it.
  await svc.retractSystemRecordForTest();
  const t0 = Date.now();
  while (Date.now() - t0 < 8000 && (svc.getKeys() || {})[`cns/${systemId}/name`] !== undefined) {
    await new Promise((r) => setTimeout(r, 250));
  }
  const recordGone = (svc.getKeys() || {})[`cns/${systemId}/name`] === undefined;
  check(recordGone, 'system record removed, so realm state is now unverifiable', 'record still present');

  let guarded = false;
  if (recordGone) {
    try {
      await svc.retractNode(`never-existed-again-${stamp}`);
    } catch (e) {
      guarded = /not available/i.test(e.message);
    }
  }
  check(guarded, 'refuses to claim success when realm state is unverifiable');
} catch (err) {
  check(false, 'suite ran without throwing', err.message);
} finally {
  // Leave nothing behind.
  try {
    if (systemId) {
      await svc.retractNode(nodeId).catch(() => {});
    }
  } catch { /* best effort */ }
  await svc.disconnect().catch(() => {});
}

console.log(`\n=== retract: ${pass}/${pass + fail} passed ===`);
process.exit(fail ? 1 : 0);
