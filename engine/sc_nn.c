// A small neural network that scores a board (no stack) for the side to act.
// Trained by engine/nn/train.py on self-play games; see engine/nn/README.md.
#include "sc.h"

static float W1[NN_INPUTS * NN_HIDDEN], B1[NN_HIDDEN], W2[NN_HIDDEN], B2;

// Input index: (enemy ? 6 : 0) + type - 1, times 64, plus the square. For Black the board is
// mirrored top to bottom, so the side to act always plays toward row 0 (like White).
int sc_nn_features(const Pos *p, int c, int *out) {
  int n = 0;
  for (int sq = 0; sq < 64; sq++) {
    int pc = p->board[sq];
    if (!pc) continue;
    int rel = PCOLOR(pc) == c ? 0 : 6, s = c == WHITE ? sq : sq ^ 56;
    out[n++] = (rel + PTYPE(pc) - 1) * 64 + s;
  }
  return n;
}

void sc_nn_set(const float *w) {
  for (int i = 0; i < NN_INPUTS * NN_HIDDEN; i++) W1[i] = *w++;
  for (int i = 0; i < NN_HIDDEN; i++) B1[i] = *w++;
  for (int i = 0; i < NN_HIDDEN; i++) W2[i] = *w++;
  B2 = *w;
}

int sc_nn_residual = 0;

double sc_nn_eval(const Pos *p, int c) {
  int f[64], n = sc_nn_features(p, c, f);
  float h[NN_HIDDEN];
  for (int j = 0; j < NN_HIDDEN; j++) h[j] = B1[j];
  for (int k = 0; k < n; k++) {
    const float *w = &W1[f[k] * NN_HIDDEN];
    for (int j = 0; j < NN_HIDDEN; j++) h[j] += w[j];
  }
  float out = B2;
  for (int j = 0; j < NN_HIDDEN; j++) if (h[j] > 0) out += h[j] * W2[j];
  return sc_nn_residual ? sc_threat_material(p, c) + out : out;
}
