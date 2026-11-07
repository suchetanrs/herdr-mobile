// Measures the input paths on a throwaway terminal (never a real one):
// typing attach DATA vs terminal.keys vs terminal.keys right after typing.
// Usage: node scripts/probe-input.mjs <terminal>  (e.g. hm-probe)
import net from 'node:net';

const target = process.argv[2];
if (!target?.startsWith('hm-')) throw new Error('pass a throwaway terminal name (hm-...)');
const sockPath = `${process.env.XDG_RUNTIME_DIR || '/run/user/1000'}/herdr-core/default.sock`;

function frame(ch, kind, payload = Buffer.alloc(0)) {
  const b = typeof payload === 'string' ? Buffer.from(payload) : payload;
  const h = Buffer.alloc(9);
  h.writeUInt32LE(ch, 0);
  h.writeUInt8(kind, 4);
  h.writeUInt32LE(b.length, 5);
  return Buffer.concat([h, b]);
}

const sock = net.createConnection(sockPath);
let buf = Buffer.alloc(0);
let greeted = false;
let id = 1;
const pending = new Map();
const chans = new Map();
sock.on('data', (c) => {
  buf = Buffer.concat([buf, c]);
  if (!greeted) {
    const nl = buf.indexOf(10);
    if (nl < 0) return;
    greeted = true;
    buf = buf.subarray(nl + 1);
    onReady();
  }
  while (buf.length >= 9) {
    const len = buf.readUInt32LE(5);
    if (buf.length < 9 + len) break;
    const ch = buf.readUInt32LE(0);
    const kind = buf.readUInt8(4);
    const p = buf.subarray(9, 9 + len);
    buf = buf.subarray(9 + len);
    if (ch === 0) {
      const m = JSON.parse(p.toString());
      const r = pending.get(m.id);
      if (r) {
        pending.delete(m.id);
        m.error ? r[1](new Error(JSON.stringify(m.error))) : r[0](m.result);
      }
    } else {
      if (kind === 0)
        sock.write(
          frame(
            ch,
            1,
            (() => {
              const x = Buffer.alloc(4);
              x.writeUInt32LE(p.length);
              return x;
            })(),
          ),
        );
      chans.get(ch)?.(kind, p);
    }
  }
});
sock.on('connect', () =>
  sock.write(`${JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'hello', params: { generation: 1, framed: true } })}\n`),
);
const call = (method, params) =>
  new Promise((res, rej) => {
    const i = id++;
    pending.set(i, [res, rej]);
    sock.write(frame(0, 0, JSON.stringify({ jsonrpc: '2.0', id: i, method, params })));
  });
const size = async () => {
  const t = await call('terminal.get', { terminal: target });
  return `${t.cols}x${t.rows}`;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function onReady() {
  // The "desktop": a typing viewer at 120x40.
  const desk = await call('terminal.attach', { terminal: target, cols: 120, rows: 40 });
  console.log('desktop attach', desk.channel, 'size', await size());
  // Shared observer.
  let seen = '';
  const obs = await call('terminal.attach', { terminal: target, cols: 120, rows: 40, observe: true, resize_notifications: true });
  chans.set(obs.channel, (k, p) => {
    if (k === 0) seen += p.toString('latin1');
    if (k === 3) console.log('observer RESIZE', p.readUInt16LE(0), p.readUInt16LE(2));
  });
  await sleep(300);
  const waitFor = async (needle, timeout = 8000) => {
    const t0 = performance.now();
    while (!seen.includes(needle)) {
      if (performance.now() - t0 > timeout) return -1;
      await sleep(0.2);
    }
    return performance.now() - t0;
  };
  // A: typing attach (resumed) at the current size.
  const cur = await call('terminal.get', { terminal: target });
  const t0 = performance.now();
  const typ = await call('terminal.attach', { terminal: target, cols: cur.cols, rows: cur.rows, resumed: true, history: 0 });
  const attachMs = performance.now() - t0;
  console.log('typing attach ms', attachMs.toFixed(2), 'size after attach', await size());
  const lat = [];
  for (let i = 0; i < 20; i++) {
    const tok = `A${i}Z${Math.random().toString(36).slice(2, 7)}`;
    const s = performance.now();
    sock.write(frame(typ.channel, 0, tok));
    const ms = await waitFor(tok);
    lat.push(ms + (performance.now() - s - ms));
    await sleep(20);
  }
  sock.write(frame(typ.channel, 0, '\x15')); // ctrl+u clears the line
  console.log('attach DATA echo ms', lat.map((x) => x.toFixed(2)).join(' '), 'size', await size());
  // B: terminal.keys right after typing (quiet rule?)
  let s = performance.now();
  await call('terminal.keys', { terminal: target, keys: ['x', 'q', 'k'] });
  console.log('keys right after typing: rpc ms', (performance.now() - s).toFixed(1), 'echo', (await waitFor('xqk')).toFixed(1));
  sock.write(frame(typ.channel, 2));
  await sleep(200);
  console.log('size after typing CLOSE', await size());
  await sleep(3500);
  s = performance.now();
  await call('terminal.keys', { terminal: target, keys: ['ctrl+u', 'm', 'w', 'p'] });
  console.log('keys after quiet: rpc ms', (performance.now() - s).toFixed(1), 'echo', (await waitFor('mwp')).toFixed(1));
  // C: desktop resize while a typing viewer is open; the typer follows, then types.
  const typ2 = await call('terminal.attach', { terminal: target, cols: 120, rows: 40, resumed: true, history: 0 });
  sock.write(frame(typ2.channel, 0, 'z'));
  await sleep(100);
  const rs = Buffer.alloc(4);
  rs.writeUInt16LE(130, 0);
  rs.writeUInt16LE(42, 2);
  sock.write(frame(desk.channel, 3, rs));
  await sleep(100);
  console.log('after desktop resize', await size());
  sock.write(frame(typ2.channel, 3, rs));
  sock.write(frame(typ2.channel, 0, 'y'));
  await sleep(100);
  console.log('after typer follows + types', await size());
  sock.write(frame(typ2.channel, 2));
  await sleep(100);
  console.log('after typer CLOSE', await size());
  const back = Buffer.alloc(4);
  back.writeUInt16LE(120, 0);
  back.writeUInt16LE(40, 2);
  sock.write(frame(desk.channel, 3, back));
  await sleep(100);
  console.log('desktop back', await size());
  sock.end();
  process.exit(0);
}
