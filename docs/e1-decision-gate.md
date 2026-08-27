# E1 decision gate — is `defensePenalty` worth adding to `simulate()`?

Date: 2026-08-27
Status: audit complete for every measurement listed below. No code changed.
Prior: [practical-value-extension-review.md](practical-value-extension-review.md)

---

## 0. Measurement inventory

Every number below was produced by probes compiled against the live engine
sources in this tree. Sample sizes are stated because several are small.

| Measurement | Sample | Probe |
|---|---|---|
| Legal 2/3/4-token runs | exhaustive (676 / 17,576 / 456,976) | static |
| Corridor liveness | 339 positions, 16 games | self-play |
| Term distributions | 4,057 candidates, 124 positions | sim path |
| Dead-cell overcharge | 5,213 charged cells | sim path |
| Spearman(dp, oppReply) | 124 positions | sim path |
| Counterfactual argmax flip | 124 positions | sim path |
| Head-to-head V1 vs V0 | **6 games**, 75 V1 decisions | sim path |
| Predictive regression | **183 decisions** | sim path |
| Paired variance | 10 positions × 6 seeds (78 trials) | sim path |
| Score-gap sweep | 8 positions × 9 gaps (72 trials) | sim path |
| Exploitation calibration | 8 games | sim path |

---

## 1. What `defensePenalty` actually is

Complete trace. It has **two references in the entire repository**: its definition
at [eval.cpp:121](../src/eval.cpp) and one call inside `staticEquity` at
[eval.cpp:164](../src/eval.cpp).

| Property | Answer |
|---|---|
| Inputs | `(board BEFORE the move, placements)`. **Not** rack, opponent rack, scores, bag, or phase. |
| Output | Non-negative float, units "board points". |
| Formula | Σ over **distinct empty cells orthogonally adjacent to ≥1 newly placed tile**, weight EX3 = 4.0, EX2 = 2.0, PX3 = 1.2, **PX2 = 0**. |
| Higher means | Worse. It is subtracted. |
| Multiplier effects | Flat per-type constants only. No ×4/×9/×27 awareness. |
| Score-gap info | **None.** |
| Zero when | The move places nothing — i.e. every exchange and pass. |

### The premise was wrong

`defensePenalty` is **not absent from `simulate()`**. `staticEquity` — which
contains it — is called inside `simulate()` at [engine.cpp:419](../src/engine.cpp),
on the **opponent's** replies:

```
oppBest = max over replies of [ reply.score + reply.leave − defensePenalty(reply) ]
rowVal  = myVal − oppBest
        = myVal − reply.score − reply.leave + defensePenalty(reply)
```

The bot already receives a **credit** when the opponent's best reply exposes
premium cells, and pays nothing when its own move does. E1 is therefore not
"adding a missing term" — it is making an existing, one-sided term symmetric.

`git log -S defensePenalty -- src/` returns exactly one commit, the initial
import. The term has never appeared in `engine.cpp` in any revision: it was
**never in `simulate()` and never removed**. The claim that sim "intentionally
removed" it is unsupported by history.

---

## 2. Precise semantics (§5, §10)

`defensePenalty` measures exactly one thing: **premium-cell adjacency created by
this move.** It is not any of these, and must not be named as them:

| Description | Why it is wrong |
|---|---|
| future opponent scoring potential | It does not know the opponent's rack, the legality of any equation through the cell, or reachability along the line. |
| immediate counterplay | That is `oppBest`, which enumerates and scores every legal reply. |
| board volatility | It is deterministic. Volatility is `λ · stddev`. |
| board space / openness | That is `ctx.mobility`, which it never reads. |

Adjacency is **neither necessary nor sufficient** for opponent access:

- **Not sufficient** — 15.4% of charged cells (804 of 5,213) are legally
  unplayable: both cross-masks are zero, so no tile can ever go there. That is a
  14.7% overcharge on the total.
- **Not necessary** — a premium cell two or three cells down a line the move just
  opened is charged nothing. This under-count is **UNMEASURED**.

Against the original requirement — *"when leading, reduce the opponent's ability
to counterattack"* — this is one narrow mechanism out of many. Most A-Math scoring
is not premium-driven: realized score is ≈6× raw tile points, and cross-run
scoring contributes heavily. **Calling it "defense" overstates it. It is
premium-adjacency exposure.**

---

## 3. Sampling noise is not what I previously said (§11)

Earlier framing — "candidate gaps 1–4, stddev 37–77" — compared the wrong two
quantities. `stddev` is the spread of a candidate's value *level* across sampled
opponent racks. Ranking depends on the *difference* between two candidates, and
the simulation already uses common random numbers, which cancels most of that.

Measured directly, 10 positions × 6 seeds:

| quantity | value |
|---|---:|
| sd across seeds of `value(A)` | 17.34 |
| sd across seeds of `value(A) − value(B)` | **3.22** |
| predicted **unpaired** sd of the difference | 19.41 |
| **CRN variance reduction on the difference** | **6.04×** |
| mean \|value(A) − value(B)\| | 2.67 |
| **signal / noise on the top-2 gap** | **0.83** |
| argmax changes on reseed | **43 / 78 (55%)** |

So common random numbers are already doing their job — the difference is 6×
tighter than an unpaired estimate would be. The problem is that the *signal* is
smaller still: the top-2 gap (2.67) is below the noise on that gap (3.22), which
is exactly why the engine picks a different move on 55% of reseeds.

**How many samples would fix it** (variance scales 1/n, from n=3):

| target signal/noise | samples needed |
|---|---:|
| 1.0 | ~4 |
| 2.0 | **~17** |
| 3.0 | ~39 |

The `max` tier already reaches 99 samples; `medium` and `hard` reach **3**. The
fix is not more compute in principle — it is not spending 95% of the candidate
budget on duplicate evaluations (diagnosis §4.2).

**Consequence for validation.** A per-game head-to-head is a very poor instrument
here: with per-game margin sd = 153.6, detecting a 30-point/game effect at 80%
power needs **206 games**. The predictive regression reached p < 0.01 on **183
decisions** (~8 games of play) — roughly **25× more sample-efficient per unit of
CPU**. Any future evaluation change should be judged by the regression first.

---

## 4. Score-gap modulation is unnecessary (§8, §9, §10)

The engine already has one lead-dependent mechanism:

```
λ = max(0, 0.18 + 0.22 · scoreDiff/50)          [engine.cpp:557]
value = mean − λ · stddev
```

Its nominal magnitude dwarfs anything proposed: at +200 with p50 `stddev`,
`λ·sd ≈ 25.7` points, against `defensePenalty` p50 = 2.00 and max = 11.20.

**Measured behaviour**, 8 positions evaluated at 9 score gaps with only the scores
changed:

| scoreGap | λ | mean `dp` of the chosen move | mean score of the chosen move |
|---:|---:|---:|---:|
| −200 | 0.00 | 2.80 | 54.50 |
| −100 | 0.00 | 2.80 | 54.50 |
| −50 | 0.00 | 2.80 | 54.50 |
| −20 | 0.09 | 2.80 | 54.50 |
| 0 | 0.18 | 2.80 | 54.50 |
| +20 | 0.27 | 2.35 | 58.12 |
| +50 | 0.40 | 2.35 | 58.12 |
| +100 | 0.62 | 2.50 | 48.75 |
| +200 | 1.06 | **2.20** | **45.50** |

Two findings, and they answer §9 and §10 directly.

**§9 — the "when leading" requirement already exists.** Going from level to +200,
the bot's chosen move drops 21% in premium exposure and 16% in immediate score. It
is already trading points for safety as the lead grows. The requested behaviour is
present and measurable; a second lead-dependent mechanism would be redundant.

**§10 — the "when behind" requirement is genuinely absent.** Behaviour at −200 is
**bit-identical** to behaviour at 0, because `max(0, …)` clamps λ to zero for any
deficit beyond −41 points. The evaluator literally cannot express variance-seeking.

That is the one confirmed gap in the whole audit, and it is a property of a
**clamp on an existing parameter**, not of a missing term.

The score-gap sweep also shows the practical size of the whole mechanism: the V0
pick changed in only **8 of 64** gap comparisons. λ's nominal 26-point swing moves
the actual decision 12.5% of the time.

---

## 5. Head-to-head and flip analysis (§4 of the prior round)

Six games, sides alternated, V1 = `argmax(value − dp)` versus V0 = engine pick:

| | |
|---|---|
| record | V1 **3 – 3** V0 |
| mean margin | **+42.8**, sd 153.6, se 62.7 |
| 95% CI | **[−80, +166]** — inconclusive |
| games needed for 30 pts/game at 80% power | **206** |
| mean `dp` of chosen move | V0 side 1.43 → V1 side **1.32** (−8%) |
| mean immediate score of chosen move | V0 37.20 → V1 41.28 |
| flip rate on V1 turns | **7 / 75 (9.3%)** |
| **of those, flipped to EXCHANGE or PASS** | **6 / 7 (86%)** |
| on a flip | d(score) −13.1, d(dp) −2.06, d(value) −0.48 |

The independent counterfactual over 124 positions agreed: flips 11.3%, mean
d(score) −17.4.

**The dominant behavioural effect of E1 is not "expose less" — it is "pass and
exchange more."** Exposure of the chosen move fell only 8%, while 86% of the
decisions it changed were converted into non-placements. That is the structural
bias, measured.

### FLIP 1, in full — `dp` overrode λ and chose the riskier move while leading

```
scoreDiff = +159   →   λ = 0.18 + 0.22·(159/50) = 0.88

V0 pick  place  score=18.0  mean=23.84  sd= 3.81  value=20.48 | dp=5.60 → 14.88
V1 pick  EXCH   score= 0.0  mean=27.78  sd=11.78  value=17.42 | dp=0.00 → 17.42
```

λ had already charged the exchange 10.37 points for its variance versus 3.35 for
the placement, and V0 correctly took the low-variance scoring move — which is what
"protect a lead" means. `defensePenalty` then charged the placement 5.60 and the
exchange 0, reversing the order. While ahead by 159 the bot switched to a
zero-score, three-times-higher-variance move.

Two lead-aware caution mechanisms disagreed, and the cruder one won.
## 6. Corridor model: RETIRE

Evidence, all measured in this tree:

| Finding | Value | n |
|---|---|---|
| Legal 2-token runs | **0 / 676** | exhaustive |
| ×27 corridors reachable within a rack | **0.00 / position** | 339 positions |
| ×9 corridors legally live | **0.01 / position** (~1 per 5 games) | 339 positions |
| Anchors that are dead cells | 24.5% | 21,310 anchors |
| Compounds already valued exactly | `scoreRun` does `mult *= 3` per new EX3 | read |
| Estimated corridor term value | **≈0.2 points/position** | derived |

**RETIRE.** Not "keep as a research feature with the code present" — the 70-entry
table stays in this document as a measured artifact and does not enter `src/`.
Dead weighted code in the evaluator is how a rejected mechanism gets switched on
later by someone who did not read the measurements.

The one class of information the existing terms genuinely cannot see is stated
precisely for the record: **structure that is illegal to play now but becomes
legal after an intervening tile is placed** — a premium cell whose cross-mask is
currently 0 and becomes non-zero in two plies. `bestPlaceScore` and `oppBest` are
1-ply and cannot see it. Its magnitude is **unmeasured**, and the corridor liveness
numbers bound it well below the decision margin. Reopen only if a direct
measurement shows live compounds above ~0.5 per position.

---

## 7. Human difficulty: the minimal replay study (still DEFERRED)

Self-play cannot validate it (engine opponents do not miss moves), so the only
route is the EQ-Lab snapshot corpus. Design, deliberately statistical rather than
ML:

**Population.** `public_game_snapshots`, `completion_kind = 'natural'`. Human
sides only. **Place moves only** — pass and exchange have different psychology and
would contaminate the miss rate.

**Reference move set.** Run the engine per position at a fixed configuration with
`topN = 40`. Critically: the engine's own pick changes on **54% of reseeds**
(measured), so a rank-based reference is not stable enough to define a miss
against. Two options, and the second is recommended:
- rank-based with a majority-vote reference over K seeds — costly and still noisy;
- **equity-gap based**: `miss ⟺ bestValue − value(human's actual move) > T`.

**Choosing T.** Set `T = 3σ_d`, where `σ_d` is the engine's own seed-to-seed
standard deviation of the value *difference* between two candidates (measured in
this audit). A miss must exceed the engine's own resolution, or the study measures
engine noise rather than human error.

**Do not use top-k equivalence.** A gap threshold handles ties naturally and
avoids picking an arbitrary k.

**Statistic.** Miss rate `p̂` per feature bucket with a Wilson 95% interval.
Features are the cheap, already-computable ones: tiles placed, cross-equations
formed, tiles absorbed from the board, distance from the previous move, and
arithmetic complexity of the equation.

**Sample size.** For `p ≈ 0.4` and a ±5 pp half-width, `n ≈ 370 per bucket`. Three
buckets per feature → ~1,100 turns per feature; allowing for overlap across three
features → **1,500–3,000 human place-turns**, i.e. roughly 150–300 completed human
games. This is the gate: below it the study cannot separate anything.

**Separating difficulty from unfamiliarity.** Compute the miss rate per bucket
*within* each player, then average across players. A bucket effect that survives
within-player is difficulty; one that appears only between players is skill. This
needs ≥5 turns per player per bucket, which the sample size above supplies.

**Criterion to enable `W_hd > 0`.** All four must hold:
1. at least one feature shows ≥15 pp miss-rate difference between its extreme buckets;
2. 95% intervals on those two buckets do not overlap;
3. the effect replicates on a held-out half of the corpus;
4. the direction is consistent within players.

The output is then a **single miss-rate scalar `p`**, used as
`oppPractical = (1−p)·oppBest + p·oppSecondBest`. Not a 9-feature logistic — the
previous design's model had more free parameters than the data would support.

Two additions from this round's measurements:

**Threshold `T` is now measurable.** The engine's own seed-to-seed sd of the value
*difference* between two candidates is **3.22** (10 positions × 6 seeds). So
`T = 3σ_d ≈ 10 equity points`. A human move within 10 points of the engine's best
is inside the engine's own resolution and must not be scored as a miss.

**The reference must not be a rank.** The engine's argmax changes on **55%** of
reseeds. A rank-1 reference would be measuring engine noise. Use the equity gap.

---

## 8. Alternatives to raw `defensePenalty` (§7)

| | **A** no new term | **B** dp restricted to future-only risk | **C** residual dp (orthogonal to `oppBest`) | **D** improve `oppBest` / the sim instead |
|---|---|---|---|---|
| Behaviour change | none | ~85% of A's magnitude | ~93% of dp's variance is already orthogonal, so ≈ raw dp | opponent model stops missing its own best move |
| New information | none | the 14.7% dead-cell charge removed | negligible — measured Spearman(dp, oppReply) median **0.20** | fixes the term with the strongest measured link to real damage (corr **+0.373**) |
| Fixes the pass bias | n/a | **no** | **no** | n/a — no new tax on placements |
| Cost | zero | small | small | large but already scoped in the diagnosis |
| Validatable today | n/a | no (206 games) | no | **yes** — measurable directly as reply-set completeness |

**C is not worth building.** The measured correlation between `dp` and `oppReply`
is weak (Spearman median 0.20 within a position), so residualizing removes almost
nothing — the two terms are already nearly independent. That independence is what
makes `dp`'s incremental R² non-zero, and it is also why "residual dp" ≈ "dp".

**B does not fix the defect that matters.** The 15.4% dead-cell filter shrinks the
term by a seventh; the 86%-flip-to-exchange bias is untouched, because exchange
and pass still carry `dp = 0` by construction.

**D is the only option that improves the term already carrying the information.**
`oppReply` is the strongest single predictor of actual opponent damage measured in
this audit (corr +0.373), and it is currently computed with a 200k node cap that
truncates 33.5% of the time and misses the opponent's best move 14.8% of the time.

---

## 9. Decision matrix — rows settled independently of the final probe

| Feature | What it actually measures | Incremental information | Evidence | Decision |
|---|---|---|---|---|
| **Score-gap modulation of defense** (`W_def(g)`) | a second lead-dependent caution weight | **None.** λ already varies with `scoreDiff` and its nominal swing (≈26 pts at +200) is an order of magnitude larger than `dp` itself (p50 2.0, max 11.2). | Score-gap sweep, 8 positions × 9 gaps: chosen move's `dp` falls 21% and its score falls 16% from level to +200 — the leading behaviour already exists. λ's own effect changes the pick in only 8/64 comparisons. | **REJECT** |
| **Corridor model** | static premium geometry | **≈0.2 pts/position.** ×27 never reachable once in 339 positions; ×9 legally live 0.01/position (~1 per 5 games); 0 legal 2-token runs; 24.5% of anchors are dead cells. | 339 positions, 16 games, exhaustive run enumeration | **RETIRE** |
| **Compound multiplier heuristic** (×4/×9/×27) | nonlinear multiplier interaction | **None.** `scoreRun` already does `mult *= 3` per new EX3, so every generated move is scored exactly — inside `move.score`, `bestPlaceScore`, and `oppBest` alike. | read directly ([rules.cpp:60](../src/rules.cpp)) | **RETIRE** (requirement already met) |
| **Human difficulty** (`W_hd`) | claimed: opponent fallibility | **Unmeasurable with current apparatus.** Self-play opponents do not miss moves, so an A/B always drives `W_hd → 0`. `oppTypical` measures generator duplicate density; `f_rank` measures the `TileCounts` enum order. | diagnosis §4.2 (60 replies → 3 distinct evaluations); movegen anchor-ordering read | **DEFER** — pending the replay study in §7 |

The remaining row — **existing `defensePenalty`** — turns on one measurement still
running: whether its incremental predictive power survives controlling for generic
board openness. Two outcomes, decided in advance so the result is not fitted after
the fact:

- **If `dp`'s ΔR² collapses once `nAdjEmpty` and `nTiles` are controlled**, then it
  is an openness proxy, its premium weights are decoration, and the honest verdict
  is **DO NOT SHIP** — adding it would tax placements (86% of its flips go to
  exchange/pass) in exchange for information the evaluator can get more directly.
- **If ΔR² survives**, `dp` carries genuine premium-specific signal, and the
  verdict becomes **MODIFY** — the term is real but the naive
  `myVal − dp` form is not, because of the exchange/pass asymmetry.

Either way the head-to-head cannot arbitrate it: 6 games gave a 95% CI of
[−80, +166], and 206 games would be needed for a 30 pt/game effect.

---

## 10. The central question: does `dp` add predictive information? (§2)

Outcome variable: the opponent's **actual** score on their next turn, observed in
self-play. Two independent samples were run.

| sample | n | ΔR²(dp \| oppReply) | F(1, n−3) | b_dp | verdict |
|---|---:|---:|---:|---:|---|
| probe6 | 183 | +0.0357 | 7.79 | +4.675 | p < 0.01 |
| probe7 | 191 | **+0.0016** | **0.32** | +1.104 | p = 0.57 |

**The significant result does not replicate.** Two independent samples of nearly
identical size differ by 22× in ΔR². (probe6's originally-printed ΔR² of +0.175
was a bug in my single-regressor baseline — the corrected value is +0.0357, and
that correction is included above.)

With the full control set the effect vanishes in the larger sample too:

```
C: actual ~ oppReply + score + leave + potential + λ·sd      R2 = 0.1948
D: C + defensePenalty                                        R2 = 0.1963
   -> dR2 = +0.0015   F(1,184) = 0.34        not significant
```

### The confound test settles it

```
dp alone, beyond oppReply            dR2 = +0.0016
generic openness, beyond oppReply    dR2 = +0.0522     <- 33x larger
dp beyond oppReply + openness + nTiles
                                     dR2 = +0.0151   F(1,186) = 3.39  (crit 3.89)  ns
```

And in that last model `b_dp = −4.157`: holding openness fixed, **more premium
exposure predicts less opponent damage**. That is a collinearity artifact, not a
defensive signal.

`nAdjEmpty` — the plain count of empty cells the move touches, with no premium
weighting at all — predicts actual opponent damage **33× better** than
premium-weighted exposure does. Whatever `defensePenalty` was picking up in the
first sample, it was not premium danger.

**Pre-committed criterion (§9): "If `dp`'s ΔR² collapses once `nAdjEmpty` and
`nTiles` are controlled … the honest verdict is DO NOT SHIP." It collapsed.**

### How weak is the evaluator's model of opponent damage overall?

| model | R² | unexplained |
|---|---:|---:|
| `oppReply` alone | 0.096 | **90%** |
| full controls | 0.195 | 81% |
| + `dp` | 0.196 | 80% |

Even the best model leaves 80% of real opponent damage unexplained. That, not a
missing heuristic, is the size of the actual problem.

---

## 11. Constant calibration (§3)

8 games. "Exploited" = the opponent physically covers the exposed cell.

| cell | exposed | legally playable | used ≤2 replies | used EVER | P(≤2) | **P(EVER)** | 95% CI | implied w (EVER) | current w |
|---|---:|---:|---:|---:|---:|---:|---|---:|---:|
| EX3 | 11 | 11 | 0 | 1 | 0.0% | 9.1% | [1.6%, 37.7%] | 2.62 | **4.0** |
| EX2 | 69 | 60 | 2 | 7 | 2.9% | 10.1% | [5.0%, 19.5%] | 1.46 | **2.0** |
| PX3 | 97 | 81 | 6 | 8 | 6.2% | 8.2% | [4.2%, 15.4%] | 0.59 | **1.2** |
| PX2 | 178 | 124 | 13 | 23 | 7.3% | **12.9%** | [8.8%, 18.6%] | 0.47 | **0.0** |

Four findings:

1. **Immediate exploitation barely happens** (0–7.3%). So `defensePenalty` is *not*
   double-counting `oppBest` — but that is because the cells are not being taken
   next turn, not because the term is measuring something `oppBest` misses.
2. **Eventual exploitation is 8–13%, and statistically indistinguishable across all
   four types** — every confidence interval overlaps every other. The premium type
   does not predict whether the cell gets used.
3. **The levels are ~1.5–2× too high.** Implied weights from measured P(EVER) are
   2.62 / 1.46 / 0.59 versus the hand-set 4.0 / 2.0 / 1.2.
4. **PX2 is the most-exposed premium type by a factor of 16 over EX3 (178 vs 11) and
   the most-exploited (12.9%), and it is charged nothing.** The term is blind to
   the exposure that actually occurs most often, and heavily weights the one that
   almost never occurs.

The earlier observation that the ratios 4 : 2 : 1.2 match multiplier gain
(4 : 2 : 1.14) still holds — but that reasoning assumed equal exploitation
probability *and* that gain is what matters. The measured rates are indeed roughly
equal, so the ratios are not contradicted; the scale is wrong and PX2 is missing.

---

## 12. The structural bias, quantified (§4)

| candidate class | n | `dp == 0` | share |
|---|---:|---:|---:|
| placement | 3,182 | 766 | **24.1%** |
| exchange | 381 | 381 | **100%** |
| pass | 98 | 98 | **100%** |

`placement dp`: p10 = 0.00, p50 = 2.00, mean = 2.33, p90 = 5.20, max = 10.00.

Every exchange and every pass carries `dp = 0` **by construction** — they place no
tiles, so they create no adjacency. That is semantically correct for a term that
measures *adjacency created*. It is not correct for a term used as *defense*,
because passing does not make the board safe; it just declines to change it.

Subtracting `dp` from `myVal` is therefore a **~2.3-point average tax on
placements with no counterpart on non-placements**, against a measured top-2
candidate gap of 2.67. That is why 86% of the decisions it changed became
exchanges or passes, while the exposure of the chosen move fell only 8%.

This should **not** be "fixed" by assigning exchange/pass an invented penalty. The
metric is doing exactly what it was defined to do; the defect is in using an
adjacency metric as a defense term.

---

## 13. Does `oppBest` already handle it? (§6)

Partly, and the gap is real but small:

- **Immediate risk**: `oppBest` enumerates and scores every legal reply, so any
  premium cell the opponent can use *next turn* is priced exactly. Measured
  immediate exploitation is 0–7.3%, so this covers most of what actually happens.
- **Future risk**: P(EVER exploited) is 8–13%, versus 0–7.3% within two replies. So
  roughly **half of eventual exploitation happens beyond `oppBest`'s horizon.**
  That residual is genuinely invisible to the current evaluator.

So the *quantity* the original requirement pointed at does exist. What fails is the
*proposed measurement of it*: premium-weighted adjacency has no measurable
predictive relationship with actual opponent damage once openness is controlled,
and its coefficient flips sign.

**Retire the measurement, not the concept.**

---

## 14. Final decision matrix

| Feature | What it actually measures | Incremental information | Evidence | Decision |
|---|---|---|---|---|
| **Existing `defensePenalty`** | premium-cell **adjacency created**, not defense | **None detectable.** ΔR² = +0.0016 (F = 0.32, n = 191); a first sample gave +0.036 but did not replicate (22× disagreement). Generic openness predicts 33× better; controlling for it flips `dp`'s sign negative. | probe6/probe7 regressions; 8-game exploitation calibration; 6-game head-to-head CI [−80, +166] | **DO NOT SHIP** |
| **Score-gap modulation** (`W_def(g)`) | a second lead-dependent caution weight | **None.** λ already varies with `scoreDiff`; its nominal swing (≈26 pts at +200) is an order of magnitude larger than `dp` (p50 2.0). | 8 positions × 9 gaps: chosen move's exposure −21%, score −16% from level to +200 | **REJECT** |
| **Corridor model** | static premium geometry | ≈0.2 pts/position | 339 positions: ×27 never reachable, ×9 live 0.01/position, 0 legal 2-token runs, 24.5% dead anchors | **RETIRE** |
| **Compound multiplier heuristic** | ×4/×9/×27 nonlinearity | **None.** `scoreRun` already computes it exactly for every generated move. | [rules.cpp:60](../src/rules.cpp) | **RETIRE** (already met) |
| **Human difficulty** (`W_hd`) | claimed opponent fallibility | Unmeasurable with current apparatus | self-play cannot model human error; `oppTypical` measures generator duplicates; `f_rank` measures enum order | **DEFER** |

---

## 15. Answers

**Q1 — Should `defensePenalty` be added to the production candidate's value?**
**No.** It shows no replicable incremental predictive power over `oppBest`; once
generic openness is controlled its coefficient turns negative; its behavioural
effect is a placement tax that converts 86% of the decisions it changes into
exchanges or passes; and it cannot be validated with the current instrument
(206 games needed; argmax already flips on 55% of reseeds).

**Q2 — If yes, what is the smallest justified change?** Not applicable. The
smallest justified change to the evaluator is **none**.

**Q3 — What already provides most of the desired behaviour?**
- *Leading:* `λ = max(0, 0.18 + 0.22·scoreDiff/50)`. Measured: from level to +200,
  the chosen move's premium exposure falls 21% and its immediate score falls 16%.
  **The requested "when leading" behaviour already exists in the current evaluator.**
- *Counterplay:* `oppBest` — the strongest measured predictor of real opponent
  damage (corr +0.373 / +0.31 across samples).
- *Compound multipliers:* `scoreRun`, exactly.
- *Own future scoring:* `β · bestPlaceScore`.

**Q4 — What is genuinely missing?**
1. **Variance-seeking when behind** — λ is clamped to 0 below −41; measured
   behaviour at −200 is bit-identical to at 0. This is a clamp on an existing
   parameter, not a missing term.
2. **Game-phase awareness** — `ctx.bagSize` and `ctx.unseenTotal` are read nowhere.
3. **Symmetric next-turn potential** — we get `β·bestPlaceScore`, the opponent gets none.
4. **Opponent-model completeness** — 200k node cap truncates 33.5%, misses the best reply 14.8%.
5. **Sample count** — 3 samples where ~17 are needed for signal/noise = 2.

**Q5 — Is board-space future potential actually missing?**
**Partly.** P(EVER exploited) is 8–13% against 0–7.3% within two replies, so about
half of eventual exploitation lies beyond `oppBest`'s horizon and is invisible.
But the residual is small, uniform across premium types, and no proposed
measurement of it survives a confound test. The concept is real; every candidate
measurement of it has failed.

**Q6 — Smallest next experiment.**
Raise the reply node cap on the sim path and re-measure `corr(oppReply, actual
opponent damage)` and R² over ~200 decisions (~8 games). If `oppReply`'s
predictive power rises, improving the opponent model is confirmed as the lever.
This is **~25× more sample-efficient than a head-to-head** (183 decisions reached
p < 0.01 where 6 games gave a CI of [−80, +166]). Precede it by deduplicating
candidates, which frees the budget both for a higher cap and for more samples.

**Q7 — Which parts of the original requirement to implement, defer, or reject?**

| Original requirement | Disposition |
|---|---|
| Nonlinear ×4/×9/×27 multiplier value | **Already implemented** (`scoreRun`). Nothing to do. |
| Score-gap-aware counterplay value, when leading | **Already implemented** (λ). Measured and working. |
| Score-gap-aware comeback value, when behind | **Missing** — but the fix is unclamping an existing parameter, and it multiplies a 3-sample stddev, so it is gated on the sampling fix. |
| Board-space / corridor value | **Reject.** ≈0.2 pts/position. |
| Human/practical difficulty | **Defer** to the replay study. |

---

## 16. Implementation gate

**Do nothing to the evaluator yet. Fix the instrument first.**

Ranked by evidence, not by appeal:

1. **Deduplicate candidates by evaluation before simulating.** Up to 95% of the
   simulation budget is spent on duplicates (diagnosis §4.2). This is free
   strength and it is the precondition for everything below.
2. **Re-measure samples per decision and re-run the paired-variance probe.** Target
   signal/noise ≥ 2, which needs ~17 samples against today's 3.
3. **Then, and only then**, revisit the one confirmed evaluator gap — λ's clamp at
   zero when behind — because it multiplies the standard deviation that step 2
   fixes.

No new term. No new weight. No corridor model. No difficulty model.
