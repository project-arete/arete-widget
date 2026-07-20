// arete-service.js
// ---------------------------------------------------------------------------
// Thin wrapper around the Arete Node SDK `Client`, meant to run in Electron's
// MAIN process (the SDK uses `ws` + `fs` and cannot run in a renderer).
//
// Responsibilities:
//   - install the stable System-ID patch before constructing a Client
//   - connect + authenticate to a CNS/CP control plane
//   - manage TLS for self-signed control planes
//   - register a System -> Node -> Context (identity scaffolding)
//   - poll/forward status and log events to whoever is listening (the UI)
//
// What it deliberately does NOT do: declare a provider/consumer of a Connection
// Profile. That is the "CP logic" and is left as an annotated stub near the
// bottom of this file — see declareRole().
// ---------------------------------------------------------------------------

import { EventEmitter } from 'events';
import { installSystemIdPatch } from './arete-system-id.js';

// NOTE: the SDK reads System ID at `new Client()` time, so the patch must be
// installed before the first construction. installSystemIdPatch() is idempotent;
// main.js calls it again with the persisted seed. Import the SDK lazily inside
// connect() so the patch is guaranteed to be in place first.
let ClientCtor = null;
async function loadClient() {
  if (!ClientCtor) {
    installSystemIdPatch(); // safety net; real seed is set from main.js
    const mod = await import('arete-sdk');
    ClientCtor = mod.Client;
  }
  return ClientCtor;
}

export class AreteService extends EventEmitter {
  #client = null;
  #statusTimer = null;
  #keysTimer = null;
  #state = 'disconnected'; // disconnected | connecting | connected | error
  #lastError = null;
  #identity = { system: null, node: null, context: null };
  #savedTlsEnv = undefined;
  #systemName = ''; // custom system name registered on connect (e.g. "Arete Widget")
  #system = null; // cached SDK System instance — client.system() must NOT be re-called casually (see #registerSystem)
  #nameGuardAt = 0; // last time the name watchdog re-applied the custom name
  #currentHost = ''; // host of the realm we're connected to (no credentials)

  get state() {
    return this.#state;
  }

  /** Structured snapshot the UI renders. */
  getStatus() {
    const c = this.#client;
    return {
      state: this.#state,
      isOpen: !!(c && c.isOpen && c.isOpen()),
      version: c ? c.version || '' : '',
      stats: c ? c.stats || {} : {},
      identity: this.#identity,
      lastError: this.#lastError,
      host: this.#currentHost,
    };
  }

  /**
   * The full CNS key namespace snapshot the monitor views render from, with
   * secret `/token` keys stripped so they never reach the renderer.
   * @returns {Object<string,string>}
   */
  getKeys() {
    const c = this.#client;
    const src = c && c.keys ? c.keys : {};
    const out = {};
    for (const k in src) {
      if (k.endsWith('/token')) continue; // secrets — never expose
      out[k] = src[k];
    }
    return out;
  }

  // Coalesce bursty SDK 'update' events into at most one 'keys' push per window.
  #scheduleKeysPush() {
    if (this.#keysTimer) return;
    this.#keysTimer = setTimeout(() => {
      this.#keysTimer = null;
      this.#checkSystemName();
      this.emit('keys', this.getKeys());
    }, 400);
    if (this.#keysTimer.unref) this.#keysTimer.unref();
  }

  #log(level, message) {
    this.emit('log', { level, message, ts: Date.now() });
  }

  #setState(state) {
    this.#state = state;
    this.emit('status', this.getStatus());
  }

  /**
   * Connect and authenticate.
   * @param {object} opts
   * @param {string} opts.protocol 'wss:' or 'ws:'
   * @param {string} opts.host     hostname WITHOUT credentials, e.g. 'my.realm.example.com'
   * @param {number} opts.port     e.g. 443
   * @param {string} [opts.username]
   * @param {string} [opts.password]
   * @param {boolean} [opts.allowSelfSigned] disable TLS verification (self-signed hosts)
   * @param {number} [opts.timeout] connect timeout ms (default 8000)
   */
  async connect(opts) {
    if (this.#client) await this.disconnect();

    const {
      protocol = 'wss:',
      host,
      port = 443,
      username = '',
      password = '',
      allowSelfSigned = false,
      timeout = 8000,
      systemName = '',
    } = opts || {};
    this.#systemName = systemName;

    if (!host) throw new Error('A host is required to connect.');
    this.#currentHost = host;

    // --- TLS: the Node SDK passes no options to `new WebSocket()`, so the only
    // way to accept a self-signed cert is the process-wide escape hatch. We set
    // it just before connecting and restore it on disconnect. This is insecure
    // by design and only appropriate for a known self-signed control plane.
    if (allowSelfSigned) {
      this.#savedTlsEnv = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
      this.#log('warn', 'TLS verification DISABLED for this connection (self-signed host).');
    }

    // --- Auth: the Node SDK has no username/password parameter. Credentials are
    // carried as HTTP Basic userinfo in the WebSocket URL; the `ws` library turns
    // userinfo into an Authorization: Basic header automatically. We fold the
    // (URL-encoded) credentials into the host the SDK will use to build the URI.
    let hostForSdk = host;
    if (username || password) {
      const u = encodeURIComponent(username);
      const p = encodeURIComponent(password);
      hostForSdk = `${u}:${p}@${host}`;
    }

    this.#lastError = null;
    this.#setState('connecting');
    this.#log('info', `Connecting to ${protocol}//${host}:${port} ...`);

    const Client = await loadClient();

    this.#client = new Client({ protocol, host: hostForSdk, port });

    // Resolves when the first update (initial cache snapshot) has been merged —
    // the SDK emits 'open' exactly then. Registering/renaming before that loses
    // a race: the snapshot can overwrite our rename in the local cache.
    const firstUpdate = new Promise((res) => this.#client.on('open', res));

    // Forward the SDK's own lifecycle events to the log/UI.
    this.#client.on('open', () => this.#log('info', 'Control plane channel open (first update received).'));
    // The SDK auto-reconnects a dropped socket every 5s and re-emits 'open'
    // on the first update after each reopen. Without this, the app would sit
    // at "disconnected" forever after any blip (widgets detached, contexts
    // unjoinable) even though the SDK is happily back online.
    this.#client.on('open', () => {
      if ((this.#state === 'disconnected' || this.#state === 'error') && this.#client && this.#client.isOpen()) {
        this.#log('info', 'Connection re-established by the SDK — resuming.');
        this.#setState('connected');
        this.emit('reconnected'); // main re-attaches widget instances
      }
    });
    this.#client.on('update', () => {
      this.emit('status', this.getStatus());
      this.#scheduleKeysPush();
    });
    this.#client.on('close', () => {
      this.#log('warn', 'Connection closed by host.');
      this.#setState('disconnected');
    });
    this.#client.on('error', (err) => {
      this.#lastError = String(err && err.message ? err.message : err);
      this.#log('error', `Socket error: ${this.#lastError}`);
      this.#setState('error');
    });

    try {
      await this.#client.waitForOpen(timeout);
    } catch (e) {
      const msg = typeof e === 'string' ? e : e && e.message ? e.message : String(e);
      this.#lastError = msg;
      this.#log('error', `Failed to connect: ${msg}`);
      this.#setState('error');
      await this.disconnect();
      throw new Error(msg);
    }

    this.#log('info', 'Connected and authenticated to the Arete control plane.');
    this.#setState('connected');

    // Register this app's System and give it its custom name right away, so the
    // realm shows "Arete Electron Dashboard" rather than the machine hostname.
    // Wait for the initial cache snapshot first (see `firstUpdate` above).
    if (this.#systemName) {
      try {
        await Promise.race([firstUpdate, new Promise((r) => setTimeout(r, 5000))]);
        await this.#registerSystem();
      } catch (e) {
        this.#log('warn', `Could not register system name: ${e && e.message ? e.message : e}`);
      }
    }

    this.#startStatusPolling();
    return this.getStatus();
  }

  /**
   * Register this app's System and apply the custom system name.
   * The SDK's `client.system()` hardcodes os.hostname() as the name, so we
   * re-issue the same `systems` command with our name to rename it.
   * @returns {Promise<object>} the SDK System instance (has .id)
   */
  async #registerSystem() {
    // CRITICAL: client.system() re-registers the system with os.hostname()
    // ("mac.lan") EVERY time it is called — the SDK hardcodes the name. So we
    // (a) call it at most once per connection (cached System instance), and
    // (b) ALWAYS re-issue the rename right after. A guard that skips the
    // rename after the first call is exactly how the realm ends up showing
    // "mac.lan": call 2 resets the name and the guard suppresses the fix.
    if (this.#system) return this.#system;
    const system = await this.#client.system();
    this.#identity.system = system.id;
    if (this.#systemName) {
      await this.#client.command('systems', system.id, this.#systemName);
      this.#log('info', `Registered system as "${this.#systemName}".`);
    }
    this.#system = system;
    this.emit('status', this.getStatus());
    return system;
  }

  // Self-healing name watchdog, run on every (debounced) keys push: if the
  // realm ever shows this system under a different name (hostname reset from
  // any code path, another process, a reconnect...), re-apply the custom name.
  // Cooldown-guarded so a refusing control plane can't cause a command storm.
  #checkSystemName() {
    if (!this.#client || !this.#systemName || !this.#identity.system) return;
    const cur = this.#client.keys ? this.#client.keys[`cns/${this.#identity.system}/name`] : undefined;
    if (cur === undefined || cur === this.#systemName) return;
    const now = Date.now();
    if (now - this.#nameGuardAt < 10000) return;
    this.#nameGuardAt = now;
    this.#log('warn', `Realm shows this system as "${cur}" — re-applying "${this.#systemName}".`);
    this.#client
      .command('systems', this.#identity.system, this.#systemName)
      .catch((e) => this.#log('error', `Could not re-apply system name: ${e && e.message ? e.message : e}`));
  }

  /**
   * The realm System ID this app registered under (null before connect).
   */
  get systemId() {
    return this.#identity.system;
  }

  /**
   * Instantiate a WIDGET: register Node -> Context under this app's System and
   * declare each capability (provider/consumer of a CP). Requires an authed
   * connection. IDs must be STABLE across restarts (22-char base62).
   *
   * @param {object} spec {nodeId, nodeName, contextId, contextName,
   *                       capabilities: [{profile, role}]}
   * @returns {Promise<{systemId:string, caps:Object<string,object>}>} caps maps
   *   "<role>|<profile>" -> SDK Provider/Consumer handle (has .get/.put).
   */
  async instantiate({ nodeId, nodeName, contextId, contextName, capabilities = [] }) {
    if (!this.#client || !this.#client.isOpen()) {
      throw new Error('Not connected. Connect before adding widgets.');
    }
    const system = await this.#registerSystem();
    this.#identity.system = system.id;
    const node = await system.node(nodeId, nodeName, false);
    const context = await node.context(contextId, contextName);

    const caps = {};
    const keys = this.#client.keys || {};
    for (const c of capabilities) {
      const base = `cns/${system.id}/nodes/${nodeId}/contexts/${contextId}/${c.role}/${c.profile}`;
      // The control plane's provider/consumer declaration is NOT idempotent:
      // re-declaring an existing capability RESETS its property values to
      // empty (verified live — systems/nodes/contexts re-registration is
      // value-safe, the providers/consumers command is the wiper, and the
      // empties then propagate into every connection). If the capability is
      // already on the realm from a previous run, skip the command and build
      // a plain key-path handle instead — existing values then survive app
      // restarts and reconnects.
      if (keys[base + '/version'] !== undefined) {
        caps[`${c.role}|${c.profile}`] = this.#capHandle(base);
        continue;
      }
      const handle = c.role === 'provider'
        ? await context.provider(c.profile)
        : await context.consumer(c.profile);
      caps[`${c.role}|${c.profile}`] = handle;
    }
    this.#log(
      'info',
      `Widget node "${nodeName}" registered in context "${contextName}" ` +
        `(${capabilities.map((c) => `${c.role} of ${c.profile}`).join(', ') || 'no capabilities'}).`
    );
    this.emit('status', this.getStatus());
    return { systemId: system.id, caps };
  }

  /**
   * Raw key write on the realm — the PER-CONNECTION channel. The Widget app
   * uses this to write ONE connection's property
   * (.../connections/<id>/properties/<prop>); the control plane mirrors such
   * a write to the SAME connection at the peer end ONLY (verified live),
   * unlike a capability-level put which broadcasts to every connection.
   * Guarded to cns/ keys so a bug can never write outside the namespace.
   */
  async putKey(key, value) {
    if (!this.#client || !this.#client.isOpen()) {
      throw new Error('Not connected.');
    }
    if (typeof key !== 'string' || !key.startsWith('cns/')) {
      throw new Error('Refusing to write a non-cns key.');
    }
    return this.#client.put(key, String(value));
  }

  // Minimal stand-in for the SDK's Provider/Consumer handle (same get/put
  // surface) that issues NO registration command — used when the capability
  // already exists on the realm.
  #capHandle(base) {
    const client = this.#client;
    return {
      get: (property, def = null) => client.get(`${base}/properties/${property}`, def),
      put: (property, value) => client.put(`${base}/properties/${property}`, value),
    };
  }

  #startStatusPolling() {
    this.#stopStatusPolling();
    // stats() reads a cache the receiver thread fills; cheap to poll.
    this.#statusTimer = setInterval(() => {
      if (this.#client && this.#client.isOpen()) {
        this.emit('status', this.getStatus());
      }
    }, 2000);
    if (this.#statusTimer.unref) this.#statusTimer.unref();
  }

  #stopStatusPolling() {
    if (this.#statusTimer) {
      clearInterval(this.#statusTimer);
      this.#statusTimer = null;
    }
  }

  async disconnect() {
    this.#stopStatusPolling();
    if (this.#keysTimer) {
      clearTimeout(this.#keysTimer);
      this.#keysTimer = null;
    }
    if (this.#client) {
      try {
        this.#client.close();
      } catch (_) {
        /* ignore */
      }
      this.#client = null;
    }
    // Restore TLS env we may have overridden.
    if (this.#savedTlsEnv === undefined) {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    } else {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = this.#savedTlsEnv;
      this.#savedTlsEnv = undefined;
    }
    this.#identity = { system: null, node: null, context: null };
    this.#system = null; // next connect must register (and rename) afresh
    this.#nameGuardAt = 0;
    this.#currentHost = '';
    this.emit('keys', {}); // clear the monitor
    this.#setState('disconnected');
    this.#log('info', 'Disconnected.');
  }

  // NOTE on CP semantics: this service knows nothing about any specific CP.
  // Widget YAML definitions carry the semantics (validated against the
  // cp.padi.io registry in widget-manager.js), and the behavior engine in
  // core/behavior-engine.js converges instances on their declared rules.
  // We deliberately do NOT use the SDK's provider/consumer .watch() — it has a
  // null-match crash bug (key.match() can return null before .length) and can
  // miss events across reconnects. State is derived from the keys cache
  // instead, which this service already pushes (debounced) via 'keys'.
}
