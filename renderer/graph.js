// graph.js — the GRAPH tab: the realm's operational pattern, live.
// ---------------------------------------------------------------------------
// Where Monitor's graph is a topology tree, this one is OPERATIONAL — and it
// groups by RELATEDNESS, not by container: everything transitively connected
// (by broker connections, or by co-presence in a context) folds into ONE
// graph; unrelated activity gets its own group card. A node is drawn ONCE
// even when it spans contexts — a tenant wired to its landlord in one context
// and to signage in another is one box with wires out both sides.
//
// THE LINES ARE THE POINT: an edge is what a Connection Profile actually
// creates, and it CARRIES the current property values. Hovering an edge peeks
// at a live card — every property the CP declares, who writes it (provider ⇢
// / consumer ⇠, from the registry's server flag), broadcast vs addressed (°),
// and the value ON THIS CONNECTION right now. CLICKING an edge PINS its card:
// pinned cards are independent floating panels — pin as many wires as you
// like, drag them by the header to arrange, and they keep updating while you
// go work the widgets (a hover alone dies the moment the cursor leaves for
// the switch). Each has its own ✕; Esc closes them all; a pin also closes
// when its connection leaves the realm.
//
// Layout: layers left → right along the provider → consumer flow (longest-
// path layering, cycle-capped). Everything renders from the debounced `keys`
// pushes — no new IPC (cards use the existing getProfile bridge). This app's
// own widgets get their definition icon/accent and click through to their
// faceplate. Structure is signature-gated: the SVG rebuilds only when
// topology changes, so flashes, chips and pinned cards are never torn down
// by a routine value tick (the UI re-render rule).
// ---------------------------------------------------------------------------
(() => {
  const host = document.getElementById('graphHost');
  const panel = document.getElementById('panel-graph');
  if (!host || !panel) return;

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  let keys = {};
  let instances = [];
  let defs = [];
  let dirty = true;        // needs a render next time the panel is visible
  let lastSig = '';        // structure signature of the last built DOM
  let prevVals = {};       // "ctx|connId" -> {prop: value} — the diff base
  let lastVals = {};       // latest values, for the cards
  let lastEdgeInfo = {};   // "ctx|connId" -> {profile, ctxName, fromName, toName}
  const chipTimers = new Map(); // element id -> timeout
  let firstDiff = true;    // suppress the flash storm of the initial snapshot

  // ------------------------------------------------------------ parse keys
  const RE = {
    sysName: /^cns\/([^/]+)\/name$/,
    nodeName: /^cns\/([^/]+)\/nodes\/([^/]+)\/name$/,
    ctxName: /^cns\/([^/]+)\/nodes\/([^/]+)\/contexts\/([^/]+)\/name$/,
    decl: /^cns\/([^/]+)\/nodes\/([^/]+)\/contexts\/([^/]+)\/(provider|consumer)\/([^/]+)(\/|$)/,
    connPeer: /^cns\/([^/]+)\/nodes\/([^/]+)\/contexts\/([^/]+)\/(provider|consumer)\/([^/]+)\/connections\/([^/]+)\/(provider|consumer)$/,
    connProp: /^cns\/([^/]+)\/nodes\/([^/]+)\/contexts\/([^/]+)\/(provider|consumer)\/([^/]+)\/connections\/([^/]+)\/properties\/([^/]+)$/,
  };

  // The realm model: RELATED groups (connected components) of nodes + edges.
  function buildModel() {
    const sysNames = {};
    const nodeNames = {}; // "sys|node" -> name
    const ctxNames = {};  // ctxId -> {name: count}
    const nodes = new Map(); // "sys|node" -> {key, sys, node, caps:Set("role|profile"), ctxIds:Set}
    const ctxMembers = {};   // ctxId -> Set(nodeKey)
    const conns = new Map(); // "ctx|connId" -> {ctxId, id, profile, ends:{provider,consumer}}

    const nodeOf = (sys, node) => {
      const k = `${sys}|${node}`;
      if (!nodes.has(k)) nodes.set(k, { key: k, sys, node, caps: new Set(), ctxIds: new Set() });
      return nodes.get(k);
    };
    const joinCtx = (n, ctxId) => {
      n.ctxIds.add(ctxId);
      (ctxMembers[ctxId] || (ctxMembers[ctxId] = new Set())).add(n.key);
    };

    for (const k in keys) {
      let m = k.match(RE.sysName);
      if (m) { sysNames[m[1]] = keys[k]; continue; }
      m = k.match(RE.nodeName);
      if (m) { nodeNames[`${m[1]}|${m[2]}`] = keys[k]; continue; }
      m = k.match(RE.ctxName);
      if (m) {
        const e = ctxNames[m[3]] || (ctxNames[m[3]] = {});
        e[keys[k]] = (e[keys[k]] || 0) + 1;
        continue;
      }
      m = k.match(RE.connPeer);
      if (m) {
        const ck = `${m[3]}|${m[6]}`;
        const conn = conns.get(ck) || { ctxId: m[3], id: m[6], profile: m[5], ends: {} };
        // The key's OWNER is one endpoint; the VALUE names the endpoint whose
        // role is the key's last segment (cns/<sys>/nodes/<node>/contexts/<ctx>).
        conn.ends[m[4]] = conn.ends[m[4]] || `${m[1]}|${m[2]}`;
        const p = String(keys[k]).split('/');
        if (p[0] === 'cns' && p[2] === 'nodes') conn.ends[m[7]] = `${p[1]}|${p[3]}`;
        conns.set(ck, conn);
        // fall through: the decl regex below also registers the owner member
      }
      m = k.match(RE.decl);
      if (m) {
        const n = nodeOf(m[1], m[2]);
        n.caps.add(`${m[4]}|${m[5]}`);
        joinCtx(n, m[3]);
      }
    }

    // Per-connection property values (merged from both endpoints' subtrees).
    const vals = {}; // "ctx|connId" -> {prop: value}
    for (const k in keys) {
      const m = k.match(RE.connProp);
      if (!m) continue;
      const vk = `${m[3]}|${m[6]}`;
      (vals[vk] || (vals[vk] = {}))[m[7]] = String(keys[k]);
    }

    // Edges (both endpoints known); connections imply membership too.
    const edges = [];
    for (const conn of conns.values()) {
      for (const role of ['provider', 'consumer']) {
        if (!conn.ends[role]) continue;
        const [sys, node] = conn.ends[role].split('|');
        const n = nodeOf(sys, node);
        n.caps.add(`${role}|${conn.profile}`);
        joinCtx(n, conn.ctxId);
      }
      if (conn.ends.provider && conn.ends.consumer) {
        edges.push({ ctxId: conn.ctxId, connId: conn.id, profile: conn.profile, from: conn.ends.provider, to: conn.ends.consumer });
      }
    }

    // ---- relatedness: union by connection AND by shared context ----
    const parent = {};
    const find = (a) => (parent[a] === a ? a : (parent[a] = find(parent[a])));
    const union = (a, b) => { parent[find(a)] = find(b); };
    for (const k of nodes.keys()) parent[k] = k;
    for (const e of edges) union(e.from, e.to);
    for (const id in ctxMembers) {
      const mem = [...ctxMembers[id]];
      for (let i = 1; i < mem.length; i++) union(mem[0], mem[i]);
    }

    // ---- decorate nodes: names, own-widget identity, boundness ----
    const instByNode = new Map(instances.map((i) => [i.nodeId, i]));
    const defById = new Map(defs.map((d) => [d.id, d]));
    const boundNodes = new Set(edges.flatMap((e) => [e.from, e.to]));
    for (const n of nodes.values()) {
      n.sysName = sysNames[n.sys] || n.sys.slice(0, 8) + '…';
      n.nodeName = nodeNames[n.key] || n.node.slice(0, 8) + '…';
      n.bound = boundNodes.has(n.key);
      const inst = instByNode.get(n.node);
      if (inst) {
        n.instId = inst.id;
        const d = defById.get(inst.widgetId);
        n.icon = (d && d.icon) || '';
        n.color = (d && d.color) || '';
      }
    }

    const ctxTitle = (id) => {
      const names = Object.entries(ctxNames[id] || {}).sort((a, b) => b[1] - a[1]);
      return names.length ? names[0][0] : id.slice(0, 8) + '…';
    };

    // What the cards need per edge, keyed like vals ("ctx|connId").
    const edgeInfo = {};
    for (const e of edges) {
      edgeInfo[`${e.ctxId}|${e.connId}`] = {
        profile: e.profile,
        connId: e.connId,
        ctxName: ctxTitle(e.ctxId),
        fromName: nodes.get(e.from).nodeName,
        toName: nodes.get(e.to).nodeName,
      };
    }

    // ---- assemble groups ----
    const byRoot = {};
    for (const n of nodes.values()) (byRoot[find(n.key)] || (byRoot[find(n.key)] = [])).push(n);
    const groups = Object.entries(byRoot).map(([root, members]) => {
      const ctxIds = [...new Set(members.flatMap((n) => [...n.ctxIds]))];
      const ctxTitles = [...new Set(ctxIds.map(ctxTitle))];
      const gEdges = edges.filter((e) => find(e.from) === root);
      return {
        id: root,
        // STABLE identity for the group tab: the union-find root can flip as
        // topology changes, the smallest member key cannot (while it exists).
        gid: members.map((n) => n.key).sort()[0],
        nodes: members,
        edges: gEdges,
        ctxIds,
        ctxTitles,
        name: ctxTitles.slice(0, 3).join(' + ') + (ctxTitles.length > 3 ? ` +${ctxTitles.length - 3}` : ''),
        mine: members.some((n) => n.instId),
      };
    })
    // Groups holding this app's widgets first, then the busiest.
    .sort((a, b) => (b.mine - a.mine) || (b.edges.length - a.edges.length) || (b.nodes.length - a.nodes.length) || String(a.name).localeCompare(String(b.name)));
    return { groups, vals, ctxTitle, edgeInfo };
  }

  // ------------------------------------------------------------ structure
  function signature(groups) {
    return JSON.stringify(groups.map((g) => [
      g.id, g.name,
      g.nodes.map((n) => [n.key, n.nodeName, n.sysName, [...n.caps].sort(), n.instId || '', n.color || '']),
      g.edges.map((e) => [e.ctxId, e.connId, e.profile, e.from, e.to]),
    ]));
  }

  // ------------------------------------------------------------- layout
  // Longest-path layering along provider → consumer, capped so cycles (two
  // nodes wired both ways on different CPs) can't loop forever. Isolated
  // nodes fall back to role: provider-only left, consumer-only right.
  function layoutGroup(g) {
    const layer = {};
    for (const n of g.nodes) layer[n.key] = 0;
    const V = g.nodes.length;
    for (let i = 0; i < V; i++) {
      let moved = false;
      for (const e of g.edges) {
        if (layer[e.to] < layer[e.from] + 1 && layer[e.from] + 1 < V) { layer[e.to] = layer[e.from] + 1; moved = true; }
      }
      if (!moved) break;
    }
    let maxL = 0;
    for (const n of g.nodes) if (n.bound) maxL = Math.max(maxL, layer[n.key]);
    for (const n of g.nodes) {
      if (n.bound) continue;
      const roles = new Set([...n.caps].map((c) => c.split('|')[0]));
      if (roles.has('consumer') && !roles.has('provider')) layer[n.key] = Math.max(maxL, g.edges.length ? maxL : 1);
      else if (roles.has('provider') && roles.has('consumer')) layer[n.key] = Math.max(1, Math.floor(maxL / 2));
      else layer[n.key] = 0;
    }
    const L = Math.max(...g.nodes.map((n) => layer[n.key])) + 1;
    const layers = Array.from({ length: L }, () => []);
    for (const n of g.nodes) layers[layer[n.key]].push(n);
    // One barycenter pass: order each layer by where its wires come from.
    const idx = new Map();
    layers[0].sort((a, b) => a.nodeName.localeCompare(b.nodeName));
    layers[0].forEach((n, i) => idx.set(n.key, i));
    for (let i = 1; i < L; i++) {
      const score = (n) => {
        const ys = g.edges.filter((e) => e.to === n.key && idx.has(e.from)).map((e) => idx.get(e.from));
        return ys.length ? ys.reduce((s, y) => s + y, 0) / ys.length : 1e9;
      };
      layers[i].sort((a, b) => score(a) - score(b) || a.nodeName.localeCompare(b.nodeName));
      layers[i].forEach((n, k) => idx.set(n.key, k));
    }
    return { layers, layer };
  }

  // ------------------------------------------------------------- drawing
  const BOX_W = 280, BOX_H = 58, VGAP = 16, TOP = 16, W = 1080;

  // ---- FLOAT layout (v61): nodes settle by a small force simulation, then
  // FREEZE — value ticks never move anything, topology changes re-settle
  // incrementally from current positions. Each node keeps a horizontal
  // spring toward its layer's x-anchor so the provider → consumer reading
  // survives the float. Dragging a node PINS it (persisted); double-click
  // releases it back to the float.
  const LS_NODEPOS = 'graphNodePos.v1';
  let fixedPos = {};
  try { fixedPos = JSON.parse(localStorage.getItem(LS_NODEPOS) || '{}') || {}; } catch (_) {}
  const saveFixed = () => { try { localStorage.setItem(LS_NODEPOS, JSON.stringify(fixedPos)); } catch (_) {} };
  const posCache = new Map(); // nodeKey -> {x,y} box CENTERS, last settled
  let edgesAll = [];          // [{vk, ctxId, connId, from, to, bow}] for live drag redraw
  const hash01 = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return ((h >>> 0) % 1000) / 1000; };

  function settleGroup(g, layers, layer) {
    const L = layers.length;
    const anchorX = (l) => (L === 1 ? W / 2 : 16 + BOX_W / 2 + l * ((W - 32 - BOX_W) / (L - 1)));
    const pts = new Map();
    layers.forEach((col) => col.forEach((n, i) => {
      // fixed (user-pinned) > warm start (last settle) > layered stack + a
      // deterministic nudge so symmetric stacks break apart repeatably
      const p = fixedPos[n.key] || posCache.get(n.key) || {
        x: anchorX(layer[n.key]) + (hash01(n.key) - 0.5) * 30,
        y: 60 + i * (BOX_H + VGAP) + (hash01(n.key + 'y') - 0.5) * 20,
      };
      pts.set(n.key, { x: p.x, y: p.y, fx: !!fixedPos[n.key] });
    }));
    const resolveOverlaps = () => {
      // boxes are big rectangles — resolve overlaps explicitly
      for (const n of g.nodes) for (const m of g.nodes) {
        if (n.key >= m.key) continue;
        const p = pts.get(n.key), q = pts.get(m.key);
        const ox = Math.abs(p.x - q.x), oy = Math.abs(p.y - q.y);
        if (ox < BOX_W + 14 && oy < BOX_H + 12) {
          const push = (BOX_H + 12 - oy) / 2 + 1;
          const dir = p.y <= q.y ? -1 : 1;
          if (!p.fx) p.y += dir * push;
          if (!q.fx) q.y -= dir * push;
        }
      }
    };
    if (g.nodes.length > 1) {
      for (let it = 0; it < 260; it++) {
        const t = 1 - it / 260; // cooling
        let meanY = 0;
        for (const n of g.nodes) meanY += pts.get(n.key).y;
        meanY /= g.nodes.length;
        for (const n of g.nodes) {
          const p = pts.get(n.key);
          if (p.fx) continue;
          let dx = 0, dy = 0;
          for (const m of g.nodes) {
            if (m === n) continue;
            const q = pts.get(m.key);
            let ex = p.x - q.x, ey = p.y - q.y;
            let d2 = ex * ex + ey * ey;
            if (d2 < 1) { ex = hash01(n.key + m.key) - 0.5; ey = 0.5; d2 = 1; }
            if (d2 > 115600) continue; // beyond ~340px boxes ignore each other
            const f = Math.min(9000 / d2, 18);
            dx += ex * f * 0.05; dy += ey * f * 0.35; // repel, mostly vertically
          }
          for (const e of g.edges) {
            if (e.from !== n.key && e.to !== n.key) continue;
            const o = pts.get(e.from === n.key ? e.to : e.from);
            dx += (o.x - p.x) * 0.006; dy += (o.y - p.y) * 0.03; // wire spring
          }
          dy += (meanY - p.y) * 0.02; // gravity: the group stays together
          dx += (anchorX(layer[n.key]) - p.x) * 0.12; // the flow keeps reading left→right
          p.x += Math.max(-14, Math.min(14, dx)) * t;
          p.y += Math.max(-14, Math.min(14, dy)) * t;
        }
        if (it % 12 === 0 || it === 259) resolveOverlaps();
      }
      // COMPACTNESS GUARD: unbounded repulsion once blew a 7-node group to a
      // couple thousand px tall (the maximized-window incident). The sheet is
      // never taller than ~1.6× the neatly-stacked ideal — if the settle
      // sprawled past that, squeeze the free nodes about their middle and
      // re-resolve overlaps.
      const rows = Math.max(...layers.map((c) => c.length));
      const idealSpan = rows * (BOX_H + VGAP) + 40;
      const free = [...pts.values()].filter((p) => !p.fx);
      if (free.length > 1) {
        const lo = Math.min(...free.map((p) => p.y)), hi = Math.max(...free.map((p) => p.y));
        const maxSpan = Math.max(idealSpan * 1.6, 300);
        if (hi - lo > maxSpan) {
          const mid = (hi + lo) / 2, k = maxSpan / (hi - lo);
          for (const p of free) p.y = mid + (p.y - mid) * k;
          resolveOverlaps(); resolveOverlaps(); resolveOverlaps();
        }
      }
    }
    // normalize: clamp into the sheet, then RIGID-shift everything (pinned
    // nodes included — a translation preserves the user's arrangement) so the
    // content hugs the top margin. Leaving pinned nodes unshifted kept their
    // stale absolute offsets and grew the sheet full of dead space (the
    // zoomed-out-to-see-it incident). Shifted pins are re-persisted.
    let minY = Infinity, maxY = -Infinity;
    for (const p of pts.values()) {
      p.x = Math.max(8 + BOX_W / 2, Math.min(W - 8 - BOX_W / 2, p.x));
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    if (isFinite(minY)) {
      const shift = TOP + BOX_H / 2 - minY;
      if (Math.abs(shift) > 0.5) {
        let movedPin = false;
        for (const [k, p] of pts) {
          p.y += shift;
          if (p.fx && fixedPos[k]) { fixedPos[k] = { x: p.x, y: p.y }; movedPin = true; }
        }
        maxY += shift;
        if (movedPin) saveFixed();
      }
    }
    const H = Math.max((isFinite(maxY) ? maxY : 0) + BOX_H / 2 + TOP, 80);
    for (const [k, p] of pts) posCache.set(k, { x: p.x, y: p.y });
    return { pts, H };
  }

  function edgeGeo(a, b, bow) {
    const x1 = a.x + BOX_W / 2, y1 = a.y;
    const x2 = b.x - BOX_W / 2, y2 = b.y;
    const forward = x2 - x1 > 20;
    const mx = (x1 + x2) / 2;
    const my = forward ? (y1 + y2) / 2 + bow
                       : Math.max(y1, y2) + BOX_H + 12 + Math.abs(bow); // route below
    // the point ON the curve at t=0.5 (for the arrowhead + value chip) and
    // the chord angle (provider → consumer reading direction)
    const cy = 0.25 * y1 + 0.5 * my + 0.25 * y2;
    const ang = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
    return { d: `M ${x1} ${y1} Q ${mx} ${my} ${x2} ${y2}`, mx, my, cy, ang };
  }

  function drawGroup(g) {
    const { layers, layer } = layoutGroup(g);
    const { pts, H } = settleGroup(g, layers, layer);
    const parts = [];

    // Edges first (under the boxes). The same pair can hold SEVERAL
    // connections (multi-connection is app semantics, by design) — fan them
    // out with distinct bows so each stays hoverable.
    const pairSeen = {};
    for (const e of g.edges) {
      const vk = `${e.ctxId}|${e.connId}`;
      const n = (pairSeen[e.from + '→' + e.to] = (pairSeen[e.from + '→' + e.to] || 0) + 1);
      const bow = (n - 1) * 20 * (n % 2 ? 1 : -1); // 0, +20, −20, +40…
      const geo = edgeGeo(pts.get(e.from), pts.get(e.to), bow);
      parts.push(`<path id="ge-${esc(e.ctxId)}-${esc(e.connId)}" class="ge bound" d="${geo.d}"></path>`);
      parts.push(`<polygon id="gea-${esc(e.ctxId)}-${esc(e.connId)}" class="gearrow" points="6,0 -5,-4 -5,4" transform="translate(${geo.mx} ${geo.cy}) rotate(${geo.ang})"></polygon>`);
      parts.push(`<path id="geh-${esc(e.ctxId)}-${esc(e.connId)}" class="ge-hit" data-conn="${esc(vk)}" d="${geo.d}"></path>`);
      parts.push(`<text id="gv-${esc(e.ctxId)}-${esc(e.connId)}" class="gv" x="${geo.mx}" y="${geo.cy - 12}" text-anchor="middle"></text>`);
      edgesAll.push({ vk, ctxId: e.ctxId, connId: e.connId, from: e.from, to: e.to, bow });
    }

    for (const col of layers) {
      for (const n of col) {
        const p = pts.get(n.key);
        const tx = p.x - BOX_W / 2, ty = p.y - BOX_H / 2;
        const own = n.instId ? ' own' : '';
        const unbound = n.bound ? '' : ' unbound';
        const pinnedPos = fixedPos[n.key] ? ' placed' : '';
        const accent = n.color ? ` style="--gn-accent:${esc(n.color)}"` : '';
        const click = n.instId ? ` data-inst="${esc(n.instId)}" role="button" tabindex="0"` : '';
        const name = (n.icon ? n.icon + ' ' : '') + n.nodeName;
        const caps = [...n.caps].sort().map((c) => { const [r, p2] = c.split('|'); return `${r} of ${p2}`; }).join(' · ');
        const ctxs = [...n.ctxIds].map((id) => g.ctxTitleOf(id)).join(', ');
        parts.push(`<g class="gn${own}${unbound}${pinnedPos}" id="gn-${esc(n.key)}" data-node="${esc(n.key)}" transform="translate(${tx} ${ty})"${accent}${click}>
          <rect x="0" y="0" width="${BOX_W}" height="${BOX_H}" rx="7"><title>${esc(caps)} — in ${esc(ctxs)}${n.instId ? ' — click opens the faceplate' : ''} — drag to place, double-click to float</title></rect>
          <text x="12" y="18" class="gt">${esc(name.slice(0, 32))}</text>
          <text x="12" y="33" class="gs">${esc(n.sysName.slice(0, 42))}</text>
          <text x="12" y="47" class="gs gcaps">${esc(caps.slice(0, 52))}</text>
        </g>`);
      }
    }

    const anyPlaced = g.nodes.some((n) => fixedPos[n.key]);
    return `<section class="card gctx${g.mine ? ' mine' : ''}">
      <div class="card-head">
        <h2>${esc(g.name)}</h2>
        <span class="card-tools">${anyPlaced
          ? `<button type="button" class="ghost gfloat" data-gfloat="${esc(g.gid)}" title="Release every placed node in this group back to the float">float all</button>`
          : ''}<span class="muted-note">${g.ctxIds.length} context${g.ctxIds.length === 1 ? '' : 's'} · ${g.nodes.length} node${g.nodes.length === 1 ? '' : 's'} · ${g.edges.length} connection${g.edges.length === 1 ? '' : 's'}</span></span>
      </div>
      <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>
    </section>`;
  }

  // ============================================================ EDGE CARDS
  // The line IS the Connection Profile at work — a card shows the whole
  // contract live: every declared property, who writes it (⇢ provider / ⇠
  // consumer, from the registry's server flag), broadcast vs addressed (°),
  // and the current value ON THIS CONNECTION. Hover = transient peek; click
  // = an independent PINNED card (any number, draggable by the header).
  const profCache = new Map(); // profile name -> {props:[...]} | 'pending' | null
  const pins = new Map();      // vk -> {vk, el, last}
  let peekKey = null;
  let peekLast = {};

  function parseProfileJson(json) {
    if (!json || !Array.isArray(json.versions) || !json.versions.length) return null;
    const latest = json.versions[json.versions.length - 1] || {};
    return {
      props: (latest.properties || []).filter((p) => p && p.name).map((p) => ({
        name: p.name,
        writer: 'server' in p ? 'provider' : 'consumer',
        propagate: 'propagate' in p,
        desc: p.description || '',
      })),
    };
  }

  function ensureProfile(name) {
    if (profCache.has(name)) return;
    profCache.set(name, 'pending');
    (window.arete.getProfile ? window.arete.getProfile(name) : Promise.resolve(null))
      .then((json) => { profCache.set(name, parseProfileJson(json)); refreshCards(); })
      .catch(() => profCache.set(name, null));
  }

  // Render one card's content. `last` is that card's own previous values —
  // rows whose value changed since flash. Returns the new `last`.
  function renderCard(el, vk, isPinned, last) {
    const info = lastEdgeInfo[vk];
    if (!info) return last;
    const vals = lastVals[vk] || {};
    const prof = profCache.get(info.profile);
    if (!prof) ensureProfile(info.profile);

    const rows = [];
    const seen = new Set();
    const profProps = prof && prof !== 'pending' ? prof.props : [];
    for (const p of profProps) { seen.add(p.name); rows.push({ ...p, value: vals[p.name] }); }
    for (const name in vals) if (!seen.has(name)) rows.push({ name, writer: null, propagate: true, value: vals[name] });

    const anyAddressed = rows.some((r) => !r.propagate);
    const rowHtml = rows.map((r) => {
      const dir = r.writer === 'provider' ? '⇢' : r.writer === 'consumer' ? '⇠' : '·';
      const chg = last[r.name] !== undefined && last[r.name] !== r.value && r.value !== undefined;
      return `<div class="gh-row${chg ? ' chg' : ''}" title="${esc(r.desc || '')}">
        <span class="gh-dir ${r.writer || ''}">${dir}</span>
        <span class="gh-prop">${esc(r.name)}${r.propagate ? '' : '<span class="gh-adr">°</span>'}</span>
        <span class="gh-val">${r.value === undefined ? '<span class="gh-empty">—</span>' : esc(r.value)}</span>
      </div>`;
    }).join('') || '<div class="gh-row"><span class="gh-empty">no values on this connection yet</span></div>';

    el.innerHTML = `
      <div class="gh-head"${isPinned ? ' title="drag to move"' : ''}><span class="gh-cp">cp:${esc(info.profile)}</span><span class="mono gh-id">${esc(info.connId.slice(0, 8))}…</span>${
        isPinned ? '<button type="button" class="gh-close" title="Unpin (Esc closes all)">✕</button>' : ''}</div>
      <div class="gh-sub">${esc(info.fromName)} ⇢ ${esc(info.toName)} · in “${esc(info.ctxName)}”</div>
      ${rowHtml}
      <div class="gh-foot">${prof === 'pending' ? 'resolving cp.padi.io…' : '⇢ provider writes · ⇠ consumer writes'}${anyAddressed ? ' · ° addressed (not broadcast)' : ''}<br/>${
        isPinned ? '📌 pinned — drag the title to arrange · ✕ this one, Esc all' : 'click the wire to pin — pin as many as you like'}</div>`;
    const next = {};
    for (const r of rows) if (r.value !== undefined) next[r.name] = r.value;
    return next;
  }

  function placeCard(el, x, y) {
    const pad = 14;
    el.style.left = Math.min(x + pad, (window.innerWidth || 1200) - 340) + 'px';
    const below = y + pad;
    const h = el.offsetHeight || 200;
    el.style.top = (below + h > (window.innerHeight || 800) - 8 ? Math.max(8, y - h - 10) : below) + 'px';
  }

  const edgeEl = (vk) => { const [c, k] = vk.split('|'); return document.getElementById(`ge-${c}-${k}`); };
  const litEdge = (vk, on) => { const e = edgeEl(vk); if (e) e.classList[on ? 'add' : 'remove']('hover'); };

  // ---- the single transient peek card ----
  const peek = document.createElement('div');
  peek.className = 'ghover';
  peek.hidden = true;
  document.body.appendChild(peek);

  function showPeek(vk, x, y) {
    if (pins.has(vk)) return; // its card is already on screen
    peekKey = vk;
    peekLast = {};
    peek.hidden = false;
    peekLast = renderCard(peek, vk, false, peekLast);
    placeCard(peek, x, y);
    litEdge(vk, true);
  }

  function hidePeek() {
    if (peekKey && !pins.has(peekKey)) litEdge(peekKey, false);
    peekKey = null;
    peekLast = {};
    peek.hidden = true;
  }

  // ---- pinned cards: independent, draggable, any number ----
  function makeDraggable(el) {
    el.addEventListener('mousedown', (e) => {
      if (!(e.target.closest && e.target.closest('.gh-head')) || (e.target.closest && e.target.closest('.gh-close'))) return;
      e.preventDefault();
      const sx = e.clientX, sy = e.clientY;
      const ox = parseFloat(el.style.left) || 0, oy = parseFloat(el.style.top) || 0;
      const move = (ev) => { el.style.left = ox + (ev.clientX - sx) + 'px'; el.style.top = oy + (ev.clientY - sy) + 'px'; };
      const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }

  function addPin(vk, x, y) {
    hidePeek(); // the peek becomes this pin
    const el = document.createElement('div');
    el.className = 'ghover pinned';
    document.body.appendChild(el);
    const entry = { vk, el, last: {} };
    entry.last = renderCard(el, vk, true, entry.last);
    // Cascade a touch so simultaneous pins never stack exactly.
    placeCard(el, x + pins.size * 16, y + pins.size * 12);
    el.addEventListener('click', (e) => {
      if (e.target.closest && e.target.closest('.gh-close')) removePin(vk);
    });
    makeDraggable(el);
    pins.set(vk, entry);
    litEdge(vk, true);
  }

  function removePin(vk) {
    const entry = pins.get(vk);
    if (!entry) return;
    pins.delete(vk);
    if (entry.el.remove) entry.el.remove();
    else entry.el.hidden = true; // extremely defensive
    if (peekKey !== vk) litEdge(vk, false);
  }

  function closeAllCards() {
    for (const vk of [...pins.keys()]) removePin(vk);
    hidePeek();
  }

  // Every card follows the wire live (called on each keys push and when a
  // profile fetch resolves).
  function refreshCards() {
    for (const entry of pins.values()) entry.last = renderCard(entry.el, entry.vk, true, entry.last);
    if (peekKey) peekLast = renderCard(peek, peekKey, false, peekLast);
  }

  host.addEventListener('mouseover', (e) => {
    const hit = e.target.closest && e.target.closest('.ge-hit');
    if (hit && hit.dataset.conn) showPeek(hit.dataset.conn, e.clientX, e.clientY);
  });
  host.addEventListener('mouseout', (e) => {
    const hit = e.target.closest && e.target.closest('.ge-hit');
    if (hit && peekKey) hidePeek();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pins.size) closeAllCards();
  });

  // ------------------------------------------------------------- live layer
  // Which way did this change flow? The writer of the changed property (from
  // the registry flags) decides: provider-written runs along the arrow,
  // consumer-written runs back against it.
  function flowDir(vk, changedNames) {
    const info = lastEdgeInfo[vk];
    const prof = info && profCache.get(info.profile);
    if (!prof || prof === 'pending') return 'on';
    const p = prof.props.find((x) => x.name === changedNames[0]);
    return p && p.writer === 'consumer' ? 'onr' : 'on';
  }

  function diffAndFlash(vals, animate) {
    for (const vk in vals) {
      const prev = prevVals[vk] || {};
      const next = vals[vk];
      const changed = [];
      for (const p in next) if (next[p] !== prev[p]) changed.push(`${p}=${next[p]}`);
      if (!changed.length) continue;
      if (!animate) continue;
      const [ctxId, connId] = vk.split('|');
      const edge = document.getElementById(`ge-${ctxId}-${connId}`);
      if (edge) {
        const cls = flowDir(vk, changed.map((c) => c.split('=')[0]));
        edge.classList.add(cls);
        setTimeout(() => { edge.classList.remove('on'); edge.classList.remove('onr'); }, 700);
      }
      const chip = document.getElementById(`gv-${ctxId}-${connId}`);
      if (chip) {
        chip.textContent = changed.slice(0, 2).join('  ').slice(0, 42);
        chip.classList.add('show');
        clearTimeout(chipTimers.get(chip.id));
        chipTimers.set(chip.id, setTimeout(() => chip.classList.remove('show'), 1800));
      }
    }
    prevVals = JSON.parse(JSON.stringify(vals));
  }

  // ------------------------------------------------------------- rendering
  // Each group lives in its OWN sub-tab (one canvas on stage at a time);
  // the chosen tab sticks across rebuilds and restarts by stable group id.
  const LS_GTAB = 'graphActiveGroup.v1';
  let activeGroup = null;
  let lastGroups = []; // the model behind the strip/stage, for click handlers
  try { activeGroup = localStorage.getItem(LS_GTAB) || null; } catch (_) {}

  function tabStrip(groups) {
    if (groups.length < 2) return '';
    return '<div class="gtabs">' + groups.map((g) =>
      `<button type="button" class="gtab${g.gid === activeGroup ? ' active' : ''}${g.mine ? ' mine' : ''}" data-gtab="${esc(g.gid)}" title="${esc(g.ctxTitles.join(', '))} — ${g.nodes.length} nodes, ${g.edges.length} connections">${esc(g.name.slice(0, 28))}<span class="gtab-n">${g.edges.length}</span></button>`
    ).join('') + '</div>';
  }

  function render() {
    const { groups, vals, ctxTitle, edgeInfo } = buildModel();
    for (const g of groups) g.ctxTitleOf = ctxTitle;
    lastGroups = groups;
    lastVals = vals;
    lastEdgeInfo = edgeInfo;
    const sig = signature(groups);
    if (sig !== lastSig) {
      lastSig = sig;
      // Pinned cards survive a rebuild as long as their connection still
      // exists — the whole point of pinning is watching a wire while things
      // change (even a wire whose group tab is not the one on stage). Pins
      // whose connection left the realm close; a mere peek closes too.
      for (const vk of [...pins.keys()]) if (!edgeInfo[vk]) removePin(vk);
      hidePeek();
      const act = groups.find((g) => g.gid === activeGroup) || groups[0] || null;
      activeGroup = act ? act.gid : null;
      edgesAll = []; // drawGroup refills the drag registry
      host.innerHTML = groups.length
        ? tabStrip(groups) + `<div id="graphStage">${drawGroup(act)}</div>`
        : `<section class="card"><p class="muted-note">${
            Object.keys(keys).length
              ? 'No nodes on this realm yet — add a widget and its pattern appears here.'
              : 'Not connected — connect on the Config tab and the realm’s live pattern appears here.'
          }</p></section>`;
      for (const vk of pins.keys()) litEdge(vk, true); // re-attach those on stage
      // prefetch every wire's CP so flow direction (and the hover card) are
      // ready before the first flash — registry answers are cached in main
      for (const vk in edgeInfo) ensureProfile(edgeInfo[vk].profile);
    }
    // First pass after (re)connect: seed the diff base silently, no flash storm.
    diffAndFlash(vals, !firstDiff);
    if (Object.keys(keys).length) firstDiff = false; // only a REAL snapshot arms the animation
    refreshCards(); // every open card tracks its wire live
    dirty = false;
  }

  const visible = () => !panel.hidden;
  function onData() {
    if (visible()) render();
    else {
      // Keep the diff base current while hidden so opening the tab doesn't
      // replay every change since; structure will rebuild on activation.
      const { vals, edgeInfo } = buildModel();
      diffAndFlash(vals, false);
      lastVals = vals;
      lastEdgeInfo = edgeInfo;
      if (Object.keys(keys).length) firstDiff = false;
      dirty = true;
    }
  }

  // ------------------------------------------------------------- events
  window.arete.onKeys((k) => { keys = k || {}; if (!Object.keys(keys).length) { firstDiff = true; lastSig = ''; prevVals = {}; closeAllCards(); } onData(); });
  window.arete.onWidgetInstances((list) => { instances = list || []; onData(); });
  window.arete.onWidgetDefs((list) => { defs = list || []; onData(); });

  // The tab bar is generic (app.js toggles panels by data-panel) — we only
  // need to know when OUR panel becomes visible to catch up on a dirty model.
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    if (t.dataset.panel !== 'panel-graph') closeAllCards(); // fixed overlays don't belong over other tabs
    else if (dirty) render();
  }));

  // ---- node dragging: place a box where you want it; the wires follow live.
  // A real drag PINS the position (persisted); double-click floats it again.
  let dragging = null;       // {key, svg, dx, dy, H, moved}
  let suppressClickUntil = 0; // a drag must not fire the click behind it

  function svgPoint(svg, clientX, clientY) {
    const r = svg.getBoundingClientRect();
    const vb = svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal : { width: W, height: r.height };
    const scale = Math.min(r.width / vb.width, r.height / vb.height) || 1;
    const ox = (r.width - vb.width * scale) / 2, oy = (r.height - vb.height * scale) / 2;
    return { x: (clientX - r.left - ox) / scale, y: (clientY - r.top - oy) / scale };
  }

  function applyNodePos(key) {
    const p = posCache.get(key);
    const el = document.getElementById('gn-' + key);
    if (el) el.setAttribute('transform', `translate(${p.x - BOX_W / 2} ${p.y - BOX_H / 2})`);
    for (const e of edgesAll) {
      if (e.from !== key && e.to !== key) continue;
      const geo = edgeGeo(posCache.get(e.from), posCache.get(e.to), e.bow);
      const ge = document.getElementById(`ge-${e.ctxId}-${e.connId}`);
      const gea = document.getElementById(`gea-${e.ctxId}-${e.connId}`);
      const geh = document.getElementById(`geh-${e.ctxId}-${e.connId}`);
      const gv = document.getElementById(`gv-${e.ctxId}-${e.connId}`);
      if (ge) ge.setAttribute('d', geo.d);
      if (gea) gea.setAttribute('transform', `translate(${geo.mx} ${geo.cy}) rotate(${geo.ang})`);
      if (geh) geh.setAttribute('d', geo.d);
      if (gv) { gv.setAttribute('x', geo.mx); gv.setAttribute('y', geo.cy - 12); }
    }
  }

  host.addEventListener('mousedown', (e) => {
    const gEl = e.target.closest && e.target.closest('[data-node]');
    if (!gEl) return;
    const svg = gEl.closest && gEl.closest('svg');
    const p = posCache.get(gEl.dataset.node);
    if (!svg || !p) return;
    e.preventDefault(); // no text selection while dragging
    const pt = svgPoint(svg, e.clientX, e.clientY);
    dragging = { key: gEl.dataset.node, svg, dx: p.x - pt.x, dy: p.y - pt.y, H: parseFloat(svg.getAttribute('height')) || 200, moved: false };
    const move = (ev) => {
      const q = svgPoint(dragging.svg, ev.clientX, ev.clientY);
      const nx = Math.max(8 + BOX_W / 2, Math.min(W - 8 - BOX_W / 2, q.x + dragging.dx));
      const ny = Math.max(BOX_H / 2 + 4, Math.min(dragging.H - BOX_H / 2 - 4, q.y + dragging.dy));
      const cur = posCache.get(dragging.key);
      if (Math.abs(nx - cur.x) + Math.abs(ny - cur.y) > 0.5) dragging.moved = true;
      cur.x = nx; cur.y = ny;
      applyNodePos(dragging.key);
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      if (dragging && dragging.moved) {
        const cur = posCache.get(dragging.key);
        fixedPos[dragging.key] = { x: cur.x, y: cur.y };
        saveFixed();
        const el = document.getElementById('gn-' + dragging.key);
        if (el) el.classList.add('placed');
        suppressClickUntil = Date.now() + 300;
      }
      dragging = null;
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });

  host.addEventListener('dblclick', (e) => {
    const gEl = e.target.closest && e.target.closest('[data-node]');
    if (!gEl || !fixedPos[gEl.dataset.node]) return;
    delete fixedPos[gEl.dataset.node]; // back to the float
    saveFixed();
    lastSig = '';
    render(); // re-settle around the released node
  });

  host.addEventListener('click', (e) => {
    if (Date.now() < suppressClickUntil) { suppressClickUntil = 0; return; } // that was a drag
    const gf = e.target.closest && e.target.closest('[data-gfloat]');
    if (gf) {
      const g = lastGroups.find((x) => x.gid === gf.dataset.gfloat);
      if (g) {
        for (const n of g.nodes) { delete fixedPos[n.key]; posCache.delete(n.key); }
        saveFixed();
        lastSig = '';
        render(); // a completely fresh settle
      }
      return;
    }
    const gt = e.target.closest && e.target.closest('[data-gtab]');
    if (gt) {
      activeGroup = gt.dataset.gtab;
      try { localStorage.setItem(LS_GTAB, activeGroup); } catch (_) {}
      lastSig = ''; // full re-render puts the chosen group on stage (pins survive)
      render();
      return;
    }
    const hit = e.target.closest && e.target.closest('.ge-hit');
    if (hit && hit.dataset.conn) {
      const vk = hit.dataset.conn;
      if (pins.has(vk)) removePin(vk); else addPin(vk, e.clientX, e.clientY);
      return;
    }
    const g = e.target.closest('[data-inst]');
    if (g) window.arete.widgetOpen(g.dataset.inst); // opening a faceplate keeps all pins
  });
  host.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.closest && e.target.closest('[data-inst]')) {
      window.arete.widgetOpen(e.target.closest('[data-inst]').dataset.inst);
    }
  });

  // ------------------------------------------------------------- init
  (async () => {
    try {
      [keys, instances, defs] = await Promise.all([
        window.arete.getKeys(),
        window.arete.widgetInstances(),
        window.arete.widgetDefs(),
      ]);
    } catch (_) { /* renders empty */ }
    onData();
  })();
})();
