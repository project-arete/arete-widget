// main.js — Electron main process for ARETE WIDGET.
// Owns the windows (main + one faceplate per widget instance), persists
// identity/config, and bridges AreteService + WidgetManager to the renderers
// over IPC. The Arete SDK and all widget behavior run HERE — a virtual widget
// keeps living (receiving, auto-actualizing, reporting) even when its
// faceplate window is closed. Faceplates are just views.

import { app, BrowserWindow, ipcMain, screen, shell } from 'electron';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import yaml from 'js-yaml';

import { installSystemIdPatch } from './arete-system-id.js';
import { AreteService } from './arete-service.js';
import { WidgetManager } from './widget-manager.js';
import { ComposeRunner } from './compose-runner.js';
import { validateDefinition, parseProfile, orderDefinition } from '../core/widget-spec.js';
import { computeActions } from '../core/behavior-engine.js';
import * as settings from './settings.js';

// IMPORTANT: get `fs` via createRequire, NOT `import fs from 'node:fs'` — a
// static ESM fs import would snapshot the fs facade before the SDK's System-ID
// patch env var is in place (see arete-system-id.js; verified in the Monitor).
const require = createRequire(import.meta.url);
const fs = require('fs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const DEFAULT_SYSTEM_NAME = "Arete Widget";
const DEFAULT_LIBRARY_URL = 'https://project-arete.github.io/widget-library';

// ---- personalized default system name -------------------------------------
// A brand-new user's system defaults to "<First>'s Widgets" using the OS
// account's real name — macOS: `id -F` (full name); Linux: the passwd GECOS
// field; otherwise the login username. Falls back to the product default when
// nothing usable is found. This is only ever a SEED for the (editable) System
// name field — never forced, and a saved setting or ARETE_SYSTEM_NAME wins.
let _firstNameMemo; // undefined = not computed; null = none; string = first name
function osFirstName() {
  if (_firstNameMemo !== undefined) return _firstNameMemo;
  _firstNameMemo = null;
  let full = '';
  try {
    if (process.platform === 'darwin') {
      full = execFileSync('id', ['-F'], { timeout: 800, encoding: 'utf8' }).trim();
    } else if (process.platform === 'linux') {
      const line = String(execFileSync('getent', ['passwd', os.userInfo().username], { timeout: 800, encoding: 'utf8' }));
      full = (line.split(':')[4] || '').split(',')[0].trim();
    }
  } catch (_) { /* command missing or denied — fall through to username */ }
  if (!full) { try { full = os.userInfo().username || ''; } catch (_) {} }
  // First name-like token (Unicode letters), Title-cased.
  const tok = (full.match(/[\p{L}][\p{L}'’-]*/u) || [''])[0];
  if (tok) _firstNameMemo = tok.charAt(0).toUpperCase() + tok.slice(1);
  return _firstNameMemo;
}
function defaultSystemName() {
  const fn = osFirstName();
  return fn ? `${fn}'s Widgets` : DEFAULT_SYSTEM_NAME;
}

const service = new AreteService();
const composeRunner = new ComposeRunner({ service });
let manager = null;
let mainWindow = null;
const faceplates = new Map(); // instanceId -> BrowserWindow

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function readEnvFile() {
  const p = path.join(ROOT, '.env');
  const env = {};
  try {
    const text = fs.readFileSync(p, 'utf8');
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  } catch (_) {
    /* no .env — fine */
  }
  return env;
}

function loadOrCreateSeed() {
  const seedFile = path.join(app.getPath('userData'), 'system-id.txt');
  try {
    return fs.readFileSync(seedFile, 'utf8').trim();
  } catch (_) {
    const seed = crypto.randomUUID();
    try {
      fs.mkdirSync(app.getPath('userData'), { recursive: true });
      fs.writeFileSync(seedFile, seed);
    } catch (e) {
      console.error('Failed to persist system-id seed', e);
    }
    return seed;
  }
}

// CP registry cache — fetched in main so renderers never touch the network.
const profileCache = new Map();
async function fetchProfile(name) {
  if (!name) return null;
  if (profileCache.has(name)) return profileCache.get(name);
  try {
    const res = await fetch('https://cp.padi.io/profiles/' + encodeURIComponent(name), {
      headers: { accept: 'application/json' },
    });
    const json = res.ok ? await res.json() : null;
    profileCache.set(name, json);
    return json;
  } catch (_) {
    profileCache.set(name, null);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------
function createMainWindow() {
  // Restore the last position/size (and maximized state) from settings,
  // clamped into a live display's work area.
  const saved = settings.readSettings().mainWindowBounds;
  let bounds = { width: 980, height: 720 };
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    const wa = screen.getDisplayMatching(saved).workArea;
    const w = Math.min(saved.width || 980, wa.width);
    const h = Math.min(saved.height || 720, wa.height);
    bounds = {
      x: Math.min(Math.max(saved.x, wa.x), wa.x + wa.width - w),
      y: Math.min(Math.max(saved.y, wa.y), wa.y + wa.height - h),
      width: w,
      height: h,
    };
  }
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 760,
    minHeight: 540,
    title: 'Arete Widget',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  if (saved && saved.maximized) mainWindow.maximize();
  mainWindow.loadFile(path.join(ROOT, 'renderer', 'index.html'));

  // Persist bounds on move/resize (debounced; final save on close). While
  // maximized, keep the pre-maximize bounds and just flag the state, so
  // un-maximizing after a restart returns to the right place.
  let saveTimer = null;
  const saveBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const prev = settings.readSettings().mainWindowBounds || {};
    settings.writeSettings({
      mainWindowBounds: mainWindow.isMaximized()
        ? { ...prev, maximized: true }
        : { ...mainWindow.getBounds(), maximized: false },
    });
  };
  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveBounds, 400);
  };
  mainWindow.on('move', scheduleSave);
  mainWindow.on('resize', scheduleSave);
  mainWindow.on('close', () => {
    clearTimeout(saveTimer);
    saveBounds();
  });
  mainWindow.on('closed', () => (mainWindow = null));
}

// ---- Faceplate window placement -------------------------------------------
// Each instance REMEMBERS its window bounds (faceplate-bounds.json in
// userData): move or resize a faceplate and it reopens exactly there, across
// app restarts. First-time opens CASCADE from the main window instead of
// stacking on the screen center.
const fpBoundsFile = () => path.join(app.getPath('userData'), 'faceplate-bounds.json');
function readFpBounds() {
  try {
    const j = JSON.parse(fs.readFileSync(fpBoundsFile(), 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch (_) {
    return {};
  }
}
function writeFpBounds(map) {
  try {
    fs.writeFileSync(fpBoundsFile(), JSON.stringify(map, null, 2));
  } catch (e) {
    console.error('Failed to persist faceplate bounds', e);
  }
}

// ---- global widget zoom (UI v46) ------------------------------------------
// One factor for EVERY faceplate window, controlled from the main header and
// persisted in settings. Content scales via webContents zoom; the windows
// resize proportionally so the device look holds at any size.
const clampZoom = (z) => Math.min(2, Math.max(0.6, Math.round((Number(z) || 1) * 20) / 20));
let widgetZoom = clampZoom(settings.readSettings().widgetZoom || 1);

function placeFaceplate(instanceId, width, height) {
  const saved = readFpBounds()[instanceId];
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    // Clamp into the closest display's work area, so a monitor that has since
    // been unplugged can't strand the window off-screen.
    // Saved bounds carry the zoom they were saved AT — rescale to the current
    // zoom so a widget re-opened after a zoom change lands at the right size.
    const zScale = widgetZoom / clampZoom(saved.zoom || 1);
    const wa = screen.getDisplayMatching(saved).workArea;
    const w = Math.min(Math.round((saved.width || width) * zScale), wa.width);
    const h = Math.min(Math.round((saved.height || height) * zScale), wa.height);
    return {
      x: Math.min(Math.max(saved.x, wa.x), wa.x + wa.width - w),
      y: Math.min(Math.max(saved.y, wa.y), wa.y + wa.height - h),
      width: w,
      height: h,
    };
  }
  // No memory yet: cascade. Start just right of the main window (or the work
  // area's corner if there's no room) and step diagonally per open faceplate.
  const wa = screen.getPrimaryDisplay().workArea;
  const base = mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : wa;
  const startX = base.x + base.width + 16 + width <= wa.x + wa.width
    ? base.x + base.width + 16
    : wa.x + 24;
  const startY = Math.max(base.y, wa.y);
  const step = 34 * (faceplates.size % 10);
  return {
    x: Math.min(Math.max(startX + step, wa.x), wa.x + wa.width - width),
    y: Math.min(Math.max(startY + step, wa.y), wa.y + wa.height - height),
    width,
    height,
  };
}

function openFaceplate(instanceId) {
  const existing = faceplates.get(instanceId);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return;
  }
  const inst = manager.getInstance(instanceId);
  if (!inst) return;
  // Size the window to the faceplate: small widgets (a bulb) stay compact,
  // big ones (trust profiles with a dozen fields) open tall enough to use.
  const model = manager.getModel(inst.widgetId);
  const split = !!(model && model.view.some((v) => v.type === 'split'));
  const items = model ? model.view.length : 4;
  const perCol = split ? Math.ceil(items / 2) : items;
  const defaultWidth = Math.round((split ? 560 : 300) * widgetZoom);
  // If the widget opens already multi-connected, budget for the peer strip.
  const stripH = (inst.peers || []).length >= 2 ? 36 : 0;
  const defaultHeight = Math.round(Math.max(300, Math.min(760, 170 + stripH + perCol * 58)) * widgetZoom);
  const bounds = placeFaceplate(instanceId, defaultWidth, defaultHeight);
  const saved = readFpBounds()[instanceId] || {};
  const win = new BrowserWindow({
    ...bounds,
    minWidth: Math.round(220 * widgetZoom),
    minHeight: Math.round(260 * widgetZoom),
    frame: false, // device look — the faceplate header is the title bar
    title: inst.name,
    alwaysOnTop: !!saved.pinned,
    webPreferences: {
      preload: path.join(__dirname, 'preload-faceplate.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: ['--arete-instance=' + instanceId],
    },
  });
  win.loadFile(path.join(ROOT, 'renderer', 'faceplate.html'));
  win.webContents.on('did-finish-load', () => win.webContents.setZoomFactor(widgetZoom));

  // Remember where the user puts it (debounced; final save on close) —
  // stamped with the zoom the bounds were measured at.
  let saveTimer = null;
  const saveBounds = () => {
    if (win.isDestroyed()) return;
    const map = readFpBounds();
    map[instanceId] = { ...(map[instanceId] || {}), ...win.getBounds(), zoom: widgetZoom };
    writeFpBounds(map);
  };
  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveBounds, 400);
  };
  win.on('move', scheduleSave);
  win.on('resize', scheduleSave);
  win.on('close', () => {
    clearTimeout(saveTimer);
    saveBounds();
  });
  win.on('closed', () => faceplates.delete(instanceId));
  faceplates.set(instanceId, win);
}

// ---------------------------------------------------------------------------
// Event wiring: service + manager -> renderers
// ---------------------------------------------------------------------------
function wireEvents() {
  const toMain = (ch, payload) => mainWindow?.webContents.send(ch, payload);

  service.on('log', (e) => toMain('arete:log', e));
  service.on('status', (st) => {
    toMain('arete:status', st);
    if (st.state === 'disconnected' || st.state === 'error') manager.detachAll();
  });
  service.on('keys', (keys) => {
    toMain('arete:keys', keys);
    manager.onKeys(keys);
    composeRunner.onKeys(keys);
  });
  // A live draft dies with the channel: drop it and tell the Composer, which
  // flips the canvas back to draft mode (go-live again is one click and the
  // v29 attach makes it value-safe).
  service.on('status', (st) => {
    if ((st.state === 'disconnected' || st.state === 'error') && composeRunner.isLive()) composeRunner.stop();
  });
  composeRunner.on('state', (payload) => toMain('compose:liveState', payload));
  composeRunner.on('log', (e) => toMain('arete:log', e));
  // SDK auto-reconnect recovered the channel: re-attach all widget instances
  // (registration is idempotent; behavior rules then reconverge on the realm).
  service.on('reconnected', () => manager.attachAll().catch(() => {}));

  manager.on('log', (e) => toMain('arete:log', e));
  manager.on('defs', (defs) => toMain('widget:defs', defs));
  manager.on('instances', (list) => {
    toMain('widget:instances', list);
    // Faceplates bootstrap their identity (name, context) once, on open —
    // push identity edits (rename / context move) to any OPEN faceplate so
    // its header and window title follow immediately.
    for (const [id, fp] of faceplates) {
      if (fp.isDestroyed()) continue;
      const inst = list.find((i) => i.id === id);
      if (!inst) continue; // removal already closes the window elsewhere
      fp.setTitle(inst.name);
      fp.webContents.send('widget:info', {
        id,
        name: inst.name,
        contextName: inst.contextName,
      });
    }
  });
  manager.on('state', ({ id, state, connections, peers, perConn, rtt }) => {
    toMain('widget:state', { id, state, connections, peers });
    const fp = faceplates.get(id);
    if (fp && !fp.isDestroyed()) {
      fp.webContents.send('widget:state', { id, state, connections, peers, perConn, rtt });
    }
  });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(async () => {
  const seed = loadOrCreateSeed();
  installSystemIdPatch(seed);
  const env = readEnvFile();

  // Clean native About panel (macOS menu → About Arete Widget; also the
  // Help → About on other platforms) with the real release version.
  app.setAboutPanelOptions({
    applicationName: 'Arete Widget',
    applicationVersion: app.getVersion(),
    credits: 'Virtual widgets on a CNS/CP realm · project-arete',
  });

  // User widget dir (survives app updates) + the definitions the app ships.
  const userWidgetsDir = path.join(app.getPath('userData'), 'widgets');
  try {
    fs.mkdirSync(userWidgetsDir, { recursive: true });
  } catch (_) {}

  const effectiveLibraryUrl = () => {
    const s = settings.readSettings();
    return s.libraryUrl !== undefined && s.libraryUrl !== null
      ? String(s.libraryUrl).trim()
      : DEFAULT_LIBRARY_URL;
  };

  manager = new WidgetManager({
    service,
    dataDir: app.getPath('userData'),
    bundledDir: path.join(ROOT, 'widgets'),
    userDir: userWidgetsDir,
    libraryCacheDir: path.join(app.getPath('userData'), 'library-widgets'),
    libraryUrl: effectiveLibraryUrl(),
    fetchProfile,
  });

  // ---- IPC: connection/config ----
  ipcMain.handle('arete:getDefaults', () => {
    const s = settings.readSettings();
    const last = s.lastConnect || {};
    return {
      protocol: last.protocol || env.ARETE_PROTOCOL || 'wss:',
      host: last.host ?? (env.ARETE_HOST || ''),
      port: Number(last.port || env.ARETE_PORT || 443),
      username: last.username ?? (env.ARETE_USER || ''),
      password: s.rememberPassword ? settings.decryptPassword(s.passwordEnc) : (env.ARETE_PASS || ''),
      allowSelfSigned: last.allowSelfSigned ?? ((env.ARETE_ALLOW_SELF_SIGNED ?? '0') === '1'),
      rememberPassword: !!s.rememberPassword,
      autoConnect: !!s.autoConnect,
      canRememberPassword: settings.canEncrypt(),
      systemName: s.systemName || env.ARETE_SYSTEM_NAME || defaultSystemName(),
      theme: s.theme || 'dark',
      userWidgetsDir,
      libraryUrl: effectiveLibraryUrl(),
      libraryUrlDefault: DEFAULT_LIBRARY_URL,
      appVersion: app.getVersion(), // from package.json — the release version
    };
  });

  // Generic preference persistence (theme, ...). A theme change is pushed to
  // every open faceplate window so they switch live with the main window.
  ipcMain.handle('arete:saveSettings', (_evt, patch) => {
    const next = settings.writeSettings(patch || {});
    if (patch && patch.theme) {
      for (const w of faceplates.values()) {
        if (!w.isDestroyed()) w.webContents.send('widget:theme', patch.theme);
      }
    }
    return next;
  });

  ipcMain.handle('arete:connect', async (_evt, opts) => {
    const { rememberPassword, autoConnect, systemName, ...conn } = opts || {};
    const st = await service.connect({
      ...conn,
      systemName: (systemName || '').trim() || defaultSystemName(),
    });
    // Persist config AFTER a successful connect.
    settings.writeSettings({
      lastConnect: {
        protocol: conn.protocol,
        host: conn.host,
        port: conn.port,
        username: conn.username,
        allowSelfSigned: !!conn.allowSelfSigned,
      },
      systemName: (systemName || '').trim() || defaultSystemName(),
      rememberPassword: !!rememberPassword,
      passwordEnc: rememberPassword ? settings.encryptPassword(conn.password) : null,
      autoConnect: !!autoConnect,
    });
    await manager.attachAll();
    return st;
  });

  ipcMain.handle('arete:disconnect', async () => {
    manager.detachAll();
    await service.disconnect();
    return service.getStatus();
  });
  ipcMain.handle('arete:getStatus', () => service.getStatus());
  ipcMain.handle('arete:getKeys', () => service.getKeys());
  ipcMain.handle('arete:getProfile', (_evt, name) => fetchProfile(name));
  ipcMain.handle('arete:openExternal', (_evt, url) => shell.openExternal(url));
  ipcMain.handle('arete:setAutoConnect', (_evt, on) => settings.writeSettings({ autoConnect: !!on }));

  // ---- IPC: widgets ----
  ipcMain.handle('widget:defs', () => manager.listDefinitions());
  ipcMain.handle('widget:reload', () => {
    manager.setLibraryUrl(effectiveLibraryUrl()); // pick up a just-edited URL
    return manager.loadDefinitions();
  });
  ipcMain.handle('widget:libraryInfo', () => manager.libraryInfo());
  ipcMain.handle('widget:instances', () => manager.listInstances());
  ipcMain.handle('widget:add', (_evt, spec) => manager.addInstance(spec));
  ipcMain.handle('widget:update', (_evt, spec) => manager.updateInstance(spec));
  ipcMain.handle('widget:remove', (_evt, id) => {
    const fp = faceplates.get(id);
    if (fp && !fp.isDestroyed()) fp.close();
    manager.removeInstance(id);
    const map = readFpBounds(); // forget the removed widget's window spot too
    if (map[id]) {
      delete map[id];
      writeFpBounds(map);
    }
  });
  ipcMain.handle('widget:removeAll', () => {
    const ids = manager.listInstances().map((i) => i.id);
    for (const fp of faceplates.values()) {
      if (!fp.isDestroyed()) fp.close();
    }
    const count = manager.removeAllInstances();
    const map = readFpBounds(); // forget every removed widget's window spot
    let dirty = false;
    for (const id of ids) if (map[id]) { delete map[id]; dirty = true; }
    if (dirty) writeFpBounds(map);
    return count;
  });
  ipcMain.handle('widget:open', (_evt, id) => openFaceplate(id));
  ipcMain.handle('widget:action', (_evt, { id, property, value, connId }) =>
    manager.putProperty(id, property, value, connId || null)
  );
  // The faceplate asks to grow/shrink (peer strip appearing/disappearing) so
  // its content area keeps a constant size instead of sprouting scrollbars.
  ipcMain.handle('widget:fp-adjust-height', (_evt, { id, delta }) => {
    const fp = faceplates.get(id);
    if (!fp || fp.isDestroyed() || !Number.isFinite(delta)) return;
    const b = fp.getBounds();
    // The renderer measures in CSS px; the window is sized in DIPs — a zoomed
    // faceplate needs the delta scaled by the zoom factor.
    fp.setBounds({ ...b, height: Math.max(Math.round(260 * widgetZoom), b.height + Math.round(delta * widgetZoom)) });
  });

  // Global widget zoom: null reads, a number applies + persists. Every OPEN
  // faceplate rescales in real time (content zoom + proportional resize).
  ipcMain.handle('widget:zoom', (_evt, z) => {
    if (z != null) {
      const prev = widgetZoom;
      widgetZoom = clampZoom(z);
      settings.writeSettings({ widgetZoom });
      if (widgetZoom !== prev) {
        for (const win of faceplates.values()) {
          if (win.isDestroyed()) continue;
          win.webContents.setZoomFactor(widgetZoom);
          win.setMinimumSize(Math.round(220 * widgetZoom), Math.round(260 * widgetZoom));
          const b = win.getBounds();
          win.setBounds({
            ...b,
            width: Math.round(b.width * widgetZoom / prev),
            height: Math.round(b.height * widgetZoom / prev),
          });
        }
      }
    }
    return widgetZoom;
  });
  // Pin a faceplate above other windows; the choice persists per instance.
  ipcMain.handle('widget:fp-pin', (_evt, { id, pinned }) => {
    const fp = faceplates.get(id);
    if (fp && !fp.isDestroyed()) fp.setAlwaysOnTop(!!pinned);
    const map = readFpBounds();
    map[id] = { ...(map[id] || {}), pinned: !!pinned };
    writeFpBounds(map);
    return !!pinned;
  });
  // Faceplate bootstrap: everything one faceplate window needs to render.
  ipcMain.handle('widget:faceplate', (_evt, id) => {
    const inst = manager.getInstance(id);
    if (!inst) return null;
    const model = manager.getModel(inst.widgetId);
    return {
      id: inst.id,
      name: inst.name,
      contextName: (inst.contexts || []).length > 1
        ? `${inst.contextName} +${inst.contexts.length - 1}`
        : inst.contextName,
      // Every context this widget is present in — >1 flips the faceplate's
      // pill labels from peer names to context (place) names.
      contexts: inst.contexts || [{ id: inst.contextId, name: inst.contextName }],
      widgetId: inst.widgetId,
      title: model ? model.title : inst.widgetId,
      icon: model ? model.icon || '' : '',
      color: model ? model.color || '' : '',
      view: model ? model.view : [],
      writable: model ? model.writable : [],
      // Own-written props the CP does NOT propagate: visible here, but
      // connections never carry them — the faceplate marks these "local".
      localOnly: model
        ? model.writable.filter((p) => model.resolve[p] && !model.resolve[p].propagate)
        : [],
      // bind -> owning CP, so the faceplate can scope pill groups, mixed
      // detection, and write addressing to each property's OWN capability.
      bindProfile: model
        ? Object.fromEntries(Object.entries(model.resolve)
            .filter(([, r]) => r !== 'AMBIGUOUS')
            .map(([prop, r]) => [prop, r.profile]))
        : {},
      hasRules: !!(model && model.behavior.rules.length),
      state: inst.state,
      connections: inst.connections,
      peers: inst.peers || [],
      perConn: inst.perConn || {},
      rtt: inst.rtt || {},
      attached: inst.attached,
      pinned: !!(readFpBounds()[inst.id] || {}).pinned,
      theme: settings.readSettings().theme || 'dark',
    };
  });

  wireEvents();

  // ---- IPC: Composer (Compose tab — Phase 1) ----
  // Validate a draft. Input is the draft DEFINITION OBJECT (plain data, the
  // same shape yaml.load produces) or raw YAML text. Returns everything the
  // Composer needs: canonical YAML, validation result, and per-capability
  // property tables (available even while the full definition is invalid, so
  // binding pickers can populate mid-edit).
  ipcMain.handle('compose:check', async (_evt, draft) => {
    let raw = draft;
    if (typeof draft === 'string') {
      try {
        raw = yaml.load(draft);
      } catch (err) {
        return { ok: false, errors: ['YAML parse error: ' + (err.message || err)], model: null, raw: null, yaml: '', caps: [] };
      }
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, errors: ['Definition is not a mapping.'], model: null, raw: null, yaml: '', caps: [] };
    }
    const profiles = {};
    const capsIn = Array.isArray(raw.capabilities) ? raw.capabilities : [];
    for (const c of capsIn) {
      const name = c && typeof c.profile === 'string' ? c.profile.trim() : '';
      if (name && !(name in profiles)) profiles[name] = await fetchProfile(name);
    }
    const res = validateDefinition(raw, profiles);
    // Per-capability prop tables for the binding pickers (independent of full validity).
    const caps = capsIn.map((c) => {
      const profile = c && typeof c.profile === 'string' ? c.profile.trim() : '';
      const role = c && typeof c.role === 'string' ? c.role.trim() : '';
      const parsed = parseProfile(profiles[profile]);
      return {
        profile,
        role,
        ok: !!parsed,
        title: parsed ? parsed.title : '',
        roles: parsed ? parsed.roles : { provider: '', consumer: '' },
        props: parsed ? parsed.props : {},
      };
    });
    let text = '';
    try {
      text = yaml.dump(orderDefinition(raw), { lineWidth: 120, noRefs: true });
    } catch (_) {}
    return { ok: res.ok, errors: res.errors, model: res.model, raw, yaml: text, caps };
  });

  // Draft-preview rule simulation: run the behavior engine over MOCK state
  // (no realm, no connections) so the preview shows rules converging. Bounded
  // iteration — a (mis)configured rule pair can never loop forever.
  ipcMain.handle('compose:simulate', (_evt, { model, state }) => {
    if (!model || !model.behavior) return { state: state || {}, fired: [] };
    const s = { ...(state || {}) };
    const fired = [];
    for (let i = 0; i < 8; i++) {
      const actions = computeActions(model, s, {}, {});
      if (!actions.length) break;
      for (const a of actions) {
        s[a.property] = String(a.value);
        fired.push({ property: a.property, value: String(a.value) });
      }
    }
    return { state: s, fired };
  });

  // Save the draft as a LOCAL widget definition (userData/widgets — highest
  // precedence source). Refuses to shadow a bundled/library id: local silently
  // overriding the library is the precedence hazard the design doc flags.
  ipcMain.handle('compose:saveLocal', async (_evt, { yamlText, overwrite }) => {
    let raw;
    try {
      raw = yaml.load(yamlText);
    } catch (err) {
      return { ok: false, error: 'YAML parse error: ' + (err.message || err) };
    }
    const id = raw && typeof raw.widget === 'string' ? raw.widget.trim() : '';
    if (!id) return { ok: false, error: 'The definition has no `widget:` id.' };
    const existing = manager.listDefinitions().find((d) => d.id === id);
    if (existing && existing.source !== 'local') {
      return { ok: false, error: `Widget id "${id}" already exists in the ${existing.source} source — a local copy would shadow it. Pick a different id.` };
    }
    if (existing && existing.source === 'local' && !overwrite) {
      return { ok: false, error: `Local widget "${id}" already exists.`, exists: true };
    }
    const fname = id.replace(/[^a-z0-9._-]/gi, '_') + '.yaml';
    try {
      fs.writeFileSync(path.join(userWidgetsDir, fname), yamlText);
    } catch (err) {
      return { ok: false, error: 'Write failed: ' + (err.message || err) };
    }
    await manager.loadDefinitions(false); // rescan without a network refresh
    const def = manager.listDefinitions().find((d) => d.id === id);
    return { ok: !!(def && def.ok), errors: def ? def.errors : [], file: fname };
  });

  // YAML source of an existing definition — "Open in Composer".
  ipcMain.handle('compose:readDef', (_evt, widgetId) => {
    const def = manager.listDefinitions().find((d) => d.id === widgetId);
    if (!def) return null;
    try {
      return { id: def.id, source: def.source, text: fs.readFileSync(def.file, 'utf8') };
    } catch (_) {
      return null;
    }
  });

  // Registry INDEX for the CP picker — one fetch of cp.padi.io/profiles
  // returns every profile WITH full versions/properties (raw JSON, so the
  // key-presence flags survive). The same fetch seeds the per-profile cache,
  // so browsing, validation and offline re-checks all ride on it.
  let profileIndex = null;
  const slimIndex = (list) => (list || []).map((p) => {
    const parsed = parseProfile(p);
    return {
      name: p.name,
      title: p.title || '',
      comment: p.comment || '',
      company: p.company || '',
      modified: p.modified || '',
      roles: parsed ? parsed.roles : { provider: '', consumer: '' },
      props: parsed ? parsed.props : null,
    };
  }).filter((p) => p.name);
  ipcMain.handle('compose:profileIndex', async (_evt, refresh) => {
    if (!profileIndex || refresh) {
      try {
        const url = 'https://cp.padi.io/profiles' + (refresh ? '?cb=' + Date.now() : '');
        const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const list = await res.json();
        if (!Array.isArray(list)) throw new Error('not a profile list');
        profileIndex = list;
        for (const p of list) if (p && p.name) profileCache.set(p.name, p);
      } catch (e) {
        return { ok: !!profileIndex, error: String(e.message || e), profiles: slimIndex(profileIndex) };
      }
    }
    return { ok: true, profiles: slimIndex(profileIndex) };
  });

  // ---- Composer go-live (Phase 3): run the draft on the realm ----
  ipcMain.handle('compose:goLive', async (_evt, { yamlText, name, nodeId, contextId, contextName, applyInit }) => {
    let raw;
    try {
      raw = yaml.load(yamlText);
    } catch (err) {
      return { ok: false, error: 'YAML parse error: ' + (err.message || err) };
    }
    const profiles = {};
    for (const c of Array.isArray(raw?.capabilities) ? raw.capabilities : []) {
      const n = c && typeof c.profile === 'string' ? c.profile.trim() : '';
      if (n && !(n in profiles)) profiles[n] = await fetchProfile(n);
    }
    const res = validateDefinition(raw, profiles);
    if (!res.ok) return { ok: false, error: res.errors[0] || 'Draft is not valid.' };
    try {
      const ids = await composeRunner.goLive({
        model: res.model,
        name: (name || '').trim() || res.model.title || res.model.id,
        nodeId,
        contextId,
        contextName: (contextName || '').trim() || (name || res.model.title || 'Draft'),
        applyInit: !!applyInit,
      });
      return { ok: true, ...ids };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });
  ipcMain.handle('compose:liveAction', (_evt, { property, value, connId }) =>
    composeRunner.putProperty(property, String(value), connId || null)
  );
  ipcMain.handle('compose:liveStop', () => composeRunner.stop());

  // faceplate.html source for the preview iframe (fetch() can't read file://).
  ipcMain.handle('compose:faceplateHtml', () => {
    try {
      return fs.readFileSync(path.join(ROOT, 'renderer', 'faceplate.html'), 'utf8');
    } catch (_) {
      return null;
    }
  });

  await manager.loadDefinitions();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', async () => {
  await service.disconnect().catch(() => {});
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  await service.disconnect().catch(() => {});
});
