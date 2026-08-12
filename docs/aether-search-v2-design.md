# Aether Decision Search — Revision 2 technical specification

**Status:** core modules and benchmark experiments through stage 9 are
implemented; their full gates are tracked separately, and legacy production
routing is unchanged pending G6–G8.  
**Scope:** the next two-player midgame decision path and the seam around it;
solo search behavior is not redesigned here.  
**Priority:** correctness → playing strength → latency.  
**Supersedes:** the proposed future L2+ search in
[`level1-fast-path-design.md`](level1-fast-path-design.md). It does not replace
the shipped static Easy path or the separate hidden-endgame specification.

## 0. Locked decisions

Revision 2 locks the following direction:

1. One deep `DecisionSearch` Module owns solver ordering and returns one legal
   decision through a small Interface.
2. Every expensive operation is charged to a request-local `WorkLedger`.
3. `StateTransition` is the single source of truth for move, draw, exchange,
   scoreless-turn, rack-out, and terminal scoring semantics.
4. `RootCatalogue` generates root placements once and preserves strategically
   distinct assigned-token states.
5. Midgame comparison uses shared hidden worlds and paired observations.
6. The first trustworthy reference is `sim_v2-reference`: real
   candidate-specific opponent generation, complete state transitions, a
   symmetric endpoint objective, and no self-future move generation.
   `bestPlaceScore` is forbidden from every v2 path; it may survive temporarily
   only inside the isolated legacy rollback path.
7. `PairedRace` may change allocation, but not the meaning of one observation.
8. The first optimization experiment after the reference is correct and
   benchmarked is an **exact** `ReplyIndex + DeltaReplyGenerator`
   decomposition. Adaptive admission and racing come afterward, so their gains
   cannot hide an inexact reply decomposition.
9. A Threat Oracle and selective third ply remain experiments. Neither is a
   required part of this architecture.
10. No large rewrite lands as one change. Each stage below is independently
    benchmarkable and revertible.

## 1. Why Revision 2 exists

The current simulator in [`engine.cpp`](../src/engine.cpp) spends almost all of
its time in repeated move generation. On the profiled 60-placement,
7-exchange, 4-world midgame position:

| work | time | share of request |
|---|---:|---:|
| root generation | 620.9 ms | 9.6% |
| opponent generations | 2,895.6 ms | 45.0% |
| `bestPlaceScore` generations | 2,915.2 ms | 45.3% |
| all other work | about 5 ms | under 0.1% |

The current generation-count model is:

```text
G_current = 2 + S * (1 + 2P + E) - memoHits

P = placement candidates
E = exchange candidates
S = completed hidden-rack samples
```

For `P=60`, `E=7`, this is approximately `2 + 128S`: 513 measured
generations at four samples and potentially more than 20,000 at 160 samples.

The current self-future term is not a real third ply. It generates our future
move on the board after our root placement but before the simulated opponent
reply has been applied. Its memo has essentially no midgame reuse, and measured
cheap substitutes were indistinguishable from omitting the term. Revision 2
therefore removes this term from the new path instead of optimizing it.

## 2. Vocabulary and seam placement

The external **Seam** sits inside the C++ engine after wire parsing and position
validation:

```text
JSON/process Adapter
        │
        ▼
validated Position + SearchEffort
        │
        ▼  DecisionSearch Interface
Decision + SearchDiagnostics
```

`DecisionSearch` is a deep **Module**: exact-endgame routing, root generation,
world construction, opponent modeling, racing, fallback, and accounting live
inside its **Implementation**. Callers do not choose candidate counts, sample
counts, confidence constants, reply-index width, or ply depth.

All search dependencies are in-process computations. Do not introduce ports
such as `IMoveGenerator`, `IRandom`, or `IClock`. Focused internal seams are
allowed for tests and benchmark policies, but they are not part of the external
Interface. The existing server-state-to-engine translation and JSON process
transport remain the only Adapters.

## 3. External Interface

Illustrative C++ Interface:

```cpp
enum class SearchEffort : uint8_t {
  Instant,
  Interactive,
  Strong,
  Deep,
};

struct ReportOptions {
  uint8_t alternatives = 1;  // output only; cannot affect the decision
  bool includeCandidateEvidence = false;
};

struct SearchQuery {
  Position position;
  SearchEffort effort;
  ReportOptions report;
};

enum class SearchMethod : uint8_t {
  Static,
  PairedOpponentSearch,
  ExactEndgame,
  CompleteHiddenEndgame,
};

enum class ValueKind : uint8_t {
  StaticEquity,
  ExpectedEquity,
  ProvenFinalMargin,
  CompleteWinProbability,
};

enum class Completion : uint8_t {
  Complete,
  RootLimited,
  WorkLimited,
};

struct SearchDecision {
  Move move;
  int32_t value;          // fixed-point units; scale named by ValueKind
  SearchMethod method;
  ValueKind valueKind;
  Completion completion;
  bool proven;
  SearchDiagnostics stats;
  std::vector<Alternative> alternatives;
};

std::expected<SearchDecision, SearchError>
DecisionSearch::decide(const SearchQuery&, ProgressSink = {});
```

### 3.1 Interface contract

- `Position` contains rule state, never product tier names or game identity.
- `SearchEffort` selects a sealed, versioned work envelope. It does not select
  an algorithm.
- `ReportOptions` affects serialization only. Asking for more alternatives must
  not change the chosen move or search order.
- The same canonical `(Position, SearchEffort, searchVersion)` produces the same
  decision and evidence regardless of machine speed or load.
- Normal work exhaustion returns the best result from the last complete search
  checkpoint with `completion != Complete`; it is not a process error.
- Only a completed perfect-information proof sets `proven=true` and
  `ValueKind::ProvenFinalMargin`.
- A completely enumerated probability-weighted hidden endgame uses
  `CompleteWinProbability`, not `proven`.
- Malformed state returns `InvalidPosition`; illegal output, accounting
  mismatch, failed undo, or budget overshoot returns
  `InternalInvariantFailure`.

During migration, `handleRequest()` remains the JSON Adapter and may continue
accepting the old `solver` fields. Those fields must not become part of the new
Module's Interface.

## 4. Position and hidden-world data

The current wire field `bagCount` combines physical bag tiles and pending
exchange returns. That is sufficient for unseen-tile accounting but insufficient
for exact transition semantics. The normalized v2 `Position` must distinguish:

```cpp
struct Position {
  Board board;
  TileCounts myRack;
  TileCounts unseen;
  uint8_t physicalBagCount;
  uint8_t opponentRackCount;
  uint8_t pendingReturnCount[2];
  int32_t myScore;
  int32_t opponentScore;
  uint8_t noScoreStreak;
  bool openingPlacementCompleted;
  Side sideToMove;
};
```

`openingPlacementCompleted` is derived and cross-checked against the canonical
game history (and, for valid ordinary positions, a non-empty board). It is not
inferred from `noScoreStreak`: six opening passes/exchanges do not trigger the
versus no-score ending until an opening placement has occurred.

At an ordinary `choose_action` decision both pending-return counts should be
zero: the previous mover refills and returns exchanged tiles before the next
decision. The state Adapter must assert this invariant. A nonzero value is not
silently folded into the bag for v2; either the request is rejected as not
action-ready or `WorldDeck` explicitly assigns those hidden tiles to their
separate compartments.

Within a sampled world the complete state is known to the search:

```cpp
struct WorldState {
  Board board;
  TileCounts rack[2];
  PhysicalBag bag;                 // ordered synthetic physical tile IDs
  TileCounts pendingReturn[2];
  int32_t score[2];
  uint8_t noScoreStreak;
  bool openingPlacementCompleted;
  Side sideToMove;
  TerminalState terminal;
};
```

Synthetic physical IDs distinguish duplicate copies of one tile kind and make
sampling, draw prefixes, and exchange-return shuffles unambiguous. They never
leave the search Module or appear in bot diagnostics.

## 5. Global invariants

These invariants are contractual and require tests, not comments:

### I1 — legal decision

Every successful result is legal in the input position. Pass is always retained
as a deterministic fallback.

### I2 — deterministic work

No wall-clock read, process order, game ID, hash-table iteration order, or
thread completion order may affect the move. Ties use a total order over move
type, cells, physical kinds, assigned tokens, and exchange multiset.

### I3 — complete accounting

Every full generation, delta generation, emitted move, movegen DFS node,
endgame node, world, transition, and cache lookup is charged to exactly one
request-local ledger purpose. `stats.nodes` may not omit future-ply work as it
does today.

### I4 — hard work bounds

The Implementation never exceeds the sealed work envelope. Wall time is an
observed diagnostic and an outer process kill switch, not a search cutoff.

### I5 — one root catalogue

At most one root placement enumeration occurs per decision. Static search,
midgame search, exact-endgame gating, and exact endgame consume the same root
artifact. A successful endgame path must not regenerate root moves.

### I6 — assignment-aware root identity

Moves that use the same physical kinds in the same cells but assign `?`, `+/-`,
or `x//` differently are distinct when their resulting board states differ.
Footprint deduplication is permitted only in a projection whose evaluator is
proved assignment-insensitive.

### I7 — one transition semantics

Every simulated placement, exchange, pass, draw, terminal event, and undo goes
through `StateTransition`. Search code may not reproduce a partial version of
the game rules.

### I8 — shared-world pairing

Within one paired batch, every active candidate is evaluated from an untouched
copy of the same hidden world. A batch affects estimates only after all active
candidates complete it at the same fidelity.

### I9 — correct objective labeling

Expected equity, complete win probability, and guaranteed final margin are
different quantities and cannot share a label. Statistical uncertainty is not
mixed into strategic utility.

### I10 — honest completeness

An incomplete root catalogue, opponent reply set, paired batch, or endgame
search is reported as such. No truncated search is called exact.

### I11 — request isolation

No board intelligence, world schedule, memo, or reply index survives the
request. Exact endgame transposition tables and reply indexes are request-local.

### I12 — rollback identity

After every make/unmake sequence, the board, racks, bag, returned tiles, scores,
streak, side to move, hash, and maintained generator state are byte-identical to
their prior values.

### I13 — opponent information boundary

An opponent action may depend on the post-root public position and that
opponent's sampled rack. It may not depend on Aether's hidden refill, the exact
remaining bag kinds/order, or any future draw. Full worlds are visible to the
rollout coordinator, not to `OpponentPolicyEvaluator`.

## 6. Module boundaries

| Module | Interface responsibility | Hidden Implementation |
|---|---|---|
| `DecisionSearch` | `SearchQuery → SearchDecision` | ordering, fallback, policy version, progress |
| `WorkLedger` | reserve and charge bounded work by purpose | counters, ceilings, completion reason |
| `RootCatalogue` | build one immutable root artifact | placement generation, exchange enumeration, total order |
| `StateTransition` | apply/undo one legal action and its consequences | scoring, draws, exchange returns, terminal rules |
| `WorldDeck` | deterministic shared hidden worlds | physical sampling, event-keyed random permutations |
| `EndpointEvaluator` | evaluate a fully transitioned leaf state | symmetric rack equity and later calibrated utility |
| `OpponentSearch` | policy-best opponent action from an information set | placement generation plus exchange/pass comparison |
| `OpponentPolicyEvaluator` | rank replies using only opponent-observable state | symmetric side-to-move score/leave policy |
| `PairedRace` | allocate worlds and eliminate contenders | paired differences, bounds, complete checkpoints |
| `EndgameRouter` | `Proven / CompleteHidden / Declined / Incomplete` | feasibility gate and exact solver invocation |
| `SearchDiagnostics` | immutable evidence returned to caller | purpose-local counters and candidate summaries |

These are logical Modules; Revision 2 does not require one class or file per row.
Create a separate file only when it improves Locality or makes the Interface a
natural test surface.

### 6.1 Required call ordering

```text
validate and normalize Position
  → create WorkLedger and deterministic world schedule
  → build RootCatalogue once
  → ask EndgameRouter using that catalogue
      → Proven or CompleteHidden: return
      → Declined or Incomplete: continue with reserved midgame work
  → static-evaluate every root action
  → admit conservative contender set
  → paired opponent search on shared worlds
  → select at last complete checkpoint
  → revalidate chosen move
  → attach diagnostics
```

The exact attempt must reserve enough work for a legal static fallback. Exact
search may never consume the root/fallback reserve and leave the decision with
no evaluated action.

## 7. WorkLedger

`WorkLedger` replaces the translation-unit generation counter as the source of
truth. A compatibility counter may remain temporarily, but tests compare it
against the ledger until it is deleted.

```cpp
enum class WorkPurpose : uint8_t {
  Root,
  OpponentReference,
  ReplyIndexBase,
  ReplyDelta,
  ReplyFallback,
  SelectiveThirdPly,
  ExactEndgame,
};

struct WorkEnvelope {
  uint32_t maxFullGenCalls;
  uint32_t maxDeltaGenCalls;
  uint64_t maxMovegenNodes;
  uint64_t maxEndgameNodes;
  uint32_t maxWorlds;
};

class WorkLedger {
 public:
  std::expected<GenerationPermit, WorkExhausted>
  reserveGeneration(WorkPurpose, uint64_t requestedNodeLimit);

  void commit(GenerationPermit&, const GenStats&);
  WorkReport report() const;
};
```

Rules:

- No generation entry point is reachable from `DecisionSearch` without a
  permit.
- A permit's node limit is at most the remaining global node allowance.
- The generator must stop without the current `nodeLimit + 1` overshoot before
  the ledger can promise `nodes <= maxMovegenNodes`.
- Full and delta generations are reported separately even if both use the same
  underlying DFS.
- Revalidation of an already materialized reply is not a generation call, but
  its count and elapsed time are still diagnostic fields.
- Each effort maps to a compile-time or versioned envelope. Initial values are
  calibration inputs, not promises:

| effort | root | opponent/full-generation allowance | optional depth |
|---|---:|---:|---:|
| Instant | 1 | 0 | 0 |
| Interactive | 1 | up to 8 | 0 |
| Strong | 1 | up to 32 | 0 |
| Deep | 1 | up to 96 | 0 until a later experiment passes |

Both call and node ceilings are mandatory: call bounds prevent architectural
explosion; node bounds control a pathological individual search.

## 8. RootCatalogue

```cpp
struct RootCatalogueResult {
  std::vector<RootAction> actions;  // placements + exchanges + pass
  bool placementEnumerationComplete;
  uint64_t nodes;
  uint64_t emittedAssignments;
};
```

Requirements:

1. Placement generation happens exactly once and is deterministically
   node-bounded.
2. The catalogue stores assignment-distinct placement states. It does not use
   the current `(cells, physical kinds)` midgame dedup key.
3. Exchange generation enumerates every unique kind multiset allowed by the
   rack and the physical-bag rule. A rack of eight has at most 255 non-empty
   physical subsets and fewer unique kind multisets, so the exhaustive step is
   cheap. The current one-greedy-subset-per-size chain is not sufficient.
4. Pass is always present.
5. Every action has a canonical key and total deterministic order.
6. Cheap static features may be computed during emission, but materializing the
   catalogue is allowed: profiling says the root DFS, not storage, dominates.
7. An incomplete catalogue can support an approximate decision, but it cannot
   support a proof or a benchmark labeled complete.

Candidate admission is a policy over this immutable artifact. It is not part of
move generation.

## 9. StateTransition

`StateTransition` is first built and tested independently of search.

### 9.1 Placement

1. Validate that the mover owns the physical kinds and that the placement is
   legal and correctly scored.
2. Remove played tiles, place their assigned tokens, and add the immediate
   score.
3. Set `openingPlacementCompleted=true` and reset `noScoreStreak` to zero.
4. Apply the production rack-out predicate and terminal bonus before refill.
5. If the game continues, draw to rack size from the physical bag.
6. Advance `sideToMove`.

### 9.2 Exchange

1. Recompute exchange eligibility from the fully specified world state; do not
   reuse the root request boolean for a future ply. In two-player play the
   production reserve is `physicalBagCount + otherRackCount - RACK_SIZE`; only
   the physical bag, not pending returns, supplies replacement tiles.
2. Remove the selected tiles into that side's pending-return compartment.
3. Increment `noScoreStreak`. If `openingPlacementCompleted`, resolve a
   six-no-score terminal before refill.
4. If play continues, draw the same count from the current physical bag. The
   exchanged tiles are not eligible for this draw.
5. Return the pending tiles to the remaining bag and perform the game's shuffle
   using the world's event-keyed random permutation.
6. Advance `sideToMove`.

### 9.3 Pass

1. Increment `noScoreStreak`.
2. If `openingPlacementCompleted`, resolve a six-no-score terminal, including
   the rack-point adjustment. Before the opening placement, the streak remains
   observable but does not end a versus game.
3. Otherwise advance `sideToMove`; no draw occurs.

### 9.4 Terminal values

- Rack-out and no-score terminal scores must match the EQ-Lab canonical rules
  bit-for-bit; `GameSim` must be brought to the same behavior.
- Once terminal, no later draw, return, or reply is applied.
- Terminal utility is the actual final score differential, not a heuristic.

Opponent modeling must compare placement, every legal exchange multiset, and
pass through these same transitions.

## 10. WorldDeck and common random numbers

A reference hidden world contains:

```cpp
struct HiddenWorld {
  TileCounts opponentRack;
  PhysicalBag orderedBag;
  WorldRandomTape randomTape;
  double weight;
};
```

Generation requirements:

- Sample physical unseen tiles without replacement. Duplicate kind counts
  therefore receive their correct combinatorial probability.
- Derive the schedule from a canonical position hash, a specified PRNG and
  shuffle algorithm, and the search-policy version. Game ID and wall time are
  excluded.
- A benchmark-only replicate salt may create independent schedules; it is not a
  production request knob.
- Every candidate starts from a fresh copy of the same world. Different draw
  counts consume different-length prefixes of the same ordered bag, preserving
  each candidate's marginal draw distribution while inducing useful positive
  correlation.
- Exchange shuffles use an event-keyed/counter-based random tape. They do not
  consume a shared mutable RNG whose position depends on the candidate's path.
- A world is committed only as part of a complete paired batch.

Uniform worlds have equal weight in `sim_v2-reference`. Stratified or weighted
world construction is a later variance-reduction experiment and must preserve
the target distribution.

## 11. Reference objective and non-clairvoyant opponent policy

Revision 2 deliberately separates **rule correctness** from the eventual
learned strength model. The first reference uses a simple, symmetric expected
equity objective after both players have acted and refilled.

For nonterminal leaf state `s`, from Aether's perspective:

```text
V_ref(s) = scoreA(s) - scoreB(s)
         + rackEquity(rackA, board, physicalBagMultiset)
         - rackEquity(rackB, board, physicalBagMultiset)
```

For terminal `s`:

```text
V_ref(s) = finalScoreA(s) - finalScoreB(s)
```

Requirements:

- Use fixed-point arithmetic or an explicitly tested total-order conversion.
- `physicalBagMultiset` is the same sampled post-transition bag context for both
  rack terms. Neither term may inspect future bag order.
- The endpoint rack term is symmetric. Aether is not granted a different leaf
  heuristic merely because it is the root player.
- `V_ref` evaluates the rollout outcome. It is **not** passed a full hidden world
  to choose the opponent action.
- The opponent receives an explicit information-set projection:

```cpp
struct OpponentInformationSet {
  Board publicBoard;
  TileCounts opponentRack;
  TileCounts publicUnseen;  // full distribution - board - opponent rack
  uint8_t publicPhysicalBagCount;
  int32_t publicScore[2];
  uint8_t noScoreStreak;
  bool openingPlacementCompleted;
};
```

- The initial declared policy is a deterministic, side-symmetric score/leave
  policy over every legal placement, exchange, and pass:

```text
Q_opp_ref(a | Iopp)
  = immediateScoreForOpponent(a)
  + expectedRackEquityForOpponent(after a | Iopp)
```

  The expectation uses only the public unseen multiset after conditioning on
  the opponent rack. The initial reference computes it analytically using the
  expected-fresh-tile term in the side-swapped static evaluator; it does not add
  a second sampling layer. It cannot read the realized Aether refill or future
  draw in the outer world. A terminal action is valued by expected final
  opponent margin conditional on the same information set.
- `OpponentSearch` chooses the action maximizing `Q_opp_ref`, with the canonical
  move order breaking ties. “Best reply” throughout this document means best
  under this declared policy, not a game-theoretic proof.
- After that single policy-chosen reply is applied completely to the outer
  world, the root candidate's observation is `V_ref` of the resulting leaf.
- Candidate value is the weighted mean across completed worlds.
- Do not subtract `lambda * sampleStddev`. Sampling uncertainty is handled by
  `PairedRace`; strategic risk belongs in a later calibrated win-probability
  utility.
- Do not call `bestPlaceScore` or any other self-future move generator.

This objective and opponent policy are reference baselines, not a claim that
the current rack model is optimal or that the modeled opponent is perfectly
rational. A later utility may maximize calibrated
`P(win | scoreDiff, bag, streak, phase, ...)`, but it must be trained only after
the opening exchange/six-pass pathology is resolved and must receive its own
held-out gate.

## 12. sim_v2-reference

`sim_v2-reference` is a benchmark policy behind the `DecisionSearch` seam. It is
not initially exposed as a production wire option.

A reference run also declares its root scope:

```cpp
enum class ReferenceRootScope : uint8_t {
  Exhaustive,       // every action in a complete RootCatalogue
  FrozenSubset,     // an explicitly recorded, immutable set of root keys
};
```

Only `Exhaustive` is a whole-position reference. `FrozenSubset` exists so that
large-position experiments can compare allocation or reply generation on an
identical affordable candidate set; it is an oracle only within that set. Its
root-key fingerprint is part of every benchmark row. Production candidate
admission is never allowed to redefine the reference set during a comparison.

```text
RootCatalogue
  → static evaluation of every root action
  → select the declared benchmark root scope
  → deterministic shared WorldDeck
  → for each contender/world:
       apply root action completely, including Aether refill
       project the opponent-visible information set
       enumerate every opponent placement on the actual resulting board
       add every legal opponent exchange and pass
       choose the policy-best reply without reading outer hidden continuations
       apply that reply completely in the outer world
       evaluate V_ref
  → paired world values
  → expected-equity ranking
```

Reference rules:

- Opponent placement generation is candidate-specific. There is no ReplyIndex,
  threat approximation, or shared reply bank.
- A reply result is `Complete` only if placement enumeration completes. A
  truncated reply cannot silently enter a benchmark labeled reference-complete.
- `reference-complete` is always qualified by `ReferenceRootScope`; for a
  `FrozenSubset` it means complete only within the recorded root fingerprint.
- Reference mode gives every in-scope candidate the same worlds and performs no
  statistical elimination. This provides the comparison oracle for
  `ReplyIndex`, admission, and `PairedRace` within the declared root scope.
- A work-limited run falls back to the last complete paired batch; if none
  exists, it returns the static leader with `WorkLimited`.
- All diagnostics are broken down by root, opponent placement generation,
  exchange/pass evaluation, transitions, and endpoint evaluation.

The generation-count model becomes:

```text
G_reference = 1 root
            + sum over completed (candidate, world) opponent generations
```

There is no self-generation term.

## 13. Candidate admission and PairedRace

### 13.1 Admission

A fixed top 60 is replaced by a conservative plausibility envelope:

```text
staticLeader - staticValue(candidate)
    <= CorrectionEnvelope(phase, volatility)
```

`CorrectionEnvelope` is fitted from held-out differences between static and
reference rankings. Until enough data exists, use a deliberately wide fixed gap
plus a deterministic hard cap derived from minimum paired work.

Mandatory families:

- static-equity leader;
- immediate-score leader;
- best action from each exchange-size family;
- pass when the streak or static gap makes it competitive;
- strategically distinct assigned-token realizations;
- high-premium or high-board-delta outliers marked for verification.

Admission quality is measured as root recall and regret against a wider
reference run. Candidate count is an outcome of plausibility and available
work, not of total legal-move count alone.

### 13.2 Paired racing

Production `PairedRace` uses the same observation as the reference; it changes
only which contender receives the next opponent-generation credit.

1. Give all contenders a minimum complete batch on common worlds.
2. Maintain paired differences against the current leader.
3. Use empirical-Bernstein/confidence-sequence bounds as an allocation and
   elimination heuristic.
4. Compare the leader and most dangerous challenger on the same next world.
5. Eliminate only after a complete paired batch and only when the challenger's
   upper bound plus a pre-registered model/truncation allowance lies below the
   leader.
6. Stop at one contender, statistical separation, or ledger exhaustion.
7. Select from the last complete checkpoint using the canonical tie order.

The bounds are not proofs: observations contain evaluator error and may contain
bounded-search error. Their calibration is validated against
`sim_v2-reference`; nominal confidence text is not shown to users.

## 14. Endgame routing

`EndgameRouter` consumes the existing `RootCatalogue`. It returns exactly one of:

```cpp
using EndgameAttempt = std::variant<
  ProvenMargin,
  CompleteHiddenOutcome,
  Declined,
  Incomplete>;
```

- `ProvenMargin`: a completed perfect-information minimax proof.
- `CompleteHiddenOutcome`: every probability-weighted hidden world and chance
  draw was solved for the stated objective; complete, but not a guaranteed
  margin.
- `Declined`: validation or complexity preflight says not to attempt.
- `Incomplete`: the attempt exhausted its reserved work; continue with
  deterministic midgame fallback.

Eligibility and feasibility are separate. Feasibility considers root
completeness, unplayed tiles, distinct physical worlds, projected branching,
and remaining endgame nodes—not bag size alone. Details of probability-weighted
hidden endgames remain in
[`hidden-endgame-design.md`](hidden-endgame-design.md).

## 15. First optimization experiment: exact ReplyIndex + DeltaReplyGenerator

This experiment starts immediately after `sim_v2-reference` passes its
correctness gate and produces a frozen benchmark baseline. It precedes adaptive
admission and `PairedRace`. It is allowed behind the unchanged `DecisionSearch`
Interface, while candidate-specific full generation remains available as the
comparison oracle and automatic fallback.

### 15.1 Required set identity

For base board `B`, root candidate placements `c`, and opponent rack `r`:

```text
FullReplies(B + c, r)
  == RevalidateAndRescore(ReplyIndex(B, r), B + c)
     union DeltaReplyGenerator(B, c, r)
```

Equality means assignment-distinct legal moves and scores, not only physical
footprints or the best value.

### 15.2 ReplyIndex

For each hidden world, perform one complete opponent generation on the base
board and retain every assignment-distinct reply plus enough dependency data to
revalidate and rescore it after a candidate:

```cpp
struct IndexedReply {
  Move move;
  CellMask placedCells;
  CellMask equationCells;
  CellMask dependencyCells;
};
```

On `B+c`, reject overlap, revalidate every affected equation, and recompute the
score. A reply that remains legal may score differently because a candidate tile
extends one of its equations.

### 15.3 DeltaReplyGenerator

Every reply legal only after `c` must have a dependency witness: at least one
equation or connection in that reply depends on a tile placed by `c`. The delta
generator enumerates exactly the DFS starts/subtrees with such a witness rather
than searching all anchors.

The proof obligation is bidirectional:

- **soundness:** every emitted delta reply is legal on `B+c`;
- **completeness:** every reply in `FullReplies(B+c,r)` that is absent from the
  revalidated base index is emitted by the delta generator.

If completeness cannot be established, the implementation is downgraded to an
approximate screen and candidate-specific full generation remains mandatory for
finalists. It must not retain the word `exact`.

### 15.4 Work model

```text
G_reply_index = 1 root
              + W complete base-board opponent generations
              + sum candidate/world delta generations
```

The ledger reports base full generations, delta calls, delta nodes,
revalidations, and full-generation fallbacks separately. A reduction in the
number called `generatePlaceMoves` is not sufficient if delta DFS visits the
same nodes under another name.

Request-local indexes are discarded after the decision. Cross-request caching
is out of scope.

## 16. Deferred experiments

### 16.1 Threat model

A threat model may be tested only as:

- a cheap static feature;
- a volatility/admission signal;
- a trigger for exact opponent verification;
- a predictor of where delta generation should search.

It is not an authoritative substitute for opponent replies. Recompute it from
scratch per candidate; incremental maintenance has no measured justification.

### 16.2 Selective third ply

A third ply may be tested only after the two-ply reference is stable. It must:

- operate on the board after the concrete opponent reply;
- use Aether's correctly refilled rack from that same hidden world;
- be limited to unresolved finalists and explicit generation credits;
- beat spending the same credits on more opponent worlds;
- report its calls under `SelectiveThirdPly`.

Full third ply over every candidate/world is rejected.

## 17. Diagnostics and progress

Required final diagnostics:

```text
root: moves, assigned variants, complete, nodes, ms
reference scope: exhaustive/frozen-subset, root-key fingerprint
admission: eligible, admitted, mandatory reasons
worlds: planned, completed, discarded partial batches
opponent reference: full calls, nodes, emitted moves, complete/incomplete
opponent policy: evaluations, policy version, hidden-information leak checks
racing: rounds, eliminations, active candidates, final paired gap
reply index: base calls, revalidations, delta calls/nodes, fallback calls
third ply: calls/nodes (normally zero)
endgame: declined/attempted/complete, worlds, nodes, TT hits
total: calls and nodes by purpose, elapsedMs, work-limit reason
```

Progress uses deterministic work units:

```text
Preparing
GeneratingRoots
ProvingEndgame
ComparingReplies
RacingFinalists
Finalizing
```

The process Adapter may display elapsed time and estimate ETA. Neither value is
fed back into search. Bot progress exposes no hidden rack or candidate details.

## 18. Benchmark corpus

Freeze train/calibration and held-out partitions before fitting admission or
racing thresholds. At minimum include:

- empty-board openings;
- ordinary midgames;
- blank/choice-heavy racks;
- high-branching boards;
- ×9/×27 premium threats;
- defensive blocks and newly enabled equations;
- setup/rack-management positions;
- pass/exchange decisions at streaks 0 through 5;
- low physical bag with exchanges disabled/enabled;
- rack-out and no-score terminals;
- bag 0, 1, and 2 endgames;
- positions where assignment variants share a physical footprint;
- the known repeated-opening-exchange pathology.

Every result records position hash, search version, replicate salt, reference
root scope and fingerprint, selected move, value kind, completeness, calls/nodes
by purpose, and latency.

## 19. Benchmark gates

### G0 — instrumentation baseline

- Reproduce the current call-count formula and the measured node undercount.
- New counters have zero unexplained difference from independently summed
  `GenStats` over at least 500 positions.
- No behavior change.

This is an accounting baseline only. No strength or optimization conclusion is
drawn until the correct v2 reference passes G4.

### G1 — WorkLedger

- Every search test satisfies all envelope ceilings exactly.
- Forced exhaustion before, during, and after a generation returns the declared
  checkpoint or static fallback; no illegal move and no overshoot.
- Compatibility generation counter equals ledger full-generation calls.
- Existing move choices are unchanged.

### G2 — StateTransition

- Treat the EQ-Lab canonical reducer as the production rules authority.
  Differentially match it for at least 10,000 generated legal action sequences;
  then make `GameSim` match the same golden corpus rather than treating two
  possibly divergent implementations as co-equal authorities.
- Explicit fixtures cover exchange draw-before-return, streak 5 → terminal,
  rack-out before refill, short bag refill, and both terminal bonuses.
- Make/unmake byte identity holds after randomized nested sequences.

### G3 — RootCatalogue

- Assignment-distinct placement set equals complete legacy generation on at
  least 500 random positions plus exhaustive small-rack fixtures.
- Exchange multisets equal brute-force enumeration.
- Root full-generation calls equal exactly one on every midgame decision.
- Exact endgame consumes the same catalogue and performs no second root call.
- Truncation/completeness is surfaced correctly.

### G4 — sim_v2-reference correctness

- Static/self-future generation calls are zero after root; no
  `bestPlaceScore` path is reachable.
- Every committed world has one observation for every in-scope candidate.
- Opponent action choice matches brute-force placement + all exchanges + pass on
  exhaustive small positions.
- Holding the opponent information set fixed while perturbing Aether's hidden
  refill and the remaining bag order never changes the selected opponent reply.
- `Exhaustive` runs evaluate every action in a complete root catalogue;
  `FrozenSubset` runs record and reproduce the exact root-key fingerprint and
  are never reported as whole-position references.
- Fixed seed-independent inputs reproduce bit-for-bit under repeated runs and
  artificial machine load.
- Reference-complete corpus rows contain no truncated root or reply generation.
- The repeated opening exchange loop is traced to a transition defect, policy
  objective, or genuinely rational rule outcome using per-action values. If the
  known fixture still exchanges until the six-no-score ending, G4 remains
  blocked for calibration: reproducibility alone is not a fix, and those games
  may not be used to fit admission or evaluation weights.

### G5 — exact ReplyIndex + DeltaReplyGenerator

- Set-and-score equality with full assignment-aware opponent generation on all
  exhaustive small-rack cases and at least 10,000 randomized
  `(board,candidate,rack)` triples.
- Best opponent action and `V_ref` match the full generator bit-for-bit whenever
  both report complete.
- Soundness/completeness tests include newly connected moves, extended main
  equations, changed cross equations, overlap invalidation, and blank/choice
  assignments.
- On held-out high-branching positions, opponent movegen nodes fall by at least
  30% and request p95 falls by at least 20%.
- Full-generation fallback and incomplete delta work are labeled and counted.
- G4 remains green on both exhaustive and frozen-subset reference runs.

Set equality is required to call the experiment exact. Passing G5 does not by
itself enable production; the composed search must later pass G6–G8.

### G6 — admission recall

Against a deliberately wider reference run on held-out positions:

- top-action recall is at least 99%;
- mean regret is at most 0.25 equity point;
- p95 regret is at most 2 points;
- no missed move loses more than 10 points without a documented corpus review.

Thresholds are registered before evaluating the held-out set.

### G7 — PairedRace

Compared with uniform `sim_v2-reference` using the same maximum world deck:

- top-action agreement is at least 95%;
- mean reference regret is at most 0.5 point and p95 at most 3 points;
- no partial batch is committed;
- median opponent-generation calls fall by at least 30%;
- seed-salt sensitivity does not exceed the uniform reference at equal work.

If strength and call reduction do not both pass, retain uniform allocation.

### G8 — strength/latency Pareto gate

- Run at least 400 paired self-play games per matchup, alternating first side
  and reusing identical initial physical bags. Expand to 2,000 games if the
  confidence interval crosses the non-inferiority boundary.
- Against the current corresponding tier, the one-sided 95% lower confidence
  bound must exceed 45% win rate and the 95% lower bound on paired mean margin
  must exceed -3 points.
- Against a deeper reference, mean and p95 fixed-position regret must improve at
  equal full-generation/node work.
- Report p50/p95/p99 latency, calls, and nodes; no tier ships on a mean-only
  improvement.
- Pass, exchange, six-pass ending, tiles played, and score-per-turn rates are
  reviewed for regressions.

Passing non-inferiority is only permission to canary; the objective remains a
Pareto improvement in strength per compute.

### G9 — deferred experiments

Threat and third-ply work each require their own held-out prediction,
fixed-position regret, self-play, and equal-compute gates. Neither can be bundled
with G5 or G8.

## 20. Smallest staged implementation sequence

Each stage is one reviewable behavior change at most:

1. **Ledger shadow mode.** Add request-local purpose counters and report them
   alongside current stats. Do not use them to stop work. Pass G0.
2. **Ledger enforcement.** Route every existing generator through permits while
   preserving current envelopes and choices. Pass G1.
3. **StateTransition in isolation.** Implement production-rule transitions and
   differential tests; no solver uses it yet. Pass G2.
4. **RootCatalogue in shadow mode.** Build the assignment-aware catalogue and
   compare it with the current root set without changing decisions. Add exhaustive
   exchange enumeration behind the v2 policy only. Pass G3.
5. **WorldDeck + EndpointEvaluator.** Add deterministic physical worlds and the
   symmetric fixed-point reference objective as isolated Modules with tests.
6. **OpponentSearch.** Enumerate complete placement, exchange, and pass replies
   for one `(candidate, sampled opponent rack)`, rank them through the explicit
   information-set projection, and apply the chosen reply with
   `StateTransition`; validate the action set and hidden-information boundary
   against brute force.
7. **sim_v2-reference, benchmark only.** Compose stages 3–6 with uniform paired
   batches. Run exhaustive-root references where feasible and frozen,
   fingerprinted subsets elsewhere. Keep current production tiers unchanged.
   Pass G4, then freeze the correctness and performance baseline.
8. **ReplyIndex experiment.** Implement complete base indexing, exact
   revalidation, and `DeltaReplyGenerator` behind an internal policy. Compare
   it with candidate-specific full generation on the identical roots and worlds.
   Pass G5 before using it as anything but an experiment.
9. **Admission + PairedRace.** Add conservative admission and paired allocation
   behind an internal policy. Full-generation reference mode remains available
   as the oracle. Pass G6–G7.
10. **Strength and canary gate.** Pass G8, then canary one non-Easy tier or an
    analysis level. Easy/static and the old simulator remain instant rollback
    paths during the canary.
11. **Retire current simulation.** Only after the canary and rollback window,
    remove `bestPlaceScore`, its dead memos, old sample-floor/time-cap behavior,
    and the public old-solver routing.
12. **Optional experiments.** Consider Threat scheduling, calibrated win
    probability, and selective third ply one at a time under G9.

No stage combines a transition correction with a search optimization. That
separation is what makes a strength change diagnosable and a regression
revertible.

## 21. Definition of Revision 2 completion

The architecture work is complete when:

- `DecisionSearch` is the single internal decision seam;
- every search path uses a request-local enforced `WorkLedger`;
- rollout rules are sourced exclusively from tested `StateTransition`;
- one assignment-aware `RootCatalogue` feeds static, midgame, and endgame work;
- `sim_v2-reference` exists as a reproducible benchmark oracle with no fake
  self-future generation;
- the shipping non-static path uses shared-world paired racing and passes G8;
- diagnostics account for all work and label completeness/objective honestly;
- ReplyIndex remains optional until exact set equality and G5 pass, and remains
  disabled in production until the composed search passes G8;
- Threat and third ply remain absent from the required architecture.
