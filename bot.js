// The computer opponent. Loaded by the page (after rules.js) and by the search workers.
if (typeof importScripts === 'function' && typeof document === 'undefined' && typeof StackRules === 'undefined') importScripts('rules.js');
// ---------- Computer opponent: minimax with alpha-beta ----------
// The search works on a light copy of the game: board, the stack, and whose decision it is.
// An action is either putting a move on the stack or letting the stack resolve.
// Resolving keeps the same player to act, so the score only flips sign when the player changes.
const VAL = { p: 100, n: 310, b: 320, r: 500, q: 900, k: 0 };
const WIN = 100000;
const AI_LEVELS = {
  easy: { nodes: Infinity, maxDepth: 2, noise: 90 },
  normal: { nodes: 2000, maxDepth: 6, noise: 15 },
  hard: { nodes: 5000, maxDepth: 10, noise: 0, minDepth: 3 } // always finishes 3 deep
};

function sFrom(G) {
  return {
    st: cloneState(G.st), cur: G.cur, winner: null,
    stack: G.stack.map(e => ({ from: e.from, to: e.to, pieceId: e.pieceId, flag: e.flag, capSq: e.capSq, capId: e.capId, promoTo: e.promoTo, player: e.player }))
  };
}
// A turn is either a response (a move on top of the stack) or, when the stack is not empty,
// letting it resolve and then making a move on the resulting board.
function sActions(s) {
  const used = new Set(s.stack.map(e => e.pieceId));
  const out = [];
  for (const m of legalMoves(s.st, s.cur)) if (!used.has(m.pieceId)) out.push({ t: 'move', m });
  if (s.stack.length) {
    const r = sResolve(s);
    if (r.winner) out.push({ t: 'resolve', r });
    else for (const m of legalMoves(r.st, r.cur)) out.push({ t: 'resolve-move', r, m });
  }
  return out;
}
function sResolve(s) {
  const st = cloneState(s.st);
  let winner = null;
  for (let i = s.stack.length - 1; i >= 0; i--) {
    const e = s.stack[i];
    if (!stillValid(st, e)) continue;
    const cap = applyMove(st, e);
    if (cap && cap.t === 'k') { winner = e.player; break; }
  }
  return { st, stack: [], cur: s.cur, winner };
}
function sApply(s, a) {
  if (a.t === 'resolve') return a.r;
  const base = a.t === 'resolve-move' ? a.r : s;
  const m = a.m.promo ? { ...a.m, promoTo: 'q' } : a.m;
  // Declaring doesn't touch the board, so the board is shared until something resolves.
  return { st: base.st, stack: base.stack.concat([{ ...m, player: s.cur }]), cur: other(s.cur), winner: null };
}

// Score = resolve the stack, then count material, from the view of the player to act.
// The player to act still has their turn, so of their pieces that die in the resolution, the
// most valuable one that could still move (isn't already committed on the stack) counts as saved.
const EV_ALIVE = new Int32Array(1024);
let evGen = 0;
function evaluate(s) {
  if (!s.stack.length) return threatMaterial(s.st, s.cur);
  const t = sResolve(s);
  if (t.winner === s.cur) return WIN;
  const gen = ++evGen;
  for (const p of t.st.board) if (p) EV_ALIVE[p.id] = gen;
  let saved = 0, kingSaved = false;
  s.st.board.forEach((p, sq) => {
    if (!p || p.c !== s.cur || EV_ALIVE[p.id] === gen || s.stack.some(e => e.pieceId === p.id) || !pieceMoves(s.st, sq).length) return;
    if (freeAttacker(s.st.board, sq, p.c, s.stack)) return; // a second attacker takes it on top after it dodges
    if (p.t === 'k') kingSaved = true;
    else saved = Math.max(saved, VAL[p.t]);
  });
  if (t.winner) return kingSaved ? threatMaterial(t.st, s.cur) : -WIN; // a king that can step away isn't lost
  return threatMaterial(t.st, s.cur) + saved;
}
// Is the piece of colour c on sq attacked by an enemy piece that has no move on the stack yet?
function freeAttacker(b, sq, c, stack) {
  const r = sq >> 3, f = sq & 7, free = q => q && q.c !== c && !stack.some(e => e.pieceId === q.id);
  const pr = c === 'w' ? r - 1 : r + 1;
  if (pr >= 0 && pr < 8) for (const df of [-1, 1]) { const ff = f + df; if (ff >= 0 && ff < 8) { const q = b[pr * 8 + ff]; if (q && q.t === 'p' && free(q)) return true; } }
  for (const [dr, df] of KN) { const rr = r + dr, ff = f + df; if (rr >= 0 && rr < 8 && ff >= 0 && ff < 8) { const q = b[rr * 8 + ff]; if (q && q.t === 'n' && free(q)) return true; } }
  for (const [dr, df] of KG) { const rr = r + dr, ff = f + df; if (rr >= 0 && rr < 8 && ff >= 0 && ff < 8) { const q = b[rr * 8 + ff]; if (q && q.t === 'k' && free(q)) return true; } }
  for (const [dirs, kinds] of [[ROOK, 'rq'], [BISH, 'bq']]) for (const [dr, df] of dirs) {
    for (let rr = r + dr, ff = f + df; rr >= 0 && rr < 8 && ff >= 0 && ff < 8; rr += dr, ff += df) {
      const q = b[rr * 8 + ff];
      if (q) { if (kinds.includes(q.t) && free(q)) return true; break; }
    }
  }
  return false;
}
// Material for player c, where each enemy piece attacking a piece takes 10% off its value (one 90%,
// two 81%, ...) unless that attacker is attacked itself,
// each piece attacking a king costs its owner 10, and a king attacked by two or more counts as half
// a lost game.
// Fast attack scan (no move lists): each attacker-target pair where an enemy piece stands on the target.
const TM_HITS = new Int8Array(64), TM_FRESH = new Int8Array(64), TM_PAIRS = new Int16Array(1024);
function threatMaterial(st, c) {
  const b = st.board, hits = TM_HITS, fresh = TM_FRESH, pairs = TM_PAIRS;
  hits.fill(0); fresh.fill(0);
  let n = 0;
  const hit = (from, to) => { hits[to]++; pairs[n++] = from; pairs[n++] = to; };
  for (let sq = 0; sq < 64; sq++) {
    const p = b[sq];
    if (!p) continue;
    const r = sq >> 3, f = sq & 7, col = p.c;
    if (p.t === 'p') {
      const r1 = r + (col === 'w' ? -1 : 1);
      if (r1 < 0 || r1 > 7) continue;
      if (f > 0) { const q = b[r1 * 8 + f - 1]; if (q && q.c !== col) hit(sq, r1 * 8 + f - 1); }
      if (f < 7) { const q = b[r1 * 8 + f + 1]; if (q && q.c !== col) hit(sq, r1 * 8 + f + 1); }
    } else if (p.t === 'n' || p.t === 'k') {
      for (const [dr, dc] of (p.t === 'n' ? KN : KG)) {
        const rr = r + dr, cc = f + dc;
        if (rr < 0 || rr > 7 || cc < 0 || cc > 7) continue;
        const q = b[rr * 8 + cc];
        if (q && q.c !== col) hit(sq, rr * 8 + cc);
      }
    } else {
      const dirs = p.t === 'r' ? ROOK : p.t === 'b' ? BISH : QUEEN_DIRS;
      for (const [dr, dc] of dirs) {
        let rr = r + dr, cc = f + dc;
        while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) {
          const q = b[rr * 8 + cc];
          if (q) { if (q.c !== col) hit(sq, rr * 8 + cc); break; }
          rr += dr; cc += dc;
        }
      }
    }
  }
  for (let i = 0; i < n; i += 2) if (!hits[pairs[i]]) fresh[pairs[i + 1]]++;
  let score = 0;
  for (let sq = 0; sq < 64; sq++) {
    const p = b[sq];
    if (!p) continue;
    const sign = p.c === c ? 1 : -1;
    if (p.t === 'k') { score -= sign * 10 * hits[sq]; if (hits[sq] >= 2) score -= sign * WIN / 2; }
    else score += sign * VAL[p.t] * 0.9 ** fresh[sq];
  }
  return score;
}
const QUEEN_DIRS = ROOK.concat(BISH);
function material(st, c) {
  let score = 0;
  for (const p of st.board) if (p) score += p.c === c ? VAL[p.t] : -VAL[p.t];
  return score;
}

function orderScore(s, a) {
  if (a.t === 'resolve') return WIN;
  const board = a.t === 'resolve-move' ? a.r.st.board : s.st.board;
  const target = board[a.m.to], mover = board[a.m.from];
  if (!target) return a.m.promo ? 800 : 0;
  if (target.t === 'k') return WIN;
  return VAL[target.t] * 10 - VAL[mover.t];
}
function ordered(s, acts) {
  return acts.map(a => [orderScore(s, a), a]).sort((x, y) => y[0] - x[0]).map(x => x[1]);
}

// Stack extensions: a response that touches the fight already on the stack doesn't use up depth,
// so the bot reads the stack out. That is a response that captures a piece with a move on the
// stack, or moves a piece that a stack move is targeting. At most MAX_STACK_EXT per line.
const MAX_STACK_EXT = 6;
function stackRelated(s, a) {
  if (a.t !== 'move' || !s.stack.length) return false;
  const target = s.st.board[a.m.to];
  if (target && target.c !== s.cur && s.stack.some(e => e.pieceId === target.id)) return true;
  return s.stack.some(e => e.player !== s.cur && e.to === a.m.from);
}
// Position table: a searched position's result and best move, kept for the rest of this move's search.
// A result is reused only for the same depth, extensions and ply, so it is the same search result.
const ZOB = (() => { const t = new Int32Array(2 * 32 * 8 * 64); let x = 0x2545F491; for (let i = 0; i < t.length; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; t[i] = x; } return t; })();
const ZT = { p: 0, n: 1, b: 2, r: 3, q: 4, k: 5 };
const TT = new Map();
function posKey(s) {
  const b = s.st.board, half = 32 * 8 * 64;
  let h1 = s.cur === 'w' ? 1 : 2, h2 = 7;
  for (let i = 0; i < 64; i++) { const p = b[i]; if (p) { const k = (((p.id & 31) * 8 + ZT[p.t]) << 6) + i; h1 ^= ZOB[k]; h2 ^= ZOB[half + k]; } }
  const cs = s.st.castle, ep = s.st.ep;
  h1 = Math.imul(h1 ^ ((cs.wK ? 1 : 0) | (cs.wQ ? 2 : 0) | (cs.bK ? 4 : 0) | (cs.bQ ? 8 : 0) | ((ep ? ep.sq + 1 : 0) << 4)), 0x9E3779B1);
  for (const e of s.stack) {
    const x = e.from | (e.to << 6) | ((e.pieceId & 31) << 12) | ((e.player === 'w' ? 1 : 0) << 17) | ((e.promoTo ? 1 : 0) << 18);
    h1 = Math.imul(h1 ^ x, 0x85EBCA6B) ^ (h1 >>> 15);
    h2 = Math.imul(h2 ^ x, 0xC2B2AE35) ^ (h2 >>> 13);
  }
  return h1 * 2097152 + (h2 & 2097151);
}
// End of the search: before the score counts, the side to act may still make its free replies
// (capture a piece whose move is on the stack, or move a piece a stack move aims at). Letting the
// stack resolve as it is (the score) is always one of the options.
function quiet(s, alpha, beta, ply, ext) {
  let best = evaluate(s);
  if (best >= beta || ext >= MAX_STACK_EXT || !s.stack.length) return best;
  if (best > alpha) alpha = best;
  for (const a of sActions(s)) {
    if (!stackRelated(s, a)) continue;
    const c = sApply(s, a);
    const v = c.winner ? (c.winner === s.cur ? WIN - ply - 1 : -(WIN - ply - 1)) : -quiet(c, -beta, -alpha, ply + 1, ext + 1);
    if (v > best) best = v;
    if (v > alpha) alpha = v;
    if (alpha >= beta) break;
  }
  return best;
}
let LMR = true, LMR_AFTER = 3;
function search(s, depth, alpha, beta, ply, ctx, ext = 0) {
  if (depth === 0) return quiet(s, alpha, beta, ply, ext);
  if (++ctx.nodes > ctx.limit) throw ctx;
  const key = posKey(s), hit = TT.get(key);
  if (hit && hit.depth === depth && hit.ext === ext && hit.ply === ply) {
    if (hit.flag === 0 || (hit.flag === 1 && hit.v >= beta) || (hit.flag === -1 && hit.v <= alpha)) return hit.v;
  }
  const alpha0 = alpha;
  const acts = ordered(s, sActions(s));
  if (!acts.length) return 0;
  if (hit && hit.best !== undefined) { const i = acts.findIndex(a => actKey(a) === hit.best); if (i > 0) acts.unshift(acts.splice(i, 1)[0]); }
  // Killer move: the move that cut off a sibling line at this depth is tried first.
  const kill = ctx.killers && ctx.killers[ply];
  if (kill !== undefined) { const i = acts.findIndex(a => actKey(a) === kill); if (i > 1 || (i === 1 && !(hit && hit.best !== undefined))) acts.splice(hit && hit.best !== undefined ? 1 : 0, 0, acts.splice(i, 1)[0]); }
  let best = -Infinity, bestA = null, i = -1;
  for (const a of acts) {
    i++;
    const c = sApply(s, a);
    let v;
    const free = ext < MAX_STACK_EXT && stackRelated(s, a);
    const nd = free ? depth : depth - 1, ne = free ? ext + 1 : ext;
    // Late move reduction: a quiet move late in the order gets a look one shallower first, and is
    // searched properly only if that look says it could be the best so far.
    const reduce = LMR && nd >= 1 && i >= LMR_AFTER && !free && orderScore(s, a) === 0;
    const go = d => c.cur === s.cur ? search(c, d, alpha, beta, ply + 1, ctx, ne) : -search(c, d, -beta, -alpha, ply + 1, ctx, ne);
    if (c.winner) v = c.winner === s.cur ? WIN - ply - 1 : -(WIN - ply - 1);
    else if (reduce) { v = go(nd - 1); if (v > alpha) v = go(nd); }
    else v = go(nd);
    if (v > best) { best = v; bestA = a; }
    if (v > alpha) alpha = v;
    if (alpha >= beta) { (ctx.killers ||= [])[ply] = actKey(a); break; }
  }
  if (TT.size < 400000) TT.set(key, { depth, ext, ply, v: best, flag: best <= alpha0 ? -1 : best >= beta ? 1 : 0, best: bestA ? actKey(bestA) : undefined });
  return best;
}
const actKey = a => a.t === 'resolve' ? -1 : (a.t === 'move' ? 0 : 4096) + a.m.from * 64 + a.m.to;

// Iterative deepening within a node budget, so the bot plays the same on fast and slow computers;
// returns an action in the game's own format.
function chooseAction(G, level) {
  const cfg = AI_LEVELS[level] || AI_LEVELS.normal;
  const s = sFrom(G);
  const acts = ordered(s, sActions(s));
  if (!acts.length) return null;
  return pickFrom(rootSearch(s, acts, cfg), cfg);
}
// Iterative deepening over the given first moves; returns [action, score] best first.
// floor: a score another search already found, so moves that can't beat it are cut quickly.
function rootSearch(s, acts, cfg, floor = -Infinity) {
  const ctx = { nodes: 0, limit: Infinity };
  TT.clear();
  let results = acts.map(a => [a, 0]);
  for (let d = 1; d <= cfg.maxDepth; d++) {
    ctx.limit = d <= (cfg.minDepth || 2) ? Infinity : cfg.nodes; // always see at least the opponent's reply
    try {
      const round = [];
      let alpha = floor;
      for (const a of acts) {
        const c = sApply(s, a);
        let v;
        const free = stackRelated(s, a);
        const nd = free ? d : d - 1, ne = free ? 1 : 0;
        if (c.winner) v = c.winner === s.cur ? WIN : -WIN;
        // Search one below the best so far, so a move that truly ties the best gets its real score.
        // A pruned move only gets "at most lo", so it is marked -Infinity and never picked.
        else {
          const lo = alpha - 1;
          v = c.cur === s.cur ? search(c, nd, lo, Infinity, 1, ctx, ne) : -search(c, nd, -Infinity, -lo, 1, ctx, ne);
          if (v <= lo) v = -Infinity;
        }
        round.push([a, v]);
        if (v > alpha) alpha = v;
      }
      round.sort((x, y) => y[1] - x[1]);
      results = round;
      acts = round.map(x => x[0]);
    } catch (e) {
      if (e !== ctx) throw e;
      break; // out of nodes: keep the last finished depth
    }
  }
  return results;
}
// Picks from scored first moves (best first): the best, with ties broken at random, plus the level's noise.
function pickFrom(results, cfg) {
  chooseAction.lastScore = results[0][1];
  // Among moves tied for best, pick one at random (avoids shuffling the same piece back and forth).
  const ties = results.filter(r => r[1] === results[0][1]);
  let pick = ties[Math.floor(Math.random() * ties.length)][0];
  if (cfg.noise) {
    let bestNoisy = -Infinity;
    for (const [a, v] of results) {
      const nv = v + Math.random() * cfg.noise;
      if (nv > bestNoisy) { bestNoisy = nv; pick = a; }
    }
  }
  return toAction(pick);
}
// A search action as a game action: a move, a resolve, or a resolve followed by a move.
function toAction(pick) {
  if (pick.t === 'resolve') return { t: 'resolve' };
  const move = pick.m.promo ? { t: 'move', from: pick.m.from, to: pick.m.to, p: 'q' } : { t: 'move', from: pick.m.from, to: pick.m.to };
  return pick.t === 'resolve-move' ? { t: 'resolve', then: move } : move;
}

// ---------- Search worker ----------
// The page sends each worker some first moves (by actKey) and a floor score, and merges their scores.
if (typeof importScripts === 'function' && typeof document === 'undefined') {
  onmessage = e => {
    const { s, level, keys, floor, job } = e.data;
    const cfg = AI_LEVELS[level] || AI_LEVELS.normal;
    const mine = ordered(s, sActions(s)).filter(a => keys.includes(actKey(a)));
    const out = mine.length ? rootSearch(s, mine, cfg, floor).map(([a, v]) => [actKey(a), v]) : [];
    postMessage({ job, out });
  };
}
