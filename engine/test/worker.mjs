// Plays games through engine/worker.js (the site's hard level) in Node: the network bot against the classic
// engine (threatMaterial only), both at depth 3 and then deepening until ms milliseconds have passed.
// Each pair is one random opening played twice with colours swapped. Prints every game and the ms per move.
//   node engine/test/worker.mjs [pairs=1] [ms=1000] [seed=1] [classicMs=ms]
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { engineDir, loadJs, rng } from './js.mjs';

const pairs = +(process.argv[2] || 1), ms = +(process.argv[3] || 1000), seed = +(process.argv[4] || 1), classicMs = +(process.argv[5] || ms);
const NET = { maxDepth: 30, minDepth: 3, nodes: 1e18, ms };
const CLASSIC = { maxDepth: 30, minDepth: 3, nodes: 1e18, ms: classicMs };

// worker.js in its own context, with fetch reading files next to it. withNet false: the network file is missing.
function makeWorker(withNet) {
  let reply;
  const ctx = vm.createContext({
    console, performance, WebAssembly, Uint8Array, Error, JSON, String,
    fetch: async url => {
      const file = path.join(engineDir, url);
      if ((!withNet && url.startsWith('nn/')) || !fs.existsSync(file)) return { ok: false, status: 404 };
      const b = fs.readFileSync(file);
      return { ok: true, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) };
    },
    postMessage: m => reply(m),
  });
  vm.runInContext(fs.readFileSync(path.join(engineDir, 'worker.js'), 'utf8'), ctx, { filename: 'worker.js' });
  return msg => new Promise(res => { reply = res; ctx.onmessage({ data: msg }); });
}
const ask = { net: makeWorker(true), classic: makeWorker(false) };

const R = loadJs().StackRules;
const rand = rng(seed);
const play = (G, a) => { const gen = R.startAction(G, a); if (!gen) throw new Error('rules.js refused ' + JSON.stringify(a)); R.drain(gen); };
const move = (G, from, to) => {
  const m = R.availableMoves(G).find(m => m.from === from && m.to === to);
  if (!m) throw new Error(`no move ${from}-${to}`);
  play(G, { t: 'move', from, to, ...(m.promo ? { p: 'q' } : {}) });
};

const time = { net: [0, 0], classic: [0, 0] };
let w = 0, d = 0, l = 0, netSeen = true;
for (let p = 0; p < pairs; p++) {
  const opening = [];
  { // random opening of 4 to 11 actions, recorded so both games of the pair start the same
    const G = R.freshGame(null), n = 4 + Math.floor(rand() * 8);
    for (let i = 0; i < n && G.phase !== 'over'; i++) {
      const mv = R.availableMoves(G), k = mv.length + (G.phase === 'respond' ? 1 : 0);
      const j = Math.floor(rand() * k);
      const a = j === mv.length ? { t: 'resolve' } : { t: 'move', from: mv[j].from, to: mv[j].to, ...(mv[j].promo ? { p: 'q' } : {}) };
      play(G, a); opening.push(a);
    }
  }
  for (const netColor of ['w', 'b']) {
    const G = R.freshGame(null), acts = [];
    for (const a of opening) { play(G, a); acts.push(a); }
    while (G.phase !== 'over' && acts.length < 300) {
      const side = G.cur === netColor ? 'net' : 'classic';
      const t0 = performance.now();
      const r = await ask[side]({ acts, ...(side === 'net' ? NET : CLASSIC), job: 1 });
      time[side][0] += performance.now() - t0; time[side][1]++;
      if (r.error) throw new Error(side + ': ' + r.error);
      if (side === 'net') netSeen &&= r.net;
      const k = r.key;
      if (k === -1 || k >= 4096) { play(G, { t: 'resolve' }); acts.push({ t: 'resolve' }); }
      if (k !== -1 && G.phase !== 'over') {
        const from = (k % 4096) >> 6, to = k & 63;
        move(G, from, to); acts.push({ t: 'move', from, to, p: 'q' });
      }
    }
    const winner = G.result ? G.result.winner : null;
    if (winner === netColor) w++; else if (winner && winner !== netColor) l++; else d++;
    console.log(`pair ${p + 1}, network ${netColor === 'w' ? 'White' : 'Black'}: ${winner ? (winner === netColor ? 'network' : 'classic') + ' wins' : 'draw'} after ${acts.length} actions` +
      ` | total network ${w} W, ${d} D, ${l} L = ${((w + d / 2) / (w + d + l) * 100).toFixed(1)}%;` +
      ` ms/move network ${(time.net[0] / time.net[1]).toFixed(0)}, classic ${(time.classic[0] / time.classic[1]).toFixed(0)}`);
  }
}
if (!netSeen) { console.log('FAIL: the worker played without the network'); process.exit(1); }
