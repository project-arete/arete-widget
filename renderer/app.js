// app.js — MAIN window UI. Talks to main ONLY through window.arete (preload).
// Three tabs: Widgets (library + instances), Status (state + log), Config.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const els = {
  statusDot: $('statusDot'),
  statePill: $('statePill'),
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
  defList: $('defList'), reloadDefsBtn: $('reloadDefsBtn'), userDirNote: $('userDirNote'),
  libraryUrl: $('libraryUrl'),
  instanceList: $('instanceList'), instancesEmpty: $('instancesEmpty'),
  systemNameNote: $('systemNameNote'),
};

let keys = {};
let defs = [];
let instances = [];
let connected = false;
let openAddForm = null; // widgetId whose add-form is open

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
  // Only re-render the widget panels when connectedness actually CHANGES —
  // status arrives every 2s, and a blind re-render would rebuild the open
  // add-form mid-interaction (resetting the context dropdown + typed name).
  if (connected !== lastConnected) {
    lastConnected = connected;
    renderInstances();
    renderDefs();
  }
}

// ---- Realm context picker (broker matches on context ID) ----
// Parse contexts with their names AND their declared capabilities, so the
// Join picker can show only contexts that hold a COMPLEMENTARY role for the
// widget's CP(s) — the only contexts the broker could actually bind in.
function realmContexts() {
  const m = {};
  const nameRe = /^cns\/([^/]+)\/nodes\/([^/]+)\/contexts\/([^/]+)\/name$/;
  const capRe = /^cns\/([^/]+)\/nodes\/([^/]+)\/contexts\/([^/]+)\/(provider|consumer)\/([^/]+)\//;
  const decls = {}; // ctxId -> Set("sys|node|role|profile") — distinct declarations
  for (const k in keys) {
    let mm = k.match(nameRe);
    if (mm) {
      const e = m[mm[3]] || (m[mm[3]] = { names: {}, count: 0 });
      e.names[keys[k]] = (e.names[keys[k]] || 0) + 1;
      e.count++;
      continue;
    }
    mm = k.match(capRe);
    if (mm) (decls[mm[3]] || (decls[mm[3]] = new Set())).add(`${mm[1]}|${mm[2]}|${mm[4]}|${mm[5]}`);
  }
  return Object.entries(m)
    .map(([id, e]) => {
      const names = Object.entries(e.names).sort((a, b) => b[1] - a[1]);
      const roles = {}; // "role|profile" -> distinct declaration count
      for (const d of decls[id] || []) {
        const [, , role, profile] = d.split('|');
        roles[`${role}|${profile}`] = (roles[`${role}|${profile}`] || 0) + 1;
      }
      return { id, name: names[0][0], also: names.slice(1).map(([n]) => n), declarations: e.count, roles };
    })
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

// Only the contexts where the broker could bind THIS widget: at least one
// declaration of the opposite role for one of the widget's profiles.
function contextsMatching(d) {
  const wanted = ((d && d.capabilities) || []).map((c) => ({
    profile: c.profile,
    partner: c.role === 'provider' ? 'consumer' : 'provider',
  }));
  return realmContexts()
    .map((c) => {
      const partners = [];
      for (const w of wanted) {
        const n = c.roles[`${w.partner}|${w.profile}`] || 0;
        if (n) partners.push(`${n} ${w.profile} ${w.partner}${n === 1 ? '' : 's'}`);
      }
      return { ...c, partnersText: partners.join(', ') };
    })
    .filter((c) => c.partnersText);
}

// ---- Widget library ----
// Snapshot/restore the open add-form across re-renders so nothing the user
// typed or selected is ever lost when the list legitimately needs rebuilding.
function snapshotAddForm() {
  if (!openAddForm) return null;
  const form = els.defList.querySelector(`[data-form="${CSS.escape(openAddForm)}"]`);
  if (!form) return null;
  const q = (id) => form.querySelector('#' + id);
  return {
    name: q('af-name') ? q('af-name').value : null,
    join: q('af-ctx-join') ? q('af-ctx-join').checked : false,
    ctxName: q('af-ctxname') ? q('af-ctxname').value : null,
    ctxSel: q('af-ctxsel') ? q('af-ctxsel').value : null,
  };
}

function restoreAddForm(snap) {
  if (!snap || !openAddForm) return;
  const form = els.defList.querySelector(`[data-form="${CSS.escape(openAddForm)}"]`);
  if (!form) return;
  const q = (id) => form.querySelector('#' + id);
  if (snap.name != null && q('af-name')) q('af-name').value = snap.name;
  if (snap.ctxName != null && q('af-ctxname')) q('af-ctxname').value = snap.ctxName;
  if (snap.join && q('af-ctx-join') && !q('af-ctx-join').disabled) {
    q('af-ctx-join').checked = true;
    q('af-ctx-new').checked = false;
  }
  const sel = q('af-ctxsel');
  if (sel && snap.ctxSel != null && [...sel.options].some((o) => o.value === snap.ctxSel)) {
    sel.value = snap.ctxSel;
  }
  syncAddFormRows();
}

// Update ONLY the context <select> options in place (called on live keys
// updates) — never rebuilds the form, always preserves the current selection.
function refreshCtxOptions() {
  const sel = els.defList.querySelector('#af-ctxsel');
  if (!sel) return;
  const cur = sel.value;
  const d = defs.find((x) => x.id === openAddForm);
  const html = contextsMatching(d)
    .map((c) => `<option value="${esc(c.id)}" data-name="${esc(c.name)}">${esc(c.name)} — ${esc(c.id.slice(0, 8))}… (${esc(c.partnersText)})</option>`)
    .join('');
  if (sel.dataset.rendered === html) return; // nothing changed — don't touch it
  sel.innerHTML = html;
  sel.dataset.rendered = html;
  if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
  const joinRadio = els.defList.querySelector('#af-ctx-join');
  if (joinRadio) {
    joinRadio.disabled = sel.options.length === 0;
    if (joinRadio.disabled && joinRadio.checked) {
      // The last matching context vanished mid-form — fall back to New.
      joinRadio.checked = false;
      els.defList.querySelector('#af-ctx-new').checked = true;
      syncAddFormRows();
    }
  }
  const hint = els.defList.querySelector('#af-join-hint');
  if (hint) hint.hidden = sel.options.length > 0;
  updateJoinInfo(); // the described context may have gained declarations/names
}

function renderDefs() {
  const snap = snapshotAddForm();
  const cards = defs.map((d) => {
    const caps = d.capabilities
      .map((c) => `<span class="cap-chip ${c.role}">${esc(c.role)} of ${esc(c.profile)}</span>`)
      .join(' ');
    const src = d.source
      ? `<span class="chip src ${esc(d.source)}" title="${d.source === 'library' ? 'from the online widget library' : d.source === 'local' ? 'from your local widget folder' : 'shipped with the app'}">${esc(d.source)}</span>`
      : '';
    const badge = src + (d.ok
      ? (d.hasBehavior ? ' <span class="chip auto" title="has auto-actualize rules">auto</span>' : '')
      : ' <span class="chip bad" title="' + esc(d.errors.join(' ')) + '">invalid</span>');
    const err = d.ok ? '' : `<div class="def-error">${esc(d.errors[0] || 'Invalid definition.')}</div>`;
    const addForm = openAddForm === d.id ? renderAddForm(d) : '';
    return `<div class="def-card ${d.ok ? '' : 'invalid'}" data-id="${esc(d.id)}">
      <div class="def-head">
        <div>
          <div class="def-title">${d.icon ? esc(d.icon) + ' ' : ''}${esc(d.title)} ${badge}</div>
          <div class="def-desc">${esc(d.description)}</div>
          <div class="def-caps">${caps}</div>
        </div>
        <button type="button" class="primary add-btn" data-add="${esc(d.id)}" ${d.ok ? '' : 'disabled'}>Add</button>
      </div>
      ${err}${addForm}
    </div>`;
  }).join('');
  els.defList.innerHTML = cards || '<p class="empty">No widget definitions found.</p>';

  if (openAddForm) restoreAddForm(snap);
}

// ---- Event delegation for the widget panels ----
// Wired ONCE on the stable containers, so controls keep working no matter how
// often the innerHTML inside them is re-rendered. (Per-element listeners were
// fragile: any rebuild silently produced dead radios/dropdowns.)
els.defList.addEventListener('click', (e) => {
  const add = e.target.closest('[data-add]');
  if (add) {
    openAddForm = openAddForm === add.dataset.add ? null : add.dataset.add;
    pendingCtxId = openAddForm ? newCtxId() : null; // mint (or drop) the would-be context id
    renderDefs();
    return;
  }
  if (e.target.closest('#af-create')) createFromForm();
});
els.defList.addEventListener('change', (e) => {
  const id = e.target && e.target.id;
  if (id === 'af-ctx-new' || id === 'af-ctx-join') syncAddFormRows();
  else if (id === 'af-ctxsel') updateJoinInfo();
});
els.instanceList.addEventListener('click', (e) => {
  const open = e.target.closest('[data-open]');
  if (open) {
    window.arete.widgetOpen(open.dataset.open);
    return;
  }
  const rm = e.target.closest('[data-remove]');
  if (rm) {
    const id = rm.dataset.remove;
    if (removeArmed === id) {
      removeArmed = null;
      window.arete.widgetRemove(id);
    } else {
      removeArmed = id;
      renderInstances();
      setTimeout(() => {
        if (removeArmed === id) { removeArmed = null; renderInstances(); }
      }, 3000);
    }
  }
});

// The context ID minted for "New context" — generated once when the form
// opens (survives re-renders) so what you see is exactly what gets created.
let pendingCtxId = null;
function newCtxId() {
  const B = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const a = new Uint8Array(22);
  crypto.getRandomValues(a);
  return [...a].map((b) => B[b % 62]).join('');
}

function renderAddForm(d) {
  const ctxs = contextsMatching(d);
  const opts = ctxs
    .map((c) => `<option value="${esc(c.id)}" data-name="${esc(c.name)}">${esc(c.name)} — ${esc(c.id.slice(0, 8))}… (${esc(c.partnersText)})</option>`)
    .join('');
  const joinDisabled = ctxs.length ? '' : 'disabled';
  return `<div class="add-form" data-form="${esc(d.id)}">
    <label>Name <input type="text" id="af-name" value="${esc(d.title)}" autocomplete="off" /></label>
    <div class="ctx-choice">
      <label class="checkbox"><input type="radio" name="af-ctx" id="af-ctx-new" checked /> <span>New context</span></label>
      <label class="checkbox"><input type="radio" name="af-ctx" id="af-ctx-join" ${joinDisabled} /> <span>Join existing</span></label>
    </div>
    <div id="af-join-hint" class="ctx-info" ${joinDisabled ? '' : 'hidden'}>No context in the realm has a matching partner for this widget${connected ? '' : ' (not connected)'} — create a new context and let a partner join you instead.</div>
    <label id="af-ctxname-row">Context name <input type="text" id="af-ctxname" value="${esc(d.title)}" autocomplete="off" /></label>
    <div id="af-ctxinfo-new" class="ctx-info">Creates a new matching space with id <span class="mono">${esc(pendingCtxId || '')}</span>.
      Nothing else is in it yet — the widget will show <em>awaiting broker</em> until something joins this context.</div>
    <label id="af-ctxsel-row" hidden>Context <select id="af-ctxsel">${opts}</select></label>
    <div id="af-ctxinfo-join" class="ctx-info" hidden></div>
    <div class="actions">
      <button type="button" class="primary" id="af-create" ${connected ? '' : 'disabled'}>Create widget</button>
      <span class="muted-note">${connected ? 'Registers a Node under this app’s System.' : 'Connect first (Config tab).'}</span>
    </div>
  </div>`;
}

// Toggle the New/Join rows to match the radio state (top-level so restore and
// live refresh can reuse it).
function syncAddFormRows() {
  const q = (id) => els.defList.querySelector('#' + id);
  const radioNew = q('af-ctx-new');
  if (!radioNew) return;
  const joining = q('af-ctx-join').checked;
  q('af-ctxname-row').hidden = joining;
  q('af-ctxinfo-new').hidden = joining;
  q('af-ctxsel-row').hidden = !joining;
  q('af-ctxinfo-join').hidden = !joining;
  if (joining) updateJoinInfo();
}

// Describe the currently selected existing context: full id, how many
// declarations already live there, and the other names systems use for it.
function updateJoinInfo() {
  const sel = els.defList.querySelector('#af-ctxsel');
  const info = els.defList.querySelector('#af-ctxinfo-join');
  if (!sel || !info) return;
  const d = defs.find((x) => x.id === openAddForm);
  const c = contextsMatching(d).find((x) => x.id === sel.value);
  if (!c) { info.textContent = ''; return; }
  const also = c.also.length ? ` · also known as: ${c.also.map(esc).join(', ')}` : '';
  info.innerHTML = `Joins <strong>${esc(c.name)}</strong> <span class="mono">${esc(c.id)}</span> —
    already holds ${esc(c.partnersText)}, so the broker should bind your widget on arrival.
    Your system adopts the name “${esc(c.name)}”.${also}`;
}

async function createFromForm() {
  const d = defs.find((x) => x.id === openAddForm);
  const form = els.defList.querySelector('.add-form');
  if (!d || !form) return;
  const q = (id) => form.querySelector('#' + id);
  const name = q('af-name').value.trim();
  if (!name) return;
  const spec = { widgetId: d.id, name };
  if (q('af-ctx-join').checked) {
    const sel = q('af-ctxsel');
    const opt = sel.options[sel.selectedIndex];
    if (!opt) return;
    spec.contextId = opt.value;
    spec.contextName = opt.dataset.name || name; // adopt the existing name
  } else {
    spec.contextId = pendingCtxId || undefined; // exactly the id shown
    spec.contextName = q('af-ctxname').value.trim() || name;
  }
  q('af-create').disabled = true;
  try {
    const inst = await window.arete.widgetAdd(spec);
    openAddForm = null;
    pendingCtxId = null;
    renderDefs();
    if (inst) window.arete.widgetOpen(inst.id);
  } catch (err) {
    logLine({ level: 'error', message: String(err.message || err) });
    const btn = els.defList.querySelector('#af-create');
    if (btn) btn.disabled = false;
  }
}

// ---- Instances ----
let removeArmed = null; // instance id armed for removal
function renderInstances() {
  els.instancesEmpty.hidden = instances.length > 0;
  els.s.attached.textContent = `${instances.filter((i) => i.attached).length} / ${instances.length}`;
  els.instanceList.innerHTML = instances.map((i) => {
    const chip = !i.attached
      ? '<span class="chip off">offline</span>'
      : i.connections > 0
        ? `<span class="chip ok">bound · ${i.connections}</span>`
        : '<span class="chip wait">awaiting broker</span>';
    const stateBits = Object.entries(i.state || {})
      .map(([k, v]) => `<span class="kv"><span class="k">${esc(k)}</span>=<span class="v">${esc(v)}</span></span>`)
      .join(' ');
    const peerNames = [...new Set((i.peers || []).map((p) => p.system))];
    const peerBit = peerNames.length
      ? ` · ⇄ ${esc(peerNames.slice(0, 3).join(', '))}${peerNames.length > 3 ? '…' : ''}`
      : '';
    const removeLabel = removeArmed === i.id ? 'Sure?' : 'Remove';
    return `<div class="inst-row" data-id="${esc(i.id)}">
      <div class="inst-main">
        <div class="inst-name">${esc(i.name)} <span class="inst-widget">${esc(i.widgetTitle)}</span> ${chip}</div>
        <div class="inst-sub">context <strong>${esc(i.contextName)}</strong> <span class="mono dim">${esc(i.contextId.slice(0, 10))}…</span>${peerBit}</div>
        <div class="inst-state">${stateBits}</div>
      </div>
      <div class="inst-actions">
        <button type="button" data-open="${esc(i.id)}">Faceplate</button>
        <button type="button" class="ghost danger" data-remove="${esc(i.id)}">${removeLabel}</button>
      </div>
    </div>`;
  }).join('');

  // (Open/Remove clicks are handled by the delegated listener on instanceList.)
}

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
  els.systemNameNote.textContent = `nodes register under “${d.systemName}”`;
  els.libraryUrl.value = d.libraryUrl;
  els.libraryUrl.placeholder = d.libraryUrlDefault;
  updateLibraryNote(d.userWidgetsDir);

  window.arete.onLog(logLine);
  window.arete.onStatus(renderStatus);
  window.arete.onKeys((k) => { keys = k || {}; refreshCtxOptions(); });
  window.arete.onWidgetDefs((list) => { defs = list || []; renderDefs(); });
  window.arete.onWidgetInstances((list) => { instances = list || []; renderInstances(); });
  window.arete.onWidgetState(({ id, state, connections, peers }) => {
    const i = instances.find((x) => x.id === id);
    if (i) { i.state = state; i.connections = connections; if (peers) i.peers = peers; renderInstances(); }
  });

  defs = await window.arete.widgetDefs();
  instances = await window.arete.widgetInstances();
  keys = await window.arete.getKeys();
  renderDefs();
  renderInstances();
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
