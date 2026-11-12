# Stack Chess engine (C)

A fast Stack Chess engine in plain C: the rules of `rules.js` and the computer opponent of `bot.js`,
using only numbers in fixed arrays, with no allocation while searching. It is groundwork for
bot-vs-bot tournaments and, later, neural-network training. It is not used by the website yet.

`rules.js` is the source of truth. The C engine is tested against it, and against `bot.js`, step by step.

## Files

- `sc.h`: types and functions.
- `sc_rules.c`: board, move generation, the stack, resolution, fizzles, the game model (`Game`).
- `sc_search.c`: the bot (alpha-beta with stack extensions, position table, killer moves,
  late move reductions, `evaluate` / `threatMaterial`). It gives exactly the same scores and node counts as `bot.js`.
- `sc_cli.c`: native command line.
- `sc_wasm.c`: WebAssembly exports (one game held in the module), no libc.
- `test/`: Node scripts that load the site's `rules.js` and `bot.js` and compare.

## Build

```bash
sh engine/build.sh
```

This builds `engine/build/sc` (gcc) and, if clang is installed, `engine/build/sc.wasm`
(`clang --target=wasm32 -nostdlib`). On this PC gcc is TDM-GCC; clang comes from `winget install LLVM.LLVM`.

## Command line

Squares are 0..63 with a8 = 0 and h1 = 63, as in `rules.js`. Actions are `m<from>-<to>` (add `q`, `r`, `b` or `n`
for a promotion) or `r` (let the stack resolve).

```bash
engine/build/sc selfplay 3          # the bot plays itself at depth 3
engine/build/sc perft 4             # counts action sequences from the start (promotions count 4, resolve counts 1)
engine/build/sc bench 3             # times the bot on engine/test/positions.txt
echo "m52-36 m12-28 r" | engine/build/sc search 3   # root scores of a position at depth 3
```

## Tests

```bash
node engine/test/parity.mjs 10000     # random games: rules.js vs C after every action
node engine/test/botparity.mjs 3 100  # bot.js vs C search: same scores and node counts at depth 3
node engine/test/bench.mjs 3          # bot.js timing on the benchmark positions
node engine/test/wasm.mjs 3           # sc.wasm loads with no imports and matches the native build
```

`parity.mjs` compares, after every action: board with piece ids, castling, en passant, side to act, phase,
result, the stack, the available moves in order, the bot's `evaluate`, and the bot's ordered action list.
The random games lean toward moves that touch the stack's squares and toward special moves
(en passant, castling, promotion), so rare resolution cases come up. Each script prints progress as it goes.

## Results (2026-11-12, this PC)

- Rules parity: 10,000 random games, 1,336,021 positions, zero differences.
- Bot parity (bot.js of e0c8ce2, with `quiet()`): 100 positions at depth 3 and 30 at depth 2, same scores and
  node counts (122,004 nodes at depth 3).
- Speed, same search, same nodes (`bench`, 4 busy positions; nodes are counted like bot.js, not counting leaf evaluations):

| | bot.js (Node 20) | C wasm (Node 20) | C native (gcc -O2) |
|---|---|---|---|
| depth 3, total of 4 positions | 4,710 ms | 318 ms (15x) | 245 ms (19x) |
| depth 4, total of 4 positions | 49,268 ms | 4,130 ms (12x) | 2,920 ms (17x) |

The wasm build gives the same moves, scores and node counts as native (`test/wasm.mjs`).

The C port is a straight translation, so all of this speed comes only from using numbers instead of objects.
There is room for more (incremental move generation, cheaper evaluation), done later and checked with the same tests.
