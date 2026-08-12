# Level 1 fast path — diagnosis, assessment, and technical specification

**Revision 2.** Design only; no code changed.
**Subject:** the `easy` bot tier (`service/src/levels.ts` → `budgetMs: 200`; UI label
"Instant", strength bar 1/4 in `EQ-Lab/src/components/pages/pregame/BotRoomPanel.tsx`).

## What changed in revision 2, and why

New measurements contradicted three load-bearing pieces of revision 1. All three
are now removed or replaced:

| rev 1 said | measurement | rev 2 says |
|---|---|---|
| Replace `bestPlaceScore` with a `δ^missing` PotOracle over the root move list | Spearman vs truth **0.517**, against **0.543** for omitting the term entirely | **Drop the self-potential term at L1.** No PotOracle. §4.2 |
| Cap root generation at `genBudgetMs = 50` | a 50 ms cap **lost the best move in 1 of 14 positions** (best static equity 119.5 → 98.7) | **Do not time-cap. Node-cap generously.** §4.4 |
| Build a `CELL_THREATS` reverse index for incremental ΔThreat | full 50-entry threat map recompute is **< 1 µs**; evaluating all 12 208 root moves inside the generation callback costs **~8 ms total** | **No incremental machinery. Recompute per candidate.** §4.3 |

Two further results settle questions raised in the review:

- Engine **process spawn + stdio round trip is 0.9 ms p50** — not a latency factor.
- Root generation is **DFS-bound, not storage-bound**: `dedup`+store, stream-only,
  and stream+full-evaluation are all within noise of each other.

Everything in §2 (the original diagnosis) is retained, with one correction to how
the seed-instability result must be stated (§2.4).

---

## 1. Executive summary

**Current Level 1:** ~2 874 ms mean, 96.9 % of it in two move-generation call
sites, producing a move that is essentially a hash of the game id.

**Proposed Level 1:** one exact root generation with the full heuristic evaluated
inside the generation callback, then at most 7 further generations for selective
verification. **p50 ≈ 25 ms, p95 ≈ 300 ms**, fully deterministic, expected
stronger.

The single most important structural fact, and the one that shapes everything
else: **every non-movegen component of this design is free.** The threat map, the
leave value, the ranking — all of it costs under a microsecond per candidate, and
evaluating 12 208 candidates inside the generator's own callback added ~8 ms to a
576 ms generation. There is therefore no reason to prune before evaluating, no
reason to cache across turns, and no reason to move anything to the frontend.
**The only quantity worth managing in this design is the number of full move
generations.**

---

## 2. Diagnosis (retained from revision 1)

### 2.1 The budget does not bind

`simulate()` commits a sample only when every candidate has been evaluated against
it, and cannot break out before three committed samples
([engine.cpp:379](../src/engine.cpp), [:471](../src/engine.cpp)). The floor is
`3 × candidates × 2` generations regardless of `budgetMs`. `service/src/levels.ts`
documents the symptom; this is the mechanism.

### 2.2 Where the time goes

Level 1 (`budgetMs=200`), 15 turns of self-play, seed 42 — 43 117 ms total,
**mean 2 874 ms/move**:

| component | ms | share |
|---|---:|---:|
| `oppReplyValue` movegen (183 calls/turn) | 22 620 | **52.5 %** |
| `bestPlaceScore` movegen (202 calls/turn) | 19 141 | **44.4 %** |
| root `generatePlaceMoves` | 1 340 | 3.1 % |
| `staticEquity` ranking of all root moves | 2.5 | 0.006 % |

Per call: `oppReplyValue` ≈ 10.6 ms, `bestPlaceScore` ≈ 8.8 ms.

### 2.3 Findings that constrain the design

- **`placeMemo` is dead mid-game**: 0 hits in ~2 700 lookups (it only fires at
  bag 0). It allocates a `std::string` key per lookup on the hot path.
- **Per-call optimisation is unavailable**: reusing `IncrementalBoard`'s
  maintained cross/contact state saves **0.053 ms of an 8.26 ms call (0.6 %)**.
  The cost is the DFS. Only the *call count* is a lever.
- **The 3-sample estimator underperforms free static equity.** Against a 24-sample
  reference over 12 positions: static equity picks the reference move 6/12 with
  mean equity loss 5.30; Level 1 picks it 2/12 with loss 7.99. Mechanism: `argmax`
  over ~68 candidates each estimated from 3 samples is a winner's-curse machine,
  and the `mean − λ·stddev` ranking key estimates `stddev` from those same 3
  samples.

### 2.4 Correction: the seed result is arbitrariness, not flakiness

Revision 1 reported that six RNG seeds produce ~4.6 distinct choices per position,
with half the seeds playing a ~70-point equation and half passing for zero.
**The measurement stands, but the framing must be corrected.**

`service/src/adapter.ts::seedFor` hashes `gameId:revision`, so in production **the
same position always produces the same seed and the same move.** Level 1 is
already reproducible per (game, revision).

The defect is therefore not that the bot flakes between requests. It is that
**which of those wildly different moves the bot plays is decided by a hash of the
game id** — a quantity with no relationship to the position. That is at least as
bad, and it means "decision stability" must be measured by *seed sensitivity*
(varying `AdapterOptions.seedSalt`, which already exists), not by re-running the
same request.

---

## 3. Review of the revision-2 proposals

### 3.1 Primary objective — **agree**

Spend saved budget on strength. But the measurements redirect *where*: not on
self-potential (§4.2, it cannot be approximated and is not missed), but on
**(a) not truncating root generation** and **(b) selective opponent verification**.

### 3.2 The invariant — **agree, and sharpen it**

Your form ("no L1 loop should invoke full move generation proportional to the
total root candidate count") is right but permits a shortlist of 60 × 4 samples.
Since generation count is now the *only* cost that matters, bound it absolutely:

> **L1 generation budget invariant.** A Level-1 decision performs exactly one
> exact root generation, plus at most `V_MAX = 8` further full generations, where
> `V_MAX` is a compile-time constant independent of the number of root moves,
> candidates, samples, or board contents.

This is directly testable: add a counter to `GenStats` (or a translation-unit
counter incremented in `generatePlaceMoves`/`generatePlaceMovesStream`) and assert
`calls ≤ 9` over a corpus of positions. Make it a unit test, not a convention —
the current design regressed into 385 calls/turn precisely because nothing
counted them.

### 3.3 Strengthen PotOracle — **disagree; delete it instead**

See §4.2. Both cheap models were measured and neither beats omitting the term.

### 3.4 Threat must cover all live areas — **agree; it always did, and here is the sharpened form**

Revision 1 computed `Threat(board)` over the full 50-entry table and
`Threat(board+c)` likewise; `ΔThreat` was the difference. Your concern is
addressed, and the wording is now explicit in §4.3. One refinement adopted from
your framing: aggregation moves from `max + γ·second` to a **top-3 geometric**
form, because "an existing area becomes more reachable" and "a new area appears
alongside an existing one" are both cases where the second and third best threats
carry the signal.

A property worth stating, because it is a *feature*: when the board's top threat
is one we cannot touch, `ΔThreat ≈ 0` for every candidate and immediate score
correctly dominates. The model does not flail at threats it cannot affect.

### 3.5 Incremental Board Intelligence — **disagree, on measurement**

| operation | cost |
|---|---|
| full 50-entry threat map, from scratch | **< 1 µs** |
| threat map re-evaluated per candidate | 0.1 – 0.65 µs |
| leave + threat evaluation for **all 12 208** root moves, inside the generation callback | **~8 ms** (576.3 ms stream-only → 584.6 ms stream+eval) |
| `IncrementalBoard::rebuild()` (cross masks, needed once) | 0.045 ms |

There is nothing to amortise. Cross-turn or cross-request maintenance would save
under a millisecond and would cost:

- a cache keyed by `(gameId, revision)` with an invalidation story;
- a correctness surface — a stale or wrong map silently degrades play, and unlike
  an illegal move nothing would catch it;
- the **"nothing is retained between requests"** property that
  `service/src/engineRunner.ts` deliberately provides ("no request can influence
  the search of another"), which is a real isolation guarantee on a shared server.

**Recommendation: compute all board intelligence from scratch at the start of each
engine request.** Keep it as a plain function of `(Board, unseen, rackSizes)`.

The distinction you drew is exactly right and this is which side of it we land on:
incrementally maintaining *cheap reusable features* would be valuable **if the
features were expensive**. They are not. They are 1 µs.

### 3.6 Frontend precomputation — **disagree; drop the idea entirely**

1. **There is nothing expensive to move.** The candidate work is < 1 µs. Everything
   costly (root generation) depends on the board *after* the human's just-committed
   move and cannot be precomputed during their turn.
2. **Transfer costs more than compute.** A useful payload (cross masks alone are
   225 cells × 26-bit plus fixed sums) is a few KB of JSON. Parsing it server-side
   would cost more than the ~1 µs it replaces, before any validation.
3. **Validating it *is* recomputing it.** There is no cheap verification of a
   threat map short of deriving it.
4. **Trusting it is a trust regression and a griefing vector.** `adapter.ts` states
   the model plainly: the client names a game and a revision, the server reads what
   is true. A client-supplied evaluation input would be the only exception, and a
   manipulated map makes the opponent's bot blunder — undetectably.
5. **Latency does not need hiding.** Process spawn is 0.9 ms p50; the engine's own
   p50 becomes ~25 ms.

Of your options A/B/C, the answer is **A, degenerate** — the server derives it,
from scratch, per request, because it is free. This is a case where the honest
answer is that the optimisation has no target.

### 3.7 Threat and self-evaluation as shared consumers — **agree, with reduced scope**

The threat map is already parameterised by `(board, rackSize, side's pool)`; the
self-side reading is the same function with our rack size. Keep it one module with
that parameter. But since the self-potential term is dropped (§4.2), the second
consumer is dormant at L1 — it exists for L2+ and for move ordering.

### 3.8–3.10 Preserve findings / don't redesign L4 / rack inference secondary — **agree**

With one correction to revision 1: I claimed tiles in the opponent's
`pendingReturn` are "exactly" excludable from their rack, calling it a free
inference win. **That was overstated.** `adapter.ts` folds `pendingReturnSize`
into `bagCount` deliberately, to keep `unseen.total == oppRackCount + bagCount` —
the exact predicate the endgame path tests. Changing the count would break endgame
eligibility. And since the returned tiles are unidentified, the only real signal is
second-order (they discarded their *worst* tiles, so the remaining pool is
marginally better than uniform). Not worth acting on at any tier.

### 3.11 Evaluation must measure strength and stability — **agree**, see §7.

### 3.12 Desired end state — **agree**, with stages 1 and 2 fused (§4.1).

---

## 4. Revised architecture

### 4.1 Pipeline

Stages 1–2 of revision 1 collapse into the generation callback, because evaluation
inside the stream was measured free.

```
Stage 0   PREPARE                                            ~50 µs, once per request
          IncrementalBoard::rebuild()      → cross masks, both directions
          BoardContext                     → mobility, freshTileValue, scoreDiff
          ThreatMap(base)                  → 50 entries, full evaluation

Stage 1   GENERATE + EVALUATE              1 generation, DFS-bound
          generatePlaceMovesStream(premiumOrder, nodeLimit)
          per emitted move, inside the callback:
              score            (exact, from the generator)
              leave            (leaveValue on rack − used)
              ΔThreat          (ThreatMap re-evaluated on board+c)
              V(c) = score + leave − ω·ΔThreat + situational
          keep a bounded top-K heap (K = 16) + mandatory inclusions
          → NO materialised move list, NO dedup map, NO second pass

Stage 2   EXCHANGE / PASS                  0 generations
          enumerateExchanges + pass, scored on the same scale

Stage 3   VERIFY (conditional)             ≤ 8 generations, bounded constant
          for the top K2 = 3 candidates × 2 deterministic opponent racks:
              real generatePlaceMoves on board+c → exact opponent best reply
          replace ω·ΔThreat with the measured value for those candidates

Stage 4   DECIDE + REPORT                  unchanged response contract
```

Total generations: **1 + (0 or 6)**. Independent of candidate count. Satisfies
§3.2's invariant with `V_MAX = 8`.

### 4.2 Self next-turn potential — **removed**

Two cheap models were built and measured against the true quantity
(`bestPlaceScore(board+c, leftover+draw)` averaged over 4 real draws), across 14
positions, ranking 30 candidates each:

| model | Spearman vs truth | top-1 agreement |
|---|---:|---:|
| `δ^missing` over the top-256 root moves (revision 1's PotOracle) | 0.517 | 7/14 |
| SelfOpportunity (threat map read for our own next rack) | 0.550 | 5/14 |
| **omit the term entirely** | **0.543** | **6/14** |

Neither proxy is distinguishable from dropping the term. The reason is structural,
not a tuning failure: **after playing `k` tiles you draw `k` new ones, so most of
your real follow-ups use tiles that were not in the rack when the root list was
generated.** A root list produced from the current 8 tiles cannot contain them. The
subset it *can* represent — follow-ups affordable from the kept tiles alone — is
small and unrepresentative.

Supporting evidence from §2.3: the one policy measured that omits potential
entirely (static equity) outperformed the one that includes it (the L1 sim).

**Decision:** Level 1 carries no self-potential term. `leaveValue` already encodes
rack quality, which is the part of "future potential" that is cheaply knowable.
Re-adding a potential term requires evidence that it improves *play*, not that it
reproduces `bestPlaceScore` — which is itself an unvalidated heuristic weighted by
a hand-set `β = 0.6`.

### 4.3 Threat map

#### Geometry (verified against `src/board.hpp`)

Equation multipliers multiply within one move (`mainMult *= eqMult`,
`src/movegen.cpp:392`). Enumerating collinear equation-premium cells on the 15×15
layout gives a fixed table:

| combo | count | lines | minimum span |
|---|---:|---|---:|
| ×9 (EX3+EX3) | 14 | rows/cols 0, 7, 14 | **8** cells |
| ×4 (EX2+EX2) | 12 | rows/cols 1, 2, 3, 11, 12, 13 | **9** cells |
| ×27 (EX3×3) | 4 | rows/cols 0 and 14 | 15 cells |
| ×6 (EX3+EX2) | **0** | — | — |

> **×6 cannot occur.** EX3 cells lie only on rows/columns {0, 7, 14}; EX2 cells
> only on {1, 2, 3, 11, 12, 13}. No shared line. Do not implement a ×6 case.

Plus 20 single-cell entries (8 EX3 at ×3, 12 EX2 at ×2). **Total 50 entries**,
all `constexpr`, generated by a committed script with a test asserting the table
matches a runtime enumeration of `PREMIUM`.

```cpp
struct ThreatEntry {
  uint8_t dir;        // 0 = row, 1 = col
  uint8_t line;       // row/col index
  uint8_t from, to;   // inclusive offsets along the line (single: from == to)
  uint8_t mult;       // 2, 3 | 4, 9, 27
  uint8_t premCount;
  uint8_t premPos[3]; // offsets of the equation-premium cells
};
constexpr ThreatEntry THREATS[50];
```

No reverse index. Measurement (§3.5) says a full 50-entry pass is cheaper than the
bookkeeping to avoid it.

#### Per-entry evaluation

```
entryValue(e, board, cross, rackSize, eTile) -> float
  for p in e.prem:  if board[p] occupied         -> 0     // premium already spent
  walk span [from, to]:
      occupied -> fixedPts += TILE_POINTS[kind]; touches = true
      empty    -> if cross[cell].mask == 0       -> 0     // structurally dead (EXACT)
                  if cross[cell].has -> touches = true
                  need++;  multSum += tileMult(cell)      // PX2/PX3
  if need == 0                                   -> 0     // nothing left to place
  if need > rackSize                             -> 0     // unreachable this turn
  if !touches && board not empty                 -> 0     // no legal attachment
  payoff = e.mult * (fixedPts + eTile * multSum)
         + (need >= RACK_SIZE ? BINGO_BONUS : 0)
  return REACH[need] * payoff
```

`cross` is the direction-appropriate maintained mask (`crossV` for row entries,
`crossH` for column entries) from `IncrementalBoard`. This is an **exact**
structural filter, and it is the single most valuable cheap term here.

`eTile` = mean tile points of the live unseen pool (1.80 over the full
distribution). `REACH[0..8]` is a calibrated 9-entry table — placeholder shape
`{0, .55, .40, .28, .18, .11, .06, .03, .012}` — fitted at Gate 3.

Refinement to implement that the prototype approximated: **maximality**. If the
cell immediately outside `[from, to]` is occupied, the equation extends and the
span must extend with it before `need` is counted. Walk outward until an empty or
off-board cell is reached.

#### Aggregation, before and after, and the delta

```
ThreatMap(board, rackSize) = the full 50-entry vector           // ALL live areas
aggregate(v, γ=0.25)       = t1 + γ·t2 + γ²·t3                  // top three, geometric

ThreatBefore = aggregate(ThreatMap(board,     oppRackSize))
ThreatAfter  = aggregate(ThreatMap(board + c, oppRackSize))     // FULL recompute
ΔThreat(c)   = ThreatAfter − ThreatBefore
```

`ThreatAfter` is a complete re-evaluation, not a patch. It therefore captures every
case in your list without special handling: a candidate can open a new area, make
an existing one more or less reachable, consume a premium cell (entry → 0), reduce
the opponent's `need` by filling span cells (entry rises — a real danger the
current model cannot see), or shift which area is top-ranked.

This replaces `defensePenalty` (`src/eval.cpp:121–147`), which **sums** a flat
4.0 / 2.0 / 1.2 per orthogonally adjacent premium cell, with no reachability, no
legality, and no notion of combination. Three modelling bugs, one replacement.

Exchange and pass get `ΔThreat = 0` by construction, keeping them on the same scale.

### 4.4 Root generation — the entire remaining cost

Measured, 14 positions:

| statistic | value |
|---|---:|
| median | **16 ms** |
| mean | 99 ms |
| max | 608 ms (12 162 moves, 9.70 M nodes) |
| throughput | ~16 nodes/µs (≈62 ns/node) |

The distribution is severely skewed: **11 of 14 positions complete in under
31 ms**; three expensive positions carry the mean.

**Wall-clock caps must go.** They are the last remaining source of
machine-dependent nondeterminism: a busy server generates fewer moves and can pick
a different move for the same position. Replace `GenOptions::budgetMs` with
`GenStats::nodeLimit` at L1 — the generator already supports it
(`src/movegen.cpp:345`) and it is exactly reproducible.

**Set the cap generously.** A 50 ms cap was measured to lose the best move in 1 of
14 positions (best static equity 119.5 → 98.7 at turn 5) — `premiumOrder` saved
the other two truncated positions, so it is doing its job, but not perfectly.
Recommended `nodeLimit = 12'000'000` (≈750 ms worst case) as a pathological-position
rail only; it does not bind on any position measured. If p95 latency later proves
unacceptable in production, tighten to 4 M (≈250 ms) **and re-run Gate 5**, not
before.

Streaming vs. materialising was measured and is a wash (dedup+store 608.0 ms,
stream-only 576.3 ms, stream+full-evaluation 584.6 ms at the worst position). Use
the streaming form anyway, because it removes the `std::string`-keyed dedup map and
the 12 000-element move vector for free, and because it is what makes Stage 1's
fusion natural. Note that streaming does **not** dedup, so blank-assignment
variants of one placement are evaluated more than once (12 208 vs 12 162 — a 0.4 %
overhead here, larger with four blanks in hand); the top-K heap must therefore
dedup by `(cells, kinds)` footprint on insert, keeping the best-scoring variant.

*Future lever, not in scope:* 9.70 M nodes for 12 162 stored moves is ~800 nodes
per surviving move, which points at blank/choice-tile assignment fan-out inside the
DFS. Pruning assignments against the cross-mask earlier would attack the only
remaining cost in this design. It is engine surgery and should be a separate
project with its own completeness proof.

### 4.5 Selective verification — where the saved budget goes

The danger term is the one significant approximation left. Verify it where it
decides, using **deterministic** opponent racks so no RNG re-enters L1:

```
R1 = expected-composition rack: the 8 tiles maximising expected count from the
     unseen pool, ties broken by tile kind index      (deterministic)
R2 = structural rack: bias toward '=', operators and blanks — the composition that
     most enables a long premium-spanning equation    (deterministic)

trigger verification if ANY of:
  V(#1) − V(#2)  <  τ_close   (4.0 points)     // heuristic cannot separate them
  |ΔThreat(#1)|  >  δ_big     (12 points)      // the estimated term is deciding
  a live entry has mult ≥ 9 and need ≤ oppRackSize
  #1 is an exchange or a pass
  bagCount ≤ 8

then for the top K2 = 3 candidates × {R1, R2}:
  generatePlaceMoves(board + c, R_i, nodeLimit = 200'000)
  oppBest_i = max staticEquity over replies
  V(c) ← score + leave − mean_i(oppBest_i) + situational
```

Cost: 6 generations ≈ 60 ms, only when triggered. Deterministic racks are the key
choice — they trade sampling breadth (which the threat map's probabilistic `REACH`
term already provides) for exact structural information about one concrete
position, without reintroducing seed dependence.

**Second use of the saved budget:** the exact endgame proof. At L1 it currently
receives `200 × 0.92 = 184 ms` and is additionally gated by
`endgameExactTilesMax = 13`. Once the midgame path costs ~25 ms, give L1's endgame
path a real budget (400–600 ms). This is a *proof* — it cannot make the bot weaker,
only slower, and only in positions where being right is worth the most.

### 4.6 What is computed where

| quantity | frequency | cost |
|---|---|---|
| cross masks (`IncrementalBoard::rebuild`) | once per request | 45 µs |
| `BoardContext` | once per request | ~10 µs |
| `ThreatMap` base + `ThreatBefore` | once per request | < 1 µs |
| `REACH`, `eTile`, hypergeometric constants | once per request | ~1 µs |
| exact score | per candidate (from the generator) | 0 |
| `leaveValue` | per candidate | ~0.2 µs |
| `ThreatAfter`, `ΔThreat` | per candidate | ~0.5 µs |
| top-K heap insert + footprint dedup | per candidate | ~0.1 µs |
| exact opponent reply | **shortlist only**, ≤ 6 total | ~10 ms each |
| endgame proof | when eligible | budgeted |

---

## 5. Minimum architecture to replace Level 1 safely

You asked for the floor, separated from the improvements. The floor is unusually
low, because the replacement already exists in the codebase.

### MVP — "static L1"

`handleRequest` already has a complete static path
([engine.cpp:1497–1514](../src/engine.cpp)): rank all root moves by `staticEquity`,
compare against exchanges, return the best, report via `buildGreedyReport`. It runs
only when `oppRackCount == 0`. Route Level 1 to it.

Required changes, in full:

1. **Solver selection.** Add an explicit request field — `"solver": "static"` —
   rather than gating on a budget threshold. Implicit budget gating is how the
   current floor came to defeat the nominal 200 ms in the first place.
   `service/src/levels.ts` sets it for the `easy` tier.
2. **Determinism.** Replace `genOpts.budgetMs` with `GenStats::nodeLimit`
   (12 M) on this path.
3. **Ordering.** Leave the endgame path where it is — ahead of solver selection —
   so L1 keeps the exact proof when it is eligible.

Expected: **p50 ≈ 16 ms, mean ≈ 99 ms**, deterministic, and — per §2.3 — already
closer to a 24-sample reference than the current Level 1. Everything else in this
document is a strength improvement layered on a shipped win.

### Improvements, in the order their evidence supports

| # | change | why it is not in the MVP |
|---|---|---|
| I1 | ThreatMap replaces `defensePenalty` | needs `REACH`/`ω` calibrated; an uncalibrated map could be worse than the crude-but-tuned status quo |
| I2 | Streaming generation + fused evaluation + top-K heap | pure latency/allocation win, no behaviour change; land after I1 so the evaluation being fused is the final one |
| I3 | Selective verification (§4.5) | depends on I1's shortlist being trustworthy |
| I4 | Larger endgame budget at L1 | independent; can land any time |
| I5 | L2/L3 re-tiering, opponent reply-set reuse | separate gauntlets |
| I6 | Belief model / particle filter (L3–L4) | explicitly secondary |

---

## 6. Opponent reply reuse — retained for L2+, not L1

For tiers that still want many opponent racks, invert the loop: generate the reply
set **once per rack on the base board**, keep the top 64 as
`{value, cellMask, score}` tuples, then per candidate take the max over replies
whose `cellMask` does not intersect the candidate's. Cell-blocking is exact;
cross-check invalidation is ignored, which can only *over*-estimate the opponent
(errs toward caution); replies newly enabled by our tiles are covered by `ΔThreat`.

This turns `|C| × S` generations into `S`. It is not needed at L1 (S = 0) and
should be gated on its own ranking-correlation test at L2.

---

## 7. Evaluation plan

Every metric below is required before flipping a tier. The harnesses from this
investigation (`selfplay`, plus a seed-salt sweep) cover all of them.

**Latency:** mean, p50, p95, p99 over ≥ 500 positions spanning all game phases.
**Generation count:** mean and max `generatePlaceMoves` calls per decision.
Enforce `≤ 9` as a unit test (§3.2), not just a measurement.

**Strength:** ≥ 400 self-play games vs current L1, alternating first move; report
win rate, mean margin, and the margin's confidence interval. Then ≥ 200 games vs
`hard` as a stronger reference, to confirm the gap to a real search did not widen.

**Behaviour:** pass frequency, exchange frequency, mean tiles played per turn,
mean score per turn. A fast bot that quietly starts passing more is a regression
these numbers catch and win rate might not.

**Tactical safety:** count positions where the chosen move's immediate score is
more than 25 points below the board's best available score. This is the
"catastrophic mistake" detector; today's L1 will fail it (§2.4's turn-2 case).

**Stability — measure it correctly.** The same request is already deterministic
(§2.4). Measure **seed sensitivity**: re-run each position with 6 values of
`AdapterOptions.seedSalt` and report distinct-choice count. Current L1 scores 4.62
of 6. The replacement must score **1.00 of 6 by construction** — any other result
means nondeterminism leaked in (a wall-clock cap, an unordered container iterated
in hash order, or a re-introduced RNG), and should be treated as a bug rather than
a tuning issue.

---

## 8. Gating strategy

| gate | phase | pass condition |
|---|---|---|
| G0 | Corpus: dump `(position, candidate, oppReply, mean)` from the max tier over ~2 000 positions | corpus builds; no behaviour change |
| **G1** | **MVP: route L1 to the static path, node-capped** | seed sensitivity = 1.00/6; generation count ≤ 1; p50 ≤ 40 ms; **≥ 400-game gauntlet vs current L1 shows no loss**; golden corpus + `make test` + `make test-bot` unchanged |
| G2 | ThreatMap module + generated tables | table matches runtime enumeration of `PREMIUM`; `entryValue` never exceeds the true best opponent score found by brute-force movegen over ≥ 200 random positions |
| G3 | Calibrate `REACH`, `ω`, `γ` against the G0 corpus | held-out R²(ΔThreat → measured `oppReply`) ≥ 0.6, residuals unbiased across game phase |
| G4 | ThreatMap replaces `defensePenalty` at L1 | gauntlet vs G1 build shows a gain; tactical-safety count does not rise |
| G5 | Streaming + fused evaluation + top-K heap | identical chosen move to G4 on ≥ 500 positions (this is a pure refactor); p95 improves |
| G6 | Selective verification | gauntlet vs G4; generation count ≤ 9 enforced by test |
| G7 | L2/L3 re-tiering; reply-set reuse | per-tier gauntlets |
| G8 | Belief model | gauntlet vs G7 |

Invariants at every gate: golden corpus cross-check against EQ-Lab's validator
passes; `make test` / `make test-bot` pass; the endgame path is untouched; every
returned move is legal.

---

## 9. Data contracts

**No frontend changes.** §3.6.

**Engine request:** one new optional field for the MVP —
`"solver": "static" | "sim"` (absent = current behaviour). The belief model, if it
ever lands, adds an optional `opponentHistory` array of **redacted** public turns;
the event log's `exchange.tiles` and `draw.tiles` carry real `TileOrdinal`s and
must never reach the engine. Give the projection its own type
(`PublicTurn`, counts only) and unit-test that no ordinal survives it.

---

## 10. Open questions

1. **Is the empty-board exchange preference real?** With 24 samples the current
   model prefers exchanging over any opening placement, repeatedly, until the
   six-pass rule ends the game (reproduced while building the harness). It
   suggests the 2-ply value function over-weights the opponent's immediate reply.
   Not caused by anything here and not fixed by anything here — but it will distort
   any calibration done against self-play, so resolve it before G3.
2. **Should `ω` vary by phase?** Exposure late in the game has fewer turns to be
   punished. Cheap to add as an interaction term; let the G3 fit decide.
3. **Does the blank-assignment fan-out in the DFS admit early cross-mask pruning?**
   ~800 nodes per surviving move at the worst position says yes. It is the only
   cost left after this work, and it needs its own completeness proof.
4. **Is a self-potential term worth recovering at all?** §4.2 removed it on
   evidence that no cheap proxy reproduces it *and* that omitting it is fine. If a
   future gauntlet shows setup play is weak, the right experiment is exact
   follow-up generation for the shortlist only (≤ 3 more generations), not another
   cheap proxy.
