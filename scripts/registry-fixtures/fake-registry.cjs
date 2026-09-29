'use strict';

// A fake fetch that serves canon's RECORDED answers (test/fixtures) with their
// recorded headers, and can be told to misbehave. No network.

const fs = require('fs');
const path = require('path');

const FIX = path.join(__dirname, 'fixtures');

function fixtureFor(pathAndQuery) {
  let p = decodeURIComponent(pathAndQuery.replace(/^\//, ''));
  p = p.replace(/[:?&=]/g, '_');
  return path.join(FIX, p);
}

function parseHeaders(text) {
  const h = new Map();
  let status = 200;

  text.split(/\r?\n/).forEach((line, i) => {
    if (i === 0) { status = parseInt(line.split(' ')[1], 10); return; }
    const k = line.indexOf(':');
    if (k > 0) h.set(line.slice(0, k).trim().toLowerCase(), line.slice(k + 1).trim());
  });

  return { status, headers: h };
}

function response(status, headers, body) {
  return {
    status: status,
    headers: { get: (k) => (headers.has(k.toLowerCase()) ? headers.get(k.toLowerCase()) : null) },
    text: () => Promise.resolve(body)
  };
}

function fakeRegistry(opts) {
  opts = opts || {};

  const reg = {
    log: [],                 // every request: { url, headers }
    offline: false,          // reject every request
    status: null,            // force this HTTP status on everything
    slow: 0,                 // delay every answer (ms)
    workspace: false,        // answer as a workspace
    garbage: false,          // answer 200 with unreadable text
    overrides: new Map()     // 'name' -> { body, headers, status } replaces a fixture
  };

  reg.fetch = function (url, init) {
    const u = new URL(url);
    const headers = {};
    Object.keys((init && init.headers) || {}).forEach((k) => { headers[k.toLowerCase()] = init.headers[k]; });
    reg.log.push({ url: url, path: u.pathname + u.search, headers: headers });

    const answer = () => {
      if (reg.offline) return Promise.reject(new TypeError('fetch failed'));
      if (reg.status) return Promise.resolve(response(reg.status, new Map(), ''));
      if (reg.garbage) return Promise.resolve(response(200, new Map(), '<html>not json'));

      const key = decodeURIComponent(u.pathname.replace(/^\//, ''));
      const o = reg.overrides.get(key);

      if (o) return Promise.resolve(response(o.status || 200, new Map(Object.entries(o.headers || {})), o.body));

      const base = fixtureFor(u.pathname + u.search);
      if (!fs.existsSync(base + '.headers')) return Promise.resolve(response(404, new Map(), '{"registered":false}'));

      const h = parseHeaders(fs.readFileSync(base + '.headers', 'utf8'));
      const body = fs.readFileSync(base + '.body', 'utf8');

      if (reg.workspace) h.headers.set('x-cp-surface', 'workspace');

      const inm = headers['if-none-match'];
      if (inm && h.headers.get('etag') === inm) return Promise.resolve(response(304, h.headers, ''));

      return Promise.resolve(response(h.status, h.headers, body));
    };

    return reg.slow ? new Promise((r) => setTimeout(r, reg.slow)).then(answer) : answer();
  };

  return reg;
}

module.exports = { fakeRegistry, FIX };
module.exports.parseHeaders = parseHeaders; module.exports.fixtureFor = fixtureFor;
