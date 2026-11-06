// Stack Chess rules and game model, shared by the page and the game server.
// In the page this is a plain script, so these names are visible to the page's own script.
// The server imports it and reads the same functions from globalThis.StackRules.

// ---------- Chess rules ----------
const FILES = 'abcdefgh';
const GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
const LETTER = { k: 'K', q: 'Q', r: 'R', b: 'B', n: 'N', p: '' };
const PNAME = { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' };
const NAME = { w: 'White', b: 'Black' };
const other = c => (c === 'w' ? 'b' : 'w');
const rc = s => [s >> 3, s & 7];
const sq = (r, c) => r * 8 + c;
const on = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;
const sqName = s => FILES[s & 7] + (8 - (s >> 3));
const KN = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
const KG = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
const ROOK = [[-1,0],[1,0],[0,-1],[0,1]];
const BISH = [[-1,-1],[-1,1],[1,-1],[1,1]];

function initialState() {
  const b = Array(64).fill(null);
  const back = ['r','n','b','q','k','b','n','r'];
  let id = 0;
  for (let c = 0; c < 8; c++) {
    b[c] = { t: back[c], c: 'b', id: id++ };
    b[8 + c] = { t: 'p', c: 'b', id: id++ };
    b[48 + c] = { t: 'p', c: 'w', id: id++ };
    b[56 + c] = { t: back[c], c: 'w', id: id++ };
  }
  return { board: b, castle: { wK: true, wQ: true, bK: true, bQ: true }, ep: null };
}
const cloneState = st => ({ board: st.board.slice(), castle: { ...st.castle }, ep: st.ep ? { ...st.ep } : null });

function attacked(b, s, by) {
  const [r, c] = rc(s);
  const pr = by === 'w' ? r + 1 : r - 1;
  for (const dc of [-1, 1]) if (on(pr, c + dc)) { const p = b[sq(pr, c + dc)]; if (p && p.c === by && p.t === 'p') return true; }
  for (const [dr, dc] of KN) if (on(r + dr, c + dc)) { const p = b[sq(r + dr, c + dc)]; if (p && p.c === by && p.t === 'n') return true; }
  for (const [dr, dc] of KG) if (on(r + dr, c + dc)) { const p = b[sq(r + dr, c + dc)]; if (p && p.c === by && p.t === 'k') return true; }
  for (const [dirs, kinds] of [[ROOK, 'rq'], [BISH, 'bq']]) {
    for (const [dr, dc] of dirs) {
      let rr = r + dr, cc = c + dc;
      while (on(rr, cc)) {
        const p = b[sq(rr, cc)];
        if (p) { if (p.c === by && kinds.includes(p.t)) return true; break; }
        rr += dr; cc += dc;
      }
    }
  }
  return false;
}

// Pseudo-legal moves for the piece on `from` (own-king safety not checked here).
function pieceMoves(st, from) {
  const b = st.board, p = b[from];
  if (!p) return [];
  const [r, c] = rc(from), col = p.c, out = [];
  const add = (to, extra) => out.push({ from, to, pieceId: p.id, ...(extra || {}) });
  if (p.t === 'p') {
    const d = col === 'w' ? -1 : 1, start = col === 'w' ? 6 : 1, last = col === 'w' ? 0 : 7, r1 = r + d;
    if (on(r1, c) && !b[sq(r1, c)]) {
      add(sq(r1, c), r1 === last ? { promo: true } : null);
      if (r === start && !b[sq(r + 2 * d, c)]) add(sq(r + 2 * d, c), { flag: 'double' });
    }
    for (const dc of [-1, 1]) {
      if (!on(r1, c + dc)) continue;
      const t = sq(r1, c + dc), q = b[t];
      if (q && q.c !== col) add(t, r1 === last ? { promo: true } : null);
      else if (!q && st.ep && st.ep.sq === t && st.ep.color !== col) add(t, { flag: 'ep', capSq: st.ep.pawnSq, capId: st.ep.pawnId });
    }
  } else if (p.t === 'n' || p.t === 'k') {
    for (const [dr, dc] of (p.t === 'n' ? KN : KG)) {
      if (!on(r + dr, c + dc)) continue;
      const t = sq(r + dr, c + dc), q = b[t];
      if (!q || q.c !== col) add(t);
    }
    if (p.t === 'k') {
      const home = col === 'w' ? 60 : 4;
      if (from === home) {
        const rk = b[home + 3], rq = b[home - 4];
        if (st.castle[col + 'K'] && rk && rk.t === 'r' && rk.c === col && !b[home + 1] && !b[home + 2]) add(home + 2, { flag: 'castleK' });
        if (st.castle[col + 'Q'] && rq && rq.t === 'r' && rq.c === col && !b[home - 1] && !b[home - 2] && !b[home - 3]) add(home - 2, { flag: 'castleQ' });
      }
    }
  } else {
    const dirs = p.t === 'r' ? ROOK : p.t === 'b' ? BISH : ROOK.concat(BISH);
    for (const [dr, dc] of dirs) {
      let rr = r + dr, cc = c + dc;
      while (on(rr, cc)) {
        const t = sq(rr, cc), q = b[t];
        if (!q) add(t);
        else { if (q.c !== col) add(t); break; }
        rr += dr; cc += dc;
      }
    }
  }
  return out;
}

function applyMove(st, m) {
  const b = st.board, p = b[m.from];
  let captured = b[m.to];
  b[m.to] = p; b[m.from] = null;
  if (m.flag === 'ep' && b[m.capSq] && b[m.capSq].id === m.capId) { captured = captured || b[m.capSq]; b[m.capSq] = null; }
  if (m.flag === 'castleK') { b[m.from + 1] = b[m.from + 3]; b[m.from + 3] = null; }
  if (m.flag === 'castleQ') { b[m.from - 1] = b[m.from - 4]; b[m.from - 4] = null; }
  if (p.t === 'p' && (m.to >> 3 === 0 || m.to >> 3 === 7)) b[m.to] = { t: m.promoTo || 'q', c: p.c, id: p.id };
  if (p.t === 'k') { st.castle[p.c + 'K'] = false; st.castle[p.c + 'Q'] = false; }
  for (const [s, k] of [[63, 'wK'], [56, 'wQ'], [7, 'bK'], [0, 'bQ']]) if (m.from === s || m.to === s) st.castle[k] = false;
  st.ep = m.flag === 'double' ? { sq: (m.from + m.to) / 2, pawnSq: m.to, pawnId: p.id, color: p.c } : null;
  return captured;
}

const kingSq = (b, color) => b.findIndex(x => x && x.t === 'k' && x.c === color);

// No check rules: every move a piece can make is allowed, including moving into check.
function legalMoves(st, color) {
  const res = [];
  for (let s = 0; s < 64; s++) {
    const p = st.board[s];
    if (p && p.c === color) res.push(...pieceMoves(st, s));
  }
  return res;
}

// At resolution: same piece still on its square, and the move is still a legal chess move.
// For pieces, capturing and plain moving are the same move: it goes through whether or not
// something is there to take now, and takes whatever enemy piece is there when it lands.
// Pawns move and capture differently, so a push needs an empty square and a diagonal needs a target.
function stillValid(st, m) {
  const b = st.board, p = b[m.from];
  if (!p || p.id !== m.pieceId) return false;
  if (m.flag === 'castleK' || m.flag === 'castleQ') return pieceMoves(st, m.from).some(x => x.flag === m.flag);
  const q = b[m.to];
  if (q && q.c === p.c) return false;
  if (p.t === 'p') {
    if ((m.from & 7) === (m.to & 7)) return !q && (m.flag !== 'double' || !b[(m.from + m.to) / 2]);
    if (m.flag === 'ep') return !q && !!b[m.capSq] && b[m.capSq].id === m.capId;
    return !!q;
  }
  if (p.t === 'r' || p.t === 'b' || p.t === 'q') {
    const [r1, c1] = rc(m.from), [r2, c2] = rc(m.to);
    const dr = Math.sign(r2 - r1), dc = Math.sign(c2 - c1);
    for (let r = r1 + dr, c = c1 + dc; r !== r2 || c !== c2; r += dr, c += dc) if (b[sq(r, c)]) return false;
  }
  return true;
}

function moveLabel(st, m) {
  if (m.flag === 'castleK') return 'O-O';
  if (m.flag === 'castleQ') return 'O-O-O';
  const p = st.board[m.from];
  const cap = st.board[m.to] || m.flag === 'ep';
  let s = LETTER[p.t] + sqName(m.from) + (cap ? '×' : '–') + sqName(m.to);
  if (m.promoTo) s += '=' + m.promoTo.toUpperCase();
  return s;
}

// ---------- Game model ----------
// A game is driven by actions: {t:'move', from, to, p?} or {t:'resolve'}.
// Online, each action also carries c (the color acting) and by (that player: host or guest),
// and the server and every page replay the same action list through these rules.

// Time controls: base time per player and seconds added after each move.
const TIME_CONTROLS = { '1+1': [1, 1], '3+2': [3, 2], '5+3': [5, 3], '10+5': [10, 5] };
function timeControl(key) {
  const tc = TIME_CONTROLS[key];
  return tc ? { key, base: tc[0] * 60000, inc: tc[1] * 1000 } : null;
}

function freshGame(tc) {
  return {
    id: Math.random().toString(36).slice(2), // tells the clock a new game started
    st: initialState(), stack: [], phase: 'move', cur: 'w', log: [], result: null, trail: [], acts: [],
    clock: tc ? { w: tc.base, b: tc.base, inc: tc.inc, key: tc.key } : null
  };
}

// Legal moves for the player to act, minus pieces that already have a move on the stack.
function availableMoves(G) {
  if (G.phase !== 'move' && G.phase !== 'respond') return [];
  return legalMoves(G.st, G.cur).filter(m => !G.stack.some(e => e.pieceId === m.pieceId));
}

function declareInto(G, m) {
  const p = G.st.board[m.from];
  const entry = {
    ...m, player: G.cur, label: moveLabel(G.st, m), glyph: GLYPH[m.promoTo || p.t], pt: p.t,
    n: G.stack.length + 1, state: 'pending'
  };
  if (G.stack.length === 0) { G.trail = []; G.log.push({ sep: true }); }
  G.stack.push(entry);
  G.log.push({ player: G.cur, html: `${NAME[G.cur]} ${entry.n === 1 ? 'moves' : 'responds with'} <span class="m">${entry.label}</span>` });
  G.cur = other(G.cur);
  G.phase = 'respond';
}

// Resolves the stack one card at a time; yields between steps so it can be animated.
function* resolveGen(G) {
  const passer = G.cur;
  G.phase = 'resolving';
  G.log.push({ player: passer, html: `${NAME[passer]} lets it resolve` });
  const trail = [];
  yield 'short';
  for (let i = G.stack.length - 1; i >= 0; i--) {
    const e = G.stack[i];
    // The move of a captured piece just goes away, with no fizzle animation.
    if (!G.st.board.some(p => p && p.id === e.pieceId)) {
      e.state = 'gone';
      G.log.push({ player: e.player, html: `<span class="m">${e.label}</span> is gone with its piece` });
      continue;
    }
    e.state = 'resolving';
    yield 'long';
    if (stillValid(G.st, e)) {
      const cap = applyMove(G.st, e);
      e.state = 'done';
      trail.push({ from: e.from, to: e.to, ok: true });
      G.log.push({ player: e.player, html: `<span class="ok">✓</span> <span class="m">${e.label}</span> resolves` });
      if (cap && cap.t === 'k') {
        G.result = { winner: e.player, text: `${NAME[e.player]} captured the king` };
        G.log.push({ player: e.player, html: `<b>${NAME[e.player]} wins</b> by capturing the king` });
      }
    } else {
      e.state = 'fizzled';
      trail.push({ from: e.from, to: e.to, ok: false });
      G.log.push({ player: e.player, html: `<span class="bad">✗</span> <span class="m">${e.label}</span> fizzles` });
    }
    G.trail = trail.slice();
    yield 'short';
    if (G.result) break;
  }
  G.stack = [];
  if (G.result) { G.phase = 'over'; return; }
  G.phase = 'move';
  G.cur = passer;
  checkNormalTurnEnd(G);
}

// Games are won by capturing the king. Only a player with no possible move at all ends it in a draw.
function checkNormalTurnEnd(G) {
  if (legalMoves(G.st, G.cur).length) return;
  G.result = { winner: null, text: `${NAME[G.cur]} has no possible move. The game is drawn` };
  G.log.push({ player: G.cur, html: `<b>No possible move.</b> Draw` });
  G.phase = 'over';
}

// Checks an action against the rules and starts it. Returns a generator to run, or null if illegal.
function startAction(G, a) {
  if (!a || (a.c && a.c !== G.cur)) return null;
  // A player whose time is up loses.
  if (a.t === 'flag') {
    if (!G.clock || (G.phase !== 'move' && G.phase !== 'respond')) return null;
    const loser = G.cur, winner = other(loser);
    G.clock[loser] = 0;
    G.result = { winner, text: `${NAME[loser]} ran out of time. ${NAME[winner]} wins` };
    G.log.push({ player: winner, html: `<b>${NAME[loser]} ran out of time.</b> ${NAME[winner]} wins` });
    G.phase = 'over';
    G.acts.push({ t: 'flag' });
    return (function* () {})();
  }
  // Actions carry the actor's time left, so every copy of the game agrees on the clocks.
  const spend = () => {
    if (G.clock && typeof a.left === 'number') G.clock[G.cur] = Math.max(0, a.left) + (a.t === 'move' ? G.clock.inc : 0);
    const rec = { t: a.t };
    if (a.t === 'move') { rec.from = a.from; rec.to = a.to; if (a.p) rec.p = a.p; }
    if (typeof a.left === 'number') rec.left = a.left;
    G.acts.push(rec);
  };
  if (a.t === 'move') {
    const m = availableMoves(G).find(x => x.from === a.from && x.to === a.to);
    if (!m) return null;
    if (m.promo && !['q', 'r', 'b', 'n'].includes(a.p)) return null;
    spend();
    declareInto(G, m.promo ? { ...m, promoTo: a.p } : m);
    return (function* () {})();
  }
  if (a.t === 'resolve') {
    if (G.phase !== 'respond') return null;
    spend();
    return resolveGen(G);
  }
  return null;
}
const drain = gen => { for (const _ of gen) { /* run to the end */ } };
const sameAct = (a, b) => !!a && !!b && a.t === b.t && a.from === b.from && a.to === b.to && a.c === b.c && (a.p || '') === (b.p || '');

function replay(actions, seats, tc) {
  const G = freshGame(tc);
  for (const a of actions) {
    if (seats && seats[a.c] !== a.by) continue;
    const gen = startAction(G, a);
    if (gen) drain(gen);
  }
  return G;
}

globalThis.StackRules = {
  FILES, GLYPH, LETTER, PNAME, NAME, other, rc, sq, on, sqName, KN, KG, ROOK, BISH,
  initialState, cloneState, attacked, pieceMoves, applyMove, kingSq, legalMoves, stillValid, moveLabel,
  TIME_CONTROLS, timeControl, freshGame, availableMoves, declareInto, resolveGen, checkNormalTurnEnd,
  startAction, drain, sameAct, replay
};
