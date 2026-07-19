// faceplate.js — renders ONE virtual widget from its definition's `view`
// primitives, live off the state pushed by the main process. This window is
// only a view: the widget itself (behavior, reporting) lives in main and keeps
// running when this window is closed.
//
// Primitives: lamp, toggle, value, label, field, meter, options, image, date,
// stepper — interactive when the bound property is writable by this widget's
// role, read-only displays otherwise — plus `split` (starts a second column).

const $ = (id) => document.getElementById(id);

let fp = null;              // bootstrap payload
let state = {};
const updaters = [];        // fns called with (state) on every push

function chip(connections, attached) {
  const el = $('fpChip');
  if (!attached) { el.className = 'chip off'; el.textContent = 'offline'; }
  else if (connections > 0) { el.className = 'chip ok'; el.textContent = 'bound · ' + connections; }
  else { el.className = 'chip wait'; el.textContent = 'awaiting broker'; }
}

function peersLine(peers) {
  const el = $('fpPeers');
  if (!peers || !peers.length) { el.textContent = ''; return; }
  if (peers.length === 1) {
    el.textContent = `bound to ${peers[0].system} · ${peers[0].node}`;
  } else {
    const names = [...new Set(peers.map((p) => p.system))];
    el.textContent = `${peers.length} connections: ${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}`;
  }
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function wrap(prim, child) {
  const box = el('div', 'prim');
  box.appendChild(child);
  if (prim.caption) box.appendChild(el('div', 'caption', prim.caption));
  return box;
}

// Flash an element when its underlying value changes (elements are mutated in
// place, never re-rendered, so a timed class here is safe).
const flashTimers = new Map();
function flash(node) {
  node.classList.add('hot');
  clearTimeout(flashTimers.get(node));
  flashTimers.set(node, setTimeout(() => node.classList.remove('hot'), 1200));
}
function watch(prim, fn) {
  let prev;
  let first = true;
  updaters.push((s) => {
    const raw = s[prim.bind];
    fn(raw, !first && raw !== prev);
    prev = raw;
    first = false;
  });
}

function act(prim, value) {
  window.faceplate.action(prim.bind, String(value)).catch(() => {});
}

const BUILDERS = {
  lamp(prim) {
    const lamp = el('div', 'lamp');
    watch(prim, (raw) => lamp.classList.toggle('on', raw === prim.on));
    return lamp;
  },

  toggle(prim, writable) {
    const t = el('button', 'toggle');
    t.type = 'button';
    t.setAttribute('aria-label', prim.caption || prim.bind);
    t.disabled = !writable;
    t.addEventListener('click', () => act(prim, state[prim.bind] === prim.on ? prim.off : prim.on));
    watch(prim, (raw) => t.classList.toggle('on', raw === prim.on));
    return t;
  },

  value(prim) {
    const v = el('div', 'value empty', '—');
    watch(prim, (raw, changed) => {
      const empty = raw === undefined || raw === null || raw === '';
      v.classList.toggle('empty', empty);
      v.textContent = empty ? '—' : String(raw);
      if (changed) flash(v);
    });
    return v;
  },

  label(prim) {
    const l = el('div', 'labelval', prim.text || '—');
    if (prim.bind) watch(prim, (raw, changed) => { l.textContent = raw ? String(raw) : '—'; if (changed) flash(l); });
    return l;
  },

  field(prim, writable) {
    const boxIn = el('div', 'field');
    const input = document.createElement('input');
    input.type = 'text';
    input.disabled = !writable;
    const commit = () => {
      if (input.value !== (state[prim.bind] ?? '')) act(prim, input.value);
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { commit(); input.blur(); } });
    input.addEventListener('blur', commit);
    updaters.push((s) => { if (document.activeElement !== input) input.value = s[prim.bind] ?? ''; });
    boxIn.appendChild(input);
    return boxIn;
  },

  meter(prim, writable) {
    const box = el('div', 'meter' + (writable ? ' rw' : ''));
    const segs = [];
    for (let v = prim.min; v <= prim.max; v++) {
      const s = el('button', 'seg');
      s.type = 'button';
      s.disabled = !writable;
      s.title = String(v);
      if (writable) s.addEventListener('click', () => act(prim, v));
      box.appendChild(s);
      segs.push({ v, node: s });
    }
    const num = el('span', 'meter-num', '—');
    box.appendChild(num);
    watch(prim, (raw, changed) => {
      const n = Number(raw);
      const has = raw !== undefined && raw !== '' && Number.isFinite(n);
      for (const s of segs) s.node.classList.toggle('lit', has && s.v <= n && s.v > prim.min - 1 && n >= prim.min);
      num.textContent = has ? String(n) : '—';
      if (changed) flash(num);
    });
    return box;
  },

  options(prim, writable) {
    // Few values + writable -> segmented buttons; many values -> a dropdown;
    // read-only -> a badge showing the current value.
    if (!writable) {
      const b = el('span', 'opt-badge', '—');
      watch(prim, (raw, changed) => { b.textContent = raw || '—'; if (changed) flash(b); });
      return b;
    }
    if (prim.values.length <= 4) {
      const box = el('div', 'opt-seg');
      const btns = prim.values.map((v) => {
        const b = el('button', 'opt', v);
        b.type = 'button';
        b.addEventListener('click', () => act(prim, v));
        box.appendChild(b);
        return b;
      });
      watch(prim, (raw) => btns.forEach((b) => b.classList.toggle('on', b.textContent === raw)));
      return box;
    }
    const sel = document.createElement('select');
    sel.className = 'opt-sel';
    sel.appendChild(new Option('—', ''));
    for (const v of prim.values) sel.appendChild(new Option(v, v));
    sel.addEventListener('change', () => { if (sel.value) act(prim, sel.value); });
    watch(prim, (raw) => {
      const v = raw ?? '';
      if ([...sel.options].some((o) => o.value === v)) sel.value = v;
    });
    return sel;
  },

  image(prim) {
    const box = el('div', 'imgbox');
    const img = document.createElement('img');
    img.alt = prim.caption || prim.bind;
    img.addEventListener('error', () => box.classList.add('broken'));
    watch(prim, (raw) => {
      const url = (raw || '').trim();
      box.classList.remove('broken');
      box.classList.toggle('empty', !url);
      if (url && /^https:\/\//i.test(url)) img.src = url;
      else img.removeAttribute('src');
    });
    box.appendChild(img);
    return box;
  },

  date(prim, writable) {
    if (!writable) return BUILDERS.value(prim);
    const boxIn = el('div', 'field');
    const input = document.createElement('input');
    input.type = 'date';
    input.addEventListener('change', () => act(prim, input.value));
    updaters.push((s) => {
      if (document.activeElement !== input) {
        const raw = s[prim.bind] ?? '';
        input.value = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : '';
      }
    });
    boxIn.appendChild(input);
    return boxIn;
  },

  stepper(prim, writable) {
    const box = el('div', 'stepper');
    const minus = el('button', 'step-btn', '−');
    const num = el('span', 'step-num', '—');
    const plus = el('button', 'step-btn', '+');
    minus.type = plus.type = 'button';
    minus.disabled = plus.disabled = !writable;
    const bump = (dir) => {
      const cur = Number(state[prim.bind]);
      let next = (Number.isFinite(cur) ? cur : (prim.min ?? 0)) + dir * prim.step;
      if (prim.min != null) next = Math.max(prim.min, next);
      if (prim.max != null) next = Math.min(prim.max, next);
      act(prim, next);
    };
    minus.addEventListener('click', () => bump(-1));
    plus.addEventListener('click', () => bump(1));
    watch(prim, (raw, changed) => {
      num.textContent = raw === undefined || raw === '' ? '—' : String(raw);
      if (changed) flash(num);
    });
    box.append(minus, num, plus);
    return box;
  },
};

function build() {
  const body = $('fpBody');
  body.innerHTML = '';
  const hasSplit = fp.view.some((v) => v.type === 'split');
  let col = el('div', 'fp-col');
  body.appendChild(col);
  if (hasSplit) body.classList.add('cols');
  for (const prim of fp.view) {
    if (prim.type === 'split') {
      col = el('div', 'fp-col');
      body.appendChild(col);
      continue;
    }
    const builder = BUILDERS[prim.type];
    if (!builder) continue;
    const writable = prim.bind ? fp.writable.includes(prim.bind) : false;
    col.appendChild(wrap(prim, builder(prim, writable)));
  }
}

function apply(s) {
  state = s || {};
  for (const fn of updaters) fn(state);
}

async function init() {
  fp = await window.faceplate.load();
  if (!fp) {
    document.body.innerHTML = '<p style="padding:20px;color:#9aa6b4">This widget no longer exists.</p>';
    return;
  }
  $('fpName').textContent = fp.name;
  $('fpKind').textContent = fp.title + ' · ' + fp.contextName;
  if (fp.icon) { $('fpIcon').textContent = fp.icon; $('fpIcon').hidden = false; }
  if (fp.color) document.body.style.setProperty('--fp-accent', fp.color);
  $('fpAuto').hidden = !fp.hasRules;
  document.title = fp.name;
  document.body.classList.toggle('light', fp.theme === 'light');

  let pinned = !!fp.pinned;
  const pinBtn = $('fpPin');
  pinBtn.classList.toggle('on', pinned);
  pinBtn.addEventListener('click', async () => {
    pinned = await window.faceplate.setPinned(!pinned);
    pinBtn.classList.toggle('on', pinned);
  });
  $('fpClose').addEventListener('click', () => window.close());

  build();
  chip(fp.connections, fp.attached);
  peersLine(fp.peers);
  apply(fp.state);
  window.faceplate.onState(({ state: s, connections, peers }) => {
    chip(connections, true);
    peersLine(peers);
    apply(s);
  });
  if (window.faceplate.onTheme) {
    window.faceplate.onTheme((theme) => document.body.classList.toggle('light', theme === 'light'));
  }
}

init();
