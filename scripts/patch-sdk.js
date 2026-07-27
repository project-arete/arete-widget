// scripts/patch-sdk.js
// ---------------------------------------------------------------------------
// Applies small, surgical patches to the arete-sdk SOURCE in node_modules.
// Runs on `postinstall`, so they re-apply automatically after every
// `npm install`. Each patch is idempotent (guarded by a marker) and never
// throws hard — if the SDK layout changes upstream it logs a warning and
// exits 0 so installs don't break.
//
// PATCH 1 — off-Pi System ID (system.js)
//   get_system_id() reads Raspberry Pi devicetree files and THROWS on
//   macOS/Windows/dev Linux, inside the `new Client()` constructor. Runtime fs
//   shims do NOT work under Electron (snapshotted module facades), so we add a
//   stable fallback that reads `process.env.ARETE_SYSTEM_SEED` (set by the app
//   before the SDK loads).
//
// PATCH 2 — WebSocket keepalive (index.js)
//   The SDK never sends any traffic on an idle connection, so idle-timeout
//   middleboxes/servers drop the socket after a few minutes (seen live:
//   Monitor disconnecting every few minutes on a quiet realm). We ping the
//   socket every 30s via ws's protocol-level ping — no realm data is written,
//   and RFC-compliant peers pong automatically.
//
// PATCH 3 — retry on UNEXPECTED clean close (index.js)
//   #onclose returns early (no 'close' event, NO reconnect, ever) whenever the
//   close was "clean" — but servers idle-close cleanly too, leaving a dead
//   client that looks alive. We only honor that early-return when close() was
//   called intentionally; any other clean close now behaves like a drop:
//   'close' is emitted and the 5s retry loop runs (the apps' reconnect
//   recovery then resumes the session automatically).
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SDK = path.join(__dirname, '..', 'node_modules', 'arete-sdk');

const PATCHES = [
  {
    name: 'system-id fallback',
    file: 'system.js',
    marker: 'arete-electron-starter:system-id-fallback',
    find: "  throw 'Unable to detect System ID on this platform';",
    replace: [
      '  // arete-electron-starter:system-id-fallback',
      '  // Off-Pi fallback: derive a stable System ID from an env seed set by the app.',
      '  if (process.env.ARETE_SYSTEM_SEED)',
      "    return uuidv5('oid', String(process.env.ARETE_SYSTEM_SEED));",
      "  throw 'Unable to detect System ID on this platform';",
    ].join('\n'),
  },
  {
    name: 'ws keepalive',
    file: 'index.js',
    marker: 'arete:ws-keepalive',
    find: '      this.#socket.onerror = this.#onerror.bind(this);',
    replace: [
      '      this.#socket.onerror = this.#onerror.bind(this);',
      '',
      '      // arete:ws-keepalive — idle sockets get dropped by timeout',
      '      // middleboxes after a few minutes; ping every 30s to keep the',
      '      // connection alive (protocol-level, writes no realm data).',
      "      if (typeof this.#socket.ping === 'function') {",
      '        const ka = setInterval(() => {',
      '          try {',
      '            if (this.#socket !== undefined && this.#socket.readyState === WebSocket.OPEN)',
      '              this.#socket.ping();',
      '          } catch (_) {}',
      '        }, 30000);',
      '        if (ka.unref) ka.unref();',
      "        this.#socket.on('close', () => clearInterval(ka));",
      '      }',
    ].join('\n'),
  },
  {
    name: 'intentional-close flag',
    file: 'index.js',
    marker: 'arete:intentional-close',
    find: '  close() {\n    if (this.#socket !== undefined) this.#socket.close();',
    replace: [
      '  close() {',
      '    this._userClosed = true; // arete:intentional-close',
      '    if (this.#socket !== undefined) this.#socket.close();',
    ].join('\n'),
  },
  {
    name: 'retry on unexpected clean close',
    file: 'index.js',
    marker: 'arete:unexpected-clean-close',
    find: '    if (e !== undefined && e.wasClean) return;',
    replace: [
      '    // arete:unexpected-clean-close — servers idle-close "cleanly" too;',
      '    // only a close WE requested is final. Anything else drops through to',
      "    // the 'close' event + retry loop so the app can resume.",
      '    if (e !== undefined && e.wasClean && this._userClosed) return;',
    ].join('\n'),
  },
  {
    // PATCH 4a — accept a Bearer token option on the Client.
    name: 'bearer token option',
    file: 'index.js',
    marker: 'arete:bearer-token-opt',
    find: '      port: options.port || location.port,',
    replace: [
      '      port: options.port || location.port,',
      "      token: options.token || '', // arete:bearer-token-opt",
    ].join('\n'),
  },
  {
    // PATCH 4b — send the token as `Authorization: Bearer <token>` on the ws
    // handshake (per-realm token auth from aretehosting; replaces HTTP-Basic
    // userinfo). ws accepts a `headers` option; browsers ignore it (no token
    // path there yet).
    name: 'bearer token header',
    file: 'index.js',
    marker: 'arete:bearer-token-hdr',
    find: '      this.#socket = new WebSocket(uri);',
    replace: [
      '      // arete:bearer-token-hdr',
      "      const __auth = this.#options.token ? { headers: { Authorization: 'Bearer ' + this.#options.token } } : undefined;",
      '      this.#socket = __auth ? new WebSocket(uri, __auth) : new WebSocket(uri);',
    ].join('\n'),
  },
  {
    // PATCH 5a — a close WE requested is ALWAYS final. The previous rule
    // (final only when wasClean && userClosed) left zombies: a 401-rejected
    // upgrade closes wasClean=false, so a client discarded after a failed
    // connect fell through to the retry loop and retried forever.
    // NOTE: applies on top of patch 3's output (patches run in order).
    name: 'user close is final',
    file: 'index.js',
    // marker must NOT be a prefix of another patch's marker, or a failed
    // apply here would be masked by the guard patch below.
    marker: 'arete:final-close-any',
    find: '    if (e !== undefined && e.wasClean && this._userClosed) return;',
    replace: [
      '    // arete:final-close-any — ANY close we requested is final (a rejected',
      '    // upgrade closes unclean; without this, discarded clients retry',
      '    // forever). Server-side closes, clean or not, still retry below.',
      '    if (this._userClosed) return;',
    ].join('\n'),
  },
  {
    // PATCH 5b — a retry timer queued before close() must not resurrect the
    // client after the app has discarded it.
    name: 'retry timer close guard',
    file: 'index.js',
    marker: 'arete:final-close-guard',
    find: '    setTimeout(() => {\n      this.open();\n    }, RETRY);',
    replace: [
      '    setTimeout(() => {',
      '      if (!this._userClosed) this.open(); // arete:final-close-guard',
      '    }, RETRY);',
    ].join('\n'),
  },
  {
    // PATCH 5c — #onerror used to call this.close(), which (since patch 3)
    // marks _userClosed and would now make every transient socket error
    // final. Tear the socket down directly instead so errors still retry.
    name: 'error teardown without user-close',
    file: 'index.js',
    marker: 'arete:error-teardown',
    find: '    this.emit(\'error\', new Error(E_SOCKET));\n    this.close();',
    replace: [
      "    this.emit('error', new Error(E_SOCKET));",
      '    // arete:error-teardown — close the socket WITHOUT marking user-closed,',
      '    // so transient socket errors still reach the retry loop and resume.',
      '    if (this.#socket !== undefined) { try { this.#socket.close(); } catch (_) { /* ignore */ } }',
    ].join('\n'),
  },
  {
    // PATCH 6 — surface the REAL socket error. ws reports a rejected upgrade
    // as "Unexpected server response: 401", but #onerror discarded it and
    // emitted a generic "Socket not open" — which made token-protected
    // realms (401) indistinguishable from network failures in the app log.
    name: 'real error message',
    file: 'index.js',
    marker: 'arete:error-detail',
    find: "    this.emit('error', new Error(E_SOCKET));",
    replace: [
      '    // arete:error-detail — pass the underlying reason through (e.g.',
      '    // "Unexpected server response: 401" from a token-protected realm).',
      '    const __why = e && (e.message || (e.error && e.error.message));',
      "    this.emit('error', new Error(__why || E_SOCKET));",
    ].join('\n'),
  },
];

let applied = 0;
let skipped = 0;
for (const p of PATCHES) {
  const target = path.join(SDK, p.file);
  let src;
  try {
    src = fs.readFileSync(target, 'utf8');
  } catch (_) {
    console.warn(`[patch-sdk] ${p.file} not found yet; skipping (fine before first install).`);
    continue;
  }
  if (src.includes(p.marker)) {
    skipped++;
    continue;
  }
  if (!src.includes(p.find)) {
    console.warn(`[patch-sdk] "${p.name}": expected code not found in ${p.file} — SDK may have changed. Skipping; verify manually.`);
    continue;
  }
  fs.writeFileSync(target, src.replace(p.find, p.replace));
  console.log(`[patch-sdk] applied "${p.name}" to ${p.file}.`);
  applied++;
}
console.log(`[patch-sdk] done — ${applied} applied, ${skipped} already present.`);
