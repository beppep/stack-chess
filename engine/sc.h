// Stack Chess engine in plain C: rules (a port of rules.js) and the bot search (a port of bot.js).
// Everything is numbers in fixed arrays; nothing is allocated while searching.
// No libc is needed by sc_rules.c or sc_search.c, so they also build for WebAssembly.
#ifndef SC_H
#define SC_H
#include <stdint.h>

// Colors and piece types. A square holds 0 (empty) or type + 8 * color.
enum { WHITE = 0, BLACK = 1 };
enum { PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6 };
#define PTYPE(code) ((code) & 7)
#define PCOLOR(code) ((code) >> 3)
#define PCODE(type, color) ((type) | ((color) << 3))

// Move flags, as in rules.js.
enum { F_NONE = 0, F_DOUBLE = 1, F_EP = 2, F_CASTLE_K = 3, F_CASTLE_Q = 4 };
// Castling rights bits.
enum { C_WK = 1, C_WQ = 2, C_BK = 4, C_BQ = 8 };

// Squares are 0..63, row 0 is Black's back rank (a8 = 0, h1 = 63), like rules.js.
typedef struct {
  uint8_t board[64];   // piece codes
  uint8_t id[64];      // stable piece id (0..31) of the piece on each square
  uint8_t castle;      // C_* bits
  int8_t ep_sq;        // en passant target square, -1 if none
  uint8_t ep_pawn_sq, ep_pawn_id, ep_color;
} Pos;

typedef struct {
  uint8_t from, to, id;  // id: the piece that declared it
  uint8_t flag;          // F_*
  uint8_t promo;         // 1 if this pawn move promotes
  uint8_t promo_to;      // piece type it promotes to (0 = not chosen yet)
  uint8_t cap_sq, cap_id;// en passant: the pawn it takes
  uint8_t player;        // who declared it (on the stack)
} Move;

#define MAX_STACK 32
#define MAX_MOVES 256

// ---------- Rules (sc_rules.c) ----------
void sc_init_pos(Pos *p);
int sc_piece_moves(const Pos *p, int from, Move *out);    // pseudo-legal moves of one piece, rules.js order
int sc_legal_moves(const Pos *p, int color, Move *out);   // all moves for a color
int sc_apply_move(Pos *p, const Move *m);                 // returns the captured piece code (0 if none)
int sc_still_valid(const Pos *p, const Move *m);          // can a stack move still resolve?

// The game model of rules.js (no clocks). phase: 0 move, 1 respond, 2 over. result: -1 none, 0/1 winner, 2 draw.
enum { PH_MOVE = 0, PH_RESPOND = 1, PH_OVER = 2 };
enum { R_NONE = -1, R_WHITE = 0, R_BLACK = 1, R_DRAW = 2 };
typedef struct {
  Pos st;
  Move stack[MAX_STACK];
  int n, cur, phase, result;
} Game;
void sc_new_game(Game *g);
int sc_available_moves(const Game *g, Move *out);
// Declare a move (promo: piece type for a promoting pawn, else ignored). Returns 1 if legal.
int sc_game_move(Game *g, int from, int to, int promo);
// Let the stack resolve. Returns 1 if legal.
int sc_game_resolve(Game *g);

// ---------- Bot search (sc_search.c) ----------
// The search's light copy of a game: board, stack and whose decision it is.
typedef struct {
  Pos st;
  Move stack[MAX_STACK];
  uint8_t n, cur;
  int8_t winner;  // -1 none
} S;
// An action: put a move on the stack, let it resolve (only when that wins or loses on the spot),
// or let it resolve and then move.
enum { A_MOVE = 0, A_RESOLVE_MOVE = 1, A_RESOLVE = 2 };
typedef struct { uint8_t t; Move m; } Act;
#define MAX_ACTS 512

#define WIN 100000
void sc_s_from_game(const Game *g, S *s);
void sc_s_resolve(const S *s, S *out);
int sc_s_actions(const S *s, Act *out, S *resolved);       // resolved: filled when the stack is not empty
void sc_s_apply(const S *s, const Act *a, const S *resolved, S *out);
int sc_order_score(const S *s, const Act *a, const S *resolved);
int sc_ordered_actions(const S *s, Act *out, S *resolved);  // actions sorted like bot.js ordered()
int sc_act_key(const Act *a);
double sc_evaluate(const S *s);
double sc_threat_material(const Pos *p, int c);

typedef struct {
  int max_depth, min_depth;   // min_depth 0 means 2, like bot.js
  double node_limit;          // nodes per depth after min_depth (use a huge number for no limit)
} SearchCfg;
typedef struct { Act a; double v; } RootResult;
// Iterative deepening over the ordered first moves, like bot.js rootSearch. Returns the number of
// results (best first); *nodes gets the nodes counted in the search.
int sc_root_search(const S *s, const SearchCfg *cfg, RootResult *out, double *nodes);
extern int sc_lmr;          // late move reductions on (1) or off
// How evaluate counts a dying piece of the side to act as "saved" (it can dodge):
// 0 always (bot.js), 1 only if no second enemy attacker without a move on the stack, 2 never.
extern int sc_saved_rule;
#endif
