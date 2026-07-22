// app.js — MAIN window UI. Talks to main ONLY through window.arete (preload).
// Three tabs: Widgets (tile grid + add/edit dialog), Status (state + log), Config.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const els = {
  statusDot: $('statusDot'),
  statePill: $('statePill'),
  appVersion: $('appVersion'),
  realmInd: $('realmInd'),
  realmHost: $('realmHost'),
  themeLight: $('themeLight'),
  statusBadge: $('statusBadge'),
  panelStatus: $('panel-status'),
  log: $('log'),
  s: { state: $('s-state'), open: $('s-open'), version: $('s-version'), system: $('s-system'), attached: $('s-attached'), error: $('s-error') },
  form: $('connectForm'),
  protocol: $('protocol'), host: $('host'), port: $('port'),
  username: $('username'), password: $('password'), systemName: $('systemName'),
  allowSelfSigned: $('allowSelfSigned'), rememberPassword: $('rememberPassword'),
  rememberNote: $('rememberNote'), autoConnect: $('autoConnect'),
  connectBtn: $('connectBtn'), disconnectBtn: $('disconnectBtn'),
  clearLogBtn: $('clearLogBtn'), cpLink: $('cpLink'),
  reloadDefsBtn: $('reloadDefsBtn'), userDirNote: $('userDirNote'),
  libraryUrl: $('libraryUrl'),
  tileGrid: $('tileGrid'),
  systemNameNote: $('systemNameNote'),
  removeAllWrap: $('removeAllWrap'),
  dlgOverlay: $('dlgOverlay'), dlgTitle: $('dlgTitle'), dlgBody: $('dlgBody'),
  dlgFoot: $('dlgFoot'), dlgClose: $('dlgClose'),
};

let keys = {};
let defs = [];
let instances = [];
let connected = false;

// ---- Tabs ----
function activateTab(panelId) {
  document.querySelectorAll('.tab').forEach((t) => {
    const on = t.dataset.panel === panelId;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.querySelectorAll('.panel').forEach((p) => { p.hidden = p.id !== panelId; });
  if (panelId === 'panel-status') els.statusBadge.hidden = true;
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => activateTab(t.dataset.panel)));

// ---- Log / status ----
function logLine(entry) {
  const time = new Date(entry.ts || Date.now()).toLocaleTimeString();
  const line = document.createElement('span');
  line.className = 'l';
  line.innerHTML = `<span class="t">[${time}] </span><span class="${entry.level || 'info'}">${esc(entry.message)}</span>`;
  els.log.appendChild(line);
  els.log.scrollTop = els.log.scrollHeight;
  if (els.panelStatus.hidden) els.statusBadge.hidden = false;
}

let lastConnected = null;
function renderStatus(st) {
  if (!st) return;
  const state = st.state || 'disconnected';
  connected = state === 'connected';
  els.statusDot.dataset.state = state;
  els.statePill.textContent = state;
  els.statePill.className = 'state-pill ' +
    (state === 'connected' ? 'ok' : state === 'connecting' ? 'mid' : 'bad');
  // centered realm indicator (Monitor treatment)
  const showRealm = !!st.host && (state === 'connected' || state === 'connecting');
  els.realmInd.hidden = !showRealm;
  if (showRealm) els.realmHost.textContent = st.host;
  els.s.state.textContent = state;
  els.s.open.textContent = st.isOpen ? 'yes' : 'no';
  els.s.version.textContent = st.version || '—';
  els.s.system.textContent = (st.identity && st.identity.system) || '—';
  els.s.error.textContent = st.lastError || '—';
  els.connectBtn.disabled = connected || state === 'connecting';
  els.disconnectBtn.disabled = state === 'disconnected';
  // Only re-render on connectedness TRANSITIONS — status arrives every 2s and
  // a blind re-render would rebuild the open dialog mid-interaction.
  if (connected !== lastConnected) {
    lastConnected = connected;
    renderTiles();
    if (dlg) renderDialog(true); // snapshot/restore preserves everything typed
  }
}

// ---- Realm context picker (broker matches on context ID) ----
// Parse contexts with their names AND their declared capabilities, so the
// Join picker can show only contexts that hold a COMPLEMENTARY role for the
// widget's CP(s) — the only contexts the broker could actually bind in.
function realmContexts() {
  const m = {};
  const nameRe = /^cns\/([^/]+)\/nodes\/([^/]+)\/contexts\/([^/]+)\/name$/;
  const capRe = /^cns\/([^/]+)\/nodes\/([^/]+)\/contexts\/([^/]+)\/(provider|consumer)\/([^/]+)(\/.*)?$/;
  const decls = {}; // ctxId -> Set("sys|node|role|profile") — distinct declarations
  const bound = {}; // ctxId -> Set(same key) — declarations that already have ≥1 connection
  for (const k in keys) {
    let mm = k.match(nameRe);
    if (mm) {
      const e = m[mm[3]] || (m[mm[3]] = { names: {}, count: 0 });
      e.names[keys[k]] = (e.names[keys[k]] || 0) + 1;
      e.count++;
      continue;
    }
    mm = k.match(capRe);
    if (mm) {
      const id = `${mm[1]}|${mm[2]}|${mm[4]}|${mm[5]}`;
      (decls[mm[3]] || (decls[mm[3]] = new Set())).add(id);
      if (mm[6] && mm[6].startsWith('/connections/')) (bound[mm[3]] || (bound[mm[3]] = new Set())).add(id);
    }
  }
  return Object.entries(m)
    .map(([id, e]) => {
      const names = Object.entries(e.names).sort((a, b) => b[1] - a[1]);
      const roles = {};   // "role|profile" -> distinct declaration count
      const waiting = {}; // "role|profile" -> declarations with NO connection yet
      for (const d of decls[id] || []) {
        const [, , role, profile] = d.split('|');
        roles[`${role}|${profile}`] = (roles[`${role}|${profile}`] || 0) + 1;
        if (!(bound[id] || new Set()).has(d)) waiting[`${role}|${profile}`] = (waiting[`${role}|${profile}`] || 0) + 1;
      }
      return { id, name: names[0][0], also: names.slice(1).map(([n]) => n), declarations: e.count, roles, waiting };
    })
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

// Only the contexts where the broker could bind THIS widget: at least one
// declaration of the opposite role for one of the widget's profiles. When
// editing, the instance's CURRENT context is excluded — staying there is the
// "Keep current context" choice, not a join.
function contextsMatching(d, excludeCtxId) {
  const wanted = ((d && d.capabilities) || []).map((c) => ({
    profile: c.profile,
    partner: c.role === 'provider' ? 'consumer' : 'provider',
  }));
  const excluded = Array.isArray(excludeCtxId) ? excludeCtxId : (excludeCtxId ? [excludeCtxId] : []);
  return realmContexts()
    .filter((c) => !excluded.includes(c.id))
    .map((c) => {
      const partners = [];
      let waiting = 0;
      for (const w of wanted) {
        const n = c.roles[`${w.partner}|${w.profile}`] || 0;
        const wn = c.waiting[`${w.partner}|${w.profile}`] || 0;
        waiting += wn;
        if (n) partners.push(`${n} ${w.profile} ${w.partner}${n === 1 ? '' : 's'}${wn ? `, ${wn} unbound` : ''}`);
      }
      return { ...c, waiting, partnersText: partners.join(', ') };
    })
    .filter((c) => c.partnersText)
    // Contexts with an UNBOUND partner first — that's almost always the
    // context the user is trying to complete — then most partners, then name.
    .sort((a, b) => b.waiting - a.waiting || b.declarations - a.declarations || String(a.name).localeCompare(String(b.name)));
}

// =========================================================================
// The add / edit dialog
// dlg is the ONLY dialog state: null (closed) or
//   { mode: 'create'|'edit', step: 1|2, defId, instId, filter }
// Step 1 = filterable widget picker (create mode only); step 2 = config form.
// =========================================================================
let dlg = null;
let pendingCtxId = null; // context id minted for "New context" — survives re-renders
let lastFilter = '';     // picker filter, remembered across dialog opens (this app session only)

function newCtxId() {
  const B = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const a = new Uint8Array(22);
  crypto.getRandomValues(a);
  return [...a].map((b) => B[b % 62]).join('');
}

function openCreateDialog() {
  // Seed with the filter from the previous add, so a run of similar widgets
  // doesn't make you retype "light" each time (reset when the app restarts).
  dlg = { mode: 'create', step: 1, defId: null, instId: null, filter: lastFilter };
  pendingCtxId = null;
  renderDialog();
  const search = els.dlgBody.querySelector('#dlgSearch');
  if (search) search.focus();
}

function openEditDialog(instId) {
  const inst = instances.find((i) => i.id === instId);
  if (!inst) return;
  dlg = { mode: 'edit', step: 2, defId: inst.widgetId, instId, filter: '' };
  pendingCtxId = newCtxId(); // ready in case they pick "New context"
  renderDialog();
}

function closeDialog() {
  dlg = null;
  pendingCtxId = null;
  els.dlgOverlay.hidden = true;
}

function defMatches(d, needle) {
  if (!needle) return true;
  const hay = [d.id, d.title, d.description, ...d.capabilities.flatMap((c) => [c.profile, c.role])]
    .join(' ')
    .toLowerCase();
  return needle.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
}

function renderPickList() {
  const list = els.dlgBody.querySelector('#dlgPickList');
  if (!list || !dlg) return;
  const matching = defs.filter((d) => defMatches(d, dlg.filter));
  list.innerHTML = matching.map((d) => {
    const caps = d.capabilities
      .map((c) => `<span class="cap-chip ${c.role}">${esc(c.role)} of ${esc(c.profile)}</span>`)
      .join(' ');
    const src = d.source
      ? `<span class="chip src ${esc(d.source)}" title="${d.source === 'library' ? 'from the online widget library' : d.source === 'local' ? 'from your local widget folder' : 'shipped with the app'}">${esc(d.source)}</span>`
      : '';
    const badge = src + (d.ok
      ? (d.hasBehavior ? ' <span class="chip auto" title="has auto-actualize rules">auto</span>' : '')
      : ' <span class="chip bad">invalid</span>');
    const err = d.ok ? '' : `<div class="def-error">${esc(d.errors[0] || 'Invalid definition.')}</div>`;
    return `<div class="pick-row ${d.ok ? '' : 'invalid'}" ${d.ok ? `data-pick="${esc(d.id)}" role="button" tabindex="0"` : ''}>
      <span class="pick-icon">${esc(d.icon || '▦')}</span>
      <div class="pick-main">
        <div class="def-title">${esc(d.title)} ${badge}</div>
        <div class="def-desc">${esc(d.description)}</div>
        <div class="def-caps">${caps}</div>
        ${err}
      </div>
    </div>`;
  }).join('') || `<p class="empty">No widget matches “${esc(dlg.filter)}”.</p>`;
}

// Snapshot/restore the config form across re-renders so nothing the user
// typed or selected is ever lost when the dialog legitimately needs rebuilding.
function snapshotForm() {
  if (!dlg || dlg.step !== 2) return null;
  const q = (id) => els.dlgBody.querySelector('#' + id);
  return {
    name: q('af-name') ? q('af-name').value : null,
    ctxName: q('af-ctxname') ? q('af-ctxname').value : null,
    newChecked: q('af-ctx-new') ? q('af-ctx-new').checked : false,
    checkedIds: [...els.dlgBody.querySelectorAll('.af-ctx-box')].filter((b) => b.checked).map((b) => b.dataset.id),
    uncheckedIds: [...els.dlgBody.querySelectorAll('.af-ctx-box')].filter((b) => !b.checked).map((b) => b.dataset.id),
  };
}

function restoreForm(snap) {
  if (!snap || !dlg || dlg.step !== 2) return;
  const q = (id) => els.dlgBody.querySelector('#' + id);
  if (snap.name != null && q('af-name')) q('af-name').value = snap.name;
  if (snap.ctxName != null && q('af-ctxname')) q('af-ctxname').value = snap.ctxName;
  if (q('af-ctx-new')) q('af-ctx-new').checked = !!snap.newChecked;
  for (const b of els.dlgBody.querySelectorAll('.af-ctx-box')) {
    if (snap.checkedIds.includes(b.dataset.id)) b.checked = true;
    else if (snap.uncheckedIds.includes(b.dataset.id)) b.checked = false;
  }
  syncFormRows();
}

function renderDialog(preserve = false) {
  if (!dlg) return;
  const snap = preserve ? snapshotForm() : null;
  els.dlgOverlay.hidden = false;
  els.dlgFoot.hidden = dlg.step !== 1;

  if (dlg.step === 1) {
    els.dlgTitle.textContent = 'Add a widget';
    els.dlgBody.innerHTML = `
      <label class="dlg-search-row">Find a widget
        <input type="search" id="dlgSearch" placeholder="type to filter — e.g. “light”" autocomplete="off" value="${esc(dlg.filter)}" />
      </label>
      <div id="dlgPickList" class="pick-list"></div>`;
    renderPickList();
    return;
  }

  // ---- step 2: configuration ----
  const d = defs.find((x) => x.id === dlg.defId);
  const inst = dlg.mode === 'edit' ? instances.find((i) => i.id === dlg.instId) : null;
  if (!d || (dlg.mode === 'edit' && !inst)) { closeDialog(); return; }
  els.dlgTitle.textContent = dlg.mode === 'edit' ? 'Edit widget' : 'Add a widget';
  if (dlg.mode === 'create' && !pendingCtxId) pendingCtxId = newCtxId();

  const caps = d.capabilities
    .map((c) => `<span class="cap-chip ${c.role}">${esc(c.role)} of ${esc(c.profile)}</span>`)
    .join(' ');
  const summary = `<div class="dlg-chosen">
    <span class="pick-icon">${esc(d.icon || '▦')}</span>
    <div class="pick-main">
      <div class="def-title">${esc(d.title)}</div>
      <div class="def-caps">${caps}</div>
    </div>
    ${dlg.mode === 'create'
      ? '<button type="button" class="ghost" data-back>Change</button>'
      : '<span class="muted-note" title="A different widget type is a different contract — create a new widget instead.">type is fixed</span>'}
  </div>`;

  // Contexts are the PLACES this widget is present in — one or many (a
  // landlord's lease declared into each unit's context). Current contexts
  // (edit) and matching realm contexts are one composable checkbox list.
  const current = inst ? (inst.contexts || [{ id: inst.contextId, name: inst.contextName }]) : [];
  const ctxs = contextsMatching(d, current.map((c) => c.id));
  // Creating: if any context could bind this widget, DEFAULT to joining the
  // best match (unbound partners first) — a widget alone in a fresh context
  // binds nothing, and a prefilled context name made that accident silent.
  const defaultJoin = dlg.mode === 'create' && ctxs.length > 0;
  const currentRows = current
    .map((c) => `<label class="checkbox"><input type="checkbox" class="af-ctx-box af-ctx-cur" data-id="${esc(c.id)}" data-name="${esc(c.name)}" checked />
      <span><strong>${esc(c.name)}</strong> <span class="mono">${esc(c.id.slice(0, 8))}…</span> — current${current.length === 1 ? '' : ''}</span></label>`)
    .join('');
  const matchRows = ctxs
    .map((c, i) => `<label class="checkbox"><input type="checkbox" class="af-ctx-box af-ctx-match" data-id="${esc(c.id)}" data-name="${esc(c.name)}" ${defaultJoin && i === 0 ? 'checked' : ''} />
      <span>Join <strong>${esc(c.name)}</strong> <span class="mono">${esc(c.id.slice(0, 8))}…</span> (${esc(c.partnersText)})</span></label>`)
    .join('');

  els.dlgBody.innerHTML = `${summary}
    <label>Name <input type="text" id="af-name" value="${esc(inst ? inst.name : d.title)}" autocomplete="off" /></label>
    <div class="ctx-choice" id="af-ctxlist">
      <p class="muted-note">Contexts — the places this widget lives in. Connections only form inside a shared context; pick one or more.</p>
      ${currentRows}
      <div id="af-ctxmatches">${matchRows}</div>
      <div id="af-join-hint" class="ctx-info" ${ctxs.length ? 'hidden' : ''}>No realm context has a matching partner for this widget${connected ? '' : ' (not connected)'} — create a new context and let a partner join you instead.</div>
      <label class="checkbox"><input type="checkbox" id="af-ctx-new" ${defaultJoin || dlg.mode === 'edit' ? '' : 'checked'} /> <span>New context</span></label>
      <label id="af-ctxname-row">Context name <input type="text" id="af-ctxname" value="" placeholder="name the new matching space — required" autocomplete="off" /></label>
      <div id="af-ctxinfo-new" class="ctx-info">Creates a new matching space with id <span class="mono">${esc(pendingCtxId || '')}</span>.
        Nothing else is in it yet — that presence shows <em>awaiting broker</em> until something joins the context.</div>
      ${dlg.mode === 'edit' ? '<div class="ctx-info">Unchecking a context drops that presence on re-attach — its old registration remains on the realm until cleaned up there.</div>' : ''}
    </div>
    <div class="actions">
      <button type="button" class="primary" id="af-create" ${dlg.mode === 'edit' || connected ? '' : 'disabled'}>${dlg.mode === 'edit' ? 'Save changes' : 'Create widget'}</button>
      <span class="muted-note">${dlg.mode === 'edit'
        ? (connected ? 'Applies immediately on the realm.' : 'Saved locally — applies when you reconnect.')
        : (connected ? 'Registers a Node under this app’s System.' : 'Connect first (Config tab).')}</span>
    </div>`;
  if (snap) restoreForm(snap); else syncFormRows();
}

// Toggle the new-context rows to match the checkbox state.
function syncFormRows() {
  const q = (id) => els.dlgBody.querySelector('#' + id);
  const boxNew = q('af-ctx-new');
  if (!boxNew) return;
  q('af-ctxname-row').hidden = !boxNew.checked;
  q('af-ctxinfo-new').hidden = !boxNew.checked;
}

// Update ONLY the matching-context rows in place (called on live keys
// updates) — never rebuilds the form, always preserves checked states.
function refreshCtxOptions() {
  if (!dlg || dlg.step !== 2) return;
  const host = els.dlgBody.querySelector('#af-ctxmatches');
  if (!host) return;
  const d = defs.find((x) => x.id === dlg.defId);
  const inst = dlg.mode === 'edit' ? instances.find((i) => i.id === dlg.instId) : null;
  const current = inst ? (inst.contexts || [{ id: inst.contextId, name: inst.contextName }]) : [];
  const ctxs = contextsMatching(d, current.map((c) => c.id));
  const html = ctxs
    .map((c) => `<label class="checkbox"><input type="checkbox" class="af-ctx-box af-ctx-match" data-id="${esc(c.id)}" data-name="${esc(c.name)}" />
      <span>Join <strong>${esc(c.name)}</strong> <span class="mono">${esc(c.id.slice(0, 8))}…</span> (${esc(c.partnersText)})</span></label>`)
    .join('');
  if (host.dataset.rendered === html) return; // nothing changed — don't touch it
  const checked = new Set([...host.querySelectorAll('.af-ctx-box')].filter((b) => b.checked).map((b) => b.dataset.id));
  host.innerHTML = html;
  host.dataset.rendered = html;
  for (const b of host.querySelectorAll('.af-ctx-box')) if (checked.has(b.dataset.id)) b.checked = true;
  const hint = els.dlgBody.querySelector('#af-join-hint');
  if (hint) hint.hidden = ctxs.length > 0;
}

async function submitDialog() {
  if (!dlg || dlg.step !== 2) return;
  const q = (id) => els.dlgBody.querySelector('#' + id);
  const name = q('af-name').value.trim();
  if (!name) return;
  const btn = q('af-create');

  const spec = { name };
  // Every checked context = one presence. Current + joined keep their ids and
  // names; "New context" mints the id shown and needs a deliberate name —
  // never defaulted from the widget (that default is how identically-named
  // orphan contexts got minted).
  const contexts = [...els.dlgBody.querySelectorAll('.af-ctx-box')]
    .filter((b) => b.checked)
    .map((b) => ({ id: b.dataset.id, name: b.dataset.name }));
  if (q('af-ctx-new').checked) {
    const ctxName = q('af-ctxname').value.trim();
    if (!ctxName) { q('af-ctxname').focus(); q('af-ctxname').classList.add('field-missing'); return; }
    contexts.push({ id: pendingCtxId || undefined, name: ctxName });
  }
  if (!contexts.length) { q('af-ctx-new').focus(); return; } // a widget must live SOMEWHERE
  spec.contexts = contexts;

  btn.disabled = true;
  try {
    if (dlg.mode === 'edit') {
      spec.id = dlg.instId;
      await window.arete.widgetUpdate(spec);
      closeDialog();
    } else {
      spec.widgetId = dlg.defId;
      const inst = await window.arete.widgetAdd(spec);
      closeDialog();
      if (inst) window.arete.widgetOpen(inst.id);
    }
  } catch (err) {
    logLine({ level: 'error', message: String(err.message || err) });
    if (els.dlgBody.contains(btn)) btn.disabled = false;
  }
}

// ---- dialog events (delegated on stable containers) ----
els.dlgClose.addEventListener('click', closeDialog);
els.dlgOverlay.addEventListener('click', (e) => { if (e.target === els.dlgOverlay) closeDialog(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && dlg) closeDialog(); });

els.dlgBody.addEventListener('click', (e) => {
  const pick = e.target.closest('[data-pick]');
  if (pick && dlg && dlg.step === 1) {
    dlg.defId = pick.dataset.pick;
    dlg.step = 2;
    pendingCtxId = newCtxId();
    renderDialog();
    return;
  }
  if (e.target.closest('[data-back]') && dlg && dlg.mode === 'create') {
    dlg.step = 1;
    pendingCtxId = null;
    renderDialog();
    const search = els.dlgBody.querySelector('#dlgSearch');
    if (search) search.focus();
    return;
  }
  if (e.target.closest('#af-create')) submitDialog();
});
els.dlgBody.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.closest('[data-pick]')) e.target.closest('[data-pick]').click();
});
els.dlgBody.addEventListener('input', (e) => {
  if (e.target.id === 'dlgSearch' && dlg) {
    dlg.filter = e.target.value;
    lastFilter = e.target.value; // remember for the next add this session
    renderPickList(); // ONLY the list — the input keeps focus and its value
  }
  if (e.target.id === 'af-ctxname') e.target.classList.remove('field-missing');
});
els.dlgBody.addEventListener('change', (e) => {
  if (e.target && e.target.id === 'af-ctx-new') syncFormRows();
});

// =========================================================================
// The tile grid — the home page. One tile per widget + a big “+”.
// Tiles hold no typed user state, so re-rendering is always safe: the ⋯ menu
// and armed-remove states are part of the render.
// =========================================================================
let menuFor = null;     // instance id whose ⋯ menu is open
let removeArmed = null; // instance id armed for removal
let removeAllArmed = false; // header "Remove all" confirm showing

// The header "Remove all…" control: hidden with no widgets; armed shows an
// are-you-sure popover (same look as the tile remove confirm).
function renderRemoveAll() {
  const w = els.removeAllWrap;
  if (!w) return;
  if (!instances.length) { removeAllArmed = false; w.innerHTML = ''; return; }
  w.innerHTML = removeAllArmed
    ? `<button type="button" class="danger" data-ra-arm>Remove all…</button>
       <div class="tile-menu confirm" data-ra-panel>
        <div class="menu-q">Remove all ${instances.length} widget${instances.length === 1 ? '' : 's'}?</div>
        <div class="menu-note">Removes every widget from this app and closes their faceplates. The realm nodes are left as-is.</div>
        <div class="menu-row">
          <button type="button" data-ra-cancel>Cancel</button>
          <button type="button" class="danger" data-ra-yes>Remove all</button>
        </div>
      </div>`
    : `<button type="button" class="danger" data-ra-arm title="Remove every widget from this app">Remove all…</button>`;
}

// A widget attached with ZERO connections is "awaiting broker" for a grace
// period; if it is STILL unbound after that, the wait is almost certainly
// structural (nothing complementary in its context) — badge it and say so.
const UNBOUND_GRACE_MS = 10000;
const zeroSince = new Map(); // instance id -> first time seen attached with 0 conns
let unboundTimer = null;

function unboundHint(i) {
  const def = defs.find((d) => d.id === i.widgetId);
  const partners = ((def && def.capabilities) || [])
    .map((c) => `a ${c.role === 'provider' ? 'consumer' : 'provider'} of ${c.profile}`);
  const need = partners.length ? partners.join(' or ') : 'a matching partner';
  return `No binding after ${UNBOUND_GRACE_MS / 1000}s — this context has no ${need}. ` +
    'Edit the widget and join the context its partner is in.';
}

function renderTiles() {
  els.s.attached.textContent = `${instances.filter((i) => i.attached).length} / ${instances.length}`;
  let anyWaiting = false;
  const tiles = instances.map((i) => {
    const def = defs.find((d) => d.id === i.widgetId);
    const icon = def && def.icon ? def.icon : '▦';
    const accent = def && def.color ? ` style="--tile-accent:${esc(def.color)}"` : '';
    let chip;
    if (!i.attached) {
      zeroSince.delete(i.id);
      chip = '<span class="chip off">offline</span>';
    } else if (i.connections > 0) {
      zeroSince.delete(i.id);
      chip = `<span class="chip ok">bound · ${i.connections}</span>`;
    } else {
      if (!zeroSince.has(i.id)) zeroSince.set(i.id, Date.now());
      const stuck = Date.now() - zeroSince.get(i.id) > UNBOUND_GRACE_MS;
      anyWaiting = anyWaiting || !stuck;
      chip = stuck
        ? `<span class="chip bad" title="${esc(unboundHint(i))}">unbound</span>`
        : '<span class="chip wait">awaiting broker</span>';
    }
    const stateBits = Object.entries(i.state || {}).slice(0, 3)
      .map(([k, v]) => `<span class="kv"><span class="k">${esc(k)}</span>=<span class="v">${esc(v)}</span></span>`)
      .join(' ');
    const peerNames = [...new Set((i.peers || []).map((p) => p.node))];
    const peerBit = peerNames.length
      ? `<div class="tile-peers">⇄ ${esc(peerNames.slice(0, 3).join(', '))}${peerNames.length > 3 ? '…' : ''}</div>`
      : '';
    let menu = '';
    if (menuFor === i.id) {
      menu = removeArmed === i.id
        ? `<div class="tile-menu confirm" data-menu-panel>
            <div class="menu-q">Remove “${esc(i.name)}”?</div>
            <div class="menu-note">Removes it from this app. The realm node is left as-is.</div>
            <div class="menu-row">
              <button type="button" data-remove-cancel>Cancel</button>
              <button type="button" class="danger" data-remove-yes="${esc(i.id)}">Remove</button>
            </div>
          </div>`
        : `<div class="tile-menu" data-menu-panel>
            <button type="button" data-edit="${esc(i.id)}">Edit…</button>
            <button type="button" class="danger" data-remove="${esc(i.id)}">Remove…</button>
          </div>`;
    }
    return `<div class="tile ${menuFor === i.id ? 'menu-open' : ''}" data-open="${esc(i.id)}"${accent} role="button" tabindex="0" title="Open the faceplate">
      <div class="tile-top">
        <span class="tile-icon">${esc(icon)}</span>
        <button type="button" class="ghost tile-more" data-menu="${esc(i.id)}" aria-label="Widget menu" title="Edit or remove">⋯</button>
        ${menu}
      </div>
      <div class="tile-name">${esc(i.name)}</div>
      <div class="tile-sub">${esc(i.widgetTitle)} · ${(i.contexts || []).length > 1
        ? esc(i.contexts.map((c) => c.name).join(' · '))
        : esc(i.contextName)}</div>
      <div class="tile-chip">${chip}</div>
      <div class="tile-state">${stateBits}</div>
      ${peerBit}
    </div>`;
  }).join('');
  els.tileGrid.innerHTML = tiles + `<button type="button" class="tile plus" data-plus title="Add a widget">
      <span class="plus-sign">+</span><span class="plus-label">Add widget</span>
    </button>`;
  renderRemoveAll();
  // While anything sits in its grace period, re-render on a short timer so
  // "awaiting broker" flips to "unbound" without needing a state event.
  if (anyWaiting && !unboundTimer) {
    unboundTimer = setTimeout(() => { unboundTimer = null; renderTiles(); }, UNBOUND_GRACE_MS / 2);
  }
}

els.removeAllWrap.addEventListener('click', (e) => {
  if (e.target.closest('[data-ra-yes]')) {
    removeAllArmed = false;
    window.arete.widgetRemoveAll(); // 'instances' push re-renders the grid
    return;
  }
  if (e.target.closest('[data-ra-cancel]')) {
    removeAllArmed = false;
    renderRemoveAll();
    return;
  }
  if (e.target.closest('[data-ra-arm]')) {
    removeAllArmed = !removeAllArmed;
    renderRemoveAll();
  }
});

els.tileGrid.addEventListener('click', (e) => {
  const menuBtn = e.target.closest('[data-menu]');
  if (menuBtn) {
    menuFor = menuFor === menuBtn.dataset.menu ? null : menuBtn.dataset.menu;
    removeArmed = null;
    renderTiles();
    return;
  }
  const edit = e.target.closest('[data-edit]');
  if (edit) {
    menuFor = null;
    renderTiles();
    openEditDialog(edit.dataset.edit);
    return;
  }
  const rm = e.target.closest('[data-remove]');
  if (rm) {
    removeArmed = rm.dataset.remove; // show the confirm view inside the menu
    renderTiles();
    return;
  }
  if (e.target.closest('[data-remove-cancel]')) {
    removeArmed = null; // back to the Edit / Remove menu
    renderTiles();
    return;
  }
  const yes = e.target.closest('[data-remove-yes]');
  if (yes) {
    const id = yes.dataset.removeYes;
    removeArmed = null;
    menuFor = null;
    window.arete.widgetRemove(id);
    return;
  }
  if (e.target.closest('[data-plus]')) {
    openCreateDialog();
    return;
  }
  const tile = e.target.closest('.tile[data-open]');
  if (tile) window.arete.widgetOpen(tile.dataset.open);
});
els.tileGrid.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('.tile[data-open]')) {
    window.arete.widgetOpen(e.target.dataset.open);
  }
});
// Any click outside the open ⋯ menu closes it.
document.addEventListener('click', (e) => {
  if (menuFor && !e.target.closest('[data-menu],[data-menu-panel]')) {
    menuFor = null;
    removeArmed = null;
    renderTiles();
  }
});

// ---- Connect ----
async function doConnect(auto) {
  els.connectBtn.disabled = true;
  const opts = {
    protocol: els.protocol.value,
    host: els.host.value.trim(),
    port: Number(els.port.value),
    username: els.username.value.trim(),
    password: els.password.value,
    allowSelfSigned: els.allowSelfSigned.checked,
    systemName: els.systemName.value.trim(),
    rememberPassword: els.rememberPassword.checked,
    autoConnect: els.autoConnect.checked,
  };
  try {
    await window.arete.connect(opts);
    activateTab('panel-widgets');
  } catch (err) {
    logLine({ level: 'error', message: String(err.message || err) });
    els.connectBtn.disabled = false;
    if (auto) activateTab('panel-config');
  }
}

// The "change" link on the system-name note jumps to Config and focuses the field.
els.systemNameNote.addEventListener('click', (e) => {
  if (e.target.closest('#changeSystemName')) {
    e.preventDefault();
    activateTab('panel-config');
    els.systemName.focus();
    els.systemName.select();
  }
});
// Keep the note in sync as the field is edited (so it reflects what will register).
els.systemName.addEventListener('input', () => {
  const name = els.systemName.value.trim() || els.systemName.placeholder || 'Arete Widget';
  els.systemNameNote.innerHTML = `nodes register under “${esc(name)}” · <a href="#" id="changeSystemName">change</a>`;
});

els.form.addEventListener('submit', (e) => { e.preventDefault(); doConnect(false); });
els.disconnectBtn.addEventListener('click', () => window.arete.disconnect());
els.clearLogBtn.addEventListener('click', () => (els.log.innerHTML = ''));
els.cpLink.addEventListener('click', (e) => { e.preventDefault(); window.arete.openExternal(els.cpLink.dataset.url); });
els.reloadDefsBtn.addEventListener('click', async () => {
  els.reloadDefsBtn.disabled = true;
  try {
    await window.arete.widgetReload(); // rescans folders AND refreshes the online library
  } finally {
    els.reloadDefsBtn.disabled = false;
    updateLibraryNote();
  }
});

let userDirCache = '';
async function updateLibraryNote(userDir) {
  if (userDir) userDirCache = userDir;
  try {
    const li = await window.arete.libraryInfo();
    const fresh = li.updatedAt ? ` · refreshed ${new Date(li.updatedAt).toLocaleString()}` : ' · not fetched yet';
    const lib = li.url ? `Online library: ${li.url} (${li.count} widgets${fresh})` : 'Online library: off';
    els.userDirNote.textContent = `${lib} — your local folder: ${userDirCache}`;
  } catch (_) {
    els.userDirNote.textContent = `Your widget folder: ${userDirCache}`;
  }
}

els.libraryUrl.addEventListener('change', () => {
  window.arete.saveSettings({ libraryUrl: els.libraryUrl.value.trim() });
});
els.autoConnect.addEventListener('change', () => window.arete.setAutoConnect(els.autoConnect.checked));
els.themeLight.addEventListener('change', () => {
  const light = els.themeLight.checked;
  document.body.classList.toggle('light', light);
  window.arete.saveSettings({ theme: light ? 'light' : 'dark' });
});

// ---- Init ----
async function init() {
  const d = await window.arete.getDefaults();
  els.protocol.value = d.protocol;
  els.host.value = d.host;
  els.port.value = d.port;
  els.username.value = d.username;
  els.password.value = d.password;
  els.systemName.value = d.systemName;
  els.allowSelfSigned.checked = !!d.allowSelfSigned;
  els.rememberPassword.checked = !!d.rememberPassword;
  els.autoConnect.checked = !!d.autoConnect;
  if (!d.canRememberPassword) {
    els.rememberPassword.disabled = true;
    els.rememberNote.textContent = '(no OS keychain available)';
  }
  const light = d.theme === 'light';
  document.body.classList.toggle('light', light);
  els.themeLight.checked = light;
  if (d.appVersion) els.appVersion.textContent = `v${d.appVersion}`;
  els.systemNameNote.innerHTML = `nodes register under “${esc(d.systemName)}” · <a href="#" id="changeSystemName">change</a>`;
  els.libraryUrl.value = d.libraryUrl;
  els.libraryUrl.placeholder = d.libraryUrlDefault;
  updateLibraryNote(d.userWidgetsDir);

  window.arete.onLog(logLine);
  window.arete.onStatus(renderStatus);
  window.arete.onKeys((k) => { keys = k || {}; refreshCtxOptions(); });
  window.arete.onWidgetDefs((list) => {
    defs = list || [];
    renderTiles(); // tile icons/colors come from the defs
    if (dlg && dlg.step === 1) renderPickList();
  });
  window.arete.onWidgetInstances((list) => { instances = list || []; renderTiles(); });
  window.arete.onWidgetState(({ id, state, connections, peers }) => {
    const i = instances.find((x) => x.id === id);
    if (i) { i.state = state; i.connections = connections; if (peers) i.peers = peers; renderTiles(); }
  });

  defs = await window.arete.widgetDefs();
  instances = await window.arete.widgetInstances();
  keys = await window.arete.getKeys();
  renderTiles();
  renderStatus(await window.arete.getStatus());
  logLine({ level: 'info', message: 'Ready.' });

  if (d.autoConnect && d.host) {
    logLine({ level: 'info', message: 'Auto-connecting…' });
    doConnect(true);
  } else if (!d.host) {
    activateTab('panel-config');
  }
}

init().catch((e) => logLine({ level: 'error', message: 'Init failed: ' + e }));
