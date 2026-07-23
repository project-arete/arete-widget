// electron/compose-runner.js
// ---------------------------------------------------------------------------
// Runs ONE draft widget live on the realm — the Composer's "go live" (Phase 3).
// Node-portable (no Electron): main.js and headless tests drive it the same
// way (scripts/test-compose-live.js runs it against a real realm).
//
// It mirrors widget-manager's live loop for a TRANSIENT definition — the
// canvas draft — with STABLE identity owned by the canvas: node/context IDs
// are minted ONCE when the canvas is created and reused on every go-live.
// Attaching goes through arete-service.instantiate (v29 value-preserving —
// re-declaring an existing capability is the value wiper), and because the
// SDK has no DELETE, stop() only drops handles: the realm node persists and
// the SAME ids pick it up next time, so preview cycles never orphan nodes.
// ---------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { deriveState, computeActions, reconcilePending } from '../core/behavior-engine.js';

export class ComposeRunner extends EventEmitter {
  #service;
  #live = null; // { inst:{systemId,nodeId,contextId}, model, caps, name, pending, state, connections, perConn, peers }
  #lastKeys = {};

  constructor({ service }) {
    super();
    this.#service = service;
  }

  isLive() {
    return !!this.#live;
  }

  /**
   * Put the draft on the realm. @returns {{systemId,nodeId,contextId,contexts}}
   * @param {object} spec {model, name, nodeId, contexts: [{id,name}], applyInit}
   *   (legacy single contextId/contextName still accepted — one-entry list)
   */
  async goLive({ model, name, nodeId, contextId, contextName, contexts, applyInit }) {
    if (!model || !Array.isArray(model.capabilities) || !model.capabilities.length) {
      throw new Error('The draft has no valid model to go live with.');
    }
    const ctxs = (Array.isArray(contexts) && contexts.length
      ? contexts
      : [{ id: contextId, name: contextName }])
      .map((c) => ({ id: String(c.id || '').trim(), name: String(c.name || '') }))
      .filter((c) => c.id);
    if (!nodeId || !ctxs.length) throw new Error('The canvas has no stable identity (nodeId/contexts).');
    if (this.#live) this.stop();
    const { systemId, caps, capsByCtx } = await this.#service.instantiate({
      nodeId,
      nodeName: name,
      contexts: ctxs,
      capabilities: model.capabilities.map((c) => ({ profile: c.profile, role: c.role })),
    });
    this.#live = {
      inst: { systemId, nodeId, contextId: ctxs[0].id, contexts: ctxs.map((c) => c.id) },
      ctxs,
      model,
      caps,
      capsByCtx,
      name,
      pending: {},
      state: {},
      connections: 0,
      perConn: {},
      peers: [],
    };
    if (applyInit) {
      for (const prop in model.behavior.init) {
        await this.#put(prop, model.behavior.init[prop]).catch(() => {});
      }
    }
    this.#process(this.#lastKeys);
    return { systemId, nodeId, contextId: ctxs[0].id, contexts: ctxs };
  }

  /** Drop live handles (realm node persists — same ids reattach next time). */
  stop() {
    if (!this.#live) return;
    this.#live = null;
    this.emit('state', null);
  }

  /** Feed every (debounced) keys push here — same contract as the manager. */
  onKeys(keys) {
    this.#lastKeys = keys || {};
    if (this.#live) this.#process(this.#lastKeys);
  }

  #peersFor(keys) {
    const { inst, model, ctxs } = this.#live;
    const peers = [];
    for (const ctx of ctxs) {
      for (const cap of model.capabilities) {
        const prefix = `cns/${inst.systemId}/nodes/${inst.nodeId}/contexts/${ctx.id}/${cap.role}/${cap.profile}/connections/`;
        const peerSide = cap.role === 'provider' ? 'consumer' : 'provider';
        for (const k in keys) {
          if (!k.startsWith(prefix)) continue;
          const m = k.slice(prefix.length).match(/^([^/]+)\/(consumer|provider)$/);
          if (!m || m[2] !== peerSide) continue;
          const p = String(keys[k]).split('/');
          peers.push({
            connId: m[1],
            profile: cap.profile,
            ctxId: ctx.id,
            context: ctx.name,
            system: keys[`cns/${p[1]}/name`] || p[1],
            node: keys[`cns/${p[1]}/nodes/${p[3]}/name`] || p[3],
          });
        }
      }
    }
    return peers;
  }

  #process(keys) {
    const live = this.#live;
    if (!live) return;
    const { state, connections, perConn } = deriveState(keys, live.inst, live.model);
    reconcilePending(state, live.pending, perConn);
    const peers = this.#peersFor(keys);
    const changed =
      connections !== live.connections ||
      JSON.stringify(state) !== JSON.stringify(live.state) ||
      JSON.stringify(perConn) !== JSON.stringify(live.perConn) ||
      JSON.stringify(peers) !== JSON.stringify(live.peers);
    live.state = state;
    live.connections = connections;
    live.perConn = perConn;
    live.peers = peers;

    const actions = computeActions(live.model, state, live.pending, perConn);
    for (const a of actions) {
      if (a.connId) {
        live.pending[a.connId + '|' + a.property] = String(a.value);
        this.#putConn(a.property, a.value, a.connId).catch((e) =>
          this.emit('log', { level: 'error', message: `Draft reply put failed: ${e.message || e}` })
        );
        continue;
      }
      this.#put(a.property, a.value).catch((e) =>
        this.emit('log', { level: 'error', message: `Draft auto-actualize failed: ${e.message || e}` })
      );
    }
    if (changed || actions.length) this.#push();
  }

  #push() {
    const live = this.#live;
    if (!live) return;
    this.emit('state', {
      state: { ...live.state, ...live.pending },
      connections: live.connections,
      peers: live.peers,
      perConn: live.perConn,
    });
  }

  /** A control interaction from the live canvas (toggle, field, …). */
  async putProperty(prop, value, connId = null) {
    if (!this.#live) throw new Error('The draft is not live.');
    if (connId) await this.#putConn(prop, value, connId);
    else await this.#put(prop, value);
    this.#push(); // optimistic — the echo confirms
  }

  // Unscoped writes FAN OUT to every attached context (multi-context go-live
  // mirrors widget-manager: one value, N presences).
  async #put(prop, value) {
    const live = this.#live;
    const r = live.model.resolve[prop];
    if (!r || !live.model.writable.includes(prop)) {
      throw new Error(`Property "${prop}" is not writable by this draft.`);
    }
    const byCtx = live.capsByCtx || { [live.inst.contextId]: live.caps };
    live.pending[prop] = String(value);
    let wrote = 0;
    for (const ctxId in byCtx) {
      const cap = byCtx[ctxId][`${r.role}|${r.profile}`];
      if (!cap) continue;
      await cap.put(prop, String(value));
      wrote++;
    }
    if (!wrote) throw new Error(`No live ${r.role} handle for ${r.profile}.`);
  }

  async #putConn(prop, value, connId) {
    const live = this.#live;
    const r = live.model.resolve[prop];
    if (!r || !live.model.writable.includes(prop)) {
      throw new Error(`Property "${prop}" is not writable by this draft.`);
    }
    const peer = live.peers.find((p) => p.connId === connId);
    if (!peer) throw new Error('Unknown connection for this draft.');
    if (peer.profile !== r.profile) {
      throw new Error(`Connection ${connId} belongs to ${peer.profile}, not ${r.profile} — refusing the misaddressed write.`);
    }
    // Route to the CONTEXT this connection lives in (multi-context go-live).
    const key =
      `cns/${live.inst.systemId}/nodes/${live.inst.nodeId}/contexts/${peer.ctxId || live.inst.contextId}` +
      `/${r.role}/${r.profile}/connections/${connId}/properties/${prop}`;
    await this.#service.putKey(key, String(value));
    live.perConn = {
      ...live.perConn,
      [connId]: { ...(live.perConn[connId] || {}), [prop]: String(value) },
    };
  }
}
