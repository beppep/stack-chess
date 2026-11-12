// Native command line for the Stack Chess engine.
//   sc replay              games on stdin (one per line), prints a snapshot after every action (parity test)
//   sc search D            positions on stdin (one per line, as actions), prints bot root scores at depth D
//   sc perft D             counts game-action sequences of length 1..D from the start
//   sc bench D [file]      times the bot to depth D on positions (default: engine/test/positions.txt)
//   sc selfplay D [seed]   the bot plays itself at depth D, printing every action
// Actions are written m<from>-<to>[qrbn] (squares 0..63, a8 = 0) or r (let the stack resolve).
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
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
  SearchCfg cfg = {depth, depth, 1e18};
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
  SearchCfg cfg = {depth, depth, 1e18};
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
  SearchCfg cfg = {depth, depth, 1e18};
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

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: sc replay | search D | perft D | bench D [file] | selfplay D [seed]\n");
    return 1;
  }
  const char *cmd = argv[1];
  int d = argc > 2 ? atoi(argv[2]) : 3;
  if (!strcmp(cmd, "replay")) cmd_replay();
  else if (!strcmp(cmd, "search")) cmd_search(d);
  else if (!strcmp(cmd, "perft")) cmd_perft(d);
  else if (!strcmp(cmd, "bench")) cmd_bench(d, argc > 3 ? argv[3] : "engine/test/positions.txt");
  else if (!strcmp(cmd, "selfplay")) cmd_selfplay(d, argc > 3 ? (unsigned)atoi(argv[3]) : (unsigned)time(0));
  else { fprintf(stderr, "unknown command %s\n", cmd); return 1; }
  return 0;
}
