// cp-resolver 1.0.0 · sha256 da5a8c1328371e35d8d8eff87e7b84696991280f9431177025c4122b44913f12
// cp-resolver.js - resolve Connection Profiles from the CP Registry, for tools and apps
//
// One file, no imports and no exports, so it loads as a plain <script> and as a
// side-effect ES import (`import './cp-resolver.js'`), and ends by setting
// globalThis.CPResolver (and module.exports when loaded as CommonJS).
//
// It follows the same rules as the Governor's registry.js (T1), and uses the
// same five failure kinds, so a log line reads the same in either:
//
//   GET {origin}/{name}      the selection surface: is the name registered, which
//                            versions exist, and each one's status. no-cache by
//                            design, so it is revalidated with its ETag (304).
//   GET {origin}/{name}:{n}  one version's contract. A published version never
//                            changes, so once fetched it is kept for good.
//   GET {origin}/profiles    a paged text search, summaries only.
//
// All with Accept: application/cp+json; profile=2026.
//
// What is held, and for how long:
//   - contracts: for good (in memory, and in the tool's store if it passes one).
//   - surfaces: revalidated by surface(), revalidate(), or when a lookup misses
//     and the held answer is older than absentTtl.
//   - "not registered", "nothing published", "no such version": asked again
//     after absentTtl, and on every surface() call. Never held for good.
//   - "registry unavailable": never held as an answer. The same name is not
//     asked again for retryGap ms.
//
// A version is chosen by its number. Nothing is taken from the contract's
// Header for that, which older versions may lack.
//
// A workspace answer (x-cp-surface: workspace, x-cp-status: unpublished) is
// refused as "nothing published" and never parsed: drafts are not a Registry's
// published word (T10 decides if and when tools show them).
//
// Copyright 2026 Padi, Inc. All Rights Reserved.

(function (root) {
  'use strict';

  var VERSION = '1.0.0';
  var DEFAULT_ORIGIN = 'https://cp.cnscp.io';
  var ACCEPT = 'application/cp+json; profile=2026';

  // Why a Profile did not resolve (same names as the Governor's registry.js)
  var UNREGISTERED = 'not registered';
  var UNPUBLISHED = 'nothing published';
  var NO_VERSION = 'no such version';
  var DEPRECATED = 'deprecated';
  var UNAVAILABLE = 'registry unavailable';

  function ResolveError(kind, name, version, detail) {
    var e = new Error(name + (version !== undefined && version !== null ? (':' + version) : '') + ' ' + kind +
      (detail ? (' (' + detail + ')') : ''));

    Object.setPrototypeOf(e, ResolveError.prototype);
    e.name = 'ResolveError';
    e.kind = kind;
    e.profile = name;
    if (version !== undefined && version !== null) e.version = version;
    return e;
  }

  ResolveError.prototype = Object.create(Error.prototype, { constructor: { value: ResolveError } });

  // The Registry's origin: a bare origin, nothing after it. A trailing slash or
  // a path is refused, not silently used: it is the classic misconfiguration.
  function normaliseOrigin(url) {
    var s = String(url === undefined || url === null || url === '' ? DEFAULT_ORIGIN : url).trim();
    var m = /^(https?:\/\/[^\/?#]+)(.*)$/i.exec(s);

    if (!m) throw new Error('cp-resolver: origin must be an http(s) URL, got "' + s + '"');
    if (m[2] !== '') {
      throw new Error('cp-resolver: origin must be the bare Registry origin such as ' + DEFAULT_ORIGIN +
        ' with no trailing "/" or path (got "' + s + '")');
    }

    return m[1];
  }

  // A version as a declaration states it: a positive integer, nothing else
  function parseVersion(version) {
    var s = String(version);
    return /^[1-9][0-9]*$/.test(s) ? parseInt(s, 10) : null;
  }

  function isYes(v) {
    return String(v).toLowerCase() === 'yes';
  }

  function deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      Object.freeze(o);
      Object.keys(o).forEach(function (k) { deepFreeze(o[k]); });
    }
    return o;
  }

  // The 2026 contract as one shape for every consumer:
  //   { name, version, title, description, owner, website,
  //     roles: { provider, consumer },
  //     properties: { <name>: { role: 'provider'|'consumer', propagate, mandatory,
  //                             default, description, sample } },
  //     channels: [ as served ] }
  // role 'provider' is what 'server' in prop meant in the 2022 shape.
  // The version comes from the request, not the Header.
  function parseContract(doc, name, version) {
    var header = (doc && doc.Header) || {};
    var groups = (doc && doc.Properties) || {};
    var properties = {};

    ['Provider', 'Consumer'].forEach(function (role) {
      (Array.isArray(groups[role]) ? groups[role] : []).forEach(function (p) {
        if (!p || typeof p.Name !== 'string' || Object.prototype.hasOwnProperty.call(properties, p.Name)) return;

        properties[p.Name] = {
          role: role.toLowerCase(),
          propagate: isYes(p.Propagate),
          mandatory: isYes(p.Mandatory),
          default: (p.Default !== undefined) ? String(p.Default) : undefined,
          description: (p.Description !== undefined) ? String(p.Description) : undefined,
          sample: (p.Sample !== undefined) ? String(p.Sample) : undefined
        };
      });
    });

    return {
      name: name,
      version: version,
      title: header.Title,
      description: header.Description,
      owner: header.Owner,
      website: header.Website,
      roles: { provider: header.Provider, consumer: header.Consumer },
      properties: properties,
      channels: Array.isArray(doc && doc.Channels) ? doc.Channels : []
    };
  }

  function header(res, key) {
    try { return res.headers && res.headers.get ? res.headers.get(key) : null; } catch (e) { return null; }
  }

  function isWorkspace(res) {
    var surface = String(header(res, 'x-cp-surface') || '').toLowerCase();
    var status = String(header(res, 'x-cp-status') || '').toLowerCase();

    return surface === 'workspace' || status === 'unpublished';
  }

  function createResolver(opts) {
    opts = opts || {};

    var origin = normaliseOrigin(opts.origin);
    var doFetch = opts.fetch || (typeof fetch === 'function' ? fetch.bind(root) : null);
    var timeout = opts.timeout || 5000;
    var retryGap = (opts.retryGap !== undefined) ? opts.retryGap : 2000;
    var absentTtl = (opts.absentTtl !== undefined) ? opts.absentTtl : 10000;
    var now = opts.now || Date.now;
    var store = opts.store || null;
    var debug = opts.debug || function () {};

    var surfaces = new Map();   // name -> { etag, versions: Map(n -> status), at }
    var absent = new Map();     // name -> { kind, at }
    var contracts = new Map();  // 'name:n' -> frozen contract (no status)
    var retryAt = new Map();    // name -> earliest time to ask again after a transient failure
    var inflight = new Map();   // request key -> promise, so concurrent lookups share one request
    var counts = { surface: 0, notModified: 0, contract: 0, search: 0, transient: 0, store: 0 };

    if (!doFetch) throw new Error('cp-resolver: no fetch available; pass opts.fetch');

    function transient(name, version, detail) {
      counts.transient++;
      if (name) retryAt.set(name, now() + retryGap);
      return new ResolveError(UNAVAILABLE, name, version, detail);
    }

    // One request at a time per key; concurrent callers share it
    function once(key, fn) {
      if (inflight.has(key)) return inflight.get(key);

      var p = Promise.resolve().then(fn).then(
        function (v) { inflight.delete(key); return v; },
        function (e) { inflight.delete(key); throw e; }
      );

      inflight.set(key, p);
      return p;
    }

    // GET with a timeout; resolves the fetch Response, or rejects
    function get(url, headers) {
      var ctl = (typeof AbortController === 'function') ? new AbortController() : null;
      var timer = null;
      var req = doFetch(url, { method: 'GET', headers: headers, signal: ctl ? ctl.signal : undefined });

      var limit = new Promise(function (resolve, reject) {
        timer = setTimeout(function () {
          if (ctl) ctl.abort();
          reject(new Error('timed out after ' + timeout + 'ms'));
        }, timeout);
      });

      return Promise.race([req, limit]).then(
        function (res) { clearTimeout(timer); return res; },
        function (e) { clearTimeout(timer); throw e; }
      );
    }

    function readJson(res) {
      return res.text().then(function (t) { return JSON.parse(t); });
    }

    // ---- selection surface -------------------------------------------------

    function fetchSurface(name) {
      return once('s:' + name, function () { return fetchSurfaceNow(name); });
    }

    function fetchSurfaceNow(name) {
      var held = surfaces.get(name);
      var headers = { 'accept': ACCEPT };

      if (held && held.etag) headers['if-none-match'] = held.etag;

      counts.surface++;

      return get(origin + '/' + encodeURIComponent(name), headers).then(function (res) {
        if (res.status === 304 && held) {
          counts.notModified++;
          held.at = now();
          retryAt.delete(name);
          return held;
        }

        if (res.status === 404) {
          surfaces.delete(name);
          absent.set(name, { kind: UNREGISTERED, at: now() });
          retryAt.delete(name);
          throw new ResolveError(UNREGISTERED, name);
        }

        if (res.status !== 200) throw transient(name, undefined, 'HTTP ' + res.status);

        // A workspace's draft is not a published Profile: never parsed
        if (isWorkspace(res)) {
          surfaces.delete(name);
          absent.set(name, { kind: UNPUBLISHED, at: now() });
          throw new ResolveError(UNPUBLISHED, name, undefined, 'a workspace answer, not a published one');
        }

        return readJson(res).then(function (doc) {
          return doc;
        }, function () {
          throw transient(name, undefined, 'unreadable reply');
        }).then(function (doc) {
          if (!doc || !Array.isArray(doc.versions)) throw transient(name, undefined, 'not a selection surface');

          var versions = new Map();

          doc.versions.forEach(function (v) {
            if (v && Number.isInteger(v.version)) versions.set(v.version, String(v.status || '').toLowerCase());
          });

          var surface = { etag: header(res, 'etag') || undefined, versions: versions, at: now() };

          surfaces.set(name, surface);
          absent.delete(name);
          retryAt.delete(name);

          return surface;
        });
      }, function (e) {
        if (e instanceof ResolveError) throw e;
        throw transient(name, undefined, e && e.message);
      });
    }

    // Held surface for a name, asking the Registry when it is not held, is stale
    // (fresh: a lookup missed on it), or the caller wants it fresh.
    function ensureSurface(name, n, fresh) {
      var a = absent.get(name);
      var s = surfaces.get(name);

      if (a && !fresh && now() - a.at < absentTtl) return Promise.reject(new ResolveError(a.kind, name, n));
      if (s && !fresh) return Promise.resolve(s);

      if ((retryAt.get(name) || 0) > now()) {
        // A transient failure was seen just now: keep what is held, else refuse
        if (s) return Promise.resolve(s);
        return Promise.reject(new ResolveError(UNAVAILABLE, name, n, 'retrying shortly'));
      }

      return fetchSurface(name);
    }

    // ---- contracts ---------------------------------------------------------

    function readStore(key) {
      if (!store || typeof store.get !== 'function') return Promise.resolve(null);

      return Promise.resolve().then(function () { return store.get(key); }).then(function (v) {
        if (v && typeof v === 'object' && v.properties) { counts.store++; return v; }
        return null;
      }, function (e) { debug('store.get ' + key + ': ' + (e && e.message)); return null; });
    }

    function writeStore(key, contract) {
      if (!store || typeof store.set !== 'function') return;

      Promise.resolve().then(function () { return store.set(key, contract); })
        .then(null, function (e) { debug('store.set ' + key + ': ' + (e && e.message)); });
    }

    function fetchContract(name, n) {
      var key = name + ':' + n;
      var held = contracts.get(key);

      if (held) return Promise.resolve(held);

      return once('c:' + key, function () {
        return readStore(key).then(function (fromStore) {
          if (fromStore) {
            var c = deepFreeze(fromStore);
            contracts.set(key, c);
            return c;
          }

          if ((retryAt.get(name) || 0) > now()) throw new ResolveError(UNAVAILABLE, name, n, 'retrying shortly');

          counts.contract++;

          return get(origin + '/' + encodeURIComponent(name) + ':' + n, { 'accept': ACCEPT }).then(function (res) {
            if (res.status === 404) throw new ResolveError(NO_VERSION, name, n);
            if (res.status !== 200) throw transient(name, n, 'HTTP ' + res.status);
            if (isWorkspace(res)) throw new ResolveError(UNPUBLISHED, name, n, 'a workspace answer, not a published one');

            return readJson(res).then(function (doc) {
              return parseContract(doc, name, n);
            }, function () {
              throw transient(name, n, 'unreadable reply');
            }).then(function (parsed) {
              var c = deepFreeze(parsed);

              contracts.set(key, c);
              writeStore(key, JSON.parse(JSON.stringify(parsed)));
              return c;
            });
          }, function (e) {
            if (e instanceof ResolveError) throw e;
            throw transient(name, n, e && e.message);
          });
        });
      });
    }

    // ---- public ------------------------------------------------------------

    // The registered state and each version's number and status. Always asks
    // (with the ETag once held), so lifecycle and new versions arrive.
    function surface(name) {
      return ensureSurface(name, undefined, true).then(function (s) {
        return {
          name: name,
          versions: Array.from(s.versions.keys()).sort(function (a, b) { return a - b; }).map(function (v) {
            return { version: v, status: s.versions.get(v) };
          })
        };
      });
    }

    // One version's contract in the tool shape, with its status from the surface.
    // Any version that exists is returned, Deprecated or not: existing
    // Connections are untouched by Deprecation, and tools show a mark.
    function contract(name, version) {
      var n = parseVersion(version);
      if (n === null) return Promise.reject(new ResolveError(NO_VERSION, name, version));

      return ensureSurface(name, n, false).then(function (s) {
        // A miss on an old answer: ask again before saying no
        if (!s.versions.has(n) && now() - s.at >= absentTtl) return ensureSurface(name, n, true);
        return s;
      }).then(function (s) {
        if (s.versions.size === 0) throw new ResolveError(UNPUBLISHED, name, n);

        var status = s.versions.get(n);
        if (status === undefined) throw new ResolveError(NO_VERSION, name, n);

        return fetchContract(name, n).then(function (c) {
          return Object.assign({}, c, { status: status });
        });
      });
    }

    // The highest published version that is not Deprecated: the version cns-cli
    // will pick at Declare. { version: n } or { version: null, reason: <kind> }.
    // Unavailable throws: it is not an answer.
    function current(name) {
      return ensureSurface(name, undefined, false).then(function (s) {
        if (s.versions.size === 0) return { version: null, reason: UNPUBLISHED };

        var best = null;
        var deprecated = false;

        s.versions.forEach(function (status, v) {
          if (status === 'published') { if (best === null || v > best) best = v; }
          else if (status === 'deprecated') deprecated = true;
        });

        if (best !== null) return { version: best };
        return { version: null, reason: deprecated ? DEPRECATED : NO_VERSION };
      }, function (e) {
        if (e instanceof ResolveError && (e.kind === UNREGISTERED || e.kind === UNPUBLISHED)) {
          return { version: null, reason: e.kind };
        }
        throw e;
      });
    }

    // One page of the list, as canon returns it (summaries; no properties).
    // `next` is served, never followed here.
    function search(q, o) {
      o = o || {};

      var params = [];
      if (q !== undefined && q !== null && String(q) !== '') params.push('q=' + encodeURIComponent(q));
      if (o.limit !== undefined) params.push('limit=' + encodeURIComponent(o.limit));
      if (o.offset !== undefined) params.push('offset=' + encodeURIComponent(o.offset));

      var url = origin + '/profiles' + (params.length ? ('?' + params.join('&')) : '');

      counts.search++;

      return once('l:' + url, function () {
        return get(url, { 'accept': ACCEPT }).then(function (res) {
          if (res.status !== 200) throw transient(null, undefined, 'HTTP ' + res.status);
          if (isWorkspace(res)) throw new ResolveError(UNPUBLISHED, '/profiles', undefined, 'a workspace answer, not a published one');

          return readJson(res).then(function (page) {
            if (!page || !Array.isArray(page.entries)) throw transient(null, undefined, 'not a list');
            return page;
          }, function () {
            throw transient(null, undefined, 'unreadable reply');
          });
        }, function (e) {
          if (e instanceof ResolveError) throw e;
          throw transient(null, undefined, e && e.message);
        });
      });
    }

    // Forget absences and transient gaps, and refresh every held surface.
    // Returns true if anything a tool shows may have changed.
    function revalidate() {
      var changed = absent.size > 0;

      absent.clear();
      retryAt.clear();

      return Promise.all(Array.from(surfaces.keys()).map(function (name) {
        var was = JSON.stringify(Array.from(surfaces.get(name).versions));

        return fetchSurface(name).then(function (after) {
          if (JSON.stringify(Array.from(after.versions)) !== was) changed = true;
        }, function (e) {
          if (e.kind === UNREGISTERED) changed = true;
          debug('Revalidate ' + name + ': ' + e.message);
        });
      })).then(function () { return changed; });
    }

    return {
      origin: origin,
      counts: counts,
      surface: surface,
      contract: contract,
      current: current,
      search: search,
      revalidate: revalidate
    };
  }

  var api = {
    version: VERSION,
    createResolver: createResolver,
    parseContract: parseContract,
    parseVersion: parseVersion,
    normaliseOrigin: normaliseOrigin,
    ResolveError: ResolveError,
    ACCEPT: ACCEPT,
    DEFAULT_ORIGIN: DEFAULT_ORIGIN,
    UNREGISTERED: UNREGISTERED,
    UNPUBLISHED: UNPUBLISHED,
    NO_VERSION: NO_VERSION,
    DEPRECATED: DEPRECATED,
    UNAVAILABLE: UNAVAILABLE
  };

  root.CPResolver = api;

  if (typeof module === 'object' && module && typeof module.exports === 'object') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
