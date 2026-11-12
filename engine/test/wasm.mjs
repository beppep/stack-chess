// Checks engine/build/sc.wasm: it loads with no imports, and its bot gives the same best score and
// node count as the native build on the benchmark positions.
//   node engine/test/wasm.mjs [depth=3]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { engineDir, exe } from './js.mjs';

const depth = +(process.argv[2] || 3);
const bytes = fs.readFileSync(path.join(engineDir, 'build', 'sc.wasm'));
const mod = await WebAssembly.compile(bytes);
console.log('imports:', WebAssembly.Module.imports(mod).length, ' exports:', WebAssembly.Module.exports(mod).map(e => e.name).filter(n => n.startsWith('sc_w')).join(' '));
const { exports: W } = await WebAssembly.instantiate(mod, {});

const lines = fs.readFileSync(path.join(engineDir, 'test', 'positions.txt'), 'utf8').split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#'));
const native = execFileSync(exe, ['search', String(depth)], { input: lines.join('\n') + '\n' }).toString().trim().split(/\r?\n/);
const PROMO = { q: 5, r: 4, b: 3, n: 2 };
let ok = true, totalMs = 0, totalNodes = 0;
lines.forEach((line, k) => {
  W.sc_w_new_game();
  for (const t of line.split(' ')) {
    const legal = t === 'r' ? W.sc_w_resolve() : W.sc_w_move(+t.slice(1).split('-')[0], parseInt(t.split('-')[1]), PROMO[t.slice(-1)] || 0);
    if (!legal) throw new Error(`position ${k}: wasm refused ${t}`);
  }
  const t0 = performance.now();
  const key = W.sc_w_think(depth, depth, 1e18);
  const ms = performance.now() - t0;
  const score = W.sc_w_last_score(), nodes = W.sc_w_last_nodes();
  const f = native[k].split(' '), [nk, nv] = f[1].split(':');
  const same = +f[0] === nodes && +nk === key && parseFloat(nv) === score;
  ok &&= same;
  totalMs += ms; totalNodes += nodes;
  console.log(`position ${k}: best ${key} score ${score}, ${nodes} nodes, ${ms.toFixed(1)} ms  ${same ? 'same as native' : `DIFFERENT (native ${f[0]} nodes, ${f[1]})`}`);
});
console.log(`${ok ? 'PASS' : 'FAIL'}: wasm ${totalNodes} nodes in ${totalMs.toFixed(1)} ms = ${Math.round(totalNodes / totalMs * 1000)} nodes/s`);
process.exit(ok ? 0 : 1);
