// Native command line for the Stack Chess engine.
//   sc replay              games on stdin (one per line), prints a snapshot after every action (parity test)
//   sc search D            positions on stdin (one per line, as actions), prints bot root scores at depth D
//   sc perft D             counts game-action sequences of length 1..D from the start
//   sc bench D [file] [net.bin] [residual]   times the bot to depth D on positions (default: engine/test/positions.txt)
//   sc selfplay D [seed]   the bot plays itself at depth D, printing every action
//   sc gen D games seed out.bin [noise] [net.bin] [residual]   self-play training data (appends to out.bin), by the classic or a network bot
//   sc nnmatch D pairs seed net.bin [netD] [residual] [ms] [netbot] [classicbot]  network bot vs classic bot, pairs of
//                                      games with the same opening (ms > 0: both think ms per move, at least depth 2,
//                                      instead of fixed depths; netbot/classicbot: scoring settings as in "s1k2f0.6",
//                                      default the engine's current ones)
//   sc tm data.bin out.f32             threatMaterial of each record (base for a residual network)
//   sc nneval net.bin data.bin N       network output for the first N records
//   sc match P0 P1 NODES MAXD MIND RULE_A RULE_B   bot A vs bot B on game pairs P0..P1-1 (see cmd_match)
// Actions are written m<from>-<to>[qrbn] (squares 0..63, a8 = 0) or r (let the stack resolve).
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <math.h>
#include "sc.h"

static const char *LET = ".PNBRQK";
static char type_letter(int t) { return "-pnbrqk"[t]; }
static int promo_of(char ch) {
  switch (ch) { case 'q': return QUEEN; case 'r': return ROOK; case 'b': return BISHOP; case 'n': return KNIGHT; }
  return 0;
}

// Plays one action token on the game. Returns 1 if it was legal.
static int play_token(Game *g, const char *tok) {
  if (tok[0] == 'r') return sc_game_resolve(g);
  if (tok[0] != 'm') return 0;
  int from, to; char p = 0;
  if (sscanf(tok + 1, "%d-%d%c", &from, &to, &p) < 2) return 0;
  return sc_game_move(g, from, to, promo_of(p));
}

static void print_move(const Move *m, int with_player) {
  if (with_player) printf("%d,%d,%d,%d,%d,%c,%c", m->from, m->to, m->id, m->flag, m->promo, type_letter(m->promo_to), m->player ? 'b' : 'w');
  else printf("%d-%d-%d-%d", m->from, m->to, m->flag, m->promo);
  if (m->flag == F_EP) printf(with_player ? ",%d,%d" : "-%d-%d", m->cap_sq, m->cap_id);
}

// One line describing everything the parity test compares. test/parity.mjs builds the same line from rules.js.
static void snapshot(const Game *g) {
  for (int i = 0; i < 64; i++) {
    int pc = g->st.board[i];
    if (!pc) printf(".--");
    else printf("%c%02x", PCOLOR(pc) == WHITE ? LET[PTYPE(pc)] : LET[PTYPE(pc)] + 32, g->st.id[i]);
  }
  printf(" %d ", g->st.castle);
  if (g->st.ep_sq < 0) printf("-");
  else printf("%d,%d,%d,%c", g->st.ep_sq, g->st.ep_pawn_sq, g->st.ep_pawn_id, g->st.ep_color ? 'b' : 'w');
  printf(" %c %c %c ", g->cur ? 'b' : 'w', "mro"[g->phase], g->result == R_NONE ? '-' : "wbd"[g->result]);
  if (!g->n) printf("-");
  for (int i = 0; i < g->n; i++) { if (i) printf(";"); print_move(&g->stack[i], 1); }
  printf(" ");
  Move av[MAX_MOVES];
  int n = sc_available_moves(g, av);
  if (!n) printf("-");
  for (int i = 0; i < n; i++) { if (i) printf(","); print_move(&av[i], 0); }
  S s, r;
  sc_s_from_game(g, &s);
  printf(" %.17g ", sc_evaluate(&s));
  Act acts[MAX_ACTS];
  int k = sc_ordered_actions(&s, acts, &r);
  if (!k) printf("-");
  for (int i = 0; i < k; i++) printf(i ? ",%d" : "%d", sc_act_key(&acts[i]));
  printf("\n");
}

static char *read_line(FILE *f) {
  static char *buf = 0; static size_t cap = 0;
  size_t len = 0; int ch;
  while ((ch = fgetc(f)) != EOF && ch != '\n') {
    if (len + 2 > cap) { cap = cap ? cap * 2 : 4096; buf = realloc(buf, cap); }
    buf[len++] = (char)ch;
  }
  if (ch == EOF && len == 0) return 0;
  if (!buf) { cap = 16; buf = malloc(cap); }
  buf[len] = 0;
  if (len && buf[len - 1] == '\r') buf[len - 1] = 0;
  return buf;
}

// Replays a line of actions into g. Returns 0 if an action was illegal.
static int replay_line(Game *g, char *line, int print) {
  sc_new_game(g);
  if (print) snapshot(g);
  for (char *tok = strtok(line, " \t"); tok; tok = strtok(0, " \t")) {
    if (!play_token(g, tok)) { if (print) printf("ILLEGAL %s\n", tok); return 0; }
    if (print) snapshot(g);
  }
  return 1;
}

static void cmd_replay(void) {
  char *line; Game g;
  while ((line = read_line(stdin))) { replay_line(&g, line, 1); printf("END\n"); }
}

static void print_act(const Act *a) {
  if (a->t == A_RESOLVE) { printf("r"); return; }
  if (a->t == A_RESOLVE_MOVE) printf("r+");
  printf("m%d-%d%s", a->m.from, a->m.to, a->m.promo ? "q" : "");
}

static void cmd_search(int depth) {
  char *line; Game g; S s; RootResult res[MAX_ACTS];
  SearchCfg cfg = {depth, depth, 1e18, 0};
  while ((line = read_line(stdin))) {
    if (!replay_line(&g, line, 0)) { printf("ILLEGAL\n"); fflush(stdout); continue; }
    sc_s_from_game(&g, &s);
    double nodes;
    int n = sc_root_search(&s, &cfg, res, &nodes);
    printf("%.0f", nodes);
    for (int i = 0; i < n; i++) printf(" %d:%.17g", sc_act_key(&res[i].a), res[i].v);
    printf("\n");
    fflush(stdout);
  }
}

static long long perft(Game *g, int depth) {
  if (depth == 0 || g->phase == PH_OVER) return 1;
  Move av[MAX_MOVES];
  int n = sc_available_moves(g, av);
  long long total = 0;
  for (int i = 0; i < n; i++) {
    int k = av[i].promo ? 4 : 1;
    static const int promos[4] = {QUEEN, ROOK, BISHOP, KNIGHT};
    for (int j = 0; j < k; j++) {
      Game c = *g;
      sc_game_move(&c, av[i].from, av[i].to, promos[j]);
      total += perft(&c, depth - 1);
    }
  }
  if (g->phase == PH_RESPOND) { Game c = *g; sc_game_resolve(&c); total += perft(&c, depth - 1); }
  return total;
}

static double now_ms(void) { return (double)clock() * 1000.0 / CLOCKS_PER_SEC; }

static void cmd_perft(int depth) {
  Game g; sc_new_game(&g);
  for (int d = 1; d <= depth; d++) {
    double t = now_ms();
    long long n = perft(&g, d);
    printf("perft %d: %lld  (%.0f ms)\n", d, n, now_ms() - t);
    fflush(stdout);
  }
}

static void cmd_bench(int depth, const char *file) {
  FILE *f = fopen(file, "r");
  if (!f) { fprintf(stderr, "cannot open %s\n", file); exit(1); }
  char *line; Game g; S s; RootResult res[MAX_ACTS];
  SearchCfg cfg = {depth, depth, 1e18, 0};
  double total_nodes = 0, total_ms = 0;
  int k = 0;
  while ((line = read_line(f))) {
    if (!line[0] || line[0] == '#') continue;
    if (!replay_line(&g, line, 0)) { printf("position %d: illegal actions\n", k); continue; }
    sc_s_from_game(&g, &s);
    double nodes, t = now_ms();
    int n = sc_root_search(&s, &cfg, res, &nodes);
    double ms = now_ms() - t;
    total_nodes += nodes; total_ms += ms;
    printf("position %d: depth %d, %d first moves, %.0f nodes, %.1f ms, best ", k++, depth, n, nodes, ms);
    if (n) { print_act(&res[0].a); printf(" %.6g", res[0].v); }
    printf("\n");
    fflush(stdout);
  }
  fclose(f);
  printf("total: %.0f nodes in %.1f ms = %.0f nodes/s\n", total_nodes, total_ms, total_ms > 0 ? total_nodes / total_ms * 1000 : 0);
}

static void cmd_selfplay(int depth, unsigned seed) {
  Game g; S s; RootResult res[MAX_ACTS];
  SearchCfg cfg = {depth, depth, 1e18, 0};
  srand(seed);
  sc_new_game(&g);
  int turns = 0;
  while (g.phase != PH_OVER && turns < 300) {
    sc_s_from_game(&g, &s);
    double nodes;
    int n = sc_root_search(&s, &cfg, res, &nodes);
    if (!n) break;
    int ties = 1;
    while (ties < n && res[ties].v == res[0].v) ties++;
    Act a = res[rand() % ties].a;
    printf("%3d %c ", ++turns, g.cur ? 'b' : 'w');
    print_act(&a);
    printf("  score %.6g, %.0f nodes\n", res[0].v, nodes);
    fflush(stdout);
    if (a.t != A_MOVE) sc_game_resolve(&g);
    if (a.t != A_RESOLVE) sc_game_move(&g, a.m.from, a.m.to, QUEEN);
  }
  if (g.n) sc_game_resolve(&g);
  printf("result: %s\n", g.result == R_WHITE ? "White wins" : g.result == R_BLACK ? "Black wins" : g.result == R_DRAW ? "draw" : "unfinished");
}

// ---------- Self-play data and matches (for the neural network work) ----------
static uint64_t rng_state = 88172645463325252ull;
static uint32_t rnd(void) { rng_state ^= rng_state << 13; rng_state ^= rng_state >> 7; rng_state ^= rng_state << 17; return (uint32_t)(rng_state >> 32); }
static double rndf(void) { return rnd() / 4294967296.0; }

// A random legal game action (used for random openings).
static void random_action(Game *g) {
  Move av[MAX_MOVES];
  int n = sc_available_moves(g, av);
  int k = g->phase == PH_RESPOND ? n + 1 : n;
  if (!k) return;
  int i = rnd() % k;
  if (i == n) sc_game_resolve(g);
  else { static const int pr[4] = {QUEEN, ROOK, BISHOP, KNIGHT}; sc_game_move(g, av[i].from, av[i].to, pr[rnd() % 4]); }
}
static void play_act(Game *g, const Act *a) {
  if (a->t != A_MOVE) sc_game_resolve(g);
  if (a->t != A_RESOLVE && g->phase != PH_OVER) sc_game_move(g, a->m.from, a->m.to, QUEEN);
}
// The bot's choice: best score plus up to `noise` of random bonus (ties broken at random).
static double move_ms = 0;  // >0: think this many ms per move (after depth 2) instead of a fixed depth
static Act bot_choice(const Game *g, int depth, double noise, double *score) {
  static RootResult res[MAX_ACTS];
  S s; sc_s_from_game(g, &s);
  SearchCfg cfg = {depth, depth, 1e18, 0};
  if (move_ms > 0) { cfg.max_depth = 30; cfg.min_depth = 2; cfg.time_ms = move_ms; }
  double nodes;
  int n = sc_root_search(&s, &cfg, res, &nodes);
  *score = res[0].v;
  int pick = 0; double best = -1e300;
  for (int i = 0; i < n; i++) {
    if (res[i].v < -1e299) continue;
    double v = res[i].v + rndf() * (noise > 0 ? noise : 1e-6);
    if (v > best) { best = v; pick = i; }
  }
  return res[pick].a;
}

// One training record: a board with no stack, the side to act, the search score for it, and the game result.
typedef struct { uint8_t board[64]; uint8_t cur; int8_t result; uint8_t pad[2]; float score; } Rec;

static void cmd_gen(int depth, int games, unsigned seed, const char *outfile, double noise) {
  FILE *f = fopen(outfile, "ab");
  if (!f) { fprintf(stderr, "cannot write %s\n", outfile); exit(1); }
  rng_state ^= (uint64_t)seed * 0x9E3779B97F4A7C15ull; rnd();
  static Rec recs[2000];
  long total = 0; int wins[3] = {0, 0, 0};
  double t0 = now_ms();
  for (int gi = 0; gi < games; gi++) {
    Game g; sc_new_game(&g);
    int opening = 4 + rnd() % 8, actions = 0, nr = 0;
    for (int i = 0; i < opening && g.phase != PH_OVER; i++, actions++) random_action(&g);
    while (g.phase != PH_OVER && actions < 300) {
      double score;
      Act a = bot_choice(&g, depth, noise, &score);
      // Record the board as it is once the stack resolves, with this player to act: that is the kind of
      // board the network scores inside the search. The label is this position's search score.
      S s, t; sc_s_from_game(&g, &s); sc_s_resolve(&s, &t);
      if (t.winner < 0 && nr < 2000) {
        Rec *r = &recs[nr++];
        for (int i = 0; i < 64; i++) r->board[i] = t.st.board[i];
        r->cur = g.cur; r->score = (float)score; r->pad[0] = r->pad[1] = 0;
      }
      play_act(&g, &a);
      actions += a.t == A_RESOLVE_MOVE ? 2 : 1;
    }
    int res = g.result == R_WHITE || g.result == R_BLACK ? g.result : 2;
    wins[res]++;
    for (int i = 0; i < nr; i++) recs[i].result = res == 2 ? 0 : (res == recs[i].cur ? 1 : -1);
    fwrite(recs, sizeof(Rec), nr, f);
    fflush(f);
    total += nr;
    printf("game %d: %s after %d actions, %d positions (total %ld; white %d, black %d, draw/unfinished %d) %.0fs\n", gi + 1,
           res == 0 ? "white" : res == 1 ? "black" : "draw", actions, nr, total, wins[0], wins[1], wins[2], (now_ms() - t0) / 1000);
    fflush(stdout);
  }
  fclose(f);
}

static float *load_net(const char *file) {
  static float w[NN_FLOATS];
  FILE *f = fopen(file, "rb");
  if (!f || fread(w, sizeof(float), NN_FLOATS, f) != NN_FLOATS) { fprintf(stderr, "cannot read network %s\n", file); exit(1); }
  fclose(f);
  return w;
}

// Prints the network's output for the first n records of a data file (to check C against train.py).
static void cmd_nneval(const char *netfile, const char *datafile, int n) {
  sc_nn_set(load_net(netfile));
  FILE *f = fopen(datafile, "rb");
  if (!f) { fprintf(stderr, "cannot read %s\n", datafile); exit(1); }
  Rec r; Pos p = {0};
  for (int i = 0; i < n && fread(&r, sizeof r, 1, f) == 1; i++) {
    for (int k = 0; k < 64; k++) { p.board[k] = r.board[k]; p.id[k] = 0; }
    printf("%.4f\n", sc_nn_eval(&p, r.cur));
  }
  fclose(f);
}

// Writes threatMaterial (float32) for every record of a data file: the base the residual network corrects.
static void cmd_tm(const char *datafile, const char *outfile) {
  FILE *f = fopen(datafile, "rb"), *o = fopen(outfile, "wb");
  if (!f || !o) { fprintf(stderr, "cannot open %s or %s\n", datafile, outfile); exit(1); }
  Rec r; Pos p = {0};
  while (fread(&r, sizeof r, 1, f) == 1) {
    for (int k = 0; k < 64; k++) p.board[k] = r.board[k];
    float v = (float)sc_threat_material(&p, r.cur);
    fwrite(&v, sizeof v, 1, o);
  }
  fclose(f); fclose(o);
}

// A bot's settings: "s<saved rule>k<king rule>f<frozen factor>p<principal variation search 0/1/2>e<free stack replies>", any part may be left out (a plain number = saved rule).
typedef struct { int saved, king; double frozen; int pvs, ext; } BotCfg;
static BotCfg parse_bot(const char *t) {
  BotCfg b = {0, 0, 0.9, 0, 6};
  if (*t >= '0' && *t <= '9') { b.saved = atoi(t); return b; }
  while (*t) {
    char k = *t++;
    double v = atof(t);
    while (*t && !(*t >= 'a' && *t <= 'z')) t++;
    if (k == 's') b.saved = (int)v; else if (k == 'k') b.king = (int)v; else if (k == 'f') b.frozen = v; else if (k == 'p') b.pvs = (int)v; else if (k == 'e') b.ext = (int)v;
  }
  return b;
}
static void use_bot(BotCfg b) { sc_saved_rule = b.saved; sc_king_rule = b.king; sc_frozen = b.frozen; sc_pvs = b.pvs; sc_max_ext = b.ext; }

// Network bot against the classic bot. Games come in pairs with the same random opening,
// the network playing White in one and Black in the other. Each side has its own scoring settings
// (see parse_bot); the network adds its correction on top of threatMaterial with the network side's settings.
static void cmd_nnmatch(int depth, int pairs, unsigned seed, const char *netfile, int net_depth, BotCfg cfg_nn, BotCfg cfg_classic) {
  sc_nn_set(load_net(netfile));
  rng_state ^= (uint64_t)seed * 0x9E3779B97F4A7C15ull; rnd();
  int w = 0, d = 0, l = 0;
  double ms[2] = {0, 0}; long moves[2] = {0, 0};
  for (int pi = 0; pi < pairs; pi++) {
    Game start; sc_new_game(&start);
    int opening = 4 + rnd() % 8;
    for (int i = 0; i < opening && start.phase != PH_OVER; i++) random_action(&start);
    for (int nn_color = 0; nn_color < 2; nn_color++) {
      Game g = start;
      int actions = opening;
      while (g.phase != PH_OVER && actions < 300) {
        int nn = g.cur == nn_color;
        sc_board_eval = nn ? sc_nn_eval : sc_threat_material;
        use_bot(nn ? cfg_nn : cfg_classic);
        double score, t = now_ms();
        Act a = bot_choice(&g, nn ? net_depth : depth, 0, &score);
        ms[nn] += now_ms() - t; moves[nn]++;
        play_act(&g, &a);
        actions += a.t == A_RESOLVE_MOVE ? 2 : 1;
      }
      if (g.result == nn_color) w++; else if (g.result == (nn_color ^ 1)) l++; else d++;
    }
    double p = (w + 0.5 * d) / (w + d + l);
    double elo = p <= 0 ? -999 : p >= 1 ? 999 : -400 * log10(1 / p - 1);
    printf("pair %d: network %d wins, %d draws, %d losses = %.1f%% (Elo %+.0f); ms/move network %.1f, classic %.1f\n",
           pi + 1, w, d, l, 100 * p, elo, ms[1] / (moves[1] ? moves[1] : 1), ms[0] / (moves[0] ? moves[0] : 1));
    fflush(stdout);
  }
}

// Bot vs bot. Each pair is a random 4-action opening played twice, colours swapped. The bots differ only in
// sc_saved_rule (RULE_A, RULE_B). Prints one line per finished game, as soon as it ends:
//   game <pair> <A colour w|b> <winner w|b|-> <bot actions> <A starts> <A lost> <B starts> <B lost>
// "starts": captures a side put on an empty stack; "lost": of those, the capturing piece was taken and the
// target survived once the stack resolved (starting a fight and losing it).
static unsigned mrng_state;
static unsigned rng(void) { mrng_state = mrng_state * 1103515245u + 12345u; return mrng_state >> 8; }
static int alive_id(const Game *g, int id) { for (int i = 0; i < 64; i++) if (g->st.board[i] && g->st.id[i] == id) return 1; return 0; }

static void cmd_match(int argc, char **argv) {
  if (argc < 9) { fprintf(stderr, "usage: sc match P0 P1 NODES MAXD MIND RULE_A RULE_B\n"); exit(1); }
  int p0 = atoi(argv[2]), p1 = atoi(argv[3]);
  SearchCfg cfg = {atoi(argv[5]), atoi(argv[6]), atof(argv[4]), 0};
  BotCfg rule[2] = {parse_bot(argv[7]), parse_bot(argv[8])};
  static RootResult res[MAX_ACTS];
  Move mv[MAX_MOVES];
  for (int pair = p0; pair < p1; pair++) {
    for (int aWhite = 1; aWhite >= 0; aWhite--) {
      Game g; sc_new_game(&g);
      mrng_state = 1000u + (unsigned)pair * 7919u;
      for (int i = 0; i < 4 && g.phase != PH_OVER; i++) {
        int n = sc_available_moves(&g, mv), k = (int)(rng() % (unsigned)(n + (g.n ? 1 : 0)));
        if (k == n) sc_game_resolve(&g); else sc_game_move(&g, mv[k].from, mv[k].to, QUEEN);
      }
      int starts[2] = {0, 0}, lost[2] = {0, 0}, plies = 0;
      int pend = 0, pend_side = 0, pend_x = 0, pend_y = 0;
      while (g.phase != PH_OVER && plies < 400) {
        int side = g.cur, bot = (side == WHITE) == aWhite ? 0 : 1;  // 0 = A, 1 = B
        use_bot(rule[bot]);
        S st; sc_s_from_game(&g, &st);
        double nodes;
        if (!sc_root_search(&st, &cfg, res, &nodes)) break;
        Act a = res[0].a;
        if (a.t == A_RESOLVE || a.t == A_RESOLVE_MOVE) sc_game_resolve(&g);
        if (!pend || g.n == 0) {
          if (pend && g.n == 0) { starts[pend_side]++; if (!alive_id(&g, pend_x) && alive_id(&g, pend_y)) lost[pend_side]++; pend = 0; }
        }
        if (a.t != A_RESOLVE && g.phase != PH_OVER) {
          int x = g.st.board[a.m.from], y = g.st.board[a.m.to];
          if (!g.n && !pend && x && y && PCOLOR(y) != PCOLOR(x)) { pend = 1; pend_side = bot; pend_x = g.st.id[a.m.from]; pend_y = g.st.id[a.m.to]; }
          sc_game_move(&g, a.m.from, a.m.to, a.m.promo ? QUEEN : 0);
        }
        if (pend && g.n == 0) { starts[pend_side]++; if (!alive_id(&g, pend_x) && alive_id(&g, pend_y)) lost[pend_side]++; pend = 0; }
        plies++;
      }
      char aCol = aWhite ? 'w' : 'b', win = g.result == R_WHITE ? 'w' : g.result == R_BLACK ? 'b' : '-';
      printf("game %d %c %c %d %d %d %d %d\n", pair, aCol, win, plies, starts[0], lost[0], starts[1], lost[1]);
      fflush(stdout);
    }
  }
}

int main(int argc, char **argv) {
  sc_clock_ms = now_ms;
  if (argc < 2) {
    fprintf(stderr, "usage: sc replay | search D | perft D | bench D [file] | selfplay D [seed]\n");
    return 1;
  }
  const char *cmd = argv[1];
  if (getenv("SC_PVS")) sc_pvs = atoi(getenv("SC_PVS"));
  int d = argc > 2 ? atoi(argv[2]) : 3;
  if (!strcmp(cmd, "replay")) cmd_replay();
  else if (!strcmp(cmd, "search")) cmd_search(d);
  else if (!strcmp(cmd, "perft")) cmd_perft(d);
  else if (!strcmp(cmd, "bench")) {
    if (argc > 4) { sc_nn_set(load_net(argv[4])); sc_nn_residual = argc > 5 && atoi(argv[5]); sc_board_eval = sc_nn_eval; }
    cmd_bench(d, argc > 3 ? argv[3] : "engine/test/positions.txt");
  }
  else if (!strcmp(cmd, "gen") && argc > 5) {
    if (argc > 7) { sc_nn_set(load_net(argv[7])); sc_nn_residual = argc > 8 && atoi(argv[8]); sc_board_eval = sc_nn_eval; }
    cmd_gen(d, atoi(argv[3]), (unsigned)atoi(argv[4]), argv[5], argc > 6 ? atof(argv[6]) : 30);
  }
  else if (!strcmp(cmd, "tm") && argc > 3) cmd_tm(argv[2], argv[3]);
  else if (!strcmp(cmd, "nnmatch") && argc > 5) {
    BotCfg cur = {sc_saved_rule, sc_king_rule, sc_frozen, sc_pvs, sc_max_ext};
    sc_nn_residual = argc > 7 && atoi(argv[7]); move_ms = argc > 8 ? atof(argv[8]) : 0;
    cmd_nnmatch(d, atoi(argv[3]), (unsigned)atoi(argv[4]), argv[5], argc > 6 ? atoi(argv[6]) : d,
                argc > 9 ? parse_bot(argv[9]) : cur, argc > 10 ? parse_bot(argv[10]) : cur);
  }
  else if (!strcmp(cmd, "nneval") && argc > 4) cmd_nneval(argv[2], argv[3], atoi(argv[4]));
  else if (!strcmp(cmd, "bench")) cmd_bench(d, argc > 3 ? argv[3] : "engine/test/positions.txt");
  else if (!strcmp(cmd, "match")) cmd_match(argc, argv);
  else if (!strcmp(cmd, "selfplay")) cmd_selfplay(d, argc > 3 ? (unsigned)atoi(argv[3]) : (unsigned)time(0));
  else { fprintf(stderr, "unknown command %s\n", cmd); return 1; }
  return 0;
}
