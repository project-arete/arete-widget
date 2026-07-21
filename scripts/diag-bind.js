// scripts/diag-bind.js — read-only realm inspection: dump every context with
// its provider/consumer capabilities and existing connections, then explain
// why any provider/consumer pair that LOOKS related is not bound.
//   ARETE_HOST=my.realm node scripts/diag-bind.js
import crypto from 'node:crypto';
import { installSystemIdPatch } from '../electron/arete-system-id.js';
import { AreteService } from '../electron/arete-service.js';

installSystemIdPatch('diag-bind-' + crypto.randomUUID());

const opts = {
  protocol: process.env.ARETE_PROTOCOL || 'wss:',
  host: process.env.ARETE_HOST || 'anto.aretehosting.com',
  port: Number(process.env.ARETE_PORT || 443),
  username: process.env.ARETE_USER || '',
  password: process.env.ARETE_PASS || '',
  timeout: 10000,
  systemName: '',           // observe only — never register
};

const service = new AreteService();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await service.connect(opts);
  await sleep(4000); // let the full key mirror arrive

  const keys = service.getKeys();
  const all = Object.keys(keys);

  // cns/<sys>/nodes/<node>/contexts/<ctx>/(provider|consumer)/<profile>/...
  const caps = new Map();  // capId -> {system,node,ctx,role,profile,props:{},conns:{}}
  const names = {};        // id -> name (systems, nodes, contexts)
  const ctxOf = new Map(); // "sys/node/ctx" -> context id

  for (const k of all) {
    const m = k.match(/^cns\/([^/]+)\/nodes\/([^/]+)\/contexts\/([^/]+)\/(provider|consumer)\/([^/]+)(\/.*)?$/);
    const nm = k.match(/^cns\/([^/]+)\/name$/) || k.match(/^cns\/[^/]+\/nodes\/([^/]+)\/name$/) ||
               k.match(/^cns\/[^/]+\/nodes\/[^/]+\/contexts\/([^/]+)\/name$/);
    if (nm) names[nm[1]] = keys[k];
    if (!m) continue;
    const [, sys, node, ctx, role, profile, rest] = m;
    const id = `${sys}|${node}|${ctx}|${role}|${profile}`;
    if (!caps.has(id)) caps.set(id, { sys, node, ctx, role, profile, props: {}, conns: new Set(), version: undefined });
    const c = caps.get(id);
    if (rest) {
      let mm;
      if ((mm = rest.match(/^\/properties\/(.+)$/))) c.props[mm[1]] = keys[k];
      else if ((mm = rest.match(/^\/connections\/([^/]+)/))) c.conns.add(mm[1]);
      else if (rest === '/version') c.version = keys[k];
    }
  }

  console.log(`Realm ${opts.host}: ${all.length} keys\n`);
  const byCtx = new Map();
  for (const c of caps.values()) {
    const key = c.ctx;
    if (!byCtx.has(key)) byCtx.set(key, []);
    byCtx.get(key).push(c);
  }

  for (const [ctx, list] of byCtx) {
    console.log(`CONTEXT ${ctx}  "${names[ctx] || '?'}"`);
    for (const c of list) {
      console.log(`  ${c.role.toUpperCase().padEnd(8)} ${c.profile}  node=${c.node} "${names[c.node] || '?'}" sys=${c.sys.slice(0, 12)}… version=${c.version} conns=${c.conns.size}`);
      const p = Object.entries(c.props).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
      if (p) console.log(`           props: ${p}`);
    }
    // pairing analysis inside this context
    const provs = list.filter((c) => c.role === 'provider');
    const cons = list.filter((c) => c.role === 'consumer');
    for (const pr of provs) for (const co of cons) {
      if (pr.profile === co.profile) {
        const shared = [...pr.conns].filter((x) => co.conns.has(x));
        console.log(`  PAIR ${pr.profile}: provider(${names[pr.node] || pr.node}) + consumer(${names[co.node] || co.node}) -> ${shared.length ? 'BOUND (' + shared.length + ' conn)' : '*** NOT BOUND ***'}`);
      }
    }
    console.log('');
  }

  // profiles that exist in only one role anywhere
  const profiles = new Map();
  for (const c of caps.values()) {
    if (!profiles.has(c.profile)) profiles.set(c.profile, { provider: 0, consumer: 0, ctxs: new Set() });
    profiles.get(c.profile)[c.role]++;
    profiles.get(c.profile).ctxs.add(c.ctx);
  }
  console.log('PROFILE SUMMARY (realm-wide):');
  for (const [p, s] of profiles) console.log(`  ${p}: providers=${s.provider} consumers=${s.consumer} contexts=${s.ctxs.size}`);

  // broker liveness hint: any connection keys at all?
  const connKeys = all.filter((k) => /\/connections\//.test(k));
  console.log(`\nconnection keys realm-wide: ${connKeys.length}`);
} catch (e) {
  console.error('FAIL:', e && e.message ? e.message : e);
} finally {
  await service.disconnect().catch(() => {});
  setTimeout(() => process.exit(0), 300);
}
