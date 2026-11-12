// Bot parity: bot.js rootSearch and the C search at the same fixed depth, on positions from random games.
// Compares the node count and every first move's score, in order.
//   node engine/test/botparity.mjs [depth=3] [positions=100] [firstSeed=1]
// Prints one line per position as it goes (with the JS time), stops at the first difference.
import { execFileSync } from 'node:child_process';
import { loadJs, rng, randomGame, exe } from './js.mjs';

const depth = +(process.argv[2] || 3), count = +(process.argv[3] || 100), firstSeed = +(process.argv[4] || 1);
const ctx = loadJs(), R = ctx.StackRules, B = ctx.Bot;

// A position: a random game cut at a random point, often with moves on the stack.
const positions = [];
for (let seed = firstSeed; positions.length < count; seed++) {
  const rand = rng(seed * 7919);
  const toks = randomGame(R, rand, { pResolve: [0.4, 0.2, 0.1][seed % 3], maxActions: 10 + Math.floor(rand() * 70) });
  const G = R.replay(toks.map(t => t === 'r' ? { t: 'resolve' } : { t: 'move', from: +t.slice(1).split('-')[0], to: parseInt(t.split('-')[1]), p: /[qrbn]$/.test(t) ? t.slice(-1) : undefined }));
  if (G.phase === 'over') continue;
  positions.push({ seed, toks, G });
}

console.log(`C engine: searching ${count} positions at depth ${depth}...`);
const t0 = Date.now();
const cOut = execFileSync(exe, ['search', String(depth)], { input: positions.map(p => p.toks.join(' ')).join('\n') + '\n', maxBuffer: 1 << 28 }).toString().trim().split('\n');
const cMs = Date.now() - t0;
console.log(`C engine done in ${cMs} ms`);

const num = x => x === 'inf' ? Infinity : x === '-inf' ? -Infinity : parseFloat(x);
let jsMs = 0, jsNodes = 0, cNodes = 0;
for (let i = 0; i < positions.length; i++) {
  const { seed, toks, G } = positions[i];
  const s = B.sFrom(G);
  const t = Date.now();
  const res = B.rootSearch(s, B.ordered(s, B.sActions(s)), { maxDepth: depth, nodes: Infinity, minDepth: depth });
  const ms = Date.now() - t;
  jsMs += ms;
  const nodes = B.rootSearch.nodes;
  const f = cOut[i].trim().split(' ');
  const cn = +f[0];
  jsNodes += nodes; cNodes += cn;
  const cRes = f.slice(1).map(x => { const [k, v] = x.split(':'); return [+k, num(v)]; });
  let err = null;
  if (cn !== nodes) err = `node count: js ${nodes}, c ${cn}`;
  else if (cRes.length !== res.length) err = `first moves: js ${res.length}, c ${cRes.length}`;
  else for (let j = 0; j < res.length; j++) {
    if (B.actKey(res[j][0]) !== cRes[j][0] || res[j][1] !== cRes[j][1]) { err = `result ${j}: js ${B.actKey(res[j][0])}:${res[j][1]}, c ${cRes[j][0]}:${cRes[j][1]}`; break; }
  }
  console.log(`${i + 1}/${count} seed ${seed}, stack ${G.stack.length}, ${res.length} first moves, ${nodes} nodes, best ${res[0][1]}, js ${ms} ms${err ? '  DIFFERENT: ' + err : ''}`);
  if (err) { console.log('position actions:', toks.join(' ')); process.exit(1); }
}
console.log(`PASS: ${count} positions at depth ${depth}, same scores and node counts.`);
console.log(`JS: ${jsNodes} nodes in ${jsMs} ms (${Math.round(jsNodes / jsMs * 1000)} nodes/s); C: ${cNodes} nodes in ${cMs} ms including startup (${Math.round(cNodes / cMs * 1000)} nodes/s)`);
