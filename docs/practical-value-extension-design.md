# Practical Value Extension — design


> **Superseded.** See [practical-value-extension-review.md](practical-value-extension-review.md), which measured this design against the engine and rejects its two central mechanisms.
Date: 2026-08-27
Status: design only, no code written
Scope: extend the **existing** value calculation with two new signal groups.
No new decision layer, no second search, no move-selection override.

---

## 0. What this changes, in one line

```
value  =  score + leave + β·potential − oppBest            ← today
value  =  score + leave + β·potential − oppPractical        ← group 1 replaces the subtrahend
                                       + W_space · Δspace   ← group 2/3/4 add one term
```

`oppPractical ≤ oppBest`, and the gap between them is bounded by the gap between the
opponent's best reply and their typical reply. `Δspace` is a difference of two board
evaluations. Everything downstream — candidate ranking, `mean − λ·stddev`, the winner —
is untouched.

---

## 1. Where `value` is calculated today

There are **three** value functions in the repo and only one is on the player-facing path.

| # | Function | File | On the production path? |
|---|---|---|---|
| 1 | `simulate()` → `rowVal[i] = myVal − oppBest` | [engine.cpp:353-580](../src/engine.cpp) | **YES** — `handleRequest` → tiers `medium/hard/max/super` |
| 2 | `staticEquity()` | [eval.cpp:170](../src/eval.cpp) | **YES** — root screening for (1), and the whole answer for `solver:"static"` |
| 3 | `EndpointEvaluator` / `OpponentPolicyEvaluator` | [opponent_search.cpp](../src/opponent_search.cpp) | No — `DecisionSearch` is benchmark/CLI only today |
| 4 | Exact endgame minimax | [engine.cpp:584-1253](../src/engine.cpp) | YES, but it returns **proofs** — must not be touched |

The production formula in full, per candidate `i`, per sampled opponent rack `s`:

```
myVal   = move.score
        + leaveValue(rack refilled from this sample's draw, ctx)
        + β · bestPlaceScore(boardAfter, refilled)        β = nextTurnPotentialWeight = 0.60
oppBest = max over all opponent replies of staticEquity(boardAfter, oppRack, reply, ctx)
rowVal  = myVal − oppBest
value   = mean_s(rowVal) − λ · stddev_s(rowVal)           λ = 0.18 + 0.22·(scoreDiff/50)
```

### What the existing system already knows

| Question | Answer |
|---|---|
| Is score represented? | Yes — `BoardContext::scoreDiff`, read in exactly two places (exchange nudge, `λ`). |
| Is board position represented? | Yes — `Board` + `constexpr PREMIUM[225]`; `ctx.mobility` = anchors/40. |
| Are opponent responses already evaluated? | Yes — `oppReplyValue` enumerates **every** opponent reply and scores each one. Only the max survives. |
| Is rack information available? | Yes — ours exactly, opponent's as a sample, plus `unseen`. |
| Is multiplier information represented? | Only **per cell, linearly**: `defensePenalty` charges −4.0/−2.0/−1.2 for an exposed EX3/EX2/PX3 neighbour. No interaction, no geometry. |
| Is game phase represented? | `ctx.bagSize` and `ctx.unseenTotal` exist and are **never read anywhere in the project**. |

### Two facts that shape the whole design

1. **`simulate()` does not apply `defensePenalty` to our own move.** `staticEquity` does;
   the sim path deliberately dropped it in favour of simulating the opponent. Per
   [bot-strength-diagnosis.md §4.5](bot-strength-diagnosis.md), that trade is what makes
   `hard` lose to `easy` (2–16 over 18 games). So the board-space term is filling a *hole*
   on the production path, not duplicating an existing term.
2. **The reply enumeration is node-capped at 200k and misses the opponent's best move
   14.8% of the time** ([§4.3](bot-strength-diagnosis.md)). Group 1 is built on the reply
   distribution, so it inherits that error. It must be **gated off when the reply
   generation truncated** — otherwise it measures the engine's blindness, not the human's.

**Consequence for sequencing:** implement group 2/3/4 first (it pays immediately),
group 1 second (it needs an accurate reply model to be worth anything).

---

## 2. Exactly where each feature is added

Two new translation units, both **pure functions of data the engine already has**:

```
src/space.hpp / space.cpp        corridor model: compound multipliers, open/close, our-vs-their
src/difficulty.hpp / .cpp        reply-difficulty model: how hard is the punishment to find
```

They live outside `eval.cpp` so the existing calibrated leave model is not disturbed, and
they are free functions so every value site can call the same code without duplication.

### Call sites — the complete diff surface

**A. `simulate()`, per-candidate prologue** ([engine.cpp:385-402](../src/engine.cpp)) — the
loop that already fills `scoreComp[i]` / `leftoverRack[i]`. Add one line:

```cpp
spaceTerm[i] = spaceDelta(board, cand, ctx, spaceBefore, SpaceScope::Full);
```

`spaceBefore` is computed **once per turn**, before the loop. The space term is
sample-independent by construction (see §8), so it is computed once per candidate and
amortized across all samples.

**B. `simulate()`, the sample loop** — one term added to each branch:

```cpp
myVal = scoreComp[i] + sampLeave + sampPot + spaceTerm[i];
```

**C. `oppReplyValue` lambda** ([engine.cpp:406-424](../src/engine.cpp)) — currently keeps
only the running max over replies. Change it to keep four scalars instead of one and
return a small struct:

```cpp
struct ReplyProfile { float best; float practical; };
```

The extra bookkeeping is 3 float ops per reply inside a loop that already calls
`staticEquity` on every reply. Then:

```cpp
rowVal[i] = myVal − oppProfile.practical;   // was: − oppBest
```

**D. `staticEquity()`** ([eval.cpp:170](../src/eval.cpp)) — for the `static` tier and the
root screen. Add the compound-only part of the space term (`defensePenalty` already covers
the singleton part here — see §9):

```cpp
return move.score + leaveValue(after, ctx) − defensePenalty(board, move.placements)
       + spaceDelta(board, move, ctx, spaceBefore, SpaceScope::CompoundOnly);
```

**E. `OpponentPolicyEvaluator::evaluate` and `EndpointEvaluator::evaluate`** — the same
two calls, so `DecisionSearch` does not drift from the production evaluator. Group 1 does
**not** apply here: `OpponentPolicyEvaluator` *is* the opponent, and modelling the
opponent's own difficulty in finding their move belongs to a different experiment.

**F. Nothing else changes.** Not `selectRootScope`, not `PairedRace`, not the
`mean − λ·stddev` ranking, not the endgame solver, not `handleRequest`'s solver routing.

---

## 3. Human difficulty — proposed formula

### The shape

Today the bot assumes the opponent always plays their best reply. A human does not — and
how often they fail depends on how *findable* the best reply is. So instead of adding a
bonus, **soften the existing subtraction**:

```
oppPractical = oppBest − W_hd · D · (oppBest − oppTypical)
```

| symbol | meaning |
|---|---|
| `oppBest` | max reply equity — unchanged, still the objective truth |
| `oppTypical` | mean equity of the top-`k` replies excluding the best (`k` ≈ 5) |
| `D ∈ (0,1)` | difficulty of finding the best reply |
| `W_hd ∈ [0,1]` | global weight; at 0 the term vanishes and behaviour is bit-identical to today |

**Why this shape and not an additive bonus.** The discount is multiplied by
`(oppBest − oppTypical)`, which is *zero when the opponent has several equally strong
replies*. A "tricky" move that leaves five different 60-point answers gets no credit at
all — only a move that leaves exactly one standout answer does. This is the difference
between "make complicated moves" and "make the punishment hard to see", and it is enforced
by the algebra rather than by a rule. It also bounds the term: it can never move a
candidate by more than the objective spread of the opponent's own options.

**Objective strength stays dominant** because `W_hd < 1` caps the discount below the full
gap, and the term is a *modifier on one of four* value components — the immediate score
and the leave are untouched.

### Computing `D`

All features are read off the reply set that `oppReplyValue` already builds, plus the
winning `Move` itself. Combined through a logistic squash so `D` is bounded and continuous
— no thresholds, no branches:

```
D = 1 / (1 + exp(−Σ w_f · f))
```

**Mathematical / calculation difficulty** (how hard the equation is to construct):

| feature | expression | why |
|---|---|---|
| `f_tiles` | `(placements − 1) / (RACK_SIZE − 1)` | a 6-tile equation is a much larger search than a 1-tile hook |
| `f_arith` | multi-digit unit runs, `÷`, and non-integer intermediate values, normalized by run length | `48÷6=8` is seen; `132÷11=12` is calculated |
| `f_assign` | 1 if the reply resolves a `?`/`+/−`/`×/÷` to a token that is **not** its most common assignment | a blank playing as `÷` is a discovery |
| `f_heavy` | fraction of placed tiles in 10–20 | heavy tiles need flanking, so equations using them are structurally rarer |

**Board-reading difficulty** (how hard the placement is to *see*):

| feature | expression | why |
|---|---|---|
| `f_cross` | `crossEquations / placements` | a play that must satisfy several perpendicular runs at once is far harder to spot |
| `f_hook` | `absorbedExistingTiles / runLength` | reusing board tiles inside the run is the classic missed resource |
| `f_dist` | Chebyshev distance from our just-played tiles / 14 | attention follows the last move; a reply on the far edge is overlooked |
| `f_rank` | `log(1 + emitIndex) / log(1 + replyCount)` | movegen runs **premium-ordered** ([movegen.cpp:469](../src/movegen.cpp)), so emission order is a usable proxy for obviousness — a reply found late was not an obvious region |
| `f_uniq` | `1 / (1 + nNear)`, `nNear` = replies within ε of the best | a unique answer is harder than one of twenty |

`f_cross`, `f_hook` and `f_dist` are the "hidden scoring lane / cross placement / tactical
pattern" cases from the brief; `f_arith`, `f_assign` and `f_tiles` are the "non-obvious
equation / several mathematical possibilities" cases. `f_rank` and `f_uniq` are the
"multi-step continuation" case, measured rather than guessed.

### Mandatory guard

```cpp
if (replyStats.truncated) return {best, best};   // no discount on a blind read
```

If generation stopped at the node cap we do not know the true `oppBest`, so `oppTypical`
and `f_rank` are both meaningless. Falling back to `practical = best` reproduces today's
behaviour exactly on those 33.5% of positions. **This gate is not optional** and should be
a test.

---

## 4. Board-space value — proposed representation

### The object: a *corridor*, not a cell

A single equation multiplies its whole run once per **new** EX2/EX3 cell it covers
([rules.cpp `scoreRun`](../src/rules.cpp)). So the strategic unit is not a premium cell —
it is a **set of equation-multiplier cells on one line that a single run can cover**.

```cpp
struct Corridor {
  uint8_t horizontal;    // orientation
  uint8_t line;          // row or column index
  uint8_t lo, hi;        // inclusive span along the line
  uint8_t eCells[3];     // indices of the E-cells, 1..3 of them
  uint8_t eCount;
  uint16_t multiplier;   // 2,3,4,9,27  — the PRODUCT, not the sum
  uint8_t pointWeight[15]; // 3 for PX3, 2 for PX2, 1 otherwise, per cell in the span
};
```

This is fully determined by `PREMIUM[]` and is therefore **`constexpr`** — built at compile
time exactly the way `PREMIUM` itself is.

### Runtime value of one corridor

```
occupiedSum(C)  = Σ over occupied cells in [lo,hi] of TILE_POINTS[kind]
newNeeded(C)    = number of EMPTY cells in [lo,hi]
runEstimate(C)  = occupiedSum(C) + meanUnseenPoint · Σ pointWeight over the empty cells
gain(C)         = runEstimate(C) · (multiplier(C) − 1)
```

`gain` is the **extra** points the compound is worth over a plain run in the same place —
which is where the required nonlinearity lives:

| structure | `gain` relative to run sum |
|---|---|
| one ×3 | `× 2` |
| two ×3 in **different** lines (never one equation) | `× 2` each, i.e. `× 4` total across two turns |
| two ×3 **one equation can cross** | `× 8` in a single turn |
| three ×3 one equation can cross | `× 26` |

`3 + 3` and `3 × 3` are structurally different objects in this representation because they
are different table entries with different `multiplier` fields. There is no cell-additive
path through the code at all.

`meanUnseenPoint = unseen.points() / unseen.total` — `TileCounts::points()` already exists.

### Not every opportunity is realistic

Three continuous discounts, all in `[0,1]`, no thresholds:

```
proximity(C) = clamp01( exp( −(newNeeded(C) − 2) / τ ) )      τ ≈ 2.5
access(C)    = fraction of the empty cells in [lo,hi] that are anchors or contact-1
fit(C, rack) = min(1, flankSupply / ⌈newNeeded/2⌉) · min(1, digits / ⌈newNeeded/2⌉)
```

- `proximity` says a corridor needing 7 fresh tiles is nearly fantasy while one needing 2
  is imminent. It is also the **band-pass** that prevents double counting (§9): corridors
  needing ≤1 tile are already inside `oppBest` / `bestPlaceScore`, so `proximity` is forced
  to **0** below `newNeeded = 2`.
- `access` reuses `IncrementalBoard::anchor` and `contactHpass/contactVpass` when an
  incremental board is available, and falls back to a 4-neighbour scan of ≤15 cells.
  A corridor floating in empty space with nothing to connect to scores near zero.
- `fit` reuses the structural counters `leaveValue` already computes (`operators`,
  `digits`, `flankSupply`, `eqCount`). This is what makes "whether the current rack can
  exploit it" a number rather than a hope. It should be factored into a small `RackShape`
  struct so it is computed once, not twice.

### Deduplication across nested corridors

Row 0 contains ×27 `{0,7,14}`, ×9 `{0,7}`, ×9 `{7,14}` and ×9 `{0,14}` simultaneously.
Counting all four quadruples the same structure. Rule: **per line, take live corridors in
descending multiplier order and mark their E-cells consumed; skip any corridor whose
E-cells are already consumed.** At most 3 E-cells per line, so this is a 3-bit mask.

---

## 5. How score gap modifies the value

One continuous variable, derived from data already in `BoardContext`:

```
g     = tanh( ctx.scoreDiff / G )                  G ≈ 80 points   → g ∈ (−1, 1)
phase = clamp01( ctx.bagSize / 40 )                → 1 early, → 0 as the bag empties
```

`g` is smooth and has no states. There is no `LEADING`/`LOSING` anywhere, and no branch on
the sign of `scoreDiff` — the sign falls out of the arithmetic.

```
Δspace = W_space · phase · [ (1 + κ·g) · (−ΔoppSpace)  +  (1 − κ·g) · (ΔourSpace) ]
```

with `κ ≈ 0.6`, so the two coefficients live in `[0.4, 1.6]` — neither ever reaches zero
and neither ever flips sign. Reading it off:

- **Far ahead** (`g → +1`): the coefficient on opponent space rises to 1.6 and on our own
  falls to 0.4. Denying a live ×9 becomes worth ~4× what opening one for ourselves is. A
  move that scores less but removes the opponent's compound access can now win the
  comparison — *if* the score it gives up is smaller than the space it denies. It remains
  a trade-off decided by the same `>` comparison as everything else.
- **Far behind** (`g → −1`): exactly the mirror, with no separate code. Opening corridors,
  keeping rack resources that fit them, and tolerating a volatile board all gain value
  because `ΔourSpace` is now weighted 1.6.
- **Level** (`g = 0`): coefficients are both 1.0, i.e. pure `ours − theirs`.

`phase` is what makes "steer toward a favourable endgame" emerge: future potential is worth
less when there are fewer turns left to realize it, so as the bag empties both space terms
shrink and the immediate score reasserts itself. This is also the first use anywhere in the
project of `ctx.bagSize`.

### Relationship to the existing `λ`

`λ = riskAversionBase + riskAversionLeadPer50·(scoreDiff/50)` is already a score-gap term.
It is **not** the same quantity and is left alone:

- `λ` prices variance **across sampled opponent racks** — hidden-information risk.
- `g` prices **board structure** — positional risk, identical in every sample.

They are independent and do not double count. (Unifying them onto `tanh` is a separate,
later change; `λ`'s current estimator is computed from 3 samples and is mostly noise per
[§4.6](bot-strength-diagnosis.md), but fixing that is not this design's job.)

---

## 6. Detecting ×4, ×9, ×27 — it is entirely static

I enumerated the actual layout in `board.hpp`. The complete compound structure of this
board is **fixed and tiny**:

| E-cells in one corridor | multiplier | count | spans |
|---|---|---|---|
| 1 (EX2) | ×2 | 24 | — |
| 1 (EX3) | ×3 | 16 | — |
| 2 (EX2+EX2) | ×4 | 12 | 9, 11, 13 |
| 2 (EX3+EX3) | ×9 | 14 | **8** (×8), 15 (×6) |
| 3 (EX3×3) | ×27 | 4 | 15 |

**70 corridors total.** Every ×27 is a full edge line (row 0, row 14, col 0, col 14).
The eight **span-8 ×9 corridors** are the strategically live ones — exactly one rack wide:

```
row 0  cols 0..7      row 0  cols 7..14      row 14 cols 0..7      row 14 cols 7..14
col 0  rows 0..7      col 0  rows 7..14      col 14 rows 0..7      col 14 rows 7..14
```

Each of these also contains one PX2, so `pointWeight` sums to 9 over 8 cells. The ×27 and
span-15 ×9 corridors sum to 17–19.

**So there is no detection algorithm at runtime.** The table is generated at compile time
from `PREMIUM`, exactly as `PREMIUM` is generated from its coordinate lists. Runtime work
is only *liveness*: which E-cells are still empty, how many cells in the span still need
filling, and whether the span touches the structure.

Reverse index for incrementality:

```cpp
constexpr std::array<uint8_t, BOARD_CELLS> CORRIDORS_AT_CELL_COUNT;  // 0..8
constexpr std::array<std::array<uint8_t,8>, BOARD_CELLS> CORRIDORS_AT_CELL;
```

Measured fan-out: 189 of 225 cells lie in ≥1 corridor span, mean 2.04 corridors per cell,
max 8. A move places ≤8 tiles, so **≤16 corridors are dirty per candidate** and typically
~6. That is the whole per-candidate cost.

---

## 7. Opening vs closing — one delta, no cases

The value is a **difference between two board evaluations**, which is what makes every verb
in the brief fall out of a single formula with no special cases:

```
spaceBefore = spaceProfile(board, ...)                 // once per turn, shared by all candidates
spaceAfter  = spaceProfile(boardAfterCandidate, ...)   // per candidate, incremental
Δ           = spaceAfter − spaceBefore
```

| the move… | mechanism | resulting sign |
|---|---|---|
| **consumes** access | covers an E-cell → corridor's `eCount` drops, multiplier collapses | both sides lose it; net is positive when the opponent had better `fit`/`access` |
| **opens** access | fills interior cells → `newNeeded` drops → `proximity` rises | both sides gain; net favours whoever fits it better and moves sooner |
| **closes** access | places a tile whose cross-check mask kills the span, or blocks the only anchor | `access(C)` collapses toward 0 |
| **preserves** access | touches nothing in any corridor span | `Δ = 0` — genuinely neutral, not "slightly bad" |
| **redirects** access | opens B while closing A | the net of two opposite deltas, automatically |
| **creates a compound** | fills the gap between two empty E-cells | `proximity` on the ×9 entry rises; the term is nonlinear in exactly the right place |
| **destroys a compound** | covers the middle E-cell of a ×27 | the ×27 entry dies, the two surviving ×9 sub-corridors are re-evaluated by the dedup rule in §4 |

This is why *"opening a ×27 is not automatically good"* needs no code: opening it raises
**both** `ourSpace` and `oppSpace`, and the sign of the sum is decided by `fit`, `access`,
turn order and `g` — never by a constant attached to the cell.

---

## 8. Our space vs opponent space

```
ourSpace(B) = Σ_C  gain(C) · proximity(C) · access(C) · fit(C, rackAfter)   · δ
oppSpace(B) = Σ_C  gain(C) · proximity(C) · access(C) · fit(C, unseenPool)  · 1
```

Three separations, each using information the engine already holds:

1. **Turn order.** The opponent moves next, so their access is undiscounted (`1`) and ours
   carries one turn of discount `δ ≈ 0.55`. This is the same idea as
   `nextTurnPotentialWeight = 0.60` applied one ply further out, and it is the whole reason
   opening a corridor is dangerous by default.
2. **Rack knowledge.** Ours is exact (`rackAfter`). Theirs is not, so `oppSpace` uses the
   **`unseen` pool** — bag plus opponent rack — rather than the sampled rack.
3. **Sample independence.** Because of (2), `oppSpace` does not depend on `racks[s]`.
   This is deliberate and is the single most important performance decision in the design:
   it lets the entire space term be computed **once per candidate** instead of once per
   `(candidate, sample)`. The accuracy given up is small — a corridor's *structure* is what
   matters, and that is identical in every sample — and `W_space` absorbs the residual bias.

`fit` on the unseen pool is the same function evaluated on a 40-tile multiset; scale its
counters by `RACK_SIZE / unseen.total` so a full bag does not read as an omnipotent rack.

The quantity the brief asks for — `our future scoring potential − opponent future scoring
potential` — is therefore `ΔourSpace − ΔoppSpace`, expressed as a delta so it composes with
the existing terms instead of restating them.

---

## 9. Avoiding double counting

The rule the whole design hangs on:

> **Immediate tactical consequence** = this turn's score and the opponent's single best
> reply. Already fully priced.
> **Future positional potential** = board structure that survives *past* that reply.
> This is the only thing the new terms may price.
> **Practical difficulty** = a discount on the reply model, never a separate addend.

| Existing term | What it already covers | How the new term stays out of it |
|---|---|---|
| `move.score` | the multipliers this move **realizes** | a corridor the move covers leaves the *after* board; it is never re-credited as points, only as a change in structure |
| `oppBest` | the opponent's **immediate** best reply, including any premium it takes | `proximity(C) = 0` for `newNeeded ≤ 1`. A corridor the opponent can take next turn is inside `oppBest` and contributes nothing to `oppSpace`. |
| `β·bestPlaceScore` | our **single** best follow-up on the post-move board | same band-pass — our one-move-away potential is already in there |
| `defensePenalty` | radius-1 static premium exposure — **only in `staticEquity`, not in `simulate`** | `SpaceScope::CompoundOnly` in `staticEquity` (singletons already charged); `SpaceScope::Full` in `simulate` (nothing charged there today) |
| `λ · stddev` | variance across hidden opponent racks | `g` acts on structure, identical in every sample — orthogonal (§5) |
| human difficulty | — | it is a *multiplier* on `(oppBest − oppTypical)`, so it can only ever redistribute value already inside `oppBest`; it never adds |

**The band-pass is the mechanism.** Corridors requiring 0–1 new tiles are immediate and
belong to the existing terms; corridors requiring >8 are unreachable this game; the new
terms own only the 2–8 band. That band is precisely "positional potential", and nothing
else in the engine looks at it.

---

## 10. Computational cost

No new move generation anywhere. `moveGenCalls()` is unchanged, the
`STATIC_MAX_GEN_CALLS = 9` contract holds, and `WorkEnvelope::maxFullGenCalls` is
untouched. That is the binding constraint and it is satisfied by construction.

| Component | When | Cost | Share of a decision |
|---|---|---|---|
| Corridor table | compile time | 0 | 0 |
| `spaceBefore` | once per turn | 70 corridors × ~20 ops ≈ **1.4k ops** | negligible |
| `spaceAfter`, incremental | once per candidate (≤63) | ≤16 dirty corridors × ~20 ops ≈ **320 ops**; ~20k ops per turn | < 0.01% |
| Reply-distribution stats | inside the existing reply loop | **3 float ops per reply** | < 1% of that loop |
| `D` features | once per (candidate, sample) | ~30 ops on the winning `Move` only | < 0.1% |
| **Total added** | | **~10⁵ ops per decision** | against ~10⁸–10⁹ for movegen |

For scale: one `generatePlaceMoves` call is ~10 ms; a `hard` decision makes ~415 of them.
The additions are roughly **four orders of magnitude** below that.

Three properties that keep it there:

- **Precomputation.** All compound geometry is static (§6). None of it is discovered at
  runtime.
- **Sample independence.** The space term is per-candidate, not per-(candidate, sample)
  (§8). At 99 samples on the `max` tier this is a 99× saving over the naive placement.
- **Incrementality.** `CORRIDORS_AT_CELL` means a candidate re-evaluates ~6 corridors, not
  70. If `IncrementalBoard` is ever wired into the sim path, `access` becomes free too.

Nothing here needs a cache, and nothing needs to be recomputed inside the sample loop.

---

## 11. What is reused

| Existing thing | Reused for |
|---|---|
| `constexpr PREMIUM[225]`, `SlotType`, `Board::idx` | generating the corridor table at compile time |
| `TILE_POINTS`, `TileCounts::points()` | `runEstimate`, `meanUnseenPoint` |
| `rules.cpp scoreRun` semantics | the definition of `multiplier` as a product over **new** E-cells — the table must not drift from the scorer |
| `BoardContext` | `scoreDiff` → `g`; `bagSize` → `phase` (first use in the project); `mobility`, `freshTileValue` unchanged |
| `IncrementalBoard::anchor`, `contactHpass`, `contactVpass` | `access(C)` — already maintained and already proven equal to a rebuild |
| the reply vector in `oppReplyValue` | emission order (`f_rank`), near-best count (`f_uniq`), top-k mean (`oppTypical`) — all free, all currently discarded |
| `GenStats::truncated` | the mandatory gate in §3 |
| `leaveValue`'s structural counters | `fit(C, rack)` — factor out a `RackShape` so it is computed once |
| `MoveValidation::equationCount` / run collection | `f_cross`, `f_hook` |
| `g_leave` / `LeaveWeights` | the pattern for the new weight structs (documented "BIAS POINTS", tuner-owned) |
| `CandidateDiag` | add `space` and `humanDiff` fields so the existing UI report explains the new terms |

Deliberately **not** reused: `movegen::premiumWeight` (its ×3 = 27 constant is a *search
ordering* heuristic, unrelated to evaluation). Making anchor ordering corridor-aware is a
plausible follow-up and is out of scope here.

---

## 12. What is tunable

Two structs, mirroring `LeaveWeights`, with the same "BIAS POINTS" contract. Every one is
an evaluation parameter; **none is a decision switch**.

```cpp
struct SpaceWeights {
  float wSpace          = 0.15f;  // future potential points → current equity points
  float ourTurnDiscount = 0.55f;  // δ, one ply of turn order
  float proximityTau    = 2.5f;   // τ, how fast an unreachable corridor decays
  float minNewNeeded    = 2.0f;   // band-pass floor — the anti-double-count constant
  float scoreGapScale   = 80.0f;  // G in tanh(scoreDiff / G)
  float scoreGapKappa   = 0.6f;   // κ, how far the lead tilts the ours/theirs balance
  float phaseBagScale   = 40.0f;  // bag size at which future potential is fully valued
};

struct DifficultyWeights {
  float wHumanDiff = 0.0f;        // W_hd — SHIPS AT ZERO, see below
  float topK       = 5.0f;        // replies averaged into oppTypical
  float nearEps    = 2.0f;        // equity window for "equally good reply"
  float fTiles = 0.6f, fArith = 0.8f, fAssign = 0.5f, fHeavy = 0.3f;
  float fCross = 1.0f, fHook = 0.7f, fDist = 0.4f, fRank = 0.9f, fUniq = 1.2f;
  float bias   = -2.5f;           // logistic intercept: D ≈ 0.08 for a plain reply
};
```

### Why `wSpace = 0.15`

Not arbitrary. A live span-8 ×9 corridor with 4 cells occupied gives
`runEstimate ≈ 22`, so `gain ≈ 176` raw points. With `proximity ≈ 0.45`,
`access ≈ 0.5`, `fit ≈ 0.6` that is ~24 points of live potential, and `× 0.15 ≈ 3.6`
equity points. Candidate gaps on the production path are 1–4 points
([§2.4](bot-strength-diagnosis.md)), so this is the order of magnitude that *can* change a
decision without swamping the score term. It is the same role `nextTurnPotentialWeight =
0.60` plays one ply out, smaller because the horizon is longer.

### Ship-safe defaults and the required tests

1. **`wSpace = 0` and `wHumanDiff = 0` must reproduce today's move bit-for-bit** on the
   existing self-play corpus. This is the kill switch and it must be an assertion, not a
   claim.
2. **`wHumanDiff` ships at 0.** Group 1 is built on a reply model that is truncated 33.5%
   of the time and wrong 14.8% of the time. Turn it on only after the reply node cap is
   raised, and only behind a self-play A/B.
3. **The truncation gate is a test**, not a comment.
4. Tune in the order the terms were justified: `wSpace` first (it fills the
   `defensePenalty` hole on the sim path and should show up immediately in the
   "premium cells exposed" metric from [§4.5](bot-strength-diagnosis.md)), then
   `scoreGapKappa`, then the `f_*` feature weights last.

The weights are independent by construction: `wSpace` scales the whole space term,
`scoreGapKappa` only redistributes it between the two sides, and `wHumanDiff` scales only
the reply discount. None of them interacts with `LeaveWeights`.

---

## 13. Risks worth stating

- **Group 1 sits on a known-broken foundation.** The reply model's 200k node cap is the
  binding error in the current engine. Human difficulty computed on a truncated reply set
  measures our own search horizon. The gate in §3 makes this safe but also makes the term
  inert on exactly the open positions where it would matter most. Raising the reply cap is
  a prerequisite for the term being worth anything.
- **`fit` is crude.** It approximates "can this rack build a run of N tokens" from counters
  rather than from generation. That is the price of not adding a movegen call, and it is
  the right trade — but it will be the least accurate part of the space term.
- **`oppSpace` uses the unseen pool, not the sampled rack.** Deliberate (§8) and the reason
  the term is affordable, but it is a real approximation.
- **The corridor table must not drift from `scoreRun`.** If the scoring rule for EX cells
  ever changes, the table's `multiplier` field silently becomes wrong. Worth a test that
  derives one corridor's multiplier by actually scoring a run through it.
