// Rules parity: random games played with rules.js, replayed by the C engine, compared at every step.
// Compared after each action: board with piece ids, castling, en passant, side to act, phase, result,
// the stack, the available moves (in order), the bot's evaluation, and the bot's ordered action list.
//   node engine/test/parity.mjs [games=5000] [firstSeed=1]
// Prints progress every batch; stops at the first difference and shows it.
import { execFileSync } from 'node:child_process';
import { loadJs, rng, randomGame, exe } from './js.mjs';

const games = +(process.argv[2] || 5000), firstSeed = +(process.argv[3] || 1);
const BATCH = 100;
const ctx = loadJs(), R = ctx.StackRules, B = ctx.Bot;

const FLAG = { double: 1, ep: 2, castleK: 3, castleQ: 4 };
const LET = { p: 'P', n: 'N', b: 'B', r: 'R', q: 'Q', k: 'K' };
const hex2 = n => n.toString(16).padStart(2, '0');
const flagOf = m => FLAG[m.flag] || 0;
const epPart = (m, sep) => m.flag === 'ep' ? `${sep}${m.capSq}${sep}${m.capId}` : '';

// The same line sc_cli.c prints in snapshot().
function snapshot(G) {
  const st = G.st;
  let board = '';
  for (const p of st.board) board += p ? (p.c === 'w' ? LET[p.t] : LET[p.t].toLowerCase()) + hex2(p.id) : '.--';
  const cs = st.castle, castle = (cs.wK ? 1 : 0) | (cs.wQ ? 2 : 0) | (cs.bK ? 4 : 0) | (cs.bQ ? 8 : 0);
  const ep = st.ep ? `${st.ep.sq},${st.ep.pawnSq},${st.ep.pawnId},${st.ep.color}` : '-';
  const phase = { move: 'm', respond: 'r', over: 'o' }[G.phase];
  const result = !G.result ? '-' : G.result.winner || 'd';
  const stack = G.stack.length ? G.stack.map(e => `${e.from},${e.to},${e.pieceId},${flagOf(e)},${e.promo ? 1 : 0},${e.promoTo || '-'},${e.player}${epPart(e, ',')}`).join(';') : '-';
  const av = R.availableMoves(G);
  const avail = av.length ? av.map(m => `${m.from}-${m.to}-${flagOf(m)}-${m.promo ? 1 : 0}${epPart(m, '-')}`).join(',') : '-';
  const s = B.sFrom(G);
  const ev = B.evaluate(s);
  const keys = B.ordered(s, B.sActions(s)).map(B.actKey);
  return [`${board} ${castle} ${ep} ${G.cur} ${phase} ${result} ${stack} ${avail}`, ev, keys.length ? keys.join(',') : '-'];
}

function compare(js, line) {
  const f = line.split(' ');
  if (f.length !== 10) return 'C printed: ' + line;
  const head = f.slice(0, 8).join(' ');
  if (head !== js[0]) return `position/moves differ\n  js: ${js[0]}\n  c:  ${head}`;
  if (parseFloat(f[8]) !== js[1]) return `evaluate differs: js ${js[1]}, c ${f[8]}`;
  if (f[9] !== js[2]) return `bot action order differs\n  js: ${js[2]}\n  c:  ${f[9]}`;
  return null;
}

let steps = 0, done = 0, results = { w: 0, b: 0, d: 0, open: 0 }, maxStack = 0;
const t0 = Date.now();
for (let start = firstSeed; start < firstSeed + games; start += BATCH) {
  const seeds = [], lines = [], snaps = [];
  for (let seed = start; seed < Math.min(start + BATCH, firstSeed + games); seed++) {
    const rand = rng(seed), mine = [];
    // Vary the style: some games resolve often, some build tall stacks.
    const pResolve = [0.5, 0.3, 0.15, 0.05][seed % 4];
    let G;
    lines.push(randomGame(R, rand, { pResolve, onStep: g => { G = g; mine.push(snapshot(g)); maxStack = Math.max(maxStack, g.stack.length); } }).join(' '));
    seeds.push(seed); snaps.push(mine);
    results[!G.result ? 'open' : G.result.winner || 'd']++;
  }
  const out = execFileSync(exe, ['replay'], { input: lines.join('\n') + '\n', maxBuffer: 1 << 30 }).toString().split('\n');
  let k = 0;
  for (let g = 0; g < seeds.length; g++) {
    for (let i = 0; i < snaps[g].length; i++, k++) {
      const err = compare(snaps[g][i], (out[k] || '').trimEnd());
      if (err) {
        console.log(`DIFFERENCE in game seed ${seeds[g]} after ${i} actions (pResolve ${[0.5, 0.3, 0.15, 0.05][seeds[g] % 4]})`);
        console.log('actions so far:', lines[g].split(' ').slice(0, i).join(' '));
        console.log(err);
        process.exit(1);
      }
      steps++;
    }
    if ((out[k++] || '').trimEnd() !== 'END') { console.log(`game seed ${seeds[g]}: C has extra output: ${out[k - 1]}`); process.exit(1); }
    done++;
  }
  console.log(`${done}/${games} games, ${steps} positions identical (max stack ${maxStack}; white ${results.w}, black ${results.b}, draw ${results.d}, unfinished ${results.open}) ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
console.log(`PASS: ${done} games, ${steps} positions, zero differences`);
