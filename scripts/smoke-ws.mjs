// Read-only smoke client: connects to a running bridge, prints the world, then
// every status change with its delay from the core's status_ms timestamp.
// usage: node scripts/smoke-ws.mjs [seconds] [base-url]   (token from ~/.config/herdr-mobile/token or HERDR_MOBILE_TOKEN)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { signIn, signOut } from './lib/session.mjs';

const seconds = Number(process.argv[2] ?? 10);
const base = process.argv[3] ?? 'ws://127.0.0.1:8787';
const token = process.env.HERDR_MOBILE_TOKEN ?? fs.readFileSync(path.join(os.homedir(), '.config/herdr-mobile/token'), 'utf8').trim();
const httpBase = base.replace(/^ws/, 'http');
const cookie = await signIn(httpBase, token, 'smoke-ws script');
const ws = new WebSocket(`${base}/ws`, { headers: { cookie } });
ws.on('close', () => void signOut(httpBase, cookie));
let world = null;
const t0 = Date.now();
const stamp = () => `[+${String(Date.now() - t0).padStart(5)}ms @${Date.now()}]`;

ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', v: 1 })));
ws.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.t === 'snapshot') {
    world = m.world;
    console.log(stamp(), `snapshot seq=${m.seq} core=${JSON.stringify(world.core)}`);
    for (const sid of world.spaceOrder) {
      const s = world.spaces[sid];
      console.log(`  SPACE ${s.name} [${s.status ?? '-'}]`);
      for (const tid of s.tabIds) {
        const t = world.tabs[tid];
        const terms = t.panes
          .filter((p) => p.terminalId)
          .map((p) => {
            const x = world.terminals[p.terminalId];
            return `${x.id}:${x.label}:${x.status ?? '-'}${x.children.length ? ` subs=${x.children}` : ''}`;
          });
        console.log(`    TAB ${t.name} [${t.status ?? '-'}] ${terms.join(', ')}`);
      }
    }
  } else if (m.t === 'patch') {
    for (const o of m.ops) {
      if (o.op !== 'terminal') continue;
      const prev = world.terminals[o.value.id];
      if (!prev || prev.status !== o.value.status || prev.word !== o.value.word) {
        const lag = o.value.statusMs ? Date.now() - o.value.statusMs : null;
        console.log(
          stamp(),
          `STATUS ${o.value.id} ${prev?.word}/${prev?.status} -> ${o.value.word}/${o.value.status} (since core status_ms: ${lag} ms)`,
        );
      }
      world.terminals[o.value.id] = o.value;
    }
    for (const o of m.ops) if (o.op === 'space' || o.op === 'tab') (o.op === 'space' ? world.spaces : world.tabs)[o.value.id] = o.value;
  } else if (m.t === 'alert') {
    console.log(stamp(), `ALERT ${m.alert.kind}: ${m.alert.title} — ${m.alert.body}`);
  } else if (m.t !== 'hb') console.log(stamp(), m.t);
});
ws.on('error', (e) => console.error('ws error', e.message));
setTimeout(() => {
  ws.close();
  process.exit(0);
}, seconds * 1000);
