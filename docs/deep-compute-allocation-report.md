# Deep/Max compute allocation — review, changes, and gate evidence

Date: 2026-08-13

Scope: how `SearchEffort::Deep` spends work, measured against the Revision 2
architecture already in the tree. Production routing is unchanged. G6–G8 are not
declared passed. The governing architecture remains
[`aether-search-v2-design.md`](aether-search-v2-design.md); the prior status is
[`aether-search-v2-implementation-report.md`](aether-search-v2-implementation-report.md).

## 1. How Deep is routed and budgeted today

`DecisionSearch` is not reachable from production. `grep` over `src/engine.cpp`,
`src/wasm_api.cpp` and `service/src` finds no reference to it: the whole
Revision 2 stack is benchmark-side. Every shipped decision still goes through
the legacy `simulate()` path in `src/engine.cpp`.

What Deep therefore means in production today:

| Route | Budget | Mechanism |
|---|---|---|
| analysis `deep` (`service/src/levels.ts`) | `sampleCap: 40`, `timeoutMs: 150_000` | legacy `simulate()` |
| analysis `max` | `sampleCap: 160`, `timeoutMs: 330_000` | legacy `simulate()` |
| bot `max` (`BOT_TIER_CONFIG`) | `budgetMs: null` | legacy `simulate()`, stopped by the engine's own wall-clock ceilings |

Two things follow that are worth stating plainly:

- The engine defaults are `simTopK = 60` and `simSamples = 160`
  (`src/engine.cpp:165-166`). Deep is exactly the "topK = 60, samples = 40,
  thirdPly = true" shape the brief asks not to define Deep as, because that is
  what it currently is.
- The bot's `max` tier is **wall-clock bounded**, not work bounded. It is the
  one shipped tier that cannot satisfy the determinism requirement, and it is
  not fixed by anything in this report — it is fixed by routing `max` to
  `DecisionSearch`, which is gated on G6–G8.

`DecisionSearch::decide` remains pinned to `SimV2Reference` and is called only
by tests and benchmarks. Nothing in this work changed that.

## 2. What stopped Deep from using the v2 architecture as intended

Six defects, in rough order of how much they distorted the picture. The first is
the one that made the brief's central experiment unaskable.

### 2.1 `PairedRace` could not reallocate the work it saved

`decideWithVariant` looped over a world deck of fixed length `policy.worlds`.
Elimination removed candidates from later batches, but nothing ever converted
that saving into additional worlds for the survivors. At a fixed envelope the
paired policy therefore observed a strict **subset** of the (candidate, world)
matrix the uniform policy observed: it could only ever be cheaper, never better
informed.

That makes the "distribute additional worlds uniformly versus concentrate them
on unresolved contenders" comparison unrunnable as posed — there were no
additional worlds to distribute either way. It also means the earlier
observation that `PairedRace` "reduces call count" was never evidence that it
buys strength; reduced call count was the only outcome it could produce.

### 2.2 The envelope was denominated in worlds, not in work

`worlds = 8` at Deep regardless of the position. An easy position and a
three-way tie received identical schedules, so "obvious position resolves
quickly, difficult position thinks harder" was not expressible.

### 2.3 Selecting a variant also changed admission

`policyFor` shrank `candidateCap` to `opponentCallAllowance / worlds` for the
reference variant only, giving Deep 12 admitted candidates for
`SimV2Reference` and 23 for the ReplyIndex variants. Any A/B between them
confounded the reply mechanism with the size of the candidate set.

### 2.4 One expensive hidden world aborted the whole search

If any candidate's reply set could not be enumerated completely, the world was
discarded and the loop `break`. The remaining budget was abandoned. Worse, the
exact fallback was handed the same per-call node limit that had just failed, so
whenever the base index truncated the fallback was guaranteed to truncate too.

Measured over a 24-world deck at Deep's original 12M per-call limit, 4–8% of
worlds overflowed — and the racks that overflow are precisely the ones with the
most replies. The old fixed 8-world schedule mostly did not reach them; a longer
schedule does, constantly.

### 2.5 The node ledger did not model the dominant cost

`WorkLedger` bounds `movegenNodes`. On the exact-reply path, revalidating the
base index against each candidate board is real work the node counter never
sees. Profiling a Deep decision put `validatePlaceMove` at roughly 30% of the
time. Two policies with equal node counts were therefore not doing equal work,
which is fatal for an equal-compute comparison.

### 2.6 A quarter of Deep's CPU was building tie-break strings

`canonicalMoveKey` used `std::ostringstream`, and it is called once per reply
per candidate per world in `ReplyIndex::recover`, then again for every reply in
`rankReplies`. A stack profile of Deep attributed **26%** of CPU to it and
another 5.5% to the `std::map<std::string, Move>` merge it feeds.

This is not an architecture problem, but it distorted every cost measurement and
it directly shrank what any envelope could buy.

## 3. Changes made

All of these are in the benchmark path. No production route, wire field, or
service tier changed.

### 3.1 Constant-factor removals (bit-identical)

- `canonicalMoveKey` hand-formats into a reserved buffer and sorts a stack index
  array. The output bytes are unchanged, which matters: the key is the total
  order behind every deterministic tie-break in the engine, so a different
  encoding would silently reorder equal-value moves.
- `rankReplies` builds a key only on an improvement or a tie, instead of for
  every reply.
- `OpponentPolicyEvaluator` gained a `context()` accessor so a ranking loop
  builds the board context once instead of per move.
- `ReplyIndex::recover` merges into a vector and does one stable sort with
  last-wins deduplication, reproducing the overwriting-map semantics without a
  tree node and an allocation per reply.

Verification: a fingerprint dump of `(move, value, method, completion, root and
admitted counts, worlds, every ledger counter, per-purpose accounting, and every
candidate's key/static/mean/observation count)` over 6 positions x 3 efforts x 3
variants is byte-identical before and after. `make test-v2` passes and
`make verify-reply-index` still reports 10000/10000 exact triples.

Effect on the profile: `canonicalMoveKey` 26% → 0.8%, `rankReplies` 16% → 0.5%,
`generatePlaceMoves` 56% → 80% of CPU. Deep is now dominated by search.

### 3.2 A deterministic cost model

`modeledSearchCost = movegenNodes + 48 x replyRevalidations`. The weight is
derived from the corpus (about 154 nodes per revalidation at a measured ~30% of
runtime) and is frozen policy, so the same query spends the same credits on any
machine. Both raw nodes and modelled cost are reported, so an equal-compute
claim can be checked in either currency.

### 3.3 Adaptive allocation

Two new benchmark variants, `ReplyIndexAdaptiveUniform` and
`ReplyIndexAdaptivePaired`. The three existing variants are untouched and remain
the oracles.

The adaptive loop replaces the fixed schedule with a credit envelope:

1. every admitted candidate is measured on a screening prefix of shared worlds;
2. after each complete batch the race eliminates separated candidates
   (paired arm only);
3. the schedule continues while credits remain and the contenders are
   unresolved, so survivors receive **more** worlds than the schedule would
   otherwise have allowed;
4. before each world the allocator prices the next one from what the completed
   worlds actually cost — one base generation plus one observation per active
   candidate — and stops rather than overshooting;
5. it stops early on `SingleCandidate` (one contender left) or `Indifferent`
   (no surviving challenger could beat the leader by more than the declared
   margin), returning the unspent credits.

Determinism: the projection is integer arithmetic, world `i` depends only on the
position hash and `i`, and no wall clock enters any decision. `StopReason` is
reported so "finished thinking" and "ran out" are never conflated; only the
first two count as `Completion::Complete`.

### 3.4 A dropped world no longer ends the search

An adaptive search now skips a world it cannot complete and continues; a fixed
schedule still stops, as before. Deep's per-call opponent node limit went from
12M to 48M, which removes the drops entirely on the measured deck. This is a
sampling-bias fix, not a speed fix: silently excluding the highest-branching
opponent racks biases the world sample toward quiet racks.

### 3.5 Measurement surface

`PairedRace` now exposes the same statistic elimination uses (`PairedGap`, with
the elimination allowance separated from the honest risk bound), elimination
rounds, and the per-round active counts. `SearchDecision` carries stop reason,
worlds planned and completed, elimination rounds, the final leader/challenger
paired gap, modelled cost, and the credit envelope.

`SearchOverrides` is a benchmark-only struct — `decide()` does not take it — that
pins admission, schedule, credits, elimination allowance and the world seed
salt, so an experiment can change exactly one thing. Ledger ceilings are
re-derived from the final knob values in one place, because an override that
widened admission without widening the ceilings would not fail loudly: it would
quietly refuse generations and report a weaker search as if it were the policy.

## 4. Results

### 4.1 Corpus and reference

24 positions built by deterministic static self-play across four seeds
(`CORPUS_SEEDS` in `src/deep_bench.cpp`). The oracle is exact-reply uniform
allocation over a wider admission (cap 48) and up to 20 shared worlds, with
stopping disabled and credits it cannot exhaust.

The oracle completed a mean of 15.0 of 20 worlds, worst case 3. That number is
itself a finding: about a quarter of hidden worlds at Deep have opponent racks
whose reply set cannot be completely enumerated inside the per-call ceiling, and
a search that requires complete enumeration has to drop them. Every regret
figure below is therefore measured against a 15-world estimate, not against
truth, and small differences between policies should not be over-read.

### 4.2 Where Deep's work goes

Stack profile of a Deep decision on the exact-reply path, before and after the
constant-factor work in 3.1:

| | before | after |
|---|---:|---:|
| `generatePlaceMoves` | 56% | 80% |
| `canonicalMoveKey` | 26% | 0.8% |
| `validatePlaceMove` (revalidation) | 19% | 24% |
| `rankReplies` | 16% | 0.5% |
| `std::map` merge | 5.5% | 0% |

The per-world cost decomposes as `base index + k x observation`. Measured on the
adaptive uniform arm: base ≈ 0.69M cost per world, observation ≈ 0.072M. **One
extra world costs about as much as 9.5 extra candidate observations, whatever
the active count is.** That fixed cost is the fact the whole allocation question
turns on.

### 4.3 Policy comparison — 24 positions, `SearchEffort::Deep`

| | A legacy sim | B reference | C index, B's admission | C' index, Deep admission | D paired, fixed | E adaptive uniform | F adaptive paired |
|---|---:|---:|---:|---:|---:|---:|---:|
| admitted candidates | 34.7 | 8.5 | 8.5 | 14.1 | 14.1 | 14.1 | 14.1 |
| worlds / samples | 25.0 samples | 8.0 | 8.0 | 8.0 | 5.5 | 16.0 | 18.5 |
| candidate-world observations | — | 68.3 | 68.3 | 112.7 | 64.5 | 313.8 | 181.2 |
| full generation calls | 2472.4 | 65.7 | 9.0 | 9.0 | 6.5 | 17.0 | 19.5 |
| delta generation calls | — | 0 | 20.3 | 56.0 | 38.6 | 127.4 | 106.3 |
| revalidations | — | 0 | 37,372 | 67,758 | 38,808 | 407,298 | 232,038 |
| DFS nodes | 158.1M | 24.1M | 4.03M | 8.42M | 7.01M | 34.3M | 39.5M |
| — of which index base | — | — | 1.99M | 1.99M | 1.90M | 10.97M | 15.19M |
| — of which delta | — | — | 1.37M | 5.76M | 4.45M | 22.69M | 23.62M |
| — of which reference | — | 23.45M | 0 | 0 | 0 | 0 | 0 |
| — of which fallback | — | 0 | 0 | 0 | 0 | 0 | 0 |
| modelled cost | — | 24.1M | 5.83M | 11.68M | 8.87M | 53.9M | 50.6M |
| latency mean | 18,902 ms | 1,386 ms | 351 ms | 770 ms | 524 ms | 3,594 ms | 3,173 ms |
| latency p50 | 1,448 ms | 398 ms | 177 ms | 224 ms | 169 ms | 494 ms | 400 ms |
| latency p95 | 47,159 ms | 4,050 ms | 988 ms | 2,190 ms | 1,749 ms | 10,245 ms | 8,830 ms |
| latency p99 | 49,493 ms | 4,830 ms | 1,009 ms | 2,474 ms | 2,158 ms | 10,938 ms | 10,303 ms |
| elimination rounds | — | 0 | 0 | 0 | 1.50 | 0 | 2.25 |
| final active candidates | — | 8.5 | 8.5 | 14.1 | 5.5 | 14.1 | 5.2 |
| leader/challenger paired gap | — | -10.38 pt | -10.38 pt | -11.36 pt | -6.57 pt | -7.63 pt | -3.89 pt |
| **top-action agreement** | **58.3%** | **66.7%** | **66.7%** | **75.0%** | **75.0%** | **87.5%** | **83.3%** |
| regret mean | 2.002 | 2.069 | 2.069 | 0.652 | 0.979 | 0.425 | 0.732 |
| regret p95 | 8.276 | 8.319 | 8.319 | 1.896 | 4.794 | 0.041 | 0.494 |
| regret max | 13.206 | 14.134 | 14.134 | 7.573 | 9.760 | 9.662 | 9.662 |
| completion | — | schedule 24 | schedule 24 | schedule 24 | schedule 15, single 9 | credits 8, deck 2, indifferent 7, single 7 | credits 4, deck 3, indifferent 8, single 9 |

Four things this table says.

**B and C are the same search.** Identical agreement, identical regret to three
decimals, identical paired gap, identical observation counts — at 6.0x fewer
DFS nodes, 4.1x lower modelled cost and 3.9x lower mean latency. The benchmark
also asserts this position by position, not just in aggregate. This is the
uncontroversial part of the whole exercise: exact reply reuse is free strength.

**Deep's biggest error source is admission, not allocation.** C and C' differ
only in how many candidates were admitted (8.5 vs 14.1). That alone moves mean
regret from 2.069 to 0.652 and agreement from 66.7% to 75.0%, for 2x cost. No
allocation change in this table produces a swing that large.

**Legacy Deep is dominated on both axes.** E uses 4.6x fewer DFS nodes than the
legacy sampler (34.3M vs 158.1M), agrees with the reference 87.5% of the time
against legacy's 58.3%, and cuts p95 latency from 47.2 s to 10.2 s. Legacy's p50
is only 1.4 s — the cost is concentrated in a tail that the fixed sample count
cannot see coming.

**The adaptive envelope behaves as intended.** E resolves and returns unspent
credits on 14 of 24 positions (7 indifferent, 7 single-candidate) and spends
credits to exhaustion on 8. Easy positions stop; contested ones spend.

### 4.4 G6 — candidate admission

Admitted set against the oracle's own choice, 24 positions:

| cap | recall | mean regret | p95 regret | max regret | catastrophic (>10 pt) |
|---:|---:|---:|---:|---:|---:|
| 7 | 70.8% | 1.986 | 8.844 | 14.134 | 1 |
| 12 | 75.0% | 1.449 | 6.156 | 14.134 | 1 |
| 15 | 83.3% | 1.290 | 6.156 | 14.105 | 1 |
| 23 | 95.8% | 0.257 | 0.000 | 6.156 | 0 |
| 32 | 95.8% | 0.257 | 0.000 | 6.156 | 0 |

Registered thresholds: recall ≥ 99%, mean regret ≤ 0.25 pt, p95 ≤ 2 pt, no miss
over 10 pt.

**G6 does not pass at any cap.** Deep's shipped admission (cap 23) reaches 95.8%
recall against a required 99%, and mean regret 0.257 against a required 0.25 —
close, but not passing. The reference variant's effective cap of 12 fails
outright: 75% recall, 1.449 mean regret, and a 14.1-point miss.

Cap 23 and cap 32 are identical, and mean admitted count at cap 23 is only 14.1.
The cap is not what is binding at that point — the 90-point plausibility
envelope is. Raising the cap alone cannot fix the remaining 4.2% of recall.

### 4.5 G7 — uniform against paired at equal credits

16 positions, same credit envelope, same shared world schedule, same admission:

| | uniform | paired |
|---|---:|---:|
| modelled cost | 66.3M | 65.1M |
| worlds completed | 15.4 | 19.4 |
| candidate-world observations | 295.6 | 183.2 |
| index base nodes | 9.66M | 15.63M |
| full generation calls | 16.4 | 20.4 |
| elimination rounds | 0 | 2.31 |
| final active candidates | 17.9 | 6.3 |
| **top-action agreement** | **87.5%** | **81.2%** |
| regret mean / p95 / max | 0.033 / 0.041 / 0.494 | 0.493 / 0.494 / 7.360 |
| elimination mistakes | — | 1 |
| seed-salt stability | 75.0% | 75.0% |
| latency mean / p95 | 4,715 / 10,916 ms | 5,210 / 14,986 ms |

Uniform vs paired top-action agreement: **93.8%** (15/16).

**G7 fails.** Against its registered thresholds:

- top-action agreement 93.8% < 95%;
- median opponent-generation calls did not fall by 30% — they **rose**, from
  16.4 to 20.4 full calls, and modelled cost fell only 1.8%;
- mean reference regret 0.493 scrapes under the 0.5 pt bar, but it is 15x the
  uniform arm's 0.033 at the same compute;
- p95 latency is 37% worse.

The mechanism is the fixed per-world cost. Paired allocation ran 26% more worlds
with 3x fewer candidates in each, so it paid 62% more for base index generation
and bought 38% fewer observations. Concentrated observations cost about 1.7x
what wide ones cost, and the concentration is spent on candidates that are
nearly tied — which is where the decision matters least by construction — while
elimination occasionally drops the move the oracle wanted.

The elimination allowance sweep confirms this is structural rather than a tuning
problem. Across allowances from 0 to 6 equity points, the paired arm's agreement
stayed at 81.2% and its mean regret at 0.493 — **identically, at every setting**
— while cost moved from 52.3M to 65.1M and final active candidates from 3.9 to
7.1:

| allowance | worlds | final active | elim rounds | cost | agreement | regret | elim mistakes |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 0.00 pt | 17.9 | 3.88 | 2.88 | 52.3M | 81.2% | 0.493 | 1 |
| 0.25 pt | 17.9 | 4.12 | 2.62 | 52.4M | 81.2% | 0.493 | 1 |
| 0.50 pt | 17.9 | 4.25 | 2.56 | 52.5M | 81.2% | 0.493 | 1 |
| 1.00 pt | 17.9 | 5.00 | 2.56 | 54.2M | 81.2% | 0.493 | 1 |
| 2.00 pt | 19.4 | 6.19 | 2.38 | 63.9M | 81.2% | 0.493 | 1 |
| 3.00 pt | 19.4 | 6.31 | 2.31 | 65.1M | 81.2% | 0.493 | 1 |
| 6.00 pt | 19.1 | 7.12 | 2.19 | 58.3M | 81.2% | 0.493 | 1 |

Tuning the allowance changes what paired allocation *spends*. It does not change
what it *decides*. There is no setting of this knob at which concentration earns
its keep on this corpus.

### 4.6 What the envelope should be spent on

Credit curve, 12 positions, admission held at Deep's cap:

| credits | policy | cost/decision | worlds | agreement | regret | p95 |
|---:|---|---:|---:|---:|---:|---:|
| 30M | uniform | 30.1M | 11.9 | 75.0% | 0.858 | 0.494 |
| 30M | paired | 25.8M | 12.5 | 75.0% | 0.858 | 0.494 |
| 60M | uniform | 57.6M | 15.1 | **83.3%** | **0.045** | 0.041 |
| 60M | paired | 55.2M | 17.4 | 75.0% | 0.203 | 0.494 |
| 120M | uniform | 88.4M | 19.5 | 83.3% | 0.045 | 0.041 |
| 120M | paired | 86.8M | 25.1 | 75.0% | 0.658 | 0.494 |
| 240M | uniform | 141.2M | 26.0 | 83.3% | 0.045 | 0.041 |
| 240M | paired | 100.7M | 28.3 | 75.0% | 0.658 | 0.494 |
| 480M | uniform | 167.3M | 28.7 | 83.3% | 0.045 | 0.041 |
| 480M | paired | 109.9M | 31.6 | **66.7%** | 0.658 | 0.494 |

Uniform allocation saturates at about 60M modelled cost. Everything above that
buys more worlds and no better decisions.

Paired allocation never reaches uniform's quality at any budget, and gets
**worse** as the budget grows: 75.0% agreement at 30M down to 66.7% at 480M.
More credits mean more elimination rounds, and every elimination round is
another chance to discard the move the reference wanted. This is the clearest
single result in the report.

Width against depth, same 120M envelope, uniform allocation:

| admission cap | admitted | worlds | cost | agreement | regret | p95 |
|---:|---:|---:|---:|---:|---:|---:|
| 7 | 7.0 | 6.9 | 14.1M | 58.3% | 3.496 | 9.760 |
| 12 | 12.0 | 15.0 | 41.1M | 58.3% | 2.729 | 9.760 |
| 17 | 16.2 | 20.4 | 73.8M | 66.7% | 1.240 | 0.494 |
| 23 | 21.2 | 19.5 | 88.4M | **83.3%** | **0.045** | 0.041 |
| 32 | 28.7 | 17.2 | 102.1M | 83.3% | 0.045 | 0.041 |
| 48 | 42.0 | 14.5 | 101.5M | 75.0% | 0.203 | 0.494 |

A narrow Deep cannot spend its envelope usefully: at cap 7 the search resolves
and stops after 6.9 worlds having spent 14M of its 120M, and is wrong far more
often. Widening from 12 to 23 cuts mean regret 60-fold for 2.2x the cost.

But width has a ceiling, and it is visible here: at cap 48 the same credits are
spread over 42 candidates and only 14.5 worlds, and the decision gets **worse**
again — 75.0% agreement, regret 0.203. More candidates and fewer worlds each
makes every estimate noisier.

So the two effects pull against each other. Admission recall rises
monotonically with width (§4.4), while decision quality at a fixed envelope
peaks and then falls. On this corpus the optimum is a plateau at cap 23–32, and
Deep's shipped cap of 23 sits on it.

**The answer to "uniform or concentrated" is therefore that neither is the
interesting axis.** Both lose to getting admission right. Within the envelope,
the ordering is: admit enough candidates to contain the reference's choice, then
measure all of them on as many shared worlds as the credits allow — and at that
point spreading the worlds beats concentrating them.

## 5. Gate status

| Gate | Verdict | Evidence |
|---|---|---|
| G5 ReplyIndex exactness | still holds | `make verify-reply-index` 10000/10000; rows B and C identical per position on all 24 corpus positions |
| G6 admission | **fail** | best measurable configuration (cap 23) reaches 95.8% recall against a required 99%, and mean regret 0.257 against a required 0.25. The reference variant's effective cap of 12 reaches 75% recall with a 14.1-point miss |
| G7 PairedRace | **fail** | uniform/paired agreement 93.8% < 95%; generation calls rose 24% instead of falling 30%; mean regret 15x the uniform arm at equal compute; p95 latency 37% worse |
| G8 strength/latency | not run | blocked by G6 and G7; requires paired self-play |

A methodology limit to fix before G6 can be re-run at wider admission: the
oracle admits cap 48, so the cap-48 and envelope-sweep rows are circular — the
policy under test and the reference share a candidate set, and recall is 100% by
construction. Those rows are printed for completeness and must not be read as
results. G6 is only meaningful today for caps of 32 and below. A wider oracle
(cap 96, or exhaustive on small-root positions) is required.

## 6. Recommendation

**Do not switch production Deep.** G6 and G7 both fail. Nothing here authorises a
routing change, a canary, or a tier config edit, and none was made.

Beyond that, the evidence supports four decisions.

**1. Reject paired elimination as Deep's allocation policy.** The brief asked
whether concentrating additional worlds on unresolved contenders beats spreading
them. On this corpus it does not, at any credit budget and at any elimination
allowance, and the reason is structural rather than a tuning failure: a world
costs one base index generation regardless of how many candidates are still
active, so concentrated observations cost about 1.7x wide ones, and they are
spent resolving candidates that are nearly tied — where the decision matters
least — while occasionally discarding the move the reference preferred. Keeping
`PairedRace` as a benchmark arm is worthwhile; shipping it as the allocator is
not.

**2. Fix admission before anything else, but not by widening it further.** It is
the dominant error source — larger than the reply mechanism, the world count and
the allocation policy combined — yet cap 23 is already on the quality plateau,
and cap 48 is worse. The remaining 4.2% of recall has to come from a better
*selection rule* at the same width, not from more candidates: above roughly cap
23 it is the 90-point plausibility envelope that binds, not the cap (mean
admitted is 14.1 against a cap of 23), and that envelope has never been fitted
against held-out data. Widening the oracle to cap 96 or exhaustive is a
prerequisite for fitting it, because today the reference cannot score anything
the reference did not itself admit.

**3. The Deep envelope should be about 60M modelled cost, not 120M.** That is
where the uniform curve saturates. The current default spends 1.5x that for no
measurable gain. Set it from the knee, and re-derive it whenever the corpus or
the evaluator changes rather than picking a round number.

**4. Deep's shape, once G6 passes, is `ReplyIndexAdaptiveUniform`:** exact
replies, wide conservative admission, all admitted candidates on every shared
world, a deterministic credit envelope, and early stopping on separation or
indifference. On the 24-position corpus that configuration uses 4.6x fewer DFS
nodes than the legacy sampler, agrees with the reference 87.5% of the time
against legacy's 58.3%, cuts p95 latency from 47.2 s to 10.2 s, and returns
unspent credits on 58% of positions.

### Separately: the bot `max` tier is not deterministic

`BOT_TIER_CONFIG.max` uses `budgetMs: null` and is stopped by the engine's
wall-clock ceilings. It is the one shipped tier that cannot satisfy the
determinism requirement, and no change in this report fixes it — only routing it
to `DecisionSearch` does, which is gated on G6–G8. Worth tracking explicitly so
it is not mistaken for something the v2 work already addressed.

### Candidate next experiments, in expected-value order

1. **Skip revalidation outside the dependency region.** `validatePlaceMove` is
   24% of Deep's CPU after the constant-factor work. A base reply can only
   change validity or score if it intersects the candidate's dependency region,
   and `dependencyStartMasks` already computes that region for delta generation.
   This is exactness-critical and would have to clear the existing 10,000-triple
   equality gate, but the gate already exists.
2. **Reduce the variance of a world rather than buying more worlds.** What
   resolves a close pair is the standard error of the paired difference.
   Stratified or antithetic opponent-rack draws attack that directly and cost
   nothing per world, whereas every extra world pays the base index again.
3. **Amortise the base index across worlds.** Speculative: generate once for a
   superset rack and filter per world by tile-multiset containment. It would
   turn the per-world fixed cost into a one-off, which is the cost term that
   makes concentration uneconomic. Worth a measurement before any design work,
   since a superset rack may simply be too large to enumerate.
4. **Decide what to do about worlds that cannot be completely enumerated.** The
   oracle drops about a quarter of them at Deep, and the racks that overflow are
   the highest-branching ones. Today they are silently excluded, which biases
   the world sample toward quiet opponent racks. The options are a higher
   ceiling, an explicit reweighting, or a soundly-defined truncation — but the
   current answer is an accident, not a choice.

Third ply remains out of scope, as required, and none of the above depends on
it.
