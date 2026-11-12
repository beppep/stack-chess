// Stack Chess rules: a numbers-only port of rules.js. rules.js is the source of truth;
// move generation order matches it exactly, because the bot's move ordering depends on it.
#include "sc.h"

static const int8_t KN[8][2] = {{-2,-1},{-2,1},{-1,-2},{-1,2},{1,-2},{1,2},{2,-1},{2,1}};
static const int8_t KG[8][2] = {{-1,-1},{-1,0},{-1,1},{0,-1},{0,1},{1,-1},{1,0},{1,1}};
// Queen directions: rook directions then bishop directions (ROOK.concat(BISH)).
static const int8_t QD[8][2] = {{-1,0},{1,0},{0,-1},{0,1},{-1,-1},{-1,1},{1,-1},{1,1}};

static inline int on(int r, int c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }

void sc_init_pos(Pos *p) {
  static const uint8_t back[8] = {ROOK, KNIGHT, BISHOP, QUEEN, KING, BISHOP, KNIGHT, ROOK};
  for (int i = 0; i < 64; i++) { p->board[i] = 0; p->id[i] = 0; }
  int id = 0;
  for (int c = 0; c < 8; c++) {
    p->board[c] = PCODE(back[c], BLACK); p->id[c] = id++;
    p->board[8 + c] = PCODE(PAWN, BLACK); p->id[8 + c] = id++;
    p->board[48 + c] = PCODE(PAWN, WHITE); p->id[48 + c] = id++;
    p->board[56 + c] = PCODE(back[c], WHITE); p->id[56 + c] = id++;
  }
  p->castle = C_WK | C_WQ | C_BK | C_BQ;
  p->ep_sq = -1; p->ep_pawn_sq = 0; p->ep_pawn_id = 0; p->ep_color = 0;
}

static inline void add(Move *out, int *n, int from, int to, int id, int flag, int promo) {
  Move *m = &out[(*n)++];
  m->from = from; m->to = to; m->id = id; m->flag = flag; m->promo = promo;
  m->promo_to = 0; m->cap_sq = 0; m->cap_id = 0; m->player = 0;
}

int sc_piece_moves(const Pos *p, int from, Move *out) {
  const uint8_t *b = p->board;
  int pc = b[from], n = 0;
  if (!pc) return 0;
  int r = from >> 3, c = from & 7, col = PCOLOR(pc), t = PTYPE(pc), id = p->id[from];
  if (t == PAWN) {
    int d = col == WHITE ? -1 : 1, start = col == WHITE ? 6 : 1, last = col == WHITE ? 0 : 7, r1 = r + d;
    if (on(r1, c) && !b[r1 * 8 + c]) {
      add(out, &n, from, r1 * 8 + c, id, F_NONE, r1 == last);
      if (r == start && !b[(r + 2 * d) * 8 + c]) add(out, &n, from, (r + 2 * d) * 8 + c, id, F_DOUBLE, 0);
    }
    for (int dc = -1; dc <= 1; dc += 2) {
      if (!on(r1, c + dc)) continue;
      int to = r1 * 8 + c + dc, q = b[to];
      if (q && PCOLOR(q) != col) add(out, &n, from, to, id, F_NONE, r1 == last);
      else if (!q && p->ep_sq == to && p->ep_color != col) {
        add(out, &n, from, to, id, F_EP, 0);
        out[n - 1].cap_sq = p->ep_pawn_sq; out[n - 1].cap_id = p->ep_pawn_id;
      }
    }
  } else if (t == KNIGHT || t == KING) {
    const int8_t (*dirs)[2] = t == KNIGHT ? KN : KG;
    for (int i = 0; i < 8; i++) {
      int rr = r + dirs[i][0], cc = c + dirs[i][1];
      if (!on(rr, cc)) continue;
      int to = rr * 8 + cc, q = b[to];
      if (!q || PCOLOR(q) != col) add(out, &n, from, to, id, F_NONE, 0);
    }
    if (t == KING) {
      int home = col == WHITE ? 60 : 4;
      if (from == home) {
        int rk = b[home + 3], rq = b[home - 4];
        int kbit = col == WHITE ? C_WK : C_BK, qbit = col == WHITE ? C_WQ : C_BQ;
        if ((p->castle & kbit) && rk == PCODE(ROOK, col) && !b[home + 1] && !b[home + 2]) add(out, &n, from, home + 2, id, F_CASTLE_K, 0);
        if ((p->castle & qbit) && rq == PCODE(ROOK, col) && !b[home - 1] && !b[home - 2] && !b[home - 3]) add(out, &n, from, home - 2, id, F_CASTLE_Q, 0);
      }
    }
  } else {
    int d0 = t == BISHOP ? 4 : 0, d1 = t == ROOK ? 4 : 8;
    for (int i = d0; i < d1; i++) {
      int dr = QD[i][0], dc = QD[i][1], rr = r + dr, cc = c + dc;
      while (on(rr, cc)) {
        int to = rr * 8 + cc, q = b[to];
        if (!q) add(out, &n, from, to, id, F_NONE, 0);
        else { if (PCOLOR(q) != col) add(out, &n, from, to, id, F_NONE, 0); break; }
        rr += dr; cc += dc;
      }
    }
  }
  return n;
}

int sc_legal_moves(const Pos *p, int color, Move *out) {
  int n = 0;
  for (int s = 0; s < 64; s++) if (p->board[s] && PCOLOR(p->board[s]) == color) n += sc_piece_moves(p, s, out + n);
  return n;
}

static inline void clear_rights_at(Pos *p, int s) {
  if (s == 63) p->castle &= ~C_WK;
  else if (s == 56) p->castle &= ~C_WQ;
  else if (s == 7) p->castle &= ~C_BK;
  else if (s == 0) p->castle &= ~C_BQ;
}

int sc_apply_move(Pos *p, const Move *m) {
  uint8_t *b = p->board, *id = p->id;
  int pc = b[m->from], pid = id[m->from];
  int captured = b[m->to];
  b[m->to] = pc; id[m->to] = pid; b[m->from] = 0; id[m->from] = 0;
  if (m->flag == F_EP && b[m->cap_sq] && id[m->cap_sq] == m->cap_id) {
    if (!captured) captured = b[m->cap_sq];
    b[m->cap_sq] = 0; id[m->cap_sq] = 0;
  }
  if (m->flag == F_CASTLE_K) { b[m->from + 1] = b[m->from + 3]; id[m->from + 1] = id[m->from + 3]; b[m->from + 3] = 0; id[m->from + 3] = 0; }
  if (m->flag == F_CASTLE_Q) { b[m->from - 1] = b[m->from - 4]; id[m->from - 1] = id[m->from - 4]; b[m->from - 4] = 0; id[m->from - 4] = 0; }
  int t = PTYPE(pc), col = PCOLOR(pc);
  if (t == PAWN && ((m->to >> 3) == 0 || (m->to >> 3) == 7)) b[m->to] = PCODE(m->promo_to ? m->promo_to : QUEEN, col);
  if (t == KING) p->castle &= col == WHITE ? ~(C_WK | C_WQ) : ~(C_BK | C_BQ);
  clear_rights_at(p, m->from);
  clear_rights_at(p, m->to);
  if (m->flag == F_DOUBLE) {
    p->ep_sq = (m->from + m->to) / 2; p->ep_pawn_sq = m->to; p->ep_pawn_id = pid; p->ep_color = col;
  } else p->ep_sq = -1;
  return captured;
}

int sc_still_valid(const Pos *p, const Move *m) {
  const uint8_t *b = p->board;
  int pc = b[m->from];
  if (!pc || p->id[m->from] != m->id) return 0;
  if (m->flag == F_CASTLE_K || m->flag == F_CASTLE_Q) {
    Move tmp[MAX_MOVES];
    int n = sc_piece_moves(p, m->from, tmp);
    for (int i = 0; i < n; i++) if (tmp[i].flag == m->flag) return 1;
    return 0;
  }
  int q = b[m->to], t = PTYPE(pc);
  if (q && PCOLOR(q) == PCOLOR(pc)) return 0;
  if (t == PAWN) {
    if ((m->from & 7) == (m->to & 7)) return !q && (m->flag != F_DOUBLE || !b[(m->from + m->to) / 2]);
    if (m->flag == F_EP) return !q && b[m->cap_sq] && p->id[m->cap_sq] == m->cap_id;
    return q != 0;
  }
  if (t == ROOK || t == BISHOP || t == QUEEN) {
    int r1 = m->from >> 3, c1 = m->from & 7, r2 = m->to >> 3, c2 = m->to & 7;
    int dr = (r2 > r1) - (r2 < r1), dc = (c2 > c1) - (c2 < c1);
    for (int r = r1 + dr, c = c1 + dc; r != r2 || c != c2; r += dr, c += dc) if (b[r * 8 + c]) return 0;
  }
  return 1;
}

// ---------- Game model ----------
void sc_new_game(Game *g) {
  sc_init_pos(&g->st);
  g->n = 0; g->cur = WHITE; g->phase = PH_MOVE; g->result = R_NONE;
}

int sc_available_moves(const Game *g, Move *out) {
  if (g->phase != PH_MOVE && g->phase != PH_RESPOND) return 0;
  Move all[MAX_MOVES];
  int n = sc_legal_moves(&g->st, g->cur, all), k = 0;
  for (int i = 0; i < n; i++) {
    int used = 0;
    for (int j = 0; j < g->n; j++) if (g->stack[j].id == all[i].id) { used = 1; break; }
    if (!used) out[k++] = all[i];
  }
  return k;
}

int sc_game_move(Game *g, int from, int to, int promo) {
  Move av[MAX_MOVES];
  int n = sc_available_moves(g, av);
  for (int i = 0; i < n; i++) {
    if (av[i].from != from || av[i].to != to) continue;
    Move m = av[i];
    if (m.promo) {
      if (promo != QUEEN && promo != ROOK && promo != BISHOP && promo != KNIGHT) return 0;
      m.promo_to = promo;
    }
    m.player = g->cur;
    g->stack[g->n++] = m;
    g->cur ^= 1;
    g->phase = PH_RESPOND;
    return 1;
  }
  return 0;
}

int sc_game_resolve(Game *g) {
  if (g->phase != PH_RESPOND) return 0;
  int passer = g->cur;
  for (int i = g->n - 1; i >= 0; i--) {
    const Move *e = &g->stack[i];
    if (!sc_still_valid(&g->st, e)) continue;  // also covers "gone with its piece"
    int cap = sc_apply_move(&g->st, e);
    if (cap && PTYPE(cap) == KING) { g->result = e->player; break; }
  }
  g->n = 0;
  if (g->result != R_NONE) { g->phase = PH_OVER; return 1; }
  g->phase = PH_MOVE;
  g->cur = passer;
  Move tmp[MAX_MOVES];
  if (!sc_legal_moves(&g->st, g->cur, tmp)) { g->result = R_DRAW; g->phase = PH_OVER; }
  return 1;
}
