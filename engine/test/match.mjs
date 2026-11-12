// Bot vs bot with the native engine, on several cores, printing the running score after every game.
//   node engine/test/match.mjs PAIRS RULE_A RULE_B [NODES=2000] [MAXD=6] [MIND=2] [PROCS=7]
// Each pair is a random opening played twice, colours swapped. RULE_A/RULE_B: sc_saved_rule for each bot
// (0 always saved, as bot.js; 1 only without a second free attacker; 2 never).
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const [pairs, ruleA, ruleB, nodes = '2000', maxd = '6', mind = '2', procs = '7'] = process.argv.slice(2);
if (!ruleB) { console.error('usage: node engine/test/match.mjs PAIRS RULE_A RULE_B [NODES] [MAXD] [MIND] [PROCS]'); process.exit(1); }
const exe = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build', process.platform === 'win32' ? 'sc.exe' : 'sc');
const n = +pairs, k = Math.min(+procs, n), t0 = Date.now();
let games = 0, aw = 0, bw = 0, dr = 0, sa = 0, la = 0, sb = 0, lb = 0, plies = 0, running = k;
const pct = (l, s) => (s ? (100 * l / s).toFixed(1) + '%' : '-');
const line = () => `${games}/${2 * n} games: A ${aw}, B ${bw}, draws ${dr} | A score ${games ? (100 * (aw + dr / 2) / games).toFixed(1) : '-'}% | started a fight and lost the capturer: A ${la}/${sa} (${pct(la, sa)}), B ${lb}/${sb} (${pct(lb, sb)}) | ${((Date.now() - t0) / 1000).toFixed(0)} s`;

for (let i = 0; i < k; i++) {
  const from = Math.floor(n * i / k), to = Math.floor(n * (i + 1) / k);
  const c = spawn(exe, ['match', from, to, nodes, maxd, mind, ruleA, ruleB].map(String));
  let buf = '';
  c.stdout.on('data', d => {
    buf += d;
    let j;
    while ((j = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, j).trim(); buf = buf.slice(j + 1);
      const m = l.split(' ');
      if (m[0] !== 'game') continue;
      const [, , aCol, win, pl, sA, lA, sB, lB] = m;
      games++; plies += +pl;
      if (win === '-') dr++; else if (win === aCol) aw++; else bw++;
      sa += +sA; la += +lA; sb += +sB; lb += +lB;
      console.log(line());
    }
  });
  c.stderr.on('data', d => process.stderr.write(d));
  c.on('exit', () => { if (--running === 0) console.log('DONE ' + line() + ` | avg ${Math.round(plies / games)} bot moves per game`); });
}
