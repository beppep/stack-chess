// Loads the site's rules.js and bot.js into one Node context, as the page does with plain scripts,
// plus helpers shared by the tests: a seeded random generator, random games, and action strings.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.resolve(here, '..', '..');
export const engineDir = path.resolve(here, '..');
export const exe = process.env.SC_EXE || path.join(engineDir, 'build', process.platform === 'win32' ? 'sc.exe' : 'sc');

export function loadJs() {
  const ctx = vm.createContext({ console, Math, Map, Set, Int8Array, Int16Array, Int32Array, Array, Object });
  vm.runInContext(fs.readFileSync(path.join(root, 'rules.js'), 'utf8'), ctx, { filename: 'rules.js' });
  // Test-only patch: rootSearch also reports how many nodes it counted, so node counts can be compared.
  let bot = fs.readFileSync(path.join(root, 'bot.js'), 'utf8');
  const patched = bot.replace(/  return results;(\r?\n)\}/, '  rootSearch.nodes = ctx.nodes;$1  return results;$1}');
  if (patched === bot) throw new Error('could not patch rootSearch in bot.js');
  vm.runInContext(patched, ctx, { filename: 'bot.js' });
  // Expose the bot's top-level names (const/let are not properties of the context's global object).
  vm.runInContext('globalThis.Bot = { sFrom, sActions, sApply, sResolve, evaluate, threatMaterial, ordered, actKey, rootSearch, TT };', ctx);
  return ctx;
}

// mulberry32: small seeded random numbers, so every test game can be regenerated from its seed.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const actionToken = a => a.t === 'resolve' ? 'r' : `m${a.from}-${a.to}${a.p || ''}`;

// Plays a random game with rules.js. onStep(G) is called on the start position and after every action.
// pResolve: chance to let a non-empty stack resolve instead of responding.
export function randomGame(R, rand, { maxActions = 300, pResolve = 0.3, pStackBias = 0.5, pSpecial = 0.5, onStep } = {}) {
  const G = R.freshGame(null);
  const tokens = [];
  if (onStep) onStep(G);
  while (G.phase !== 'over' && tokens.length < maxActions) {
    const moves = R.availableMoves(G);
    let a;
    if (G.phase === 'respond' && (!moves.length || rand() < pResolve)) a = { t: 'resolve' };
    else {
      // Half the time, prefer a move that touches the stack's squares (moves away from, onto or through
      // the squares stack moves use), so rare resolution cases (fizzles, en passant target gone) come up.
      let pool = moves;
      if (G.stack.length && rand() < pStackBias) {
        const sqs = new Set();
        for (const e of G.stack) { sqs.add(e.from); sqs.add(e.to); if (e.flag === 'ep') sqs.add(e.capSq); if (e.flag === 'double') sqs.add((e.from + e.to) / 2); }
        const hot = moves.filter(m => sqs.has(m.from) || sqs.has(m.to));
        if (hot.length) pool = hot;
      }
      // Special moves (en passant, castling, promotion) are rare in random play; often pick one when possible.
      if (rand() < pSpecial) {
        const special = moves.filter(m => m.promo || (m.flag && m.flag !== 'double'));
        if (special.length) pool = special;
      }
      const m = pool[Math.floor(rand() * pool.length)];
      a = { t: 'move', from: m.from, to: m.to };
      if (m.promo) a.p = 'qrbn'[Math.floor(rand() * 4)];
    }
    const gen = R.startAction(G, a);
    if (!gen) throw new Error('rules.js refused its own action ' + actionToken(a));
    R.drain(gen);
    tokens.push(actionToken(a));
    if (onStep) onStep(G);
  }
  return tokens;
}
