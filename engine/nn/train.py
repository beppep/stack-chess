# Trains the board-scoring network on self-play records from `sc gen`, and writes weights the C engine loads.
#   python engine/nn/train.py out.net epochs lambda [--residual] data1.bin data2.bin ...
# --residual: the network learns a correction on top of threatMaterial (read from dataN.bin.tm, made by
# `sc tm dataN.bin dataN.bin.tm`); the engine then scores threatMaterial + network (`sc match ... 1`).
# Target per position: lambda * game result (1 win, 0.5 draw, 0 loss for the side to act)
#                    + (1 - lambda) * sigmoid(search score / 400).
# Trained in win-probability logits (prediction = sigmoid(output)); exported times 400, the search's units.
import sys, time
import numpy as np
import torch

INPUTS, HIDDEN, PAD = 768, 128, 768
REC = np.dtype([('board', 'u1', 64), ('cur', 'u1'), ('result', 'i1'), ('pad', 'u1', 2), ('score', '<f4')])

def features(recs):
    """Active input indices per record, (N, 64) with PAD for empty squares. Same as sc_nn_features in C."""
    board = recs['board'].astype(np.int64)
    cur = recs['cur'].astype(np.int64)[:, None]
    sq = np.arange(64)[None, :]
    sq = np.where(cur == 0, sq, sq ^ 56)
    ptype, color = board & 7, board >> 3
    idx = (np.where(color == cur, 0, 6) + ptype - 1) * 64 + sq
    return np.where(board == 0, PAD, idx).astype(np.int16)

class Net(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.emb = torch.nn.EmbeddingBag(INPUTS + 1, HIDDEN, mode='sum', padding_idx=PAD)
        self.b1 = torch.nn.Parameter(torch.zeros(HIDDEN))
        self.out = torch.nn.Linear(HIDDEN, 1)
        torch.nn.init.normal_(self.emb.weight, 0, 0.1)
        with torch.no_grad(): self.emb.weight[PAD].zero_()
    def forward(self, x):
        return self.out(torch.relu(self.emb(x) + self.b1)).squeeze(1)

def main():
    out_file, epochs, lam = sys.argv[1], int(sys.argv[2]), float(sys.argv[3])
    files = sys.argv[4:]
    residual = files[0] == '--residual'
    if residual: files = files[1:]
    recs = np.concatenate([np.fromfile(f, dtype=REC) for f in files])
    base = torch.from_numpy(np.concatenate([np.fromfile(f + '.tm', dtype='<f4') for f in files]) / 400 if residual else np.zeros(len(recs), np.float32)).float()
    assert len(base) == len(recs)
    print(f'{len(recs)} positions; results win {np.mean(recs["result"] == 1):.3f} draw {np.mean(recs["result"] == 0):.3f} loss {np.mean(recs["result"] == -1):.3f}', flush=True)
    x = torch.from_numpy(features(recs))
    wdl = (recs['result'].astype(np.float32) + 1) / 2
    srch = 1 / (1 + np.exp(-np.clip(recs['score'], -4000, 4000) / 400))
    y = torch.from_numpy((lam * wdl + (1 - lam) * srch).astype(np.float32))
    # Hold out whole games at the end of each file's run of records: here simply the last 5% of positions.
    n_val = len(recs) // 20
    perm = np.random.default_rng(1).permutation(len(recs) - n_val)
    xv, yv, bv = x[-n_val:].long(), y[-n_val:], base[-n_val:]

    net = Net()
    if residual:  # start exactly at threatMaterial
        with torch.no_grad(): net.out.weight.zero_(); net.out.bias.zero_()
    opt = torch.optim.Adam(net.parameters(), lr=1e-3)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, epochs)
    bs = 4096
    with torch.no_grad():
        avg = ((yv - yv.mean()) ** 2).mean().item()
        tm = ((torch.sigmoid(bv) - yv) ** 2).mean().item()
    print(f'validation loss of always guessing the average: {avg:.5f}' + (f', of threatMaterial alone: {tm:.5f}' if residual else ''), flush=True)
    for ep in range(epochs):
        t0, tot, cnt = time.time(), 0.0, 0
        np.random.default_rng(ep).shuffle(perm)
        net.train()
        for i in range(0, len(perm), bs):
            b = torch.from_numpy(perm[i:i + bs])
            pred = torch.sigmoid(net(x[b].long()) + base[b])
            loss = ((pred - y[b]) ** 2).mean()
            opt.zero_grad(); loss.backward(); opt.step()
            tot += loss.item() * len(b); cnt += len(b)
        sched.step()
        net.eval()
        with torch.no_grad():
            vl = ((torch.sigmoid(net(xv) + bv) - yv) ** 2).mean().item()
        print(f'epoch {ep + 1}/{epochs}: train {tot / cnt:.5f}  validation {vl:.5f}  ({time.time() - t0:.0f}s)', flush=True)
        save(net, out_file)
    print(f'wrote {out_file}')

def save(net, path):
    """Raw float32: W1[768][HIDDEN], b1[HIDDEN], W2[HIDDEN], b2 (see sc.h)."""
    with torch.no_grad():
        # The network learns in win-probability logits; times 400 gives the search's units.
        parts = [net.emb.weight[:INPUTS].reshape(-1), net.b1, 400 * net.out.weight.reshape(-1), 400 * net.out.bias]
        np.concatenate([p.numpy().astype('<f4') for p in parts]).tofile(path)

if __name__ == '__main__':
    main()
