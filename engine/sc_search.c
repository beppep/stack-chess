// The computer opponent: a port of bot.js (alpha-beta with stack extensions, position table,
// killer moves, late move reductions, and the evaluate/threatMaterial scoring).
// It gives the same scores and visits the same nodes as bot.js at the same depth.
#include "sc.h"

#define INF (__builtin_inf())
static const int VAL[7] = {0, 100, 310, 320, 500, 900, 0};
// 0.9 ** k exactly as JavaScript computes it.
static const double P9[40] = {
  1.0000000000000000, 0.90000000000000002, 0.81000000000000005, 0.72900000000000009, 0.65610000000000013,
  0.59049000000000007, 0.53144100000000005, 0.47829690000000008, 0.43046721000000010, 0.38742048900000009,
  0.34867844010000010, 0.31381059609000006, 0.28242953648100011, 0.25418658283290008, 0.22876792454961009,
  0.20589113209464907, 0.18530201888518416, 0.16677181699666577, 0.15009463529699918, 0.13508517176729928,
  0.12157665459056935, 0.10941898913151242, 0.098477090218361180, 0.088629381196525053, 0.079766443076872556,
  0.071789798769185301, 0.064610818892266775, 0.058149737003040096, 0.052334763302736093, 0.047101286972462478,
  0.042391158275216237, 0.038152042447694615, 0.034336838202925150, 0.030903154382632636, 0.027812838944369374,
  0.025031555049932437, 0.022528399544939195, 0.020275559590445275, 0.018248003631400750, 0.016423203268260675};

static const int8_t KN[8][2] = {{-2,-1},{-2,1},{-1,-2},{-1,2},{1,-2},{1,2},{2,-1},{2,1}};
static const int8_t KG[8][2] = {{-1,-1},{-1,0},{-1,1},{0,-1},{0,1},{1,-1},{1,0},{1,1}};
static const int8_t QD[8][2] = {{-1,0},{1,0},{0,-1},{0,1},{-1,-1},{-1,1},{1,-1},{1,1}};

void sc_s_from_game(const Game *g, S *s) {
  s->st = g->st;
  s->n = g->n;
  for (int i = 0; i < g->n; i++) s->stack[i] = g->stack[i];
  s->cur = g->cur;
  s->winner = -1;
}

void sc_s_resolve(const S *s, S *out) {
  out->st = s->st;
  out->n = 0; out->cur = s->cur; out->winner = -1;
  for (int i = s->n - 1; i >= 0; i--) {
    const Move *e = &s->stack[i];
    if (!sc_still_valid(&out->st, e)) continue;
    int cap = sc_apply_move(&out->st, e);
    if (cap && PTYPE(cap) == KING) { out->winner = e->player; break; }
  }
}

static inline int on_stack(const S *s, int id) {
  for (int j = 0; j < s->n; j++) if (s->stack[j].id == id) return 1;
  return 0;
}

int sc_s_actions(const S *s, Act *out, S *resolved) {
  Move mv[MAX_MOVES];
  int n = sc_legal_moves(&s->st, s->cur, mv), k = 0;
  uint32_t stacked = 0;
  for (int j = 0; j < s->n; j++) stacked |= 1u << (s->stack[j].id & 31);
  for (int i = 0; i < n; i++) if (!(stacked >> (mv[i].id & 31) & 1)) { out[k].t = A_MOVE; out[k].m = mv[i]; k++; }
  if (s->n) {
    sc_s_resolve(s, resolved);
    if (resolved->winner >= 0) { out[k].t = A_RESOLVE; k++; }
    else {
      n = sc_legal_moves(&resolved->st, resolved->cur, mv);
      for (int i = 0; i < n; i++) { out[k].t = A_RESOLVE_MOVE; out[k].m = mv[i]; k++; }
    }
  }
  return k;
}

void sc_s_apply(const S *s, const Act *a, const S *resolved, S *out) {
  if (a->t == A_RESOLVE) { *out = *resolved; return; }
  const S *base = a->t == A_RESOLVE_MOVE ? resolved : s;
  out->st = base->st;
  out->n = base->n;
  for (int i = 0; i < base->n; i++) out->stack[i] = base->stack[i];
  Move m = a->m;
  if (m.promo) m.promo_to = QUEEN;
  m.player = s->cur;
  out->stack[out->n++] = m;
  out->cur = s->cur ^ 1;
  out->winner = -1;
}

int sc_order_score(const S *s, const Act *a, const S *resolved) {
  if (a->t == A_RESOLVE) return WIN;
  const uint8_t *b = a->t == A_RESOLVE_MOVE ? resolved->st.board : s->st.board;
  int target = b[a->m.to], mover = b[a->m.from];
  if (!target) return a->m.promo ? 800 : 0;
  if (PTYPE(target) == KING) return WIN;
  return VAL[PTYPE(target)] * 10 - VAL[PTYPE(mover)];
}

int sc_act_key(const Act *a) {
  if (a->t == A_RESOLVE) return -1;
  return (a->t == A_MOVE ? 0 : 4096) + a->m.from * 64 + a->m.to;
}

// Stable sort by order score, highest first (same as JS Array.prototype.sort, which is stable).
static void sort_acts(Act *acts, int *score, int n) {
  for (int i = 1; i < n; i++) {
    Act a = acts[i]; int sc = score[i], j = i - 1;
    while (j >= 0 && score[j] < sc) { acts[j + 1] = acts[j]; score[j + 1] = score[j]; j--; }
    acts[j + 1] = a; score[j + 1] = sc;
  }
}

// Order scores are never negative, and most actions score 0. Sorting only the positive ones and
// putting the zeros after them, in their original order, is the same stable sort.
int sc_ordered_actions(const S *s, Act *out, S *resolved) {
  Act all[MAX_ACTS];
  int n = sc_s_actions(s, all, resolved), score[MAX_ACTS], k = 0;
  for (int i = 0; i < n; i++) {
    int sc = sc_order_score(s, &all[i], resolved);
    if (sc > 0) { out[k] = all[i]; score[k++] = sc; }
  }
  sort_acts(out, score, k);
  for (int i = 0; i < n; i++) if (sc_order_score(s, &all[i], resolved) <= 0) out[k++] = all[i];
  return n;
}

// ---------- Evaluation ----------
int sc_king_rule = 2;     // two attackers on a king: 0 any two = half a lost game, 1 only two not attacked themselves, 2 only -300
double sc_frozen = 0.6;   // king 2 + frozen 0.6 won 199-92 against king 0 + frozen 0.9 over 300 games (2026-11-12)   // value kept by a piece with exactly one attacker that is not attacked itself
// Attack tables for the fast version below. Bit i of a mask is square i (a8 = 0, h1 = 63).
static uint64_t KN_ATT[64], KG_ATT[64], PAWN_ATT[2][64], RAY[8][64];
static int att_ready = 0;
static void att_init(void) {
  for (int sq = 0; sq < 64; sq++) {
    int r = sq >> 3, f = sq & 7;
    KN_ATT[sq] = KG_ATT[sq] = PAWN_ATT[0][sq] = PAWN_ATT[1][sq] = 0;
    for (int i = 0; i < 8; i++) {
      int rr = r + KN[i][0], cc = f + KN[i][1];
      if (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) KN_ATT[sq] |= 1ull << (rr * 8 + cc);
      rr = r + KG[i][0]; cc = f + KG[i][1];
      if (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) KG_ATT[sq] |= 1ull << (rr * 8 + cc);
      RAY[i][sq] = 0;
      for (rr = r + QD[i][0], cc = f + QD[i][1]; rr >= 0 && rr < 8 && cc >= 0 && cc < 8; rr += QD[i][0], cc += QD[i][1]) RAY[i][sq] |= 1ull << (rr * 8 + cc);
    }
    for (int col = 0; col < 2; col++) {
      int r1 = r + (col == WHITE ? -1 : 1);
      if (r1 < 0 || r1 > 7) continue;
      if (f > 0) PAWN_ATT[col][sq] |= 1ull << (r1 * 8 + f - 1);
      if (f < 7) PAWN_ATT[col][sq] |= 1ull << (r1 * 8 + f + 1);
    }
  }
  att_ready = 1;
}
// Directions 0 (up), 2 (left), 4 and 5 (up-left, up-right) go to lower squares: the nearest blocker
// is the highest bit. The others go to higher squares: the nearest blocker is the lowest bit.
static inline int ray_down(int d) { return d == 0 || d == 2 || d == 4 || d == 5; }

// White and Black piece masks of a board, eight squares at a time. A square's code is 0 or
// type (1..6) + 8 * colour, so a byte is non-zero exactly when its low three bits are.
static inline void board_masks(const uint8_t *b, uint64_t occ[2]) {
  occ[0] = occ[1] = 0;
  for (int row = 0; row < 8; row++) {
    uint64_t x = 0;
    __builtin_memcpy(&x, b + row * 8, 8);  // 8 squares, little-endian (x86 and WebAssembly)
    uint64_t t = x & 0x0707070707070707ull;
    uint64_t any = ((t + 0x7F7F7F7F7F7F7F7Full) & 0x8080808080808080ull) >> 7;  // 1 per non-empty square
    uint64_t blk = (x >> 3) & 0x0101010101010101ull;
    // Gather the low bit of each byte into one byte (square order within the row).
    occ[0] |= (((any & ~blk) * 0x0102040810204080ull) >> 56) << (row * 8);
    occ[1] |= (((any & blk) * 0x0102040810204080ull) >> 56) << (row * 8);
  }
}

// Same result as sc_threat_material_ref, bit for bit: the attack counts are integers and the final
// sum runs over the squares in the same order with the same operations.
double sc_threat_material(const Pos *p, int c) {
  if (!att_ready) att_init();
  const uint8_t *b = p->board;
  uint64_t occ[2], tg[64];
  uint8_t hits[64] = {0}, fresh[64] = {0};
  board_masks(b, occ);
  uint64_t all = occ[0] | occ[1];
  // One mask per piece type, then each type's attacks without asking every piece what it is.
  uint64_t tm[8] = {0};
  for (uint64_t m = all; m; m &= m - 1) { int sq = __builtin_ctzll(m); tm[PTYPE(b[sq])] |= 1ull << sq; }
#define NEAR(d, sq) do { uint64_t blk = RAY[d][sq] & all; if (blk) a |= 1ull << (ray_down(d) ? 63 - __builtin_clzll(blk) : __builtin_ctzll(blk)); } while (0)
#define RECORD(sq) do { a &= enemy; tg[sq] = a; for (; a; a &= a - 1) hits[__builtin_ctzll(a)]++; } while (0)
  for (int col = 0; col < 2; col++) {
    uint64_t own = occ[col], enemy = occ[col ^ 1], a;
    for (uint64_t m = tm[PAWN] & own; m; m &= m - 1) { int sq = __builtin_ctzll(m); a = PAWN_ATT[col][sq]; RECORD(sq); }
    for (uint64_t m = tm[KNIGHT] & own; m; m &= m - 1) { int sq = __builtin_ctzll(m); a = KN_ATT[sq]; RECORD(sq); }
    for (uint64_t m = tm[KING] & own; m; m &= m - 1) { int sq = __builtin_ctzll(m); a = KG_ATT[sq]; RECORD(sq); }
    for (uint64_t m = (tm[BISHOP] | tm[QUEEN]) & own; m; m &= m - 1) {
      int sq = __builtin_ctzll(m); a = 0;
      NEAR(4, sq); NEAR(5, sq); NEAR(6, sq); NEAR(7, sq);
      if (b[sq] == PCODE(QUEEN, col)) { NEAR(0, sq); NEAR(1, sq); NEAR(2, sq); NEAR(3, sq); }
      RECORD(sq);
    }
    for (uint64_t m = tm[ROOK] & own; m; m &= m - 1) { int sq = __builtin_ctzll(m); a = 0; NEAR(0, sq); NEAR(1, sq); NEAR(2, sq); NEAR(3, sq); RECORD(sq); }
  }
#undef NEAR
#undef RECORD
  for (uint64_t m = all; m; m &= m - 1) {
    int sq = __builtin_ctzll(m);
    if (!hits[sq]) for (uint64_t a = tg[sq]; a; a &= a - 1) fresh[__builtin_ctzll(a)]++;
  }
  double score = 0;
  for (uint64_t m = all; m; m &= m - 1) {  // squares in increasing order, as the original
    int sq = __builtin_ctzll(m), pc = b[sq];
    int sign = PCOLOR(pc) == c ? 1 : -1;
    if (PTYPE(pc) == KING) {
      score -= sign * 10 * hits[sq];
      if ((sc_king_rule == 1 ? fresh[sq] : hits[sq]) >= 2) score -= sign * (sc_king_rule == 2 ? 300 : WIN / 2);
    } else score += (double)(sign * VAL[PTYPE(pc)]) * (fresh[sq] == 1 ? sc_frozen : P9[fresh[sq]]);
  }
  return score;
}

// The original square-by-square version, kept to test the fast one against.
double sc_threat_material_ref(const Pos *p, int c) {
  const uint8_t *b = p->board;
  int hits[64], fresh[64], pairs[1024], n = 0;
  for (int i = 0; i < 64; i++) { hits[i] = 0; fresh[i] = 0; }
#define HIT(from, to) do { hits[to]++; pairs[n++] = (from); pairs[n++] = (to); } while (0)
  for (int sq = 0; sq < 64; sq++) {
    int pc = b[sq];
    if (!pc) continue;
    int r = sq >> 3, f = sq & 7, col = PCOLOR(pc), t = PTYPE(pc);
    if (t == PAWN) {
      int r1 = r + (col == WHITE ? -1 : 1);
      if (r1 < 0 || r1 > 7) continue;
      if (f > 0) { int q = b[r1 * 8 + f - 1]; if (q && PCOLOR(q) != col) HIT(sq, r1 * 8 + f - 1); }
      if (f < 7) { int q = b[r1 * 8 + f + 1]; if (q && PCOLOR(q) != col) HIT(sq, r1 * 8 + f + 1); }
    } else if (t == KNIGHT || t == KING) {
      const int8_t (*dirs)[2] = t == KNIGHT ? KN : KG;
      for (int i = 0; i < 8; i++) {
        int rr = r + dirs[i][0], cc = f + dirs[i][1];
        if (rr < 0 || rr > 7 || cc < 0 || cc > 7) continue;
        int q = b[rr * 8 + cc];
        if (q && PCOLOR(q) != col) HIT(sq, rr * 8 + cc);
      }
    } else {
      int d0 = t == BISHOP ? 4 : 0, d1 = t == ROOK ? 4 : 8;
      for (int i = d0; i < d1; i++) {
        int dr = QD[i][0], dc = QD[i][1], rr = r + dr, cc = f + dc;
        while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) {
          int q = b[rr * 8 + cc];
          if (q) { if (PCOLOR(q) != col) HIT(sq, rr * 8 + cc); break; }
          rr += dr; cc += dc;
        }
      }
    }
  }
#undef HIT
  for (int i = 0; i < n; i += 2) if (!hits[pairs[i]]) fresh[pairs[i + 1]]++;
  double score = 0;
  for (int sq = 0; sq < 64; sq++) {
    int pc = b[sq];
    if (!pc) continue;
    int sign = PCOLOR(pc) == c ? 1 : -1;
    if (PTYPE(pc) == KING) {
      score -= sign * 10 * hits[sq];
      if ((sc_king_rule == 1 ? fresh[sq] : hits[sq]) >= 2) score -= sign * (sc_king_rule == 2 ? 300 : WIN / 2);
    } else score += (double)(sign * VAL[PTYPE(pc)]) * (fresh[sq] == 1 ? sc_frozen : P9[fresh[sq]]);
  }
  return score;
}

int sc_saved_rule = 1;  // 1 won 68% against 0 over 300 games (2026-11-12)

// Is the piece of colour c on sq attacked by an enemy piece that has no move on the stack yet?
static int free_attacker(const S *s, int sq, int c) {
  const Pos *p = &s->st;
  int r = sq >> 3, f = sq & 7, pr = c == WHITE ? r - 1 : r + 1;
#define FREE(q, i) ((q) && PCOLOR(q) != c && !on_stack(s, p->id[i]))
  if (pr >= 0 && pr < 8) for (int df = -1; df <= 1; df += 2) { int ff = f + df; if (ff >= 0 && ff < 8) { int i = pr * 8 + ff, q = p->board[i]; if (PTYPE(q) == PAWN && FREE(q, i)) return 1; } }
  for (int k = 0; k < 8; k++) { int rr = r + KN[k][0], ff = f + KN[k][1]; if (rr >= 0 && rr < 8 && ff >= 0 && ff < 8) { int i = rr * 8 + ff, q = p->board[i]; if (PTYPE(q) == KNIGHT && FREE(q, i)) return 1; } }
  for (int k = 0; k < 8; k++) { int rr = r + KG[k][0], ff = f + KG[k][1]; if (rr >= 0 && rr < 8 && ff >= 0 && ff < 8) { int i = rr * 8 + ff, q = p->board[i]; if (PTYPE(q) == KING && FREE(q, i)) return 1; } }
  for (int k = 0; k < 8; k++) {
    for (int rr = r + QD[k][0], ff = f + QD[k][1]; rr >= 0 && rr < 8 && ff >= 0 && ff < 8; rr += QD[k][0], ff += QD[k][1]) {
      int i = rr * 8 + ff, q = p->board[i];
      if (!q) continue;
      int t = PTYPE(q);
      if ((t == QUEEN || (k < 4 ? t == ROOK : t == BISHOP)) && FREE(q, i)) return 1;
      break;
    }
  }
#undef FREE
  return 0;
}

double sc_evaluate(const S *s) {
  if (!s->n) return sc_threat_material(&s->st, s->cur);
  S t;
  sc_s_resolve(s, &t);
  if (t.winner == s->cur) return WIN;
  if (!att_ready) att_init();
  uint64_t occ[2];
  uint32_t alive = 0, stacked = 0;
  board_masks(t.st.board, occ);
  for (uint64_t m = occ[0] | occ[1]; m; m &= m - 1) alive |= 1u << (t.st.id[__builtin_ctzll(m)] & 31);
  for (int j = 0; j < s->n; j++) stacked |= 1u << (s->stack[j].id & 31);
  board_masks(s->st.board, occ);
  int saved = 0, king_saved = 0;
  Move tmp[MAX_MOVES];
  for (uint64_t m = occ[s->cur]; m; m &= m - 1) {
    int sq = __builtin_ctzll(m), pc = s->st.board[sq];
    int id = s->st.id[sq];
    if (((alive | stacked) >> (id & 31) & 1) || !sc_piece_moves(&s->st, sq, tmp)) continue;
    if (sc_saved_rule == 2 || (sc_saved_rule == 1 && free_attacker(s, sq, s->cur))) continue;
    if (PTYPE(pc) == KING) king_saved = 1;
    else if (VAL[PTYPE(pc)] > saved) saved = VAL[PTYPE(pc)];
  }
  if (t.winner >= 0) return king_saved ? sc_threat_material(&t.st, s->cur) : -WIN;
  return sc_threat_material(&t.st, s->cur) + saved;
}

// ---------- Search ----------
#define MAX_STACK_EXT 6
int sc_max_ext = MAX_STACK_EXT;  // 3 scored 44%, 1 about 39% against 6 at equal nodes (2026-11-13); free stack replies inside the search (quiet() at the end keeps MAX_STACK_EXT)
#define LMR_AFTER 3
int sc_lmr = 1;
int sc_pvs = 0;  // 2 (also at the root) scored 48.5% against 0 over 100 games at equal nodes (2026-11-13)
#define PVS_EPS 1e-6

static int stack_related(const S *s, const Act *a) {
  if (a->t != A_MOVE || !s->n) return 0;
  int target = s->st.board[a->m.to];
  if (target && PCOLOR(target) != s->cur && on_stack(s, s->st.id[a->m.to])) return 1;
  for (int j = 0; j < s->n; j++) if (s->stack[j].player != s->cur && s->stack[j].to == a->m.from) return 1;
  return 0;
}

// End of the search: before the score counts, the side to act may still make its free replies
// (capture a piece whose move is on the stack, or move a piece a stack move aims at). Letting the
// stack resolve as it is (the score) is always one of the options. Same as quiet() in bot.js.
static double quiet(const S *s, double alpha, double beta, int ply, int ext) {
  double best = sc_evaluate(s);
  if (best >= beta || ext >= MAX_STACK_EXT || !s->n) return best;
  if (best > alpha) alpha = best;
  // Only plain moves can be stack related, so the resolve actions of sActions() are skipped here.
  // Stack related moves: capturing an enemy piece that has a move on the stack (squares in hit),
  // or any move of a piece an enemy stack move aims at (squares in aimed). Generated piece by
  // piece in square order, so they come in the same order as the full move list.
  uint32_t stacked = 0;
  uint64_t aimed = 0, hit = 0, occ[2];
  for (int j = 0; j < s->n; j++) {
    stacked |= 1u << (s->stack[j].id & 31);
    if (s->stack[j].player != s->cur) aimed |= 1ull << s->stack[j].to;
  }
  board_masks(s->st.board, occ);
  for (uint64_t m = occ[s->cur ^ 1]; m; m &= m - 1) { int sq = __builtin_ctzll(m); if (stacked >> (s->st.id[sq] & 31) & 1) hit |= 1ull << sq; }
  aimed &= occ[s->cur];
  if (!hit && !aimed) return best;
  Move mv[64];
  Act a; S c;
  a.t = A_MOVE;
  for (uint64_t m = occ[s->cur]; m; m &= m - 1) {
   int sq = __builtin_ctzll(m);
   if (stacked >> (s->st.id[sq] & 31) & 1) continue;
   int all_count = aimed >> sq & 1;
   int n = sc_piece_moves(&s->st, sq, mv);
   for (int i = 0; i < n; i++) {
    if (!all_count && !(hit >> mv[i].to & 1)) continue;
    a.m = mv[i];
    sc_s_apply(s, &a, 0, &c);
    double v = c.winner >= 0 ? (c.winner == s->cur ? WIN - ply - 1 : -(WIN - ply - 1)) : -quiet(&c, -beta, -alpha, ply + 1, ext + 1);
    if (v > best) best = v;
    if (v > alpha) alpha = v;
    if (alpha >= beta) return best;
   }
  }
  return best;
}

// Zobrist numbers, the same xorshift sequence as bot.js.
static int32_t ZOB[2 * 32 * 8 * 64];
static int zob_ready = 0;
static void zob_init(void) {
  uint32_t x = 0x2545F491u;
  for (int i = 0; i < 2 * 32 * 8 * 64; i++) { x ^= x << 13; x ^= x >> 17; x ^= x << 5; ZOB[i] = (int32_t)x; }
  zob_ready = 1;
}
static inline uint32_t imul(uint32_t a, uint32_t b) { return a * b; }
static int64_t pos_key(const S *s) {
  const int half = 32 * 8 * 64;
  uint32_t h1 = s->cur == WHITE ? 1 : 2, h2 = 7;
  for (int i = 0; i < 64; i++) {
    int pc = s->st.board[i];
    if (!pc) continue;
    int k = (((s->st.id[i] & 31) * 8 + PTYPE(pc) - 1) << 6) + i;
    h1 ^= (uint32_t)ZOB[k]; h2 ^= (uint32_t)ZOB[half + k];
  }
  uint32_t cs = s->st.castle; // bits wK 1, wQ 2, bK 4, bQ 8, as in bot.js
  uint32_t ep = s->st.ep_sq >= 0 ? (uint32_t)(s->st.ep_sq + 1) : 0;
  h1 = imul(h1 ^ (cs | (ep << 4)), 0x9E3779B1u);
  for (int j = 0; j < s->n; j++) {
    const Move *e = &s->stack[j];
    uint32_t x = e->from | (e->to << 6) | ((e->id & 31) << 12) | ((e->player == WHITE ? 1u : 0u) << 17) | ((e->promo_to ? 1u : 0u) << 18);
    uint32_t o1 = h1, o2 = h2;
    h1 = imul(o1 ^ x, 0x85EBCA6Bu) ^ (o1 >> 15);
    h2 = imul(o2 ^ x, 0xC2B2AE35u) ^ (o2 >> 13);
  }
  return (int64_t)(int32_t)h1 * 2097152 + (int64_t)(h2 & 2097151);
}

// Position table: open addressing with a generation stamp, so clearing is instant.
// Like the JS Map, it holds at most TT_MAX positions and stops storing when full.
#define TT_BITS 20
#define TT_SIZE (1 << TT_BITS)
#define TT_MAX 400000
typedef struct { int64_t key; double v; uint32_t gen; int16_t best; int8_t depth, ext, ply, flag; } TTE;
static TTE TT[TT_SIZE];
static uint32_t tt_gen = 0;
static int tt_count = 0;
static void tt_clear(void) { tt_gen++; tt_count = 0; }
static inline uint32_t tt_slot(int64_t key) { uint64_t k = (uint64_t)key * 0x9E3779B97F4A7C15ull; return (uint32_t)(k >> (64 - TT_BITS)); }
static TTE *tt_find(int64_t key) {
  for (uint32_t i = tt_slot(key);; i = (i + 1) & (TT_SIZE - 1)) {
    TTE *e = &TT[i];
    if (e->gen != tt_gen) return 0;
    if (e->key == key) return e;
  }
}
static void tt_store(int64_t key, int depth, int ext, int ply, double v, int flag, int best) {
  if (tt_count >= TT_MAX) return;
  uint32_t i = tt_slot(key);
  for (;; i = (i + 1) & (TT_SIZE - 1)) {
    if (TT[i].gen != tt_gen) { tt_count++; break; }
    if (TT[i].key == key) break;
  }
  TTE *e = &TT[i];
  e->key = key; e->gen = tt_gen; e->v = v; e->depth = depth; e->ext = ext; e->ply = ply; e->flag = flag; e->best = best;
}

#define MAX_PLY 128
#define NO_KILLER 100000
typedef struct { double nodes, limit; int abort; int killers[MAX_PLY]; } Ctx;

static void move_to(Act *acts, int from, int to) {  // acts.splice(to, 0, acts.splice(from, 1)[0])
  Act a = acts[from];
  if (from > to) for (int j = from; j > to; j--) acts[j] = acts[j - 1];
  else for (int j = from; j < to; j++) acts[j] = acts[j + 1];
  acts[to] = a;
}

static double search(const S *s, int depth, double alpha, double beta, int ply, Ctx *ctx, int ext) {
  if (depth == 0) return quiet(s, alpha, beta, ply, ext);
  if (++ctx->nodes > ctx->limit) { ctx->abort = 1; return 0; }
  int64_t key = pos_key(s);
  TTE *hit = tt_find(key);
  if (hit && hit->depth == depth && hit->ext == ext && hit->ply == ply) {
    if (hit->flag == 0 || (hit->flag == 1 && hit->v >= beta) || (hit->flag == -1 && hit->v <= alpha)) return hit->v;
  }
  double alpha0 = alpha;
  Act acts[MAX_ACTS];
  S r;
  int n = sc_ordered_actions(s, acts, &r);
  if (!n) return 0;
  if (hit) {
    for (int i = 0; i < n; i++) if (sc_act_key(&acts[i]) == hit->best) { if (i > 0) move_to(acts, i, 0); break; }
  }
  int kill = ply < MAX_PLY ? ctx->killers[ply] : NO_KILLER;
  if (kill != NO_KILLER) {
    for (int i = 0; i < n; i++) if (sc_act_key(&acts[i]) == kill) {
      if (i > 1 || (i == 1 && !hit)) move_to(acts, i, hit ? 1 : 0);
      break;
    }
  }
  double best = -INF;
  int best_key = 0;
  S c;
  for (int i = 0; i < n; i++) {
    const Act *a = &acts[i];
    sc_s_apply(s, a, &r, &c);
    double v;
    int fr = ext < sc_max_ext && stack_related(s, a);
    int nd = fr ? depth : depth - 1, ne = fr ? ext + 1 : ext;
    int reduce = sc_lmr && nd >= 1 && i >= LMR_AFTER && !fr && sc_order_score(s, a, &r) == 0;
    if (c.winner >= 0) v = c.winner == s->cur ? WIN - ply - 1 : -(WIN - ply - 1);
    else {
      int same = c.cur == s->cur;
      int d = reduce ? nd - 1 : nd;
      // Principal variation search: after the first action, only ask "is this better than alpha?"
      // with a zero-width window, and search again with the full window when it is.
      double hi = sc_pvs && i > 0 ? alpha + PVS_EPS : beta;
      if (hi > beta) hi = beta;
      v = same ? search(&c, d, alpha, hi, ply + 1, ctx, ne) : -search(&c, d, -hi, -alpha, ply + 1, ctx, ne);
      if (ctx->abort) return 0;
      if (reduce && v > alpha) {
        v = same ? search(&c, nd, alpha, hi, ply + 1, ctx, ne) : -search(&c, nd, -hi, -alpha, ply + 1, ctx, ne);
        if (ctx->abort) return 0;
      }
      if (hi < beta && v > alpha) {
        v = same ? search(&c, nd, alpha, beta, ply + 1, ctx, ne) : -search(&c, nd, -beta, -alpha, ply + 1, ctx, ne);
        if (ctx->abort) return 0;
      }
    }
    if (v > best) { best = v; best_key = sc_act_key(a); }
    if (v > alpha) alpha = v;
    if (alpha >= beta) { if (ply < MAX_PLY) ctx->killers[ply] = sc_act_key(a); break; }
  }
  tt_store(key, depth, ext, ply, best, best <= alpha0 ? -1 : best >= beta ? 1 : 0, best_key);
  return best;
}

int sc_root_search(const S *s, const SearchCfg *cfg, RootResult *out, double *nodes_out) {
  if (!zob_ready) zob_init();
  static Ctx ctx;
  ctx.nodes = 0; ctx.abort = 0;
  for (int i = 0; i < MAX_PLY; i++) ctx.killers[i] = NO_KILLER;
  tt_clear();
  Act acts[MAX_ACTS];
  S r, c;
  int n = sc_ordered_actions(s, acts, &r);
  for (int i = 0; i < n; i++) { out[i].a = acts[i]; out[i].v = 0; }
  RootResult round[MAX_ACTS];
  int min_depth = cfg->min_depth ? cfg->min_depth : 2;
  for (int d = 1; d <= cfg->max_depth; d++) {
    ctx.limit = d <= min_depth ? INF : cfg->node_limit;
    double alpha = -INF;
    for (int i = 0; i < n; i++) {
      const Act *a = &acts[i];
      sc_s_apply(s, a, &r, &c);
      double v;
      int fr = stack_related(s, a);
      int nd = fr ? d : d - 1, ne = fr ? 1 : 0;
      if (c.winner >= 0) v = c.winner == s->cur ? WIN : -WIN;
      else {
        double lo = alpha - 1;
        if (sc_pvs >= 2 && i > 0) {
          // Only the best action matters: first ask whether this one beats it at all.
          v = c.cur == s->cur ? search(&c, nd, alpha, alpha + PVS_EPS, 1, &ctx, ne) : -search(&c, nd, -alpha - PVS_EPS, -alpha, 1, &ctx, ne);
          if (ctx.abort) break;
          if (v <= alpha) v = -INF;
          else {
            v = c.cur == s->cur ? search(&c, nd, alpha, INF, 1, &ctx, ne) : -search(&c, nd, -INF, -alpha, 1, &ctx, ne);
            if (ctx.abort) break;
          }
        } else {
        v = c.cur == s->cur ? search(&c, nd, lo, INF, 1, &ctx, ne) : -search(&c, nd, -INF, -lo, 1, &ctx, ne);
        if (ctx.abort) break;
        if (v <= lo) v = -INF;
        }
      }
      round[i].a = *a; round[i].v = v;
      if (v > alpha) alpha = v;
    }
    if (ctx.abort) break;  // out of nodes: keep the last finished depth
    // Stable sort, best first. Two -Infinity scores count as equal.
    for (int i = 1; i < n; i++) {
      RootResult x = round[i]; int j = i - 1;
      while (j >= 0 && round[j].v < x.v) { round[j + 1] = round[j]; j--; }
      round[j + 1] = x;
    }
    for (int i = 0; i < n; i++) { out[i] = round[i]; acts[i] = round[i].a; }
  }
  if (nodes_out) *nodes_out = ctx.nodes;
  return n;
}
