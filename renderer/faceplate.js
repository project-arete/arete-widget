// faceplate.js — renders ONE virtual widget from its definition's `view`
// primitives, live off the state pushed by the main process. This window is
// only a view: the widget itself (behavior, reporting) lives in main and keeps
// running when this window is closed.

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

function build() {
  const body = $('fpBody');
  body.innerHTML = '';
  for (const prim of fp.view) {
    if (prim.type === 'lamp') {
      const lamp = el('div', 'lamp');
      updaters.push((s) => lamp.classList.toggle('on', s[prim.bind] === prim.on));
      body.appendChild(wrap(prim, lamp));
    } else if (prim.type === 'toggle') {
      const t = el('button', 'toggle');
      t.type = 'button';
      t.setAttribute('aria-label', prim.caption || prim.bind);
      const writable = fp.writable.includes(prim.bind);
      t.disabled = !writable;
      t.addEventListener('click', () => {
        const next = state[prim.bind] === prim.on ? prim.off : prim.on;
        window.faceplate.action(prim.bind, next).catch(() => {});
      });
      updaters.push((s) => t.classList.toggle('on', s[prim.bind] === prim.on));
      body.appendChild(wrap(prim, t));
    } else if (prim.type === 'value') {
      const v = el('div', 'value empty', '—');
      updaters.push((s) => {
        const raw = s[prim.bind];
        const empty = raw === undefined || raw === null || raw === '';
        v.classList.toggle('empty', empty);
        v.textContent = empty ? '—' : String(raw);
      });
      body.appendChild(wrap(prim, v));
    } else if (prim.type === 'label') {
      const l = el('div', 'labelval', prim.text || '—');
      if (prim.bind) {
        updaters.push((s) => (l.textContent = s[prim.bind] ? String(s[prim.bind]) : '—'));
      }
      body.appendChild(wrap(prim, l));
    } else if (prim.type === 'field') {
      const boxIn = el('div', 'field');
      const input = document.createElement('input');
      input.type = 'text';
      const writable = fp.writable.includes(prim.bind);
      input.disabled = !writable;
      const commit = () => {
        if (input.value !== (state[prim.bind] ?? '')) {
          window.faceplate.action(prim.bind, input.value).catch(() => {});
        }
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { commit(); input.blur(); } });
      input.addEventListener('blur', commit);
      updaters.push((s) => {
        if (document.activeElement !== input) input.value = s[prim.bind] ?? '';
      });
      boxIn.appendChild(input);
      body.appendChild(wrap(prim, boxIn));
    }
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
  $('fpFoot').hidden = !fp.hasRules;
  document.title = fp.name;
  document.body.classList.toggle('light', fp.theme === 'light');
  build();
  chip(fp.connections, fp.attached);
  apply(fp.state);
  window.faceplate.onState(({ state: s, connections }) => {
    chip(connections, true);
    apply(s);
  });
  if (window.faceplate.onTheme) {
    window.faceplate.onTheme((theme) => document.body.classList.toggle('light', theme === 'light'));
  }
}

init();
