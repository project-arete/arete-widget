// scripts/test-connect.js
// Headless verification of the connection path WITHOUT launching Electron.
// It exercises exactly what the main process does: install the System-ID patch,
// load the SDK, connect, wait for open, and register System -> Node -> Context.
//
// Default target is the SDK example's PUBLIC host (dashboard.test.cns.dev:443),
// which needs no credentials — so this proves the scaffold end-to-end.
//
// Usage:
//   node scripts/test-connect.js
//   ARETE_HOST=my.realm.example.com ARETE_USER=... ARETE_PASS=... \
//     ARETE_ALLOW_SELF_SIGNED=1 node scripts/test-connect.js

import crypto from 'node:crypto';
import { installSystemIdPatch } from '../electron/arete-system-id.js';
import { AreteService } from '../electron/arete-service.js';

installSystemIdPatch('test-connect-' + crypto.randomUUID());

const opts = {
  protocol: process.env.ARETE_PROTOCOL || 'wss:',
  host: process.env.ARETE_HOST || 'dashboard.test.cns.dev',
  port: Number(process.env.ARETE_PORT || 443),
  username: process.env.ARETE_USER || '',
  password: process.env.ARETE_PASS || '',
  allowSelfSigned: (process.env.ARETE_ALLOW_SELF_SIGNED || '0') === '1',
  timeout: Number(process.env.ARETE_TIMEOUT || 10000),
};

const svc = new AreteService();
svc.on('log', (e) => console.log(`  [${e.level}] ${e.message}`));

const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const id22 = () => {
  const b = crypto.randomBytes(22);
  let s = '';
  for (let i = 0; i < 22; i++) s += B62[b[i] % 62];
  return s;
};

let code = 1;
try {
  console.log(`Connecting to ${opts.protocol}//${opts.host}:${opts.port} ...`);
  await svc.connect(opts);
  const st = svc.getStatus();
  console.log('STATUS:', JSON.stringify({ state: st.state, isOpen: st.isOpen, version: st.version }));

  console.log('Registering node/context ...');
  const ident = await svc.instantiate({
    nodeId: id22(),
    nodeName: 'arete-widget-test',
    contextId: id22(),
    contextName: 'Widget Test Context',
  });
  console.log('IDENTITY:', JSON.stringify(ident));
  console.log('\n✅ PASS — connected, authenticated, and registered.');
  code = 0;
} catch (e) {
  console.error('\n❌ FAIL —', e && e.message ? e.message : e);
  code = 1;
} finally {
  await svc.disconnect().catch(() => {});
  // Give the SDK's daemon socket a beat to close, then exit deterministically.
  setTimeout(() => process.exit(code), 300);
}
