// electron/widget-manager.js
// ---------------------------------------------------------------------------
// Owns everything "widget": definition files, validation against the CP
// registry, the persisted instance list, live SDK capability handles, and the
// auto-actualize loop. Runs in the MAIN process (or plain Node for headless
// tests) — imports Node APIs but NEVER Electron, so scripts/test-widget.js can
// drive it directly.
//
// Definition files: *.yaml / *.yml in one or more widget dirs (the app ships
// widgets/ and also scans a per-user dir so users can add widgets without
// touching the app bundle). A definition whose CP is not in the cp.padi.io
// registry FAILS validation and cannot be instantiated (project hard rule).
//
// An INSTANCE = one virtual widget: a Node (+ Context) under this app's
// System, with the definition's capabilities declared. Instances persist in
// instances.json with STABLE node/context IDs and are re-attached on every
// connect. The behavior engine then converges them on their declared rules —
// including changes that happened while the widget was offline.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import yaml from 'js-yaml';

import { validateDefinition } from '../core/widget-spec.js';
import { deriveState, computeActions, reconcilePending } from '../core/behavior-engine.js';

const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function base62(len = 22) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += B62[bytes[i] % 62];
  return out;
}

export class WidgetManager extends EventEmitter {
  #service;
  #dataDir;
  #bundledDir;
  #userDir;
  #libraryCacheDir;
  #libraryUrl;
  #fetchProfile;
  #defs = new Map(); // widgetId -> {id, file, source, ok, errors, title, description, model}
  #instances = [];   // persisted records
  #live = new Map(); // instanceId -> {caps, pending, state, connections}
  #lastKeys = {};

  /**
   * @param {object} deps
   * @param {AreteService} deps.service
   * @param {string} deps.dataDir where instances.json lives
   * @param {string} deps.bundledDir definitions shipped with the app (offline fallback)
   * @param {string} [deps.userDir] the user's own local definitions (highest precedence)
   * @param {string} [deps.libraryCacheDir] where fetched online-library files are cached
   * @param {string} [deps.libraryUrl] base URL of the online catalog ('' disables)
   * @param {(name:string)=>Promise<object|null>} deps.fetchProfile registry fetch (cached)
   */
  constructor({ service, dataDir, bundledDir, userDir, libraryCacheDir, libraryUrl, fetchProfile }) {
    super();
    this.#service = service;
    this.#dataDir = dataDir;
    this.#bundledDir = bundledDir;
    this.#userDir = userDir || null;
    this.#libraryCacheDir = libraryCacheDir || null;
    this.#libraryUrl = (libraryUrl || '').trim();
    this.#fetchProfile = fetchProfile;
    this.#loadInstances();
  }

  setLibraryUrl(url) {
    this.#libraryUrl = (url || '').trim();
  }

  /** Info for the UI: where the library comes from and how fresh the cache is. */
  libraryInfo() {
    let updatedAt = null;
    try {
      updatedAt = fs.statSync(path.join(this.#libraryCacheDir, 'index.json')).mtimeMs;
    } catch (_) {}
    return {
      url: this.#libraryUrl,
      updatedAt,
      count: [...this.#defs.values()].filter((d) => d.source === 'library').length,
    };
  }

  // Fetch the online catalog into the local cache. Failures are non-fatal —
  // the previously cached files (or bundled defs) keep working offline.
  async #refreshLibrary() {
    if (!this.#libraryUrl || !this.#libraryCacheDir) return;
    const base = this.#libraryUrl.replace(/\/+$/, '');
    try {
      const idxRes = await fetch(base + '/index.json', {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
      if (!idxRes.ok) throw new Error('HTTP ' + idxRes.status);
      const idx = await idxRes.json();
      if (!idx || !Array.isArray(idx.widgets)) throw new Error('not a widget catalog');

      fs.mkdirSync(this.#libraryCacheDir, { recursive: true });
      const keep = new Set(['index.json']);
      for (const w of idx.widgets) {
        if (!w || typeof w.file !== 'string') continue;
        const fname = path.basename(w.file); // flatten; never write outside the cache dir
        if (!/\.ya?ml$/i.test(fname)) continue;
        const res = await fetch(base + '/' + w.file, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error(`${w.file}: HTTP ${res.status}`);
        fs.writeFileSync(path.join(this.#libraryCacheDir, fname), await res.text());
        keep.add(fname);
      }
      // Drop cached files that left the catalog.
      for (const f of fs.readdirSync(this.#libraryCacheDir)) {
        if (!keep.has(f)) fs.rmSync(path.join(this.#libraryCacheDir, f), { force: true });
      }
      fs.writeFileSync(path.join(this.#libraryCacheDir, 'index.json'), JSON.stringify(idx));
      this.#log('info', `Widget library refreshed — ${idx.widgets.length} definition(s) from ${base}.`);
    } catch (e) {
      this.#log('warn', `Widget library refresh failed (${e.message || e}) — using cached copies.`);
    }
  }

  #log(level, message) {
    this.emit('log', { level, message, ts: Date.now() });
  }

  // ------------------------------------------------------------ definitions
  /**
   * (Re)load all definitions. Sources in ASCENDING precedence — a later source
   * overrides an earlier one with the same widget id:
   *   bundled (shipped with the app) < library (online catalog, cached) < local (user's folder)
   * @param {boolean} [refresh=true] also re-fetch the online catalog first
   */
  async loadDefinitions(refresh = true) {
    if (refresh) await this.#refreshLibrary();

    const sources = [
      { dir: this.#bundledDir, source: 'bundled' },
      { dir: this.#libraryCacheDir, source: 'library' },
      { dir: this.#userDir, source: 'local' },
    ];
    const defs = new Map();
    for (const { dir, source } of sources) {
      if (!dir) continue;
      let entries = [];
      try {
        entries = fs.readdirSync(dir).sort();
      } catch (_) {
        continue; // dir may not exist yet
      }
      for (const f of entries) {
        if (!/\.ya?ml$/i.test(f)) continue;
        const file = path.join(dir, f);
        let raw;
        try {
          raw = yaml.load(fs.readFileSync(file, 'utf8'));
        } catch (e) {
          const id = f.replace(/\.ya?ml$/i, '');
          defs.set(id, { id, file, source, ok: false, errors: ['YAML parse error: ' + (e.message || e)], title: id, description: '', model: null });
          continue;
        }
        // Resolve every referenced profile from the registry FIRST (hard rule).
        const profiles = {};
        const wanted = new Set(
          (Array.isArray(raw?.capabilities) ? raw.capabilities : [])
            .map((c) => c && c.profile)
            .filter(Boolean)
        );
        for (const name of wanted) profiles[name] = await this.#fetchProfile(name);

        const res = validateDefinition(raw, profiles);
        const id = res.model ? res.model.id : f.replace(/\.ya?ml$/i, '');
        if (defs.has(id) && defs.get(id).source === source) {
          this.#log('warn', `Two ${source} files define widget id "${id}" — keeping ${defs.get(id).file}, ignoring ${file}.`);
          continue;
        }
        if (defs.has(id)) {
          this.#log('info', `Widget "${id}": ${source} definition overrides the ${defs.get(id).source} one.`);
        }
        defs.set(id, {
          id,
          file,
          source,
          ok: res.ok,
          errors: res.errors,
          title: res.model ? res.model.title : id,
          description: res.model ? res.model.description : '',
          model: res.model,
        });
      }
    }
    this.#defs = defs;
    const bad = [...defs.values()].filter((d) => !d.ok);
    this.#log('info', `Loaded ${defs.size} widget definition(s)` + (bad.length ? ` — ${bad.length} invalid.` : '.'));
    for (const d of bad) this.#log('warn', `Widget "${d.id}" invalid: ${d.errors[0]}`);
    this.emit('defs', this.listDefinitions());
    return this.listDefinitions();
  }

  listDefinitions() {
    return [...this.#defs.values()].map((d) => ({
      id: d.id,
      file: d.file,
      source: d.source,
      ok: d.ok,
      errors: d.errors,
      title: d.title,
      description: d.description,
      icon: d.model ? d.model.icon || '' : '',
      color: d.model ? d.model.color || '' : '',
      capabilities: d.model ? d.model.capabilities.map((c) => ({ profile: c.profile, role: c.role, title: c.title })) : [],
      hasBehavior: !!(d.model && d.model.behavior.rules.length),
    }));
  }

  getModel(widgetId) {
    const d = this.#defs.get(widgetId);
    return d && d.ok ? d.model : null;
  }

  // ------------------------------------------------------------- instances
  #instancesFile() {
    return path.join(this.#dataDir, 'instances.json');
  }

  #loadInstances() {
    try {
      this.#instances = JSON.parse(fs.readFileSync(this.#instancesFile(), 'utf8'));
      if (!Array.isArray(this.#instances)) this.#instances = [];
    } catch (_) {
      this.#instances = [];
    }
  }

  #saveInstances() {
    try {
      fs.mkdirSync(this.#dataDir, { recursive: true });
      fs.writeFileSync(this.#instancesFile(), JSON.stringify(this.#instances, null, 2));
    } catch (e) {
      this.#log('error', 'Failed to persist instances: ' + (e.message || e));
    }
  }

  listInstances() {
    return this.#instances.map((inst) => {
      const live = this.#live.get(inst.id);
      const def = this.#defs.get(inst.widgetId);
      return {
        ...inst,
        attached: !!live,
        state: live ? live.state : {},
        connections: live ? live.connections : 0,
        peers: live ? live.peers || [] : [],
        perConn: live ? live.perConn || {} : {},
        rtt: live ? live.rttTimes || {} : {},
        widgetOk: !!(def && def.ok),
        widgetTitle: def ? def.title : inst.widgetId,
      };
    });
  }

  // Who is this instance bound to? Read the connection peer paths from the
  // keys and resolve their system/node names — the visible face of a binding.
  #peersFor(inst, model, keys) {
    const peers = [];
    for (const cap of model.capabilities) {
      const prefix = `cns/${inst.systemId}/nodes/${inst.nodeId}/contexts/${inst.contextId}/${cap.role}/${cap.profile}/connections/`;
      const peerSide = cap.role === 'provider' ? 'consumer' : 'provider';
      for (const k in keys) {
        if (!k.startsWith(prefix)) continue;
        const m = k.slice(prefix.length).match(/^([^/]+)\/(consumer|provider)$/);
        if (!m || m[2] !== peerSide) continue;
        const p = String(keys[k]).split('/'); // cns/<sys>/nodes/<node>/contexts/<ctx>
        peers.push({
          connId: m[1],
          profile: cap.profile,
          system: keys[`cns/${p[1]}/name`] || p[1],
          node: keys[`cns/${p[1]}/nodes/${p[3]}/name`] || p[3],
        });
      }
    }
    return peers;
  }

  getInstance(id) {
    return this.listInstances().find((i) => i.id === id) || null;
  }

  /**
   * Create a new widget instance. If contextId is given we JOIN that context
   * (the broker matches on context ID); otherwise a fresh one is minted.
   */
  async addInstance({ widgetId, name, contextId, contextName }) {
    const def = this.#defs.get(widgetId);
    if (!def || !def.ok) throw new Error(`Widget "${widgetId}" is not available (invalid or unknown definition).`);
    const instName = (name || '').trim();
    if (!instName) throw new Error('The widget needs a name (it becomes the Node name).');

    const inst = {
      id: base62(10),
      widgetId,
      name: instName,
      nodeId: base62(22),
      contextId: (contextId || '').trim() || base62(22),
      contextName: (contextName || '').trim() || instName,
      createdAt: new Date().toISOString(),
      initDone: false,
    };
    this.#instances.push(inst);
    this.#saveInstances();
    this.#log('info', `Widget "${instName}" (${widgetId}) created.`);

    try {
      await this.#attach(inst);
    } catch (e) {
      this.#log('warn', `Widget "${instName}" saved but not yet on the realm: ${e.message || e}`);
    }
    this.emit('instances', this.listInstances());
    return this.getInstance(inst.id);
  }

  /**
   * Edit an existing instance: rename it and/or move it to another context.
   * The widget TYPE is deliberately immutable — different capabilities are a
   * different contract, so that is a new widget, not an edit.
   * Re-attaches live when connected, so the realm picks the changes up
   * immediately (node rename propagates; a context move re-registers the
   * capabilities under the new context — the old context registration stays
   * on the realm until cleaned up there, the SDK has no delete).
   */
  async updateInstance({ id, name, contextId, contextName }) {
    const inst = this.#instances.find((i) => i.id === id);
    if (!inst) throw new Error('Unknown widget instance.');
    const newName = (name || '').trim();
    if (!newName) throw new Error('The widget needs a name (it becomes the Node name).');

    const newCtxId = (contextId || '').trim() || inst.contextId;
    const newCtxName = (contextName || '').trim() || inst.contextName;
    const ctxMoved = newCtxId !== inst.contextId;
    const changed = ctxMoved || newName !== inst.name || newCtxName !== inst.contextName;
    if (!changed) return this.getInstance(id);

    inst.name = newName;
    inst.contextId = newCtxId;
    inst.contextName = newCtxName;
    this.#saveInstances();
    this.#log('info', `Widget "${newName}" updated` + (ctxMoved ? ' (moved to another context — the old context registration remains on the realm until cleaned up there).' : '.'));

    if (this.#live.has(id)) {
      this.#live.delete(id);
      try {
        await this.#attach(inst);
      } catch (e) {
        this.#log('warn', `Widget "${newName}" updated but re-attach failed: ${e.message || e}`);
      }
    }
    this.emit('instances', this.listInstances());
    return this.getInstance(id);
  }

  /** Forget an instance locally (its Node remains on the realm until cleaned up there). */
  removeInstance(id) {
    const inst = this.#instances.find((i) => i.id === id);
    this.#live.delete(id);
    this.#instances = this.#instances.filter((i) => i.id !== id);
    this.#saveInstances();
    if (inst) this.#log('info', `Widget "${inst.name}" removed from this app (realm node not deleted).`);
    this.emit('instances', this.listInstances());
  }

  /** Forget EVERY instance locally (realm nodes remain until cleaned up there). */
  removeAllInstances() {
    const count = this.#instances.length;
    this.#live.clear();
    this.#instances = [];
    this.#saveInstances();
    if (count) this.#log('info', `All ${count} widget(s) removed from this app (realm nodes not deleted).`);
    this.emit('instances', this.listInstances());
    return count;
  }

  // ------------------------------------------------------ attach / detach
  async #attach(inst) {
    const def = this.#defs.get(inst.widgetId);
    if (!def || !def.ok) throw new Error(`Definition "${inst.widgetId}" unavailable.`);
    const { systemId, caps } = await this.#service.instantiate({
      nodeId: inst.nodeId,
      nodeName: inst.name,
      contextId: inst.contextId,
      contextName: inst.contextName,
      capabilities: def.model.capabilities.map((c) => ({ profile: c.profile, role: c.role })),
    });
    inst.systemId = systemId;
    this.#live.set(inst.id, { caps, pending: {}, state: {}, connections: 0, rttProbes: {}, rttTimes: {} });

    // First-ever attach: issue the definition's init puts.
    if (!inst.initDone) {
      for (const prop in def.model.behavior.init) {
        await this.#put(inst, def.model, prop, def.model.behavior.init[prop]);
      }
      inst.initDone = true;
      this.#saveInstances();
    }
    // Converge immediately against whatever the realm looks like right now.
    this.#processInstance(inst, this.#lastKeys);
  }

  /** (Re-)attach every stored instance — call after each successful connect. */
  async attachAll() {
    for (const inst of this.#instances) {
      try {
        await this.#attach(inst);
      } catch (e) {
        this.#log('warn', `Could not attach widget "${inst.name}": ${e.message || e}`);
      }
    }
    this.emit('instances', this.listInstances());
  }

  /** Drop live handles — call on disconnect. */
  detachAll() {
    this.#live.clear();
    this.emit('instances', this.listInstances());
  }

  // ------------------------------------------------------ the live loop
  /** Feed every (debounced) keys push here. Derives state + runs behavior. */
  onKeys(keys) {
    this.#lastKeys = keys || {};
    for (const inst of this.#instances) this.#processInstance(inst, this.#lastKeys);
  }

  #processInstance(inst, keys) {
    const live = this.#live.get(inst.id);
    const def = this.#defs.get(inst.widgetId);
    if (!live || !def || !def.ok || !inst.systemId) return;

    const { state, connections, perConn } = deriveState(keys, inst, def.model);
    reconcilePending(state, live.pending, perConn);
    const peers = this.#peersFor(inst, def.model, keys);
    const rttChanged = this.#rttCollect(live, def.model, perConn);

    const changed =
      rttChanged ||
      connections !== live.connections ||
      JSON.stringify(state) !== JSON.stringify(live.state) ||
      JSON.stringify(perConn) !== JSON.stringify(live.perConn || {}) ||
      JSON.stringify(peers) !== JSON.stringify(live.peers || []);
    live.state = state;
    live.connections = connections;
    live.perConn = perConn;
    live.peers = peers;

    // Auto-actualize: converge on the declared rules (perConn feeds
    // aggregate rules; reply rules produce connection-addressed actions).
    const actions = computeActions(def.model, state, live.pending, perConn);
    for (const a of actions) {
      if (a.connId) {
        live.pending[a.connId + '|' + a.property] = String(a.value);
        this.#putConn(inst, def.model, a.property, a.value, a.connId).catch((e) =>
          this.#log('error', `Reply put failed for "${inst.name}".${a.property}: ${e.message || e}`)
        );
        this.#log('info', `⚙ ${inst.name}: ${a.property} → "${a.value}" (reply on ${a.connId}).`);
        continue;
      }
      this.#put(inst, def.model, a.property, a.value).catch((e) =>
        this.#log('error', `Auto-actualize put failed for "${inst.name}".${a.property}: ${e.message || e}`)
      );
      this.#log('info', `⚙ ${inst.name}: ${a.property} → "${a.value}" (rule).`);
    }

    if (changed || actions.length) {
      this.emit('state', {
        id: inst.id,
        state: { ...state, ...live.pending },
        connections,
        peers,
        perConn,
        rtt: live.rttTimes || {},
      });
    }
  }

  // ---- round-trip measurement (the `rtt` view primitive) ----
  // A write to a probe's `send:` property stamps t0; the clock stops per
  // CONNECTION when that connection's `echo:` comes back carrying the same
  // value. Times live only in the app — nothing extra crosses the wire.
  #rttStamp(inst, model, prop, value, connId = null) {
    const live = this.#live.get(inst.id);
    if (!live) return;
    for (const p of model.view) {
      if (p.type !== 'rtt' || p.send !== prop) continue;
      live.rttProbes = live.rttProbes || {};
      live.rttProbes[connId ? `${p.echo}|${connId}` : p.echo] = { value: String(value), t0: Date.now() };
      // A fresh probe restarts the clock for the connections it covers.
      const times = { ...(live.rttTimes || {}) };
      if (connId) {
        if (times[p.echo]) { times[p.echo] = { ...times[p.echo] }; delete times[p.echo][connId]; }
      } else {
        times[p.echo] = {};
      }
      live.rttTimes = times;
    }
  }

  #rttCollect(live, model, perConn) {
    let changed = false;
    const probes = live.rttProbes || {};
    for (const p of model.view) {
      if (p.type !== 'rtt') continue;
      for (const connId in perConn) {
        const v = perConn[connId] ? perConn[connId][p.echo] : undefined;
        if (v === undefined) continue;
        // A connection-scoped probe (peer-chip send) beats the broadcast one.
        const probe = probes[`${p.echo}|${connId}`] || probes[p.echo];
        if (!probe || v !== probe.value) continue;
        live.rttTimes = live.rttTimes || {};
        const t = (live.rttTimes[p.echo] = live.rttTimes[p.echo] || {});
        if (t[connId] === undefined) { t[connId] = Date.now() - probe.t0; changed = true; }
      }
    }
    return changed;
  }

  async #put(inst, model, prop, value) {
    const live = this.#live.get(inst.id);
    if (!live) throw new Error('Widget is not attached (not connected).');
    const r = model.resolve[prop];
    if (!r || !model.writable.includes(prop)) {
      throw new Error(`Property "${prop}" is not writable by this widget.`);
    }
    const cap = live.caps[`${r.role}|${r.profile}`];
    if (!cap) throw new Error(`No live ${r.role} handle for ${r.profile}.`);
    live.pending[prop] = String(value);
    this.#rttStamp(inst, model, prop, value); // clock starts at the write
    await cap.put(prop, String(value));
  }

  // Per-connection write: sets ONE connection's property. The control plane
  // mirrors it to the same connection at the peer end only — this is how a
  // faceplate with a peer selected controls JUST that peer. Note the widget's
  // own capability value is untouched, so connections may now legitimately
  // disagree — the faceplate shows that as 'mixed' in the All view.
  async #putConn(inst, model, prop, value, connId) {
    const live = this.#live.get(inst.id);
    if (!live) throw new Error('Widget is not attached (not connected).');
    const r = model.resolve[prop];
    if (!r || !model.writable.includes(prop)) {
      throw new Error(`Property "${prop}" is not writable by this widget.`);
    }
    if (!(live.peers || []).some((p) => p.connId === connId)) {
      throw new Error('Unknown connection for this widget.');
    }
    const key =
      `cns/${inst.systemId}/nodes/${inst.nodeId}/contexts/${inst.contextId}` +
      `/${r.role}/${r.profile}/connections/${connId}/properties/${prop}`;
    this.#rttStamp(inst, model, prop, value, connId); // clock starts at the write
    await this.#service.putKey(key, String(value));
    // Optimistic per-connection echo so the faceplate reacts instantly.
    live.perConn = {
      ...(live.perConn || {}),
      [connId]: { ...((live.perConn || {})[connId] || {}), [prop]: String(value) },
    };
    this.#log('info', `⇢ ${inst.name}: ${prop} → "${value}" (this connection only).`);
  }

  /** A user action from a faceplate (toggle click, field edit).
   *  With connId: scoped to that one connection; without: capability-level
   *  put, broadcast by the control plane to every connection. */
  async putProperty(instanceId, prop, value, connId = null) {
    const inst = this.#instances.find((i) => i.id === instanceId);
    if (!inst) throw new Error('Unknown widget instance.');
    const def = this.#defs.get(inst.widgetId);
    if (!def || !def.ok) throw new Error('Widget definition unavailable.');
    if (connId) await this.#putConn(inst, def.model, prop, value, connId);
    else await this.#put(inst, def.model, prop, value);
    const live = this.#live.get(instanceId);
    // Optimistic push so the faceplate reacts instantly; the echo confirms.
    this.emit('state', {
      id: instanceId,
      state: { ...live.state, ...live.pending },
      connections: live.connections,
      peers: live.peers || [],
      perConn: live.perConn || {},
      rtt: live.rttTimes || {},
    });
  }
}
