#!/usr/bin/env node
// check-cp-resolver.js - is this copy of cp-resolver.js the one that was stamped,
// and is it the current one?
//
//   node check-cp-resolver.js <copy>                     the copy's body matches its own stamp
//   node check-cp-resolver.js --walk <source> <copies.json> <base>
//                                                        from the source: every known copy
//
// copies.json: [ { "repo": "arete-gateway", "path": "src/cp-resolver.js" }, ... ]
// with each path relative to <base>/<repo>.
//
// Exit 0 when everything passes; 1 otherwise, naming each file. An EDITED copy
// (hash does not match its stamp) and a BEHIND copy (stamp older than the
// source) and a MISSING copy are three different findings.
//
// No dependencies, so a tool can carry this file into its own test script.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function read(file) {
  const text = fs.readFileSync(file, 'utf8');
  const nl = text.indexOf('\n');
  const m = /^\/\/ cp-resolver (\d+\.\d+\.\d+) · sha256 ([0-9a-f]{64})$/.exec(nl < 0 ? text : text.slice(0, nl));

  if (!m) return { file: file, stamped: false };

  const body = text.slice(nl + 1);
  const hash = crypto.createHash('sha256').update(body, 'utf8').digest('hex');

  return { file: file, stamped: true, version: m[1], stamp: m[2], hash: hash, edited: hash !== m[2] };
}

function older(a, b) {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}

function checkCopy(file) {
  const r = read(file);

  if (!r.stamped) return [file + ': no cp-resolver stamp on line 1'];
  if (r.edited) return [file + ': EDITED - the body no longer matches its stamp (cp-resolver ' + r.version + '). Change the source, bump it, and copy it out.'];
  return [];
}

function walk(source, listFile, base) {
  const src = read(source);
  const problems = [];

  if (!src.stamped || src.edited) return [source + ': the source itself is not correctly stamped; run stamp.js'];

  const list = JSON.parse(fs.readFileSync(listFile, 'utf8'));

  for (const c of list) {
    const file = path.join(base, c.repo, c.path);

    if (!fs.existsSync(file)) { problems.push(file + ': MISSING - ' + c.repo + ' should carry a copy'); continue; }

    const r = read(file);

    if (!r.stamped) { problems.push(file + ': no cp-resolver stamp on line 1'); continue; }
    if (r.edited) { problems.push(file + ': EDITED (stamp ' + r.version + ')'); continue; }
    if (older(r.version, src.version)) problems.push(file + ': BEHIND - ' + r.version + ', the source is ' + src.version);
    else if (r.hash !== src.stamp) problems.push(file + ': differs from the source at ' + r.version + ' (same version, different body)');
  }

  return problems;
}

if (require.main === module) {
  const a = process.argv.slice(2);
  let problems;

  if (a[0] === '--walk' && a.length === 4) problems = walk(a[1], a[2], a[3]);
  else if (a.length === 1 && a[0][0] !== '-') problems = checkCopy(a[0]);
  else { console.error('usage: check-cp-resolver.js <copy> | --walk <source> <copies.json> <base>'); process.exit(2); }

  if (problems.length) { problems.forEach((p) => console.error(p)); process.exit(1); }
  console.log('cp-resolver check: ok');
}

module.exports = { read, checkCopy, walk };
