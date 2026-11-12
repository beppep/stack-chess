// WebAssembly interface: one game held inside the module, driven by small number-only calls.
// Built with clang --target=wasm32 and no libc (see build.sh). Used by the website's hard level (engine/worker.js).
// One import: env.now_ms, a clock in milliseconds (for the time budget of sc_w_think).
#include "sc.h"

// clang may turn struct copies and array clears into calls to these, and there is no libc.
void *memcpy(void *d, const void *s, unsigned long n) { char *a = d; const char *b = s; while (n--) *a++ = *b++; return d; }
void *memmove(void *d, const void *s, unsigned long n) {
  char *a = d; const char *b = s;
  if (a < b) while (n--) *a++ = *b++;
  else { a += n; b += n; while (n--) *--a = *--b; }
  return d;
}
void *memset(void *d, int c, unsigned long n) { char *a = d; while (n--) *a++ = (char)c; return d; }

#define EXPORT __attribute__((visibility("default")))
static Game G;
static RootResult RES[MAX_ACTS];
static double last_score, last_nodes;

__attribute__((import_module("env"), import_name("now_ms"))) double js_now_ms(void);
static double clock_ms(void) { return js_now_ms(); }

// Neural-network scoring: the caller writes NN_FLOATS float32 weights at sc_w_nn_buf(), then calls
// sc_w_nn_use(1). The bot then scores boards as threatMaterial + network (a residual network, see nn/README.md).
static float NNBUF[NN_FLOATS];
EXPORT float *sc_w_nn_buf(void) { return NNBUF; }
EXPORT void sc_w_nn_use(int on) {
  if (on) { sc_nn_set(NNBUF); sc_nn_residual = 1; sc_board_eval = sc_nn_eval; }
  else sc_board_eval = sc_threat_material;
}

EXPORT void sc_w_new_game(void) { sc_new_game(&G); }
// Declare a move; promo is 5 queen, 4 rook, 3 bishop, 2 knight (ignored for non-promoting moves). 1 if legal.
EXPORT int sc_w_move(int from, int to, int promo) { return sc_game_move(&G, from, to, promo); }
EXPORT int sc_w_resolve(void) { return sc_game_resolve(&G); }
EXPORT int sc_w_cur(void) { return G.cur; }               // 0 White, 1 Black
EXPORT int sc_w_phase(void) { return G.phase; }           // 0 move, 1 respond, 2 over
EXPORT int sc_w_result(void) { return G.result; }         // -1 none, 0 White won, 1 Black won, 2 draw
EXPORT int sc_w_stack_size(void) { return G.n; }
EXPORT int sc_w_piece(int sq) { return G.st.board[sq]; }  // 0 empty, else type + 8 * color
EXPORT int sc_w_piece_id(int sq) { return G.st.id[sq]; }

// The bot at min_depth, then deepening while the node budget lasts (like bot.js) and, if time_ms > 0,
// until time_ms milliseconds have passed (the depth being searched is abandoned at the deadline).
// Returns the best action as a key: -1 resolve, from*64+to a move, 4096+from*64+to resolve then move.
EXPORT int sc_w_think(int max_depth, int min_depth, double node_limit, double time_ms) {
  S s;
  sc_s_from_game(&G, &s);
  SearchCfg cfg = {max_depth, min_depth, node_limit, time_ms > 0 ? time_ms : 0};
  sc_clock_ms = clock_ms;
  int n = sc_root_search(&s, &cfg, RES, &last_nodes);
  if (!n) return -2;
  last_score = RES[0].v;
  return sc_act_key(&RES[0].a);
}
EXPORT double sc_w_last_score(void) { return last_score; }
EXPORT double sc_w_last_nodes(void) { return last_nodes; }
