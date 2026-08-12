# amath-engine

Competitive A-Math engine for [EQ-Lab](../EQ-Lab), written in C++20 and shipped
to the browser as a single-file WASM module running inside a Web Worker.
No server, no network round-trip: the engine runs on the player's machine.

## Design highlights

- **Exact arithmetic.** Equation balance is decided over exact rationals
  (`src/rational.hpp`, int64 with __int128 intermediates) — no floating-point
  epsilon anywhere. This engine is the single source of truth for legality;
  EQ-Lab's TS validator re-checks every bot move before commit as a safety net.
- **Complete move generation** (`src/movegen.cpp`): Scrabble-style anchor
  generation adapted to A-Math — per-cell 26-token cross-check masks (exact,
  because the perpendicular tiles are fixed), a structural line automaton for
  prefix pruning, rack tile-kind counts (no permutation duplicates), and
  contact-distance pruning. Proven equal to a brute-force reference enumerator
  on random positions (`tests/test_engine.cpp`).
- **Solvers** (`src/engine.cpp`), chosen by the request's `solver` field:
  - *static* (`"solver":"static"`) — deterministic static-equity ranking over a
    complete root generation: immediate score + rack-leave − premium exposure
    (`src/eval.cpp`). One move generation per decision and no RNG, so the answer
    is a pure function of the request. This is what the `easy` tier runs; it
    replaced a sampling search that issued ~385 generations a turn and cost
    ~2.9 s at a tier asking for 200 ms. Root generation is bounded in DFS
    **nodes**, never wall-clock, so a loaded machine cannot change the move.
  - *sim* (default) — 2-ply simulation under hidden information: top-K
    candidates × sampled opponent racks from the unseen pool, common random
    numbers, sample-major order so early termination stays fair, budget-capped
  - *endgame* — when the bag is empty the opponent rack is known exactly
    (tile accounting); alpha-beta + Zobrist transposition table computes the
    game-theoretic final margin, including rack-out double bonus and the
    six-pass ending. Verified move-for-move against plain negamax
    (`tests/test_bot.cpp`).
- **Anytime + progress.** The engine reports phase / percent / ETA while it
  thinks and always returns a legal move (exchange/pass fallbacks included).

## Building

Native tests and CLI (needs clang++ with C++20):

```bash
make test        # rules + movegen completeness vs brute force
make test-bot    # endgame exactness vs reference negamax (slow, ~5 min)
make test-static # Level-1 static path: generation bound, determinism, legality
make cli         # build/amath_cli: bench | selfplay | golden | request
```

WASM (needs emscripten):

```bash
make wasm        # build/amath_engine.mjs (single file, ES module)
cp build/amath_engine.mjs ../EQ-Lab/src/bot/amath_engine.mjs
```

## Cross-checking against EQ-Lab

```bash
./build/amath_cli golden 60 99 build/golden.jsonl
cd ../EQ-Lab && npx tsx ../amath-engine/scripts/golden_check.ts ../amath-engine/build/golden.jsonl
```

Every corpus case (engine-generated moves + mutations) must get the identical
valid/invalid verdict and score from both implementations.

## Self-play

```bash
./build/amath_cli selfplay 6 easy easy-sim 555
```

Plays full games under real EQ-Lab rules (draw-to-8, exchange with delayed
tile return, rack-out and no-score-streak endings) and validates every move.

The tier names are the ones the service ships (`service/src/levels.ts`), so a
gauntlet compares what players actually get: `easy` (static), `easy-sim` (the
pre-static `easy`, kept so the two can be played head to head), `medium`,
`hard`, `max`. Reports win/loss, mean margin, pass/exchange mix, generation
calls per decision, and the latency distribution per side — a mean alone hides
the tail that decides whether a tier feels instant.

## Move generation (bounded & fair)

`generatePlaceMoves` defaults to complete, board-order enumeration (used by the
endgame solver and every test). The midgame decision path passes `GenOptions`:

- **`premiumOrder`** — anchors near premium squares are explored first, so a
  spent time budget never silently drops the board's best plays. (This fixed a
  real bug where blank-heavy racks let a 6M-node cap truncate the right side of
  the board, hiding a 148-point play behind a 64-point one.)
- **`dedup`** — collapses blank/choice *assignment* variants of the same
  physical placement, keeping the best-scoring one (leave and defense depend
  only on cells + kinds, not the assigned token). Bounds stored moves by board
  geometry, independent of blank count → RAM stays in single-digit MB even with
  four blanks in hand.
- **`budgetMs`** — wall-clock budget split evenly across both directions;
  device-independent (a slower device generates less of the long tail, never a
  biased region). The `test_engine` completeness + dedup checks guard both.

## Tuning (M5)

All hand-set weights are marked as **BIAS POINTS** in `src/eval.hpp`
(`LeaveWeights` + the `BoardContext`-driven leave model) and the difficulty
table in `src/engine.cpp` (`configFor`). Notable ones:

- `kindValue[]`, `equalsSchedule[]` — per-tile and per-`=` leave values.
- `zeroMulDivSynergy`, `zeroNoMulDivPenalty` — 0 plays well with ×÷, poorly with +−.
- `heavyBurden` — convex penalty for hoarding 10–20 tiles, eased by board openness.
- `leadDumpPenalty`, `trailFishBonus`, `exchangeTempoCost` — exchange appetite by
  score situation.
- `configFor()` search budgets: `simTopK`, `simSamples`, `genBudgetMs`,
  `defaultBudgetMs`, `endgameNodeBudget`.

The self-play harness in `src/selfplay.hpp` is the intended evaluation loop.
