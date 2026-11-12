# Neural-network scoring for the Stack Chess bot (first try, 2026-11-12)

The bot's search stays the same (the port of bot.js). Only the score of a board at the end of the
search changes: instead of `threatMaterial`, a small network trained on self-play games.

## Pipeline

```bash
sh engine/build.sh
# 1. Self-play data: the classic bot at depth 2 plays itself, with random openings (4-11 random actions)
#    and up to 30 points of noise per choice. 8 processes in parallel, appending to their own files.
engine/build/sc gen 2 1000 1000 engine/nn/data/d2_1.bin 30
# 2. (hybrid only) threatMaterial of every record, the base the network corrects.
engine/build/sc tm engine/nn/data/d2_1.bin engine/nn/data/d2_1.bin.tm
# 3. Train (PyTorch, CPU, about 15 s per epoch on 800k positions).
python engine/nn/train.py engine/nn/hybrid1.net 2 0.5 --residual engine/nn/data/d2_*.bin
# 4. Network bot vs classic bot: pairs of games from the same random opening, network plays both colors.
engine/build/sc match 3 6 313 engine/nn/hybrid1.net 3 1          # both at depth 3
engine/build/sc match 2 5 911 engine/nn/hybrid1.net 2 1 200      # both 200 ms per move
```

Every record is the board as it is once the stack resolves, with the player to act. That is the board the
network scores in the search. (In Stack Chess the bot almost never faces an empty stack: the other side
always declares something, so its choices are responses or resolve-then-move.)
Label = 0.5 × game result + 0.5 × sigmoid(depth-2 search score / 400).

Network: 768 inputs (own/enemy × 6 piece types × 64 squares, board turned so the player to act moves up),
128 ReLU units, one output. The C code (`sc_nn.c`) gives exactly the same outputs as PyTorch (`sc nneval`).

## Results

Data: 8,000 self-play games, 795,750 positions (White won 47%, Black 48%, the rest drawn or unfinished).

| network | vs classic bot | games | score |
|---|---|---|---|
| plain (network alone) | both depth 2 | 200 | 44 W, 58 D, 98 L = 36.5% (about −96 Elo) |
| hybrid (threatMaterial + network), `hybrid1.net` | both depth 2 | 200 | 103 W, 35 D, 62 L = 60.3% (about +72 Elo) |
| hybrid | both depth 3 | 96 | 73 W, 4 D, 19 L = 78% (about +220 Elo) |
| hybrid | 200 ms per move each | 80 | 42 W, 2 D, 36 L = 53.8% (even, within noise) |
| hybrid at depth 2 | classic at depth 3 | 64 | 10 W, 4 D, 50 L = 19% |

So the hybrid knows more per position, but each score costs about 1.5 times as much
(`threatMaterial` about 2 µs, the network about 1 µs more), and at equal thinking time it is about even.
The plain network alone (no hand-written knowledge of attacks) loses.

Training notes: the plain network keeps improving for about 6 epochs (validation 0.0489, versus 0.058 for
threatMaterial alone); the hybrid overfits after 2 epochs, so it was trained for 2.

## Next ideas

- Second generation: self-play with the hybrid bot (`sc gen ... net.bin 1`), deeper games, more data, retrain.
- Make scoring cheaper, so the knowledge also wins at equal time: integer weights, fewer hidden units,
  and a faster `threatMaterial` (which helps both bots).
- Attack inputs for the network (which squares each side attacks), so it can learn what threatMaterial knows.
