// Times bot.js on the benchmark positions at a fixed depth, the same way `sc bench D` does in C.
//   node engine/test/bench.mjs [depth=3] [file=engine/test/positions.txt]
import fs from 'node:fs';
import path from 'node:path';
import { loadJs, engineDir } from './js.mjs';

const depth = +(process.argv[2] || 3);
const file = process.argv[3] || path.join(engineDir, 'test', 'positions.txt');
const ctx = loadJs(), R = ctx.StackRules, B = ctx.Bot;
const toAction = t => t === 'r' ? { t: 'resolve' } : { t: 'move', from: +t.slice(1).split('-')[0], to: parseInt(t.split('-')[1]), p: /[qrbn]$/.test(t) ? t.slice(-1) : undefined };

// Warm up the JIT on the first position at depth 2, so the timings are of optimized code.
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#'));
{ const s = B.sFrom(R.replay(lines[0].split(' ').map(toAction))); B.rootSearch(s, B.ordered(s, B.sActions(s)), { maxDepth: 2, nodes: Infinity, minDepth: 2 }); }

let totalNodes = 0, totalMs = 0;
lines.forEach((line, k) => {
  const s = B.sFrom(R.replay(line.split(' ').map(toAction)));
  const t = performance.now();
  const res = B.rootSearch(s, B.ordered(s, B.sActions(s)), { maxDepth: depth, nodes: Infinity, minDepth: depth });
  const ms = performance.now() - t, nodes = B.rootSearch.nodes;
  totalNodes += nodes; totalMs += ms;
  console.log(`position ${k}: depth ${depth}, ${res.length} first moves, ${nodes} nodes, ${ms.toFixed(1)} ms, best score ${res[0][1]}`);
});
console.log(`total: ${totalNodes} nodes in ${totalMs.toFixed(1)} ms = ${Math.round(totalNodes / totalMs * 1000)} nodes/s`);
