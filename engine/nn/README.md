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

## Round two (self-play by the hybrid bot)

The round-one hybrid (`hybrid1.net`) played itself: 6,400 games at depth 2, same random openings and noise
(`sc gen 2 800 <seed> data/h2_<i>.bin 30 engine/nn/hybrid1.net 1`), 873,529 positions.
These games are much more drawish: about 30% drawn or stopped at 300 actions (round one: 2%).
Two candidates, both hybrids trained 2 epochs:

| network | validation loss | vs classic, 200 ms per move (same 80 openings, both colors) | vs classic, both depth 3 |
|---|---|---|---|
| round 1, `hybrid1.net` (control) | | 72 W, 2 D, 86 L = 45.6% | 78% |
| round 2, trained on round-two games only | 0.0416 | 43 W, 3 D, 114 L = 27.8% | |
| round 2, trained on both rounds, `hybrid2.net` | 0.0399 | 87 W, 3 D, 70 L = **55.3%** | 76 W, 2 D, 18 L = 80.2% |

Training on both rounds helps at equal time (about 10 points over round one on the same openings: about
1.8 standard errors, suggestive rather than proven). Training only on the hybrid's own drawish games makes it
much worse. The equal-time score of `hybrid1.net` was 53.8% on other openings earlier, so single runs of
80 openings move by several points.

## Round three (self-play by `hybrid2.net`), and the scoring change on main

`hybrid2.net` played itself: 6,400 games at depth 2 (`sc gen 2 800 700<i> data/h3_<i>.bin 30 engine/nn/hybrid2.net 1`),
935,000 positions, about 31% drawn or stopped at 300 actions.

Meanwhile main changed the classic scoring (saved rule 1, king rule 2, frozen pieces keep 60%; each change beat the
old bot). The residual network adds its correction to threatMaterial, so the `.tm` bases of all three rounds were
recomputed with the new scoring, and `hybrid3.net` was trained on all of it (2,606,951 positions, 2 epochs, validation
0.0377 against 0.0479 for threatMaterial alone).

`sc nnmatch D pairs seed net [netD] [residual] [ms] [netbot] [classicbot]` takes scoring settings for each side
(`s1k2f0.6` is the new scoring, `s0k0f0.9` the old one). Against the new classic bot, 200 ms per move each,
the same 80 openings (`nnmatch 2 5 <s*1237> ... 2 1 200`):

| network | score |
|---|---|
| round 3, `hybrid3.net` (new scoring + network) | 61 W, 1 D, 18 L = **76.9%** |
| round 2, `hybrid2.net` on the old scoring it was trained with | 24 W, 2 D, 54 L = 31.3% |

## On the website (hard level)

`engine/worker.js` loads `nn/hybrid3.net` (393 KB of float32 weights) into `sc.wasm` and scores boards with
threatMaterial + network; without the file it plays with threatMaterial alone. The hard level searches to depth 3, then
deeper until 700 ms have passed (`sc_w_think(30, 3, 1e18, 700)`; the wasm reads the clock through its one import,
`env.now_ms`). The engine it replaces (30,000 nodes, no network) took about 750 ms per move in the browser on this PC.
`node engine/test/worker.mjs pairs ms seed` plays games through `worker.js` itself: the network at `ms` per move
against the old hard settings.

## Next ideas

- A third round from `hybrid2.net`, always keeping the earlier rounds' data in the training set.
- Make scoring cheaper, so the knowledge also wins at equal time: integer weights, fewer hidden units,
  and a faster `threatMaterial` (which helps both bots).
- Attack inputs for the network (which squares each side attacks), so it can learn what threatMaterial knows.
