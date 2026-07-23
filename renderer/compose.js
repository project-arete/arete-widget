// compose.js — the COMPOSE tab: a visual canvas over the widget YAML spec.
// Phase 1 of the Widget Composer (see widget-composer-design.md).
//
// The load-bearing invariant: EVERY CANVAS IS A WIDGET YAML DOCUMENT. The
// Composer edits a plain definition object (the same shape yaml.load gives),
// validation and serialization run in main over the SAME core/widget-spec.js
// the runtime uses, and the preview is faceplate.js itself running in an
// iframe against mock state (compose-fp-bridge.js) — the canvas cannot drift
// from what the app would actually run.
//
// Phase 1 scope: identity, capabilities (typed CP + role, registry-validated),
// visual palette + reorderable stack, per-primitive inspector, mock state,
// YAML round-trip (import/export/apply), draft store, save-as-local-widget.
// Rules are displayed (read-only sentences) and PRESERVED verbatim on
// round-trip — the rule builder is Phase 3. Unknown rule clauses (e.g. a
// future gate/is/else) survive untouched.

(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const PRIMS = ['lamp', 'toggle', 'value', 'label', 'field', 'meter', 'options', 'image', 'date', 'stepper', 'split', 'rtt'];
  const LS_DRAFTS = 'composeDrafts.v1';
  const LS_CURRENT = 'composeCurrent.v1';

  const ui = {
    sel: $('cmpDraftSel'), status: $('cmpStatus'),
    newBtn: $('cmpNew'), dupBtn: $('cmpDup'), openBtn: $('cmpOpenDef'), delBtn: $('cmpDelete'),
    exportBtn: $('cmpExport'), saveBtn: $('cmpSave'),
    palette: $('cmpPalette'), viewList: $('cmpViewList'),
    preview: $('cmpPreview'), previewNote: $('cmpPreviewNote'), errors: $('cmpErrors'),
    liveBtn: $('cmpLiveBtn'),
    yaml: $('cmpYaml'), yamlApply: $('cmpYamlApply'),
    identity: $('cmpIdentity'), caps: $('cmpCaps'), inspector: $('cmpInspector'),
    rules: $('cmpRules'), rulesNote: $('cmpRulesNote'), mock: $('cmpMock'),
  };
  if (!ui.sel) return; // panel not present
  if (!window.arete || !window.arete.composeCheck) {
    ui.status.textContent = 'restart the app to enable Compose (main process is older than this UI)';
    ui.status.className = 'cmp-status bad';
    return;
  }

  // ------------------------------------------------------------ draft store
  let drafts = [];
  let cur = null;         // current draft: {key, name, def, mock, updatedAt}
  let selIdx = -1;        // selected view item index
  let check = null;       // last compose:check result
  let appDefs = [];       // window.arete.widgetDefs() cache (collision checks)
  let fpHtml = null;      // faceplate.html source (cached)
  let bridge = null;      // preview bridge for the CURRENT iframe

  const uid = () => Math.random().toString(36).slice(2, 10);
  const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const b62 = (len = 22) => {
    const bytes = crypto.getRandomValues(new Uint8Array(len));
    let out = '';
    for (const b of bytes) out += B62[b % 62];
    return out;
  };
  // Every canvas owns ONE stable node/context identity, minted at creation
  // and reused on every go-live (v29 attach; no DELETE in the SDK — reuse,
  // never re-mint, so preview cycles cannot orphan realm nodes).
  const ensureLiveIds = (d) => {
    if (!d.liveIds) d.liveIds = { nodeId: b62(22), contextId: b62(22), initDone: false };
    return d.liveIds;
  };

  function loadDrafts() {
    try {
      const j = JSON.parse(localStorage.getItem(LS_DRAFTS));
      if (Array.isArray(j) && j.length) drafts = j.filter((d) => d && d.def);
    } catch (_) {}
    if (!drafts.length) drafts = [newDraftObj()];
    const wanted = localStorage.getItem(LS_CURRENT);
    cur = drafts.find((d) => d.key === wanted) || drafts[0];
  }
  function persist() {
    cur.updatedAt = Date.now();
    try {
      localStorage.setItem(LS_DRAFTS, JSON.stringify(drafts));
      localStorage.setItem(LS_CURRENT, cur.key);
    } catch (_) {}
  }
  function newDraftObj(def, name) {
    let n = 1;
    const ids = new Set(drafts.map((d) => d.def.widget));
    while (ids.has('local.widget-' + n)) n++;
    return {
      key: uid(),
      name: name || '',
      def: def || {
        widget: 'local.widget-' + n,
        title: 'My widget',
        description: '',
        meta: { composed: true, created: new Date().toISOString().slice(0, 10) },
        capabilities: [],
        view: [{ type: 'label', text: 'New widget' }],
      },
      mock: {},
      liveIds: { nodeId: b62(22), contextId: b62(22), initDone: false },
      updatedAt: Date.now(),
    };
  }

  // --------------------------------------------------------------- pipeline
  let checkTimer = null;
  function touched(structural = true) {
    dropLive('edited — back to the draft canvas');
    closeLivePick(); // stale matches — reopen recomputes
    persist();
    clearTimeout(checkTimer);
    checkTimer = setTimeout(() => refresh(structural), 350);
  }

  async function refresh(rebuildPreview = true) {
    check = await window.arete.composeCheck(cur.def);
    renderStatus();
    renderYaml();      // guards itself (skips while the textarea is focused)
    // The re-render rule: NEVER rebuild a panel the user is typing in — the
    // debounced refresh lands mid-word and replaces the focused input
    // (renderRules and renderYaml already guard; these panels must too).
    // Direct calls (picker search, inspector edits) still re-render at will.
    const focused = document.activeElement;
    if (!ui.caps.contains(focused)) renderCaps();          // needs check.caps (prop tables)
    renderViewList();  // bind labels may change validity (rows hold no typing focus)
    if (!ui.inspector.contains(focused)) renderInspector();
    renderRules();     // has its own focus guard
    if (!ui.mock.contains(focused)) renderMock();
    renderIdentityWarnings();
    if (rebuildPreview) await buildPreview();
  }

  function renderStatus() {
    if (!check) return;
    if (check.ok) {
      ui.status.textContent = '✓ valid widget';
      ui.status.className = 'cmp-status ok';
      ui.saveBtn.disabled = false;
    } else {
      ui.status.textContent = check.errors.length + ' issue' + (check.errors.length === 1 ? '' : 's');
      ui.status.className = 'cmp-status bad';
      ui.saveBtn.disabled = true;
    }
    ui.errors.hidden = check.ok;
    if (!check.ok) ui.errors.textContent = check.errors.map((e) => '• ' + e).join('\n');
  }

  // ------------------------------------------------------------- draft bar
  function renderDraftBar() {
    ui.sel.innerHTML = '';
    for (const d of drafts) {
      const label = (d.def.widget || 'untitled') + (d.def.title ? ' — ' + d.def.title : '') + (d.name ? ` (${d.name})` : '');
      const o = new Option(label, d.key, false, d === cur);
      ui.sel.appendChild(o);
    }
  }
  ui.sel.addEventListener('change', () => {
    dropLive();
    closeLivePick();
    cur = drafts.find((d) => d.key === ui.sel.value) || cur;
    selIdx = -1;
    persist();
    renderAll();
  });
  ui.newBtn.addEventListener('click', () => {
    cur = newDraftObj();
    drafts.push(cur);
    selIdx = -1;
    persist();
    renderAll();
  });
  ui.dupBtn.addEventListener('click', () => {
    const copy = JSON.parse(JSON.stringify(cur.def));
    copy.widget = (copy.widget || 'local.widget') + '-copy';
    const d = newDraftObj(copy);
    d.mock = { ...cur.mock };
    drafts.push(d);
    cur = d;
    selIdx = -1;
    persist();
    renderAll();
  });
  ui.delBtn.addEventListener('click', () => {
    if (drafts.length === 1) {
      drafts = [newDraftObj()];
    } else {
      drafts = drafts.filter((d) => d !== cur);
    }
    cur = drafts[0];
    selIdx = -1;
    persist();
    renderAll();
  });

  // "Open widget…": choose any existing definition (bundled/library/local)
  // and put its ACTUAL FILE CONTENT on the canvas — invariant made visible.
  ui.openBtn.addEventListener('click', async () => {
    appDefs = await window.arete.widgetDefs();
    const old = ui.openBtn.nextElementSibling;
    if (old && old.classList.contains('cmp-opensel')) old.remove();
    const sel = document.createElement('select');
    sel.className = 'cmp-opensel';
    sel.appendChild(new Option('Choose a widget…', ''));
    for (const src of ['local', 'library', 'bundled']) {
      const group = document.createElement('optgroup');
      group.label = src;
      for (const d of appDefs.filter((x) => x.source === src)) {
        group.appendChild(new Option(`${d.id} — ${d.title}`, d.id));
      }
      if (group.children.length) sel.appendChild(group);
    }
    ui.openBtn.after(sel);
    sel.focus();
    const done = () => sel.remove();
    sel.addEventListener('blur', () => setTimeout(done, 150));
    sel.addEventListener('change', async () => {
      const id = sel.value;
      done();
      if (!id) return;
      const res = await window.arete.composeReadDef(id);
      if (!res) return;
      const parsed = await window.arete.composeCheck(res.text);
      if (!parsed.raw) {
        ui.status.textContent = 'could not parse ' + id;
        ui.status.className = 'cmp-status bad';
        return;
      }
      const d = newDraftObj(parsed.raw, 'from ' + res.source);
      drafts.push(d);
      cur = d;
      selIdx = -1;
      persist();
      renderAll();
    });
  });

  // Export the canonical YAML as a file download.
  ui.exportBtn.addEventListener('click', () => {
    const text = (check && check.yaml) || '';
    if (!text) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/yaml' }));
    a.download = (cur.def.widget || 'widget') + '.yaml';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });

  // Save as a LOCAL widget (userData/widgets). Shadowing a bundled/library id
  // is refused by main; an existing local id asks before overwriting.
  ui.saveBtn.addEventListener('click', async () => {
    if (!check || !check.ok) return;
    let res = await window.arete.composeSaveLocal({ yamlText: check.yaml });
    if (res.exists) {
      if (!confirm(`Local widget "${cur.def.widget}" already exists. Overwrite it?`)) return;
      res = await window.arete.composeSaveLocal({ yamlText: check.yaml, overwrite: true });
    }
    if (res.ok) {
      ui.status.textContent = `saved — "${cur.def.widget}" is now in the Add dialog (local)`;
      ui.status.className = 'cmp-status ok';
    } else {
      ui.status.textContent = res.error || (res.errors && res.errors[0]) || 'save failed';
      ui.status.className = 'cmp-status bad';
    }
  });

  // ---------------------------------------------------------------- identity
  function renderIdentity() {
    const d = cur.def;
    ui.identity.innerHTML = `
      <label>Widget id <span class="muted-note">(slug — becomes the definition id)</span>
        <input id="cmpFid" type="text" value="${esc(d.widget || '')}" spellcheck="false" />
      </label>
      <div class="cmp-idnote" id="cmpIdNote"></div>
      <label>Title <input id="cmpFtitle" type="text" value="${esc(d.title || '')}" /></label>
      <div class="cmp-idrow">
        <label>Description <input id="cmpFdesc" type="text" value="${esc(d.description || '')}" /></label>
        <label>Icon <input id="cmpFicon" type="text" value="${esc(d.icon || '')}" placeholder="💡" /></label>
        <label>Color <input id="cmpFcolor" type="text" value="${esc(d.color || '')}" placeholder="#4c8bf5" /></label>
      </div>
      <label>Author <input id="cmpFauthor" type="text" value="${esc((d.meta && d.meta.author) || '')}" /></label>`;
    const bind = (id, fn) => $(id).addEventListener('input', (e) => { fn(e.target.value); touched(); });
    bind('cmpFid', (v) => { cur.def.widget = v.trim(); renderDraftBar(); });
    bind('cmpFtitle', (v) => { cur.def.title = v; renderDraftBar(); });
    bind('cmpFdesc', (v) => { cur.def.description = v; });
    bind('cmpFicon', (v) => { v.trim() ? cur.def.icon = v.trim() : delete cur.def.icon; });
    bind('cmpFcolor', (v) => { v.trim() ? cur.def.color = v.trim() : delete cur.def.color; });
    bind('cmpFauthor', (v) => {
      cur.def.meta = cur.def.meta || { composed: true };
      v.trim() ? cur.def.meta.author = v.trim() : delete cur.def.meta.author;
    });
  }

  async function renderIdentityWarnings() {
    const note = $('cmpIdNote');
    if (!note) return;
    appDefs = await window.arete.widgetDefs();
    const id = (cur.def.widget || '').trim();
    const hit = appDefs.find((x) => x.id === id);
    if (hit && hit.source !== 'local') {
      note.innerHTML = `<span class="cmp-err">id "${esc(id)}" already exists in the ${hit.source} source — saving is blocked (a local copy would shadow it).</span>`;
    } else if (hit) {
      note.innerHTML = `<span class="cmp-warn">id "${esc(id)}" is an existing LOCAL widget — saving will overwrite it.</span>`;
    } else {
      note.innerHTML = '';
    }
  }

  // ---------------------------------------------------- CP registry picker
  // Phase 2: browse/search cp.padi.io instead of typing CP names. One index
  // fetch (main caches it and seeds the per-profile cache) powers search,
  // the property/flag preview, and role choice.
  let pickerOpen = false;
  let pickerIndex = null; // [{name,title,comment,company,modified,props}]
  let pickerError = '';
  let pickerFilter = '';
  let pickerSel = null;   // expanded profile name

  async function loadPickerIndex(refresh) {
    const res = await window.arete.composeProfileIndex(!!refresh);
    pickerIndex = res.profiles || [];
    pickerError = res.ok ? '' : (res.error || 'registry unreachable');
  }

  // Role choice comes FIRST — a connection always has two ends, and which
  // end this widget is decides what it may write. The CP's own use-case
  // descriptions (client/server strings from the registry) phrase the choice
  // concretely; properties are only listed AFTER the role is picked, on the
  // capability card, as plain writable / read only.
  function pickerRoleBtn(p, role, disabled) {
    const desc = (p.roles && p.roles[role]) || '';
    return `<button type="button" class="primary" data-role="${role}" ${disabled ? 'disabled' : ''}>` +
      `Add as ${role}${desc ? ` <span class="cmp-pk-roledesc">(${esc(desc)})</span>` : ''}</button>`;
  }

  function renderPicker(host) {
    const box = document.createElement('div');
    box.className = 'cmp-picker';
    if (pickerIndex === null) {
      box.innerHTML = '<p class="muted-note">loading the CP registry…</p>';
      host.appendChild(box);
      return;
    }
    const q = pickerFilter.trim().toLowerCase();
    const hits = pickerIndex
      .filter((p) => !q || [p.name, p.title, p.comment, p.company].some((x) => (x || '').toLowerCase().includes(q)))
      .sort((a, b) => a.name.localeCompare(b.name));
    box.innerHTML = `
      <div class="cmp-pk-head">
        <input type="text" id="cmpPkSearch" placeholder="search ${pickerIndex.length} connection profiles…" value="${esc(pickerFilter)}" spellcheck="false" />
        <button type="button" class="ghost" id="cmpPkRefresh" title="Re-fetch the registry index (cache-busted)">↻</button>
        <button type="button" class="ghost" id="cmpPkClose" title="Close">✕</button>
      </div>
      ${pickerError ? `<p class="cmp-err">${esc(pickerError)} — showing the cached index.</p>` : ''}
      <div class="cmp-pk-list" id="cmpPkList"></div>`;
    host.appendChild(box);
    const list = box.querySelector('#cmpPkList');
    if (!hits.length) list.innerHTML = '<p class="muted-note">no profile matches — the registry is authoritative: a CP that is not listed cannot be used.</p>';
    for (const p of hits) {
      const row = document.createElement('div');
      row.className = 'cmp-pk-row' + (pickerSel === p.name ? ' on' : '');
      row.innerHTML = `<span class="pn">${esc(p.name)}</span><span class="pt">${esc(p.title)}</span>` +
        `<span class="pc">${p.props ? Object.keys(p.props).length + ' props' : 'no versions'}</span>`;
      row.addEventListener('click', () => {
        pickerSel = pickerSel === p.name ? null : p.name;
        renderCaps();
      });
      list.appendChild(row);
      if (pickerSel === p.name) {
        const prev = document.createElement('div');
        prev.className = 'cmp-pk-prev';
        const dup = (role) => (cur.def.capabilities || []).some((c) => c.profile === p.name && c.role === role);
        prev.innerHTML = `
          ${p.comment ? `<p class="muted-note">${esc(p.comment)}${p.company ? ' · ' + esc(p.company) : ''}</p>` : ''}
          <p class="muted-note">Which end of the connection is this widget? Its properties are listed once the role is picked.</p>
          <div class="cmp-pk-add">
            ${pickerRoleBtn(p, 'consumer', !p.props || dup('consumer'))}
            ${pickerRoleBtn(p, 'provider', !p.props || dup('provider'))}
          </div>`;
        prev.querySelectorAll('[data-role]').forEach((b) => b.addEventListener('click', () => {
          cur.def.capabilities = Array.isArray(cur.def.capabilities) ? cur.def.capabilities : [];
          cur.def.capabilities.push({ profile: p.name, role: b.dataset.role });
          pickerOpen = false;
          pickerSel = null;
          pickerFilter = '';
          touched();
          renderCaps();
        }));
        list.appendChild(prev);
      }
    }
    box.querySelector('#cmpPkSearch').addEventListener('input', (e) => {
      pickerFilter = e.target.value;
      const at = e.target.selectionStart;
      renderCaps();
      const inp = $('cmpPkSearch');
      if (inp) { inp.focus(); inp.setSelectionRange(at, at); }
    });
    box.querySelector('#cmpPkRefresh').addEventListener('click', async () => {
      pickerIndex = null;
      renderCaps();
      await loadPickerIndex(true);
      renderCaps();
    });
    box.querySelector('#cmpPkClose').addEventListener('click', () => {
      pickerOpen = false;
      pickerSel = null;
      renderCaps();
    });
  }

  // ------------------------------------------------------------ capabilities
  function renderCaps() {
    const caps = Array.isArray(cur.def.capabilities) ? cur.def.capabilities : [];
    const info = (check && check.caps) || [];
    ui.caps.innerHTML = '';
    caps.forEach((c, i) => {
      const inf = info[i] || { ok: false, props: {} };
      const box = document.createElement('div');
      box.className = 'cmp-cap';
      const status = !c.profile
        ? '<span class="cmp-cap-status wait">enter a CP name</span>'
        : inf.ok
          ? `<span class="cmp-cap-status ok">✓ ${esc(inf.title || 'in registry')}</span>`
          : '<span class="cmp-cap-status bad">not in the CP registry — refused</span>';
      box.innerHTML = `
        <div class="cmp-cap-head">
          <input type="text" value="${esc(c.profile || '')}" placeholder="padi.light" spellcheck="false" />
          <select title="Which end of the connection this widget is — flips what it may write">
            <option value="consumer"${c.role === 'consumer' ? ' selected' : ''}>consumer${inf.roles && inf.roles.consumer ? ' — ' + esc(inf.roles.consumer) : ''}</option>
            <option value="provider"${c.role === 'provider' ? ' selected' : ''}>provider${inf.roles && inf.roles.provider ? ' — ' + esc(inf.roles.provider) : ''}</option>
          </select>
          <button type="button" class="ghost danger" title="Remove capability">✕</button>
        </div>
        <div>${status}</div>
        <div class="cmp-cap-props">${propTable(inf, c.role)}</div>`;
      const [inp] = box.getElementsByTagName('input');
      const [sel] = box.getElementsByTagName('select');
      const del = box.querySelector('button');
      inp.addEventListener('change', () => { c.profile = inp.value.trim(); touched(); });
      sel.addEventListener('change', () => { c.role = sel.value; touched(); });
      del.addEventListener('click', () => { caps.splice(i, 1); touched(); renderCaps(); });
      ui.caps.appendChild(box);
    });
    if (pickerOpen) {
      renderPicker(ui.caps);
    } else {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'ghost';
      add.id = 'cmpCapAdd';
      add.textContent = '+ Add capability (browse the registry)';
      add.addEventListener('click', async () => {
        cur.def.capabilities = caps;
        pickerOpen = true;
        renderCaps();
        if (pickerIndex === null) {
          await loadPickerIndex(false);
          renderCaps();
        }
      });
      ui.caps.appendChild(add);
    }
  }

  function propTable(inf, role) {
    const names = Object.keys(inf.props || {});
    if (!names.length) return '';
    return names.map((n) => {
      const p = inf.props[n];
      const writes = (role === 'provider') === (p.writer === 'server');
      return `<span class="pn">${esc(n)}</span>` +
        (writes ? '<span class="cmp-flag w" title="your role writes this property">writable</span>'
                : '<span class="cmp-flag" title="written by the other end of the connection">read only</span>') +
        (p.required ? '<span class="cmp-flag">required</span>' : '') +
        (p.desc ? ` <span class="muted-note">${esc(p.desc)}</span>` : '');
    }).join('<br/>');
  }

  // ---------------------------------------------------- palette + view stack
  function renderPalette() {
    ui.palette.innerHTML = '';
    for (const t of PRIMS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = t === 'split' ? 'split ⇥' : t;
      b.title = t === 'split' ? 'column break — items after it render in a second column' : 'add a ' + t;
      b.addEventListener('click', () => {
        cur.def.view = Array.isArray(cur.def.view) ? cur.def.view : [];
        cur.def.view.push(defaultPrim(t));
        selIdx = cur.def.view.length - 1;
        touched();
        renderViewList();
        renderInspector();
      });
      ui.palette.appendChild(b);
    }
  }

  function defaultPrim(t) {
    const firstBind = firstBindable(t);
    switch (t) {
      case 'split': return { type: 'split' };
      case 'label': return { type: 'label', text: 'Label' };
      case 'rtt': return { type: 'rtt', send: firstBindable('field') || 'send', echo: firstBind || 'response' };
      case 'meter': return { type: 'meter', bind: firstBind || '', min: 0, max: 5 };
      case 'options': return { type: 'options', bind: firstBind || '', values: ['A', 'B'] };
      case 'stepper': return { type: 'stepper', bind: firstBind || '', step: 1 };
      default: return { type: t, bind: firstBind || '' };
    }
  }

  // All properties visible to this draft (from the checked capability tables),
  // with writability under the declared role.
  function knownProps() {
    const out = [];
    for (const inf of (check && check.caps) || []) {
      for (const n in inf.props || {}) {
        const p = inf.props[n];
        out.push({
          name: n,
          profile: inf.profile,
          writable: (inf.role === 'provider') === (p.writer === 'server'),
        });
      }
    }
    return out;
  }
  function firstBindable(type) {
    const props = knownProps();
    const needW = type === 'toggle' || type === 'field';
    const hit = props.find((p) => (needW ? p.writable : true));
    return hit ? hit.name : '';
  }

  function rowLabel(v) {
    if (v.type === 'split') return '— column break —';
    if (v.type === 'label') return v.text != null ? JSON.stringify(v.text) : (v.bind || '');
    if (v.type === 'rtt') return `${v.send || '?'} → ${v.echo || '?'}`;
    return v.bind || '(unbound)';
  }

  function renderViewList() {
    const view = Array.isArray(cur.def.view) ? cur.def.view : [];
    ui.viewList.innerHTML = '';
    view.forEach((v, i) => {
      const row = document.createElement('div');
      row.className = 'cmp-vrow' + (i === selIdx ? ' sel' : '') + (v.type === 'split' ? ' is-split' : '');
      row.draggable = true;
      row.innerHTML = `<span class="grip" title="drag to reorder">⋮⋮</span>` +
        `<span class="t">${esc(v.type)}</span><span class="b">${esc(rowLabel(v))}</span>` +
        `<span class="rowbtns">` +
        `<button type="button" class="ghost" data-a="up" title="Move up">▲</button>` +
        `<button type="button" class="ghost" data-a="dn" title="Move down">▼</button>` +
        `<button type="button" class="ghost danger" data-a="rm" title="Remove">✕</button></span>`;
      row.addEventListener('click', (e) => {
        const a = e.target.dataset && e.target.dataset.a;
        if (a === 'up' && i > 0) { view.splice(i - 1, 0, view.splice(i, 1)[0]); selIdx = i - 1; touched(); renderViewList(); renderInspector(); return; }
        if (a === 'dn' && i < view.length - 1) { view.splice(i + 1, 0, view.splice(i, 1)[0]); selIdx = i + 1; touched(); renderViewList(); renderInspector(); return; }
        if (a === 'rm') { view.splice(i, 1); if (selIdx >= view.length) selIdx = view.length - 1; touched(); renderViewList(); renderInspector(); return; }
        selIdx = i;
        renderViewList();
        renderInspector();
      });
      row.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', String(i)));
      row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('dragover'); });
      row.addEventListener('dragleave', () => row.classList.remove('dragover'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('dragover');
        const from = Number(e.dataTransfer.getData('text/plain'));
        if (!Number.isFinite(from) || from === i) return;
        const [moved] = view.splice(from, 1);
        view.splice(i, 0, moved);
        selIdx = i;
        touched();
        renderViewList();
        renderInspector();
      });
      ui.viewList.appendChild(row);
    });
    if (!view.length) ui.viewList.innerHTML = '<p class="muted-note">Add elements from the palette above.</p>';
  }

  // ------------------------------------------------------------- inspector
  function renderInspector() {
    const view = Array.isArray(cur.def.view) ? cur.def.view : [];
    const v = view[selIdx];
    if (!v) {
      ui.inspector.innerHTML = '<p class="muted-note">Select an element in the Faceplate list.</p>';
      return;
    }
    const props = knownProps();
    // Interactive primitives can be forced into their read-only rendering —
    // show, don't touch — even when the role may write the bind (mirrors
    // INTERACTIVE in core/widget-spec.js).
    const canReadonly = ['toggle', 'field', 'meter', 'options', 'date', 'stepper'].includes(v.type);
    const needW = (v.type === 'toggle' || v.type === 'field') && !v.readonly;
    const bindSel = (cu, field, writableOnly) => {
      const opts = props
        .filter((p) => (writableOnly ? p.writable : true))
        .map((p) => `<option value="${esc(p.name)}"${cu === p.name ? ' selected' : ''}>${esc(p.name)} (${esc(p.profile)}${p.writable ? ' · writable' : ''})</option>`)
        .join('');
      const custom = cu && !props.some((p) => p.name === cu)
        ? `<option value="${esc(cu)}" selected>${esc(cu)} (unknown property)</option>` : '';
      return `<label>${field} <select data-f="${field}"><option value="">—</option>${custom}${opts}</select></label>`;
    };
    let html = `<p class="muted-note">${esc(v.type)}</p>`;
    if (v.type !== 'split' && v.type !== 'rtt' && v.type !== 'label') html += bindSel(v.bind || '', 'bind', needW);
    if (v.type === 'label') {
      html += `<label>text <input data-f="text" type="text" value="${esc(v.text ?? '')}" placeholder="static text (clear to use bind)" /></label>`;
      html += bindSel(v.bind || '', 'bind', false);
    }
    if (v.type === 'rtt') {
      html += bindSel(v.send || '', 'send', true);
      html += bindSel(v.echo || '', 'echo', false);
    }
    if (v.type === 'lamp' || v.type === 'toggle') {
      html += `<div class="cmp-idrow"><label>on <input data-f="on" type="text" value="${esc(v.on ?? '1')}" /></label>` +
              `<label>off <input data-f="off" type="text" value="${esc(v.off ?? '0')}" /></label><span></span></div>`;
    }
    if (v.type === 'meter') {
      html += `<div class="cmp-idrow"><label>min <input data-f="min" type="number" value="${esc(v.min ?? 0)}" /></label>` +
              `<label>max <input data-f="max" type="number" value="${esc(v.max ?? 5)}" /></label><span></span></div>`;
    }
    if (v.type === 'stepper') {
      html += `<div class="cmp-idrow"><label>min <input data-f="min" type="number" value="${esc(v.min ?? '')}" /></label>` +
              `<label>max <input data-f="max" type="number" value="${esc(v.max ?? '')}" /></label>` +
              `<label>step <input data-f="step" type="number" value="${esc(v.step ?? 1)}" /></label></div>`;
    }
    if (v.type === 'options') {
      html += `<label>values <span class="muted-note">(comma-separated)</span>` +
              `<input data-f="values" type="text" value="${esc((v.values || []).join(', '))}" /></label>`;
    }
    if (v.type !== 'split') {
      html += `<label>caption <input data-f="caption" type="text" value="${esc(v.caption ?? '')}" /></label>`;
    }
    if (canReadonly) {
      html += `<label class="checkbox cmp-check"><input data-f="readonly" type="checkbox"${v.readonly ? ' checked' : ''} /><span>read only — display the value, never write it (rules still can)</span></label>`;
    }
    ui.inspector.innerHTML = html;
    ui.inspector.querySelectorAll('[data-f]').forEach((el) => {
      el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => {
        const f = el.dataset.f;
        const val = el.value;
        if (f === 'readonly') {
          el.checked ? v.readonly = true : delete v.readonly;
          touched();
          renderViewList();
          renderInspector(); // bind picker widens/narrows with the flag
          return;
        }
        if (f === 'values') {
          v.values = val.split(',').map((x) => x.trim()).filter(Boolean);
        } else if (f === 'min' || f === 'max' || f === 'step') {
          val === '' ? delete v[f] : v[f] = Number(val);
        } else if (val === '' && (f === 'caption' || f === 'text' || f === 'bind')) {
          delete v[f];
        } else {
          v[f] = val;
        }
        touched();
        renderViewList();
      });
    });
  }

  // ------------------------------------------------------- rule builder (Phase 3)
  // Rules are edited as data with validator-shaped constraints baked into the
  // pickers; the sentence at the top of each card is the same rendering the
  // read-only phase used. Unknown clause keys on imported rules are preserved
  // untouched. Re-render discipline: while focus is inside the panel, we skip
  // rebuilds (text inputs keep focus); the sentence catches up on blur.
  function ruleSentence(r) {
    let sent = `<span class="kw">when</span> <code>${esc(r.when ?? '?')}</code> changes → <span class="kw">set</span> <code>${esc(r.set ?? '?')}</code>`;
    if (r.map && Object.keys(r.map).length) sent += `, <span class="kw">mapped</span> <code>${esc(Object.entries(r.map).map(([k, v]) => k + '→' + v).join(', '))}</code>`;
    if (r.aggregate) sent += `, <span class="kw">aggregated by</span> <code>${esc(r.aggregate)}</code>`;
    if (r.reply) sent += `, <span class="kw">replying per connection</span>`;
    if (r.gate) {
      sent += `, <span class="kw">gated on</span> <code>${esc(r.gate)}</code> <span class="kw">being</span> <code>${esc(r.is ?? '?')}</code>`;
      if (r.else !== undefined) sent += `, <span class="kw">else</span> <code>${esc(r.else)}</code>`;
    }
    const KNOWN = ['when', 'set', 'map', 'aggregate', 'reply', 'gate', 'is', 'else'];
    const extra = Object.keys(r).filter((k) => !KNOWN.includes(k));
    if (extra.length) sent += ` <span class="cmp-rule-extra">· preserved: ${esc(extra.join(', '))}</span>`;
    return sent;
  }

  const mapToText = (m) => Object.entries(m || {}).map(([k, v]) => `${k}=${v}`).join(', ');
  function textToMap(text) {
    const m = {};
    for (const part of String(text).split(/[,;]/)) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      const k = part.slice(0, eq).trim();
      const v = part.slice(eq + 1).trim();
      if (k) m[k] = v;
    }
    return Object.keys(m).length ? m : undefined;
  }

  // force=true for USER-ACTION re-renders (add/delete/select inside the
  // panel): in real Chromium the clicked button HOLDS focus, so the typing
  // guard below would swallow the re-render and the panel looks dead — the
  // click mutates the draft but nothing appears (the IBB-call bug). Only the
  // debounced refresh() may honor the guard; it exists to protect TYPING in
  // map/is/else inputs, never to block deliberate clicks.
  function renderRules(force = false) {
    if (!force && ui.rules.contains(document.activeElement)) return; // keep focus (re-render rule)
    const bhv = cur.def.behavior && typeof cur.def.behavior === 'object' && !Array.isArray(cur.def.behavior)
      ? cur.def.behavior : (cur.def.behavior = {});
    const rules = Array.isArray(bhv.rules) ? bhv.rules : [];
    const init = bhv.init && typeof bhv.init === 'object' && !Array.isArray(bhv.init) ? bhv.init : {};
    const props = knownProps();
    const readable = props.map((p) => p.name);
    const writable = props.filter((p) => p.writable).map((p) => p.name);
    ui.rulesNote.textContent = rules.length ? `(${rules.length})` : '';
    ui.rules.innerHTML = '';

    const opts = (list, curVal, none) => {
      let h = none ? `<option value="">${none}</option>` : '';
      if (curVal && !list.includes(curVal)) h += `<option value="${esc(curVal)}" selected>${esc(curVal)} (unknown)</option>`;
      for (const n of list) h += `<option value="${esc(n)}"${n === curVal ? ' selected' : ''}>${esc(n)}</option>`;
      return h;
    };
    const cleanup = (obj) => { for (const k of ['map', 'aggregate', 'reply', 'gate', 'is', 'else']) if (obj[k] === undefined) delete obj[k]; };

    // --- init (puts issued once, at first attach) ---
    const initBox = document.createElement('div');
    initBox.className = 'cmp-initbox';
    initBox.innerHTML = '<p class="muted-note">At start, set:</p>';
    for (const prop of Object.keys(init)) {
      const row = document.createElement('div');
      row.className = 'cmp-initrow';
      row.innerHTML = `<select>${opts(writable, prop)}</select><input type="text" value="${esc(init[prop])}" placeholder="value" /><button type="button" class="ghost danger">✕</button>`;
      const [sel] = row.getElementsByTagName('select');
      const [inp] = row.getElementsByTagName('input');
      sel.addEventListener('change', () => { const v = init[prop]; delete init[prop]; init[sel.value] = v; bhv.init = init; touched(); renderRules(true); });
      inp.addEventListener('input', () => { init[prop] = inp.value; bhv.init = init; touched(); });
      row.querySelector('button').addEventListener('click', () => { delete init[prop]; if (!Object.keys(init).length) delete bhv.init; touched(); renderRules(true); });
      initBox.appendChild(row);
    }
    const addInit = document.createElement('button');
    addInit.type = 'button';
    addInit.className = 'ghost';
    addInit.textContent = '+ init value';
    addInit.disabled = !writable.length;
    addInit.addEventListener('click', () => {
      const free = writable.find((w) => !(w in init));
      if (!free) return;
      init[free] = '0';
      bhv.init = init;
      touched();
      renderRules(true);
    });
    initBox.appendChild(addInit);
    ui.rules.appendChild(initBox);

    // --- rule cards ---
    rules.forEach((r, i) => {
      const card = document.createElement('div');
      card.className = 'cmp-rule cmp-rule-edit';
      const gateFields = r.gate
        ? `<label>is <input data-f="is" type="text" value="${esc(r.is ?? '')}" placeholder="required" /></label>
           <label>else <input data-f="else" type="text" value="${esc(r.else ?? '')}" placeholder="(hold last)" /></label>`
        : '<span></span><span></span>';
      card.innerHTML = `
        <div class="cmp-rule-sent">${ruleSentence(r)}</div>
        <div class="cmp-rulegrid">
          <label>when <select data-f="when">${opts(readable, r.when)}</select></label>
          <label>set <select data-f="set">${opts(writable, r.set)}</select></label>
          <label>map <input data-f="map" type="text" value="${esc(mapToText(r.map))}" placeholder="1=on, 0=off" /></label>
          <label>aggregate <select data-f="aggregate">${opts(['average', 'min', 'max'], r.aggregate || '', '—')}</select></label>
          <label class="checkbox cmp-reply"><input data-f="reply" type="checkbox"${r.reply ? ' checked' : ''}${r.aggregate ? ' disabled' : ''} /><span>reply per connection</span></label>
          <label>gate <select data-f="gate">${opts(readable.filter((n) => n !== r.set), r.gate || '', '—')}</select></label>
          ${gateFields}
          <button type="button" class="ghost danger cmp-rule-del" title="Remove rule">✕</button>
        </div>`;
      card.querySelectorAll('[data-f]').forEach((el) => {
        el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', () => {
          const f = el.dataset.f;
          if (f === 'map') r.map = textToMap(el.value);
          else if (f === 'reply') r.reply = el.checked ? true : undefined;
          else if (f === 'aggregate') { r.aggregate = el.value || undefined; if (r.aggregate) r.reply = undefined; }
          else if (f === 'gate') {
            r.gate = el.value || undefined;
            if (!r.gate) { r.is = undefined; r.else = undefined; }
            else if (r.is === undefined) r.is = '';
          } else if (f === 'is') r.is = el.value;
          else if (f === 'else') r.else = el.value === '' ? undefined : el.value;
          else r[f] = el.value;
          cleanup(r);
          touched();
          if (el.tagName === 'SELECT' || el.type === 'checkbox') renderRules(true);
        });
      });
      card.querySelector('.cmp-rule-del').addEventListener('click', () => {
        rules.splice(i, 1);
        if (!rules.length) delete bhv.rules;
        touched();
        renderRules(true);
      });
      ui.rules.appendChild(card);
    });

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'ghost';
    add.id = 'cmpRuleAdd';
    add.textContent = '+ Add rule';
    add.disabled = !readable.length || !writable.length;
    add.title = add.disabled ? 'Add a capability first — rules read and write its properties' : 'Add a behavior rule';
    add.addEventListener('click', () => {
      const when = readable.find((n) => n !== writable[0]) || readable[0];
      const set = writable.find((n) => n !== when) || writable[0];
      bhv.rules = rules;
      rules.push({ when, set });
      cur.def.behavior = bhv;
      touched();
      renderRules(true);
    });
    ui.rules.appendChild(add);
  }

  // ------------------------------------------------------------- mock state
  function boundProps() {
    const set = new Set();
    for (const v of Array.isArray(cur.def.view) ? cur.def.view : []) {
      if (v && v.bind) set.add(v.bind);
      if (v && v.send) set.add(v.send);
      if (v && v.echo) set.add(v.echo);
    }
    const b = cur.def.behavior || {};
    for (const r of Array.isArray(b.rules) ? b.rules : []) {
      if (r && r.when) set.add(r.when);
      if (r && r.set) set.add(r.set);
    }
    return [...set];
  }

  function renderMock() {
    const props = boundProps();
    if (!props.length) {
      ui.mock.innerHTML = '<p class="muted-note">Bind an element to a property and its sample value appears here.</p>';
      return;
    }
    ui.mock.innerHTML = '';
    for (const p of props) {
      const row = document.createElement('div');
      row.className = 'cmp-mockrow';
      row.innerHTML = `<span class="mn">${esc(p)}</span><input type="text" value="${esc(cur.mock[p] ?? '')}" placeholder="sample value" />`;
      row.querySelector('input').addEventListener('input', (e) => {
        const val = e.target.value;
        val === '' ? delete cur.mock[p] : cur.mock[p] = val;
        persist();
        if (bridge) bridge.setState(cur.mock);
      });
      ui.mock.appendChild(row);
    }
  }

  // ------------------------------------------------------------ YAML panel
  function renderYaml() {
    if (document.activeElement === ui.yaml) return; // never clobber an edit in progress
    ui.yaml.value = (check && check.yaml) || '';
  }
  ui.yamlApply.addEventListener('click', async () => {
    const res = await window.arete.composeCheck(ui.yaml.value);
    if (!res.raw) {
      ui.status.textContent = (res.errors && res.errors[0]) || 'YAML parse error';
      ui.status.className = 'cmp-status bad';
      return;
    }
    cur.def = res.raw;
    selIdx = -1;
    persist();
    renderAll();
  });

  // --------------------------------------------------------------- preview
  // The canvas preview IS faceplate.js, running unmodified in an iframe whose
  // window.faceplate is a mock bridge over the draft's model + mock state.
  function makeBridge(model, state) {
    let stateCb = null;
    let themeCb = null;
    const push = () => {
      if (stateCb) stateCb({ state: { ...state }, connections: 0, peers: [], perConn: {}, rtt: {} });
      scheduleChrome();
    };
    const api = {
      load: async () => ({
        id: 'draft',
        name: cur.def.title || cur.def.widget || 'Draft',
        contextName: 'draft canvas',
        widgetId: cur.def.widget || 'draft',
        title: model.title,
        icon: model.icon || '',
        color: model.color || '',
        view: model.view,
        writable: model.writable,
        localOnly: model.writable.filter((p) => model.resolve[p] && !model.resolve[p].propagate),
        bindProfile: Object.fromEntries(Object.entries(model.resolve)
          .filter(([, r]) => r !== 'AMBIGUOUS')
          .map(([prop, r]) => [prop, r.profile])),
        hasRules: !!(model.behavior.rules || []).length,
        state: { ...state },
        connections: 0,
        peers: [],
        perConn: {},
        rtt: {},
        attached: true,
        pinned: false,
        theme: document.body.classList.contains('light') ? 'light' : 'dark',
      }),
      // A control interaction in the preview writes MOCK state, then lets the
      // real behavior engine converge on it (compose:simulate) — so a draft
      // switch flips a draft bulb exactly the way the realm eventually would.
      action: async (prop, value) => {
        state[prop] = String(value);
        cur.mock[prop] = String(value);
        const sim = await window.arete.composeSimulate({ model, state: { ...state } });
        Object.assign(state, sim.state);
        Object.assign(cur.mock, sim.state);
        persist();
        push();
        renderMock();
      },
      onState: (cb) => { stateCb = cb; return () => { stateCb = null; }; },
      onTheme: (cb) => { themeCb = cb; },
      onInfo: () => {},
      setPinned: async (v) => !!v,
    };
    return {
      api,
      push,
      setTheme: (t) => themeCb && themeCb(t),
      setState: (mock) => {
        for (const k of Object.keys(state)) delete state[k];
        Object.assign(state, mock);
        push();
      },
    };
  }

  const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
  // ------------------------------------------------------ go-live (Phase 3)
  // The SAME canvas flips between mock state (draft) and the realm (live).
  // Going live re-attaches the canvas's stable node/context via the v29
  // value-preserving path in main; editing anything drops back to draft.
  let liveMode = false;
  let liveLast = null; // latest live payload from main

  function updateLiveBtn() {
    if (!ui.liveBtn) return;
    ui.liveBtn.classList.toggle('on', liveMode);
    ui.liveBtn.textContent = liveMode ? '● live — back to draft' : 'Go live';
    ui.previewNote.textContent = liveMode
      ? 'LIVE on the realm — the canvas is the widget now'
      : 'rendered by the real faceplate renderer · mock state';
  }

  function dropLive(note) {
    if (!liveMode) return;
    liveMode = false;
    liveLast = null;
    if (window.arete.composeLiveStop) window.arete.composeLiveStop().catch(() => {});
    updateLiveBtn();
    buildPreview();
    if (note) { ui.status.textContent = note; ui.status.className = 'cmp-status'; }
  }

  function makeLiveBridge(model) {
    let stateCb = null;
    let themeCb = null;
    const first = liveLast || { state: {}, connections: 0, peers: [], perConn: {} };
    const api = {
      load: async () => ({
        id: 'draft-live',
        name: cur.def.title || cur.def.widget || 'Draft',
        contextName: 'live · ' + (cur.def.title || cur.def.widget || 'draft'),
        widgetId: cur.def.widget || 'draft',
        title: model.title,
        icon: model.icon || '',
        color: model.color || '',
        view: model.view,
        writable: model.writable,
        localOnly: model.writable.filter((p) => model.resolve[p] && !model.resolve[p].propagate),
        bindProfile: Object.fromEntries(Object.entries(model.resolve)
          .filter(([, r]) => r !== 'AMBIGUOUS')
          .map(([prop, r]) => [prop, r.profile])),
        hasRules: !!(model.behavior.rules || []).length,
        state: first.state,
        connections: first.connections,
        peers: first.peers,
        perConn: first.perConn,
        rtt: {},
        attached: true,
        pinned: false,
        theme: document.body.classList.contains('light') ? 'light' : 'dark',
      }),
      action: async (prop, value, connId) => {
        await window.arete.composeLiveAction({ property: prop, value: String(value), connId: connId || null }).catch(() => {});
      },
      onState: (cb) => { stateCb = cb; return () => { stateCb = null; }; },
      onTheme: (cb) => { themeCb = cb; },
      onInfo: () => {},
      setPinned: async (v) => !!v,
    };
    return {
      api,
      setTheme: (t) => themeCb && themeCb(t),
      setState: () => {},
      pushLive: (p) => {
        if (stateCb) stateCb({ state: p.state, connections: p.connections, peers: p.peers, perConn: p.perConn, rtt: {} });
        scheduleChrome();
      },
    };
  }

  // ---- go-live context chooser -------------------------------------------
  // A widget alone in a fresh context binds NOTHING — connections only form
  // between capabilities in the SAME context. So Go live first asks where:
  // join a realm context holding a COMPLEMENTARY role for one of the draft's
  // CPs (app.js's contextsMatching — same window), or the canvas's own
  // context (a partner must then join US). The choice persists per draft.
  function liveMatches() {
    try {
      if (typeof contextsMatching === 'function') {
        return contextsMatching(cur.def, ensureLiveIds(cur).contextId) || [];
      }
    } catch (_) {}
    return [];
  }

  function closeLivePick() {
    const el = $('cmpLivePick');
    if (el) el.remove();
  }

  function openLivePick() {
    closeLivePick();
    const ids = ensureLiveIds(cur);
    const matches = liveMatches();
    const title = cur.def.title || cur.def.widget || 'Draft';
    // Preselect: the draft's previous choice if still offered, else the best
    // match (unbound partners first), else the canvas's own context.
    let sel = '';
    if (ids.join && matches.some((c) => c.id === ids.join.contextId)) sel = ids.join.contextId;
    else if (matches.length) sel = matches[0].id;
    const box = document.createElement('div');
    box.className = 'cmp-livepick';
    box.id = 'cmpLivePick';
    box.innerHTML = `
      <p class="muted-note">Connections only form inside a shared context — where should this widget go live?</p>
      ${matches.map((c) => `
        <label class="checkbox"><input type="radio" name="cmpLpCtx" value="${esc(c.id)}"${sel === c.id ? ' checked' : ''} />
        <span>Join <strong>${esc(c.name)}</strong> <span class="muted-note">${esc(c.partnersText)}</span></span></label>`).join('')}
      <label class="checkbox"><input type="radio" name="cmpLpCtx" value=""${sel ? '' : ' checked'} />
      <span>New context “${esc(title)}” <span class="muted-note">${matches.length
        ? "the canvas's own — nothing to connect to until a partner joins it"
        : 'no realm context has a matching partner — a partner will have to join you'}</span></span></label>
      <div class="cmp-lp-btns">
        <button type="button" class="primary" id="cmpLpGo">Go live</button>
        <button type="button" class="ghost" id="cmpLpCancel">Cancel</button>
      </div>`;
    const wrap = ui.preview.closest('.cmp-previewwrap');
    wrap.parentNode.insertBefore(box, wrap);
    box.querySelector('#cmpLpCancel').addEventListener('click', closeLivePick);
    box.querySelector('#cmpLpGo').addEventListener('click', () => {
      const picked = box.querySelector('input[name="cmpLpCtx"]:checked');
      const id = picked ? picked.value : '';
      const m = matches.find((c) => c.id === id);
      ids.join = m ? { contextId: m.id, contextName: m.name } : null;
      closeLivePick();
      doGoLive(m ? { contextId: m.id, contextName: m.name }
                 : { contextId: ids.contextId, contextName: title });
    });
  }

  async function doGoLive(ctx) {
    const ids = ensureLiveIds(cur);
    ui.liveBtn.disabled = true;
    const res = await window.arete.composeGoLive({
      yamlText: check.yaml,
      name: cur.def.title || cur.def.widget || 'Draft',
      nodeId: ids.nodeId,
      contextId: ctx.contextId,
      contextName: ctx.contextName,
      applyInit: !ids.initDone,
    });
    ui.liveBtn.disabled = false;
    if (!res.ok) {
      ui.status.textContent = res.error || 'go-live failed';
      ui.status.className = 'cmp-status bad';
      return;
    }
    ids.initDone = true;
    persist();
    liveMode = true;
    liveLast = null;
    updateLiveBtn();
    await buildPreview();
    ui.status.textContent = `live in “${ctx.contextName}” — awaiting broker`;
    ui.status.className = 'cmp-status ok';
  }

  if (ui.liveBtn) {
    if (!window.arete.composeGoLive) ui.liveBtn.hidden = true;
    else ui.liveBtn.addEventListener('click', () => {
      if (liveMode) { dropLive(); return; }
      if (!check || !check.ok) return;
      if ($('cmpLivePick')) { closeLivePick(); return; } // toggle
      openLivePick();
    });
  }
  if (window.arete.onComposeLive) {
    window.arete.onComposeLive((payload) => {
      if (payload === null) {
        if (liveMode) dropLive('the live draft went offline — back to mock preview');
        return;
      }
      liveLast = payload;
      if (liveMode && bridge && bridge.pushLive) bridge.pushLive(payload);
    });
  }

  function scheduleChrome() {
    raf(fixChrome);
    setTimeout(fixChrome, 120);
  }
  function fixChrome() {
    try {
      const doc = ui.preview.contentDocument;
      if (!doc) return;
      const chip = doc.getElementById('fpChip');
      if (chip && !liveMode) { chip.className = 'chip wait'; chip.textContent = 'draft · mock'; }
      const pin = doc.getElementById('fpPin');
      const close = doc.getElementById('fpClose');
      if (pin) pin.hidden = true;
      if (close) close.hidden = true;
      // size the frame to its content. faceplate.css sets html,body height:100%
      // (fills the real widget window) — inside the iframe that makes
      // scrollHeight track the FRAME height, so measuring it and adding 8
      // grew the preview by 8px on every call (every keystroke). Neutralize
      // before measuring so scrollHeight is the intrinsic content height.
      doc.documentElement.style.height = 'auto';
      doc.body.style.height = 'auto';
      const h = Math.max(260, Math.min(600, doc.body.scrollHeight + 8));
      ui.preview.style.height = h + 'px';
    } catch (_) {}
  }

  async function buildPreview() {
    if (!check || !check.ok || !check.model) {
      ui.preview.srcdoc = '<body style="margin:0;background:transparent"></body>';
      bridge = null;
      return;
    }
    if (!fpHtml) fpHtml = await window.arete.composeFaceplateHtml();
    if (!fpHtml) {
      ui.previewNote.textContent = 'preview unavailable (faceplate.html not readable)';
      return;
    }
    if (liveMode) {
      bridge = makeLiveBridge(check.model);
    } else {
      const state = {};
      for (const k in cur.mock) state[k] = String(cur.mock[k]);
      bridge = makeBridge(check.model, state);
    }
    window.__composeBridge = () => bridge.api;
    ui.preview.srcdoc = fpHtml.replace(
      '<script src="faceplate.js">',
      '<script src="compose-fp-bridge.js"></script><script src="faceplate.js">'
    );
    ui.preview.onload = () => { scheduleChrome(); setTimeout(fixChrome, 400); };
  }

  // Theme follows the app live (body.light is toggled by app.js/Config).
  new MutationObserver(() => {
    if (bridge) bridge.setTheme(document.body.classList.contains('light') ? 'light' : 'dark');
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  // ------------------------------------------------------------------ boot
  function renderAll() {
    renderDraftBar();
    renderIdentity();
    renderPalette();
    renderViewList();
    renderInspector();
    refresh(true);
  }

  loadDrafts();
  renderAll();
})();
