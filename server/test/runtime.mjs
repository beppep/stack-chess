// Runs the Stack Chess server code under Node, standing in for Cloudflare's Durable Objects
// (workerd doesn't run on this PC). Every message and alarm wipes the object's in-memory
// state, like hibernation, so the storage path is exercised.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = join(HERE, '..');
const BUNDLE_DIR = join(SERVER_DIR, '.bundle');
const { WebSocketServer, WebSocket } = createRequire(join(SERVER_DIR, 'package.json'))('ws');
const clone = v => (v === undefined ? v : structuredClone(v));

function makeNamespace(Cls, env) {
  const objs = new Map();
  return {
    idFromName: n => n,
    get(id) {
      if (!objs.has(id)) {
        const data = new Map(), sockets = new Set();
        let alarmTimer = null;
        const ctx = {
          storage: {
            async get(k) { return clone(data.get(k)); },
            async put(k, v) { data.set(k, clone(v)); },
            async delete(k) { return data.delete(k); },
            async list({ prefix = '', reverse = false, limit } = {}) {
              let e = [...data].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
              if (reverse) e.reverse();
              if (limit) e = e.slice(0, limit);
              return new Map(e.map(([k, v]) => [k, clone(v)]));
            },
            async setAlarm(t) { clearTimeout(alarmTimer); alarmTimer = setTimeout(() => { inst.s = undefined; inst.G = null; inst.alarm(); }, Math.max(0, t - Date.now())); },
            async deleteAlarm() { clearTimeout(alarmTimer); alarmTimer = null; }
          },
          acceptWebSocket(ws) { sockets.add(ws); },
          getWebSockets() { return [...sockets]; },
          sockets
        };
        const inst = new Cls(ctx, env);
        inst.ctx = ctx; inst.env = env;
        inst.stopAlarm = () => clearTimeout(alarmTimer);
        objs.set(id, inst);
      }
      return objs.get(id);
    },
    all: () => [...objs.values()]
  };
}

// One build per process, to a file named by pid, so parallel test processes never share a file.
let built;
function bundle() {
  if (built) return built;
  mkdirSync(BUNDLE_DIR, { recursive: true });
  const code = execFileSync(join(SERVER_DIR, 'node_modules/@esbuild/win32-x64/esbuild.exe'),
    ['src/index.js', '--bundle', '--format=esm', '--external:cloudflare:workers', '--log-level=warning'],
    { cwd: SERVER_DIR, encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'inherit'] });
  built = join(BUNDLE_DIR, 'bundle-' + process.pid + '.mjs');
  writeFileSync(built, code.replaceAll('"cloudflare:workers"', JSON.stringify(pathToFileURL(join(HERE, 'cfworkers.mjs')).href)));
  process.on('exit', () => { try { unlinkSync(built); } catch (_) {} });
  return built;
}

export async function startServer({ port = 0 } = {}) {
  const mod = await import(pathToFileURL(bundle()).href);
  const env = {};
  for (const [key, cls] of [['ROOM', 'Room'], ['LOBBY', 'Lobby'], ['ACCOUNTS', 'Accounts']]) if (mod[cls]) env[key] = makeNamespace(mod[cls], env);

  const http = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = chunks.length && !['GET', 'HEAD'].includes(req.method) ? Buffer.concat(chunks) : undefined;
      const r = await mod.default.fetch(new Request('http://' + req.headers.host + req.url, { method: req.method, headers: req.headers, body }), env);
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) { console.error('ERR', e); res.writeHead(500); res.end('error'); }
  });
  const wss = new WebSocketServer({ server: http });
  wss.on('connection', (sock, req) => {
    const [, kind, raw] = req.url.split('?')[0].split('/');
    const name = decodeURIComponent(raw || '');
    const ns = kind === 'room' ? env.ROOM : kind === 'lobby' ? env.LOBBY : null;
    if (!ns) return sock.close();
    const inst = ns.get(name);
    let att = kind === 'room' ? { code: name } : { tc: name };
    const ws = {
      send: d => sock.readyState === 1 && sock.send(d),
      close: c => { try { sock.close(c); } catch (_) {} },
      serializeAttachment: a => { att = clone(a); },
      deserializeAttachment: () => clone(att)
    };
    inst.ctx.acceptWebSocket(ws);
    if (kind === 'lobby') inst.count();
    let chain = Promise.resolve(); // one message at a time per socket
    sock.on('message', d => { chain = chain.then(async () => { inst.s = undefined; inst.G = null; await inst.webSocketMessage(ws, d.toString()); }).catch(e => console.error('ERR', e)); });
    sock.on('close', c => { chain = chain.then(async () => { await inst.webSocketClose(ws, c); inst.ctx.sockets.delete(ws); }).catch(e => console.error('ERR', e)); });
  });
  await new Promise(r => http.listen(port, '127.0.0.1', r));
  const p = http.address().port;
  return {
    worker: (path, headers) => mod.default.fetch(new Request('http://x' + path, { headers }), env), // the worker's own routing
    http: 'http://127.0.0.1:' + p, ws: 'ws://127.0.0.1:' + p, env,
    stop: () => new Promise(r => {
      for (const ns of Object.values(env)) for (const o of ns.all()) o.stopAlarm();
      for (const c of wss.clients) c.terminate();
      http.close(() => r());
      http.closeAllConnections?.();
    })
  };
}

// Test client: next(type) resolves with the next unread message (of that type), skipping others.
export function connect(url) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(url), queue = [], waiters = [];
    const pump = () => {
      for (const w of [...waiters]) {
        const i = queue.findIndex(m => !w.type || m.type === w.type);
        if (i >= 0) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(w.timer); w.resolve(queue.splice(i, 1)[0]); }
      }
    };
    sock.on('message', d => { queue.push(JSON.parse(d.toString())); pump(); });
    sock.on('error', reject);
    sock.on('open', () => resolve({
      send: obj => sock.send(JSON.stringify(obj)),
      next: (type, timeoutMs = 2000) => new Promise((res, rej) => {
        const w = { type, resolve: res };
        w.timer = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error('timeout waiting for ' + (type || 'message'))); }, timeoutMs);
        waiters.push(w); pump();
      }),
      close: () => sock.close()
    }));
  });
}
