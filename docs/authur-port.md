# Authur — porting the amath-bot-lab bot into the C++ engine and EQ-Lab

## Current integration status (2026-09-23)

Authur and Aether are separate opponents. EQ-Lab now has an Authur choice, a
persisted `botEngine` identity, a separate `authur_strong` archive/profile mode,
and a dedicated browser worker. The worker runs a self-contained browser build
of the **original TypeScript STRONG selector**, with its three original model
files. It does not call the Aether decision engine; the common room validator
and game-application path are reused. A service guard rejects any attempt to
ask Aether to play an Authur room. Browser/source decisions agree on one real
midgame and one bag-zero golden position; EQ-Lab's adapter also maps the bag-zero
choice to a legal move under its official validator.

This makes the browser path playable once
`EQ-Lab/supabase/authur_bot_migration.sql` is applied. The migration has **not**
been applied to a live database by this work. EQ-Lab refuses to create an Authur
room while the database would label it `aether_super`.

**C++ STRONG is still not the production Authur brain.** The C++ component
gates below pass, but selector composition, exact endgame, and chosen-move
parity are not finished. The browser bundle preserves the TypeScript choice;
it is not the requested C++ speedup. The annotate branching tree and
face-down/hand-picked tile model are also still in amath-bot-lab, not EQ-Lab.
Do not call the whole port complete on the strength of a playable bot turn.

The browser artifact is generated from
`amath-bot-lab/scratchpad/authur/browser-entry.ts` with esbuild and checked in
as `EQ-Lab/src/bot/authur/strong.mjs`. Rebuild from EQ-Lab with:

```
./node_modules/.bin/esbuild ../amath-bot-lab/scratchpad/authur/browser-entry.ts --bundle --format=esm --platform=browser --target=es2022 --minify --outfile=src/bot/authur/strong.mjs
```

Then copy the three files from `amath-bot-lab/public/models/strong/` to
`EQ-Lab/public/models/strong/` and run
`npx tsx scratchpad/authur/check-browser-bundle.ts` in amath-bot-lab.

Three repositories are involved and each owns a different part of this.

```
amath-bot-lab   TypeScript research lab. Owns STRONG (tier 1/2/3 PIMC, the tier-3
  (~20 000 LOC) danger ordering, the evaluator) and the bag-0 exact endgame ladder,
                plus a working annotate / branching tree and the face-down tile model.

amath-engine    C++20, ~15 300 LOC. Owns the SHIPPED engine: movegen, space map,
  (this repo)   eval, decision/opponent search, world deck, exact rationals. Builds a
                native `amath_cli` and a single-file WASM module. Already runs the
                `super` tier in a Web Worker on the player's device.

EQ-Lab          The React product. `aether_*` are its bot mode keys, persisted in
                Supabase and in archived game records. Its branching timeline is
                DESIGN ONLY — `EDIT_BOARD_BRANCHING_DESIGN.md` says so itself.
```

## Decisions taken

```
1  Authur's brain is a full port of STRONG into C++, replacing the search — not a
   graft of STRONG's two recent wins onto the existing engine.
2  The annotate / branching tree and the tile-picking model go into EQ-Lab as
   TYPESCRIPT. They are state machines and UI, not compute, and a WASM boundary
   would cost build complexity and serialisation for no speed.
3  Authur ships as NEW mode key `authur_strong` ALONGSIDE `aether_*`. Nothing existing
   is renamed. A Supabase migration IS required for database-side mode derivation
   and separate bot statistics; without it room creation refuses Authur.
```

Decision 3 pays for something decision 1 skipped. **Nobody has ever measured STRONG
against the existing C++ `super`** — they are different bots with different budgets
(STRONG: three tiers, 24/96/64 worlds, 4.8 s; `super`: a 160-sample schedule run to
completion, ~180 CPU-seconds a move). Shipping Authur beside Aether rather than over
it means the comparison happens in real games instead of never.

## The seam

`handleRequest` already selects a solver from the request (`src/engine.hpp:31`):

```
"solver": "sim" | "static"      ->  add "strong"
```

So Authur is a new solver in the existing protocol, not a new protocol. Everything
below the decision layer — board representation, move generation, the space map,
exact rationals, state transition — is reused only after Stage 0 checks the two
codebases against the same positions. That gate is the first piece of work, because
every later stage is built on it.

## Stage 0 — complete move-set corpus gate passed

The correct gate calls `generatePlaceMoves` with its default options: no time or node limit,
**no dedup**, and therefore every assigned face. A test-only executable in
`tests/authur_move_dump.cpp` reads the same board and rack as the TypeScript generator and
prints every canonical `(cell, physical kind, assigned face)` placement, immediate score, and
STRONG action ID.
It is not linked into the product or WASM. The companion harness is
`amath-bot-lab/scratchpad/authur/full-move-parity.ts`. Reproduce with `make authur-move-dump`
here, then run `npx tsx scratchpad/authur/full-move-parity.ts 100` from amath-bot-lab.

**Result: 100 harvested positions, 117,311 per-position TypeScript placement shapes, zero
missing C++ moves, zero extra C++ moves, zero score mismatches, zero action-ID mismatches.**
The original 40-position
subset also passes: 68,612 shapes, zero mismatches. This is strong finite-corpus evidence,
not a proof of equality on every possible board. A new rules change needs this gate rerun.

The earlier proposed `solver: "sim"` + lifted `topN` check would not have measured the
complete root set: `sim` first admits at most `cfg.simTopK` deduped footprints, then expands
only those survivors. Raising the report length cannot restore candidates never admitted.
No production clamp or routing was changed for this gate.

### Why the first attempt looked like a failure

**The first run reported a failure. It was measuring the wrong path, and the failure was mine.**

The harness drove `build/amath_cli` with `solver: "static"`, chosen because it is deterministic
— no RNG, no clock, a complete root generation. Against 40 harvested positions:

```
  IMMEDIATE SCORE differs                 0
  a C++ move TypeScript does not have     0
  ROOT MOVE COUNT differs                14        gaps from 4 moves to 14 506
  racks with no blank and no choice tile 20 of 20  agree exactly
```

Reproduced on the smallest board that shows it, `"7 = 7"` with a `+/-` and a `0`: TypeScript
produced `7 = 7 + 0`, `7 = 7 - 0` and `0 + 7 = 7`; the C++ produced the first and third. With a
REAL `-` tile instead of the choice tile, both engines agreed. So the difference was the
assignment of a choice tile, not any rule about subtracting zero — `rules.hpp:67` carries the
same `-0` rule as the TypeScript and rejects it on the same condition.

**Then `tests/test_assignment_expansion.cpp` explained it, and it is deliberate.** Its own
header says it: dedup collapses a FOOTPRINT — the same cells holding the same physical tile
kinds — to its highest-scoring member, and what it discards is the FACE a choice tile was going
to wear. That is "sound for ranking and unsound for everything after it", so the engine restores
every face by post-admission expansion before anything simulates against the resulting board.
The test exists because a forced win was once lost to exactly that collapse.

`solver: "static"` IS the ranking path. It is where the collapse is correct by design. Running
the same position on `solver: "sim"`, which is what the real bot uses:

```
board "7 = 7"   rack "+/-" and "0"
  static   C++ returns 2   — 7 = 7 + 0 , 0 + 7 = 7
  sim      C++ returns 3   — 7 = 7 + 0 , 7 = 7 - 0 , 0 + 7 = 7      ← expansion restored it
```

The count gap has the same explanation: `stats.moves` reports DEDUPED FOOTPRINTS, and the
TypeScript count is face-expanded moves. On `i6006/7` that is 59 against 70, and the eleven
extra are precisely the eleven choice-tile faces the diff had already isolated. The two numbers
were never the same quantity.

**At that point the two generators were not known to disagree, but Stage 0 was not finished.**
That uncertainty was resolved for the 100-position corpus by the complete-set gate above.
What the first attempt had established is worth keeping:

```
immediate scores agree exactly, on every move both engines produce, over 40 positions
the C++ set is never a superset — nothing it generates is missing from the TypeScript
racks with no blank and no choice tile agree on the complete count, 20 of 20
the one observed difference is a documented, deliberate, reversible dedup
```

The `static`/`sim` comparison above explains the misleading first result. The complete-set
gate at the start of this section supersedes the old suggestion to inspect a longer `sim`
candidate report.

## Stage 1 progress — what is built and gated

Four pieces of Authur's brain are ported and hold against the TypeScript original bit for bit.
`make test-strong` runs all four.

```
src/strong/forest.hpp        the gradient-boosted forests tiers 1 and 2 price a position with
  models/*.afst              reply-self, reply-opponent, next-turn — 300 trees, 18 300 nodes each
  GATE  1 200 predictions from real positions, 0 not bit-identical, largest difference 0

src/strong/keep_quality.hpp  the leave heuristic the cheap score and the shortlist rank by
  GATE  3 629 racks — every kind alone, 400 random racks at each size 0..8
        0 not bit-identical, largest difference 0

src/strong/features.hpp      the 57 base features plus five reply extras
  GATE  430 real states, 77 830 feature values and 1 290 end-to-end predictions,
        0 not bit-identical

src/strong/worlds.hpp        the shared seeded hidden-world schedule
  GATE  61 schedules / 244 sampled worlds, 0 mismatches; includes known opponent
        tiles, a pending-return pile, and a near-maximum seed
```

Both gates failed first, and both failures were the kind only an EXACT comparison finds:

```
the forests    TypeScript ends `s < 0 ? 0 : s` — these predict an expected SCORE and a turn
               cannot score less than nothing. The floor is part of the model, and 6 of the
               first 1 200 cases land below zero.
keepQuality    `-O2` contracted `shape + points * 0.15` into an FMA, which rounds once where
               JavaScript rounds twice. One ulp, 23 of 3 629 racks — and one ulp is enough to
               break a tie the other way and return a different move.
```

The forests are NOT embedded in the binary. Their source JSON files currently live in
amath-bot-lab, **not** EQ-Lab; EQ-Lab must receive the three `.afst` files when the Authur
worker is wired. `scratchpad/authur/convert-forests.ts` in amath-bot-lab writes the flat format.
The earlier statement that EQ-Lab already served them was incorrect.

The feature corpus includes 92 bag-zero states, 111 with a blank in a rack, 308 with a choice
tile in a rack, 15 empty-board states, and 26 with a nonempty no-score tail. Regenerate
`tests/strong_feature_cases.json` with
`amath-bot-lab/scratchpad/authur/dump-feature-cases.ts`; run `make test-strong-features`.
The forests split on at most the first 57 fields; the five reply extras are reproduced because
they are still part of STRONG's input vector. This is a component gate, not a claim that
Authur can select a move in EQ-Lab yet. Stage 0 passes on the 100-position corpus, but chosen
move parity is a separate gate that remains outstanding.

The action-ID calculation is also ported in `src/strong/move_id.hpp`: all 117,311 Stage 0
placement IDs match TypeScript, including assigned `×` and `÷` faces. This matters because
the selector breaks score ties by ID, not generator order.

**Still to build, in order:** the selector itself — complete generation, cheap score, the
diverse shortlist, tiers 1/2/3 with danger ordering, and the margins that make a non-PLACE
clear the best PLACE. Then `solver: "strong"`, the WASM build, and EQ-Lab's `authur_*` modes.

## Stages, each with the gate that ends it

```
0  RULES PARITY                                          ← CORPUS GATE PASSED
   Complete PLACE sets and scores match on 100 real positions (117,311 shapes).
   This is not a universal proof; rerun when either generator/ruleset changes.

1  THE PORT, BOTTOM UP
   1a  evaluator terms                     gate: term-by-term equality vs TS
   1b  world sampling + determinizer       gate: identical worlds for a seed
   1c  tier 1/2/3 selector + danger order   gate: identical chosen move vs TS
   1d  bag-0 exact ladder                   gate: identical verdict + margin vs TS,
                                                  and vs the brute-force oracle
   Each gate compares against the TypeScript original on the SAME positions. A port
   that is merely "about as strong" is a different bot and is not what was asked for.

2  WASM + EQ-Lab WIRING
   `solver: "strong"` reachable from the browser worker; `authur_*` mode keys added
   beside `aether_*`.
   Gate: a real game played end to end by Authur, client-side.

3  ANNOTATE / BRANCHING + TILE PICKING (TypeScript, EQ-Lab)
   Port the immutable node tree and the face-down tile model.
   Gate: the branching contract in EDIT_BOARD_BRANCHING_DESIGN.md, which is
   currently unimplemented, holds.
```

## Risks named up front

```
The two engines may not agree about the rules.        Stage 0 exists to find out.
STRONG may not be stronger than `super`.              Decision 3 lets real games say.
STRONG's evaluator has terms proved inert or          Port what the measurements
  double-counting (see amath-bot-lab's docs).         support, not the whole file.
The port is a rewrite, not a translation: TS
  idioms (Map keys as strings, closures per node)
  are what C++ has to stop doing to be fast.
```


---

## Handover status, and the blocker the next session meets first

### What plays today

**Authur plays in EQ-Lab, and its brain is the ORIGINAL TypeScript STRONG in a Web Worker —
not this C++.** Aether and Authur are separate bots over one room/game/history layer, chosen
when the room is created, and `supabase/authur_bot_migration.sql` adds `bot_engine` with
`aether` as the default so no existing room changes. Verified here: typecheck clean, production
build clean, and `tests/authur-request.test.ts` passes six checks including that Authur finds
STRONG's own winning move from an EQ-Lab game state, that the real opponent rack and bag are
never handed to it, and that a partial bag-zero answer is never reported as a proven win.

One EQ-Lab test fails and it is NOT from this work: `tests/engine-in-browser.test.ts` asserts
this repo's Makefile has a `wasm-mt:` target, and HEAD has never had one.

### C++: ported and gated

```
src/strong/forest.hpp        3 forests   GATE 1 200 predictions, 0 not bit-identical
src/strong/keep_quality.hpp  the leave   GATE 3 629 racks,       0 not bit-identical
src/strong/features.hpp      57 / 62     GATE 430 states, 77 830 values, 1 290 predictions
src/strong/worlds.hpp        determinizer GATE 244 draws
src/strong/move_id.hpp       move ids    GATE 117 311 shapes
src/strong/selector.hpp      DECLARED ONLY — no implementation yet
```

Stage 0 is also closed, properly: a complete-root dump on both sides over 100 positions and
117 311 shapes found no move missing, no move extra and no score different. That replaces the
`sim` + raised-`topN` idea suggested earlier here, which could only ever show ADMITTED
candidates and so could not have proved it.

### The blocker

**`sampleWorlds` deals in tile ID strings; `SearchState` has none.** The determinizer matches
the TypeScript bit for bit precisely because it shuffles the same ID list in the same order —
that is what its 244-draw gate proves. The engine's own state carries `TileCounts` and a
`vector<uint8_t>` bag, which cannot reproduce that shuffle, and a kind-level sampler would draw
different worlds and quietly stop being STRONG.

So a C++ `solver: "strong"` cannot use the existing request shape unchanged. It needs the
unseen pool AS IDENTIFIED TILES — the ids EQ-Lab's tilebag already assigns and
`buildAuthurRequest` already sends to the TypeScript worker. Either the request carries them,
or the worlds are sampled on the EQ-Lab side and handed down. That choice should be made before
`selector.cpp` is written, because it decides the function's signature.

### Order of what is left

```
1  decide the ID question above, then implement selector.cpp
     cheap score -> diverse shortlist -> tiers 1/2 -> margins
     GATE against TypeScript STRONG run with `tier3Rounds: 0`, which the original supports,
     so the port can be gated exactly before tier 3 exists
2  tier 3: the real bounded opponent reply, ordered by danger (D1)
3  solver: "strong" in handleRequest, then `make wasm`, then EQ-Lab points Authur's worker
     at the WASM instead of strong.mjs
4  annotate / branching tree  — amath-bot-lab `src/core/tree.ts` is 120 lines and self-contained
5  the face-down tile model   — EQ-Lab's branching design doc specifies the contract already
```

Items 4 and 5 have not been started. Item 3 is what makes Authur C++ rather than TypeScript;
until it lands, Authur is correct but not faster.
