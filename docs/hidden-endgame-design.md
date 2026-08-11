# Hidden-Information Endgame — Design (bag = 1, 2; scalable to 5)

> **Status:** design only, no code. Extends the exact endgame from `bag == 0` to
> `bag ∈ {1, 2}` (and a path to `{3, 4, 5}`) under hidden opponent information.

## 0. Objective & key decisions

**Objective = maximize Win Rate.** For each candidate AI move we compute the
probability that the move leads to a win over the space of hidden worlds, and
pick the highest. This is *not* the worst-case margin the current `bag ≤ 1`
solver reports, and *not* expected margin — it is `P(final AI score > final opp
score)`.

Decisions locked with the requester:

| # | Decision | Choice |
|---|----------|--------|
| D1 | Aggregation across worlds | **Win Rate** = winning worlds / total worlds (probability-weighted) |
| D2 | Reuse of the perfect-information minimax | **Do not modify it.** It stays the bag-0 oracle. |
| D3 | Rollout scope now | **bag 2 first**, ship + validate, then assess 3–5 |
| D4 | Safety | If the hidden search can't finish in budget → fall through to today's sampling `sim` (never returns a worse move than today) |

**Critical correctness note carried through the whole doc (see §10):** "Win"
must be judged against the *current score lead*, not against a zero margin. The
minimax returns a **margin** `Δ = AI_gain − Opp_gain` from here to game end. The
game is won iff `myScore + AI_gain > oppScore + Opp_gain`, i.e.

```
WIN  ⇔  Δ > (oppScore − myScore)      = −currentLead   ≡ threshold T
DRAW ⇔  Δ = T
LOSE ⇔  Δ < T
```

`T = oppScore − myScore`. Everything below treats `T` as the win threshold.

---

## 1. Overall architecture

Three layers, top to bottom. Only Layer 1 is genuinely new; Layer 2 already
exists (as `HiddenBagSolver`) and needs an aggregation change; Layer 3 is
untouched.

```
┌─ Layer 1: Hidden-World Driver  (NEW) ───────────────────────────────┐
│  • enumerate all worlds (bag composition ⇒ opp rack), with weights   │
│  • for each AI candidate move × each world → get an outcome          │
│  • aggregate outcomes into a Win Rate per move; pick argmax          │
└──────────────────────────────────────────────────────────────────────┘
             │ per (move, world): "solve this world to a margin"
             ▼
┌─ Layer 2: In-World Expectiminimax  (EXISTS, adapt aggregation) ─────┐
│  HiddenBagSolver over the shallow "bag-draining" prefix:             │
│   • player nodes = adversarial minimax (opp known in this world)     │
│   • draw nodes   = chance over which of the ≤bag tiles come out      │
│   • when bag hits 0 → call Layer 3                                    │
└──────────────────────────────────────────────────────────────────────┘
             │ bag == 0, both racks fully known, perfect information
             ▼
┌─ Layer 3: Exact bag-0 minimax  (UNTOUCHED oracle) ──────────────────┐
│  EndgameSolver::solve / HiddenBagSolver bag-empty TT path            │
│  returns the exact final margin Δ for a fully-known world            │
└──────────────────────────────────────────────────────────────────────┘
```

The essential idea: **the hidden layer is a shallow expectiminimax over the few
turns until the bag empties, bottoming out in the existing exact oracle.** With
bag ≤ 2 the prefix is only 1–2 draw events deep, so the added tree is tiny
relative to the bag-0 subtree the engine already solves.

---

## 2. Data flow

```
handleRequest(req)
   │  endgameEligible && bag ∈ [1..maxBag]
   ▼
HiddenWorldDriver.run(req)
   │
   ├─ enumerateWorlds(unseen, bagCount) ─────────────► [ (bag_i, oppRack_i, weight_i) ]   (Σ weight = 1)
   │
   ├─ generatePlaceMoves(board, aiRack) ─────────────► [ m_0 … m_k , PASS ]   (reuse existing)
   │
   └─ for each move m_j:                     winRate[j] = 0 ; expMargin[j] = 0
        for each world (bag_i, oppRack_i, w_i):
            apply m_j to board + aiRack                     (make/unmake, reuse)
            outcome = InWorldSolver.solve(state, bag_i, oppRack_i, T)
                       └── expectiminimax prefix → bag-0 oracle (Layer 3)
            winRate[j]  += w_i * outcome.pWin
            expMargin[j] += w_i * outcome.expMargin      (tie-break only)
            undo m_j
        record (m_j, winRate[j], expMargin[j])
   │
   ▼
pick argmax winRate  (tie-break: expMargin, then immediate score)
   │
   ▼
respond(move, solver="endgame", winRate, report=per-move table)
```

State passed to `InWorldSolver` = `{ board, aiRack−placed, oppRack_i, bag_i,
sideToMove, noScoreStreak, T }`. `T` is constant across worlds (depends only on
current scores), passed down so a world can be resolved as W/D/L or as a fuller
distribution.

---

## 3. Required modules

| Module | New/Exists | Responsibility |
|--------|-----------|----------------|
| **WorldEnumerator** | new (generalize `enumerateBags`) | all bag compositions + **probability weights**; dedup by kind-multiset |
| **HiddenWorldDriver** | new (generalize `solveHiddenEndgame`) | move × world loop, Win-Rate aggregation, argmax, report |
| **InWorldSolver** | exists = `HiddenBagSolver` | expectiminimax prefix + draw handling; **swap draw aggregation** min→chance, and surface pWin |
| **Bag-0 oracle** | exists = `EndgameSolver` / `HiddenBagSolver` TT path | untouched exact margin for a known world |
| **WorldOutcome** | new tiny struct | `{ pWin, pDraw, expMargin }` |
| **Shared TT** | exists | cross-world memo of bag-0 states (see §6) |
| **Gate/config** | exists | raise `endgameExactBagMax`, add `winRate` toggle |
| **Validation harness** | extend `scripts/` | brute-force reference for bag 2; bit-exact + win-rate cross-check |

---

## 4. Integration with the existing engine

Touch points (all additive; existing paths unchanged):

1. **Gate** in `handleRequest` at [engine.cpp:1321](../src/engine.cpp). Today:
   `if (endgameEligible && req.bagCount <= cfg.endgameExactBagMax)`. Change:
   raise `endgameExactBagMax` from `1` → `2`, and route through the new
   `HiddenWorldDriver` (which subsumes `solveHiddenEndgame`).
2. **Eligibility** unchanged: `req.unseen.total == req.oppRackCount +
   req.bagCount` already guarantees "the whole hidden pool is exactly opp rack +
   bag" — the precondition the world enumeration needs.
3. **Fallback** unchanged: driver returns `found=false` on budget abort →
   control falls through to the `sim` sampler at [engine.cpp:1346](../src/engine.cpp).
   So enabling bag 2 is **strictly non-regressing**.
4. **Response**: reuse `respond(...)` / `buildEndgameReport(...)`. Add a
   `winRate` field to the per-move report rows; keep `expectedFinalDiff` (now
   `expMargin`). `endgameSolved` semantics change (see §10.6).

Nothing in `EndgameSolver` (the trusted bag-0 negamax) changes.

---

## 5. Module interfaces / APIs (signatures only, no bodies)

```cpp
// ── WorldEnumerator ───────────────────────────────────────────────
struct World {
  TileCounts bag;        // exact multiset in the bag
  TileCounts oppRack;    // = unseen − bag
  double     weight;     // P(this world) ; Σ weight = 1
};
// Distinct kind-multiset worlds with correct combinatorial weights.
std::vector<World> enumerateWorlds(const TileCounts& unseen, int bagCount);

// ── WorldOutcome ──────────────────────────────────────────────────
struct WorldOutcome {
  double pWin;       // P(final margin > T)  within this world
  double pDraw;      // P(final margin == T)
  double expMargin;  // E[margin]            (tie-break / display)
};

// ── InWorldSolver  (adapted HiddenBagSolver) ──────────────────────
// Solve one fully-specified world: opp rack known, bag known, draws are
// chance. Returns the outcome distribution vs threshold T. Bag-0 leaves
// call the UNTOUCHED oracle.
WorldOutcome solveWorld(InWorldState& st, int T);

// ── HiddenWorldDriver  (replaces solveHiddenEndgame) ──────────────
struct DriverResult {
  bool  found = false;      // false ⇒ caller falls back to sim
  bool  complete = false;   // every (move,world) solved within budget
  Move  move;
  double winRate = 0;       // of chosen move
  double expMargin = 0;
  std::vector<MoveScore> perMove;   // {move, winRate, expMargin} for the UI
};
DriverResult runHiddenWorlds(const Request& req, Budget b, int maxWorlds);
```

Note the only interface change to Layer 2 vs today's `HiddenBagSolver`: draw
nodes aggregate by **expectation** (weighted by draw probability) instead of
`min`, and the return type carries a `pWin/pDraw` distribution instead of a bare
`int` margin. The bag-0 TT path and move generation are reused verbatim.

---

## 6. Caching strategy

Three cache tiers, in increasing lifetime:

1. **Bag-0 transposition table (exists, keep).** Direct-mapped, fixed 2^22
   slots (~64 MB), keyed by Zobrist of `(board, bothRacks, side, streak)`
   ([engine.cpp:715](../src/engine.cpp)). **Shared across all worlds and all root
   moves** — a bag-0 state is world-independent once both racks are fixed, so a
   position reached in world A is a valid hit in world B. This sharing is the
   single biggest speedup and is already sound (the key includes both full
   racks). *Do not clear between worlds.* Allocate once per request.

2. **World-outcome memo (new, small).** Different `(move, world)` pairs often
   collapse to the same post-move state (e.g. two AI moves that reach the same
   board + rack, or duplicate-kind worlds). Key = Zobrist of the post-move state
   `(board, aiRack, oppRack, bag, side, streak, T)` → `WorldOutcome`. A plain
   `unordered_map`, bounded by pair count (≤ moves × worlds). Optional; the
   bag-0 TT already captures most reuse.

3. **Move-generation ordering caches (exist, keep).** Killers/history in
   `HiddenBagSolver` ([engine.cpp:731](../src/engine.cpp)) — ordering only, never
   affects values. Reset per request.

**Threshold-search caching caveat:** if we use null-window probes at `T` (§8),
TT entries store *bounds relative to that window*, which is fine because the
window (`T`) is constant for the whole request. If `T` ever varied per world the
bag-0 TT could not be shared — it does not, so sharing stays valid.

---

## 7. Time & memory complexity

Let `U` = unseen tiles, `B` = bag size, `R` = opp rack (`U = R + B`), `M` = AI
candidate moves, `S` = per-world bag-0 subtree size (nodes the oracle expands),
`D` = draw branching per refill (≤ distinct kinds in the bag, so ≤ B).

- **Worlds** `W = C(U, B)` physical, collapsed to distinct kind-multisets
  `W' ≤ W` with weights. For `R = 8`:

  | bag | U | worlds C(U,B) | distinct kind-worlds W' (typical) |
  |-----|---|---------------|-----------------------------------|
  | 1 | 9  | 9    | ≤ 9  |
  | 2 | 10 | 45   | ≤ ~30 |
  | 3 | 11 | 165  | ≤ ~80 |
  | 4 | 12 | 495  | ≤ ~150 |
  | 5 | 13 | 1287 | ≤ ~250 |

- **Time** ≈ `O(M × W' × (draw-prefix ≈ D^B) × S)`. The dominating factor is
  `M × W' × S`; the draw prefix `D^B` is tiny for B ≤ 2 (≤ ~2–4). Crucially `S`
  is **the same order as the bag-0 solve the engine already does**, and the
  shared TT makes the effective per-world `S` shrink as worlds are processed
  (heavy cross-world transposition). Realistic bag-2 cost ≈ a few × to ~50× a
  single bag-0 solve, well inside the 5-min ceiling for most positions; wide
  positions abort → fallback.

- **Memory** = TT (fixed ~64 MB) + world list `O(W')` + move list `O(M)` +
  recursion stack `O(game length)`. **Flat in bag size** — worlds are streamed
  one at a time, never materialized as a tree. This is what makes 3–5 a
  time problem, not a memory problem.

---

## 8. Performance bottlenecks & mitigations

| Bottleneck | Mitigation (all value-preserving) |
|-----------|-----------------------------------|
| `M × W'` outer product | (a) shared bag-0 TT across worlds; (b) **null-window probe at `T`** — to classify a world W/D/L we only need `Δ>T?` and `Δ≥T?`, two boolean searches with window `[T,T+1]`, far cheaper than exact `Δ` (only compute exact `Δ` for the winRate-leading move, for display) |
| Wide `M` (root moves) | rank roots by static equity first (reuse `staticEquity`); once a move's *best-possible* winRate can't beat the incumbent, skip its remaining worlds (branch-and-bound on winRate: remaining worlds ≤ needed-to-win) |
| Deep bag-0 subtree `S` | already optimized: incremental board, TT, killers/history — untouched |
| Draw chance fan-out `D^B` | negligible for B ≤ 2; for B ≥ 3 cap draw enumeration to distinct kinds (already the case) and weight by multiplicity |
| Duplicate work across identical kind-worlds | weight-collapse in `enumerateWorlds` (30 not 45 for bag 2) + world-outcome memo |
| Time budget blowout | per-world time checks (exist), global abort → `found=false` → sim fallback |

**Win-rate branch-and-bound detail:** process worlds for a move in weight order;
maintain running `winSoFar` and `remainingWeight`. If `winSoFar +
remainingWeight ≤ bestWinRateSoFar`, prune the move. Combined with the
null-window probe this turns each (move,world) into a cheap boolean and lets the
driver abandon losing moves early.

---

## 9. Maximum code reuse (map to existing symbols)

| Need | Reuse | File |
|------|-------|------|
| bag composition enumeration | generalize `enumerateBags` (already handles count ≤ 2) | [engine.cpp:945](../src/engine.cpp) |
| move × world loop skeleton | `solveHiddenEndgame` | [engine.cpp:984](../src/engine.cpp) |
| in-world minimax + draws | `HiddenBagSolver::mm` / `drawWorst` (change min→chance) | [engine.cpp:795](../src/engine.cpp) |
| bag-0 exact oracle | `HiddenBagSolver` bag-empty TT path / `EndgameSolver::solve` | [engine.cpp:525](../src/engine.cpp) |
| incremental board make/unmake | `IncrementalBoard` | `src/inc_board.hpp` |
| streamed move gen | `generatePlaceMovesStream` | [engine.cpp:833](../src/engine.cpp) |
| root move gen + ordering | `generatePlaceMoves` + `staticEquity` | `src/movegen.cpp`, `src/eval.*` |
| TT / Zobrist | `HiddenBagSolver::tt`, `zobrist()` | [engine.cpp:715](../src/engine.cpp) |
| response + per-move report | `respond`, `buildEndgameReport` | [engine.cpp:1198](../src/engine.cpp) |
| ground-truth validation | `scripts/endgame_exact_reference.hpp`, `scripts/bench_endgame.cpp` | `scripts/` |

Net new code is small: `enumerateWorlds` (add weights), the Win-Rate
aggregation + argmax in the driver, and swapping `drawWorst`'s `min` for a
probability-weighted average (a sibling `drawExpected`, leaving `drawWorst`
intact for the existing proof path).

---

## 10. Correctness concerns

1. **Win threshold uses the score lead.** `T = oppScore − myScore`. Judging
   "win" against `Δ > 0` instead of `Δ > T` is the most likely bug. Thread `T`
   through and unit-test with nonzero leads.

2. **World probability weights.** `C(10,2)=45` counts *physical* tiles; the
   engine groups by kind. A kind-world's weight = (number of physical
   combinations that map to it) / 45. Enumerating by kind **without** weights
   silently biases toward rare kinds. `enumerateWorlds` must emit weights (falling
   factorials on `unseen.n[k]`). Sanity check: `Σ weight == 1`.

3. **In-world draw randomness.** Even with the bag fixed, *which* of the ≤B tiles
   a player draws is random. For a true Win *Rate* this must be a **chance node
   (expectation)**, not the `min` the current proof solver uses. Model both:
   - draw = chance ⇒ correct `pWin` (recommended).
   - draw = adversarial `min` ⇒ pessimistic proxy (reuses existing `drawWorst`,
     gives a clean single margin, faster). Ship chance; keep min as a debug
     cross-check.

4. **Opponent model inside a world.** The opponent's rack is known *to the search*
   but the opponent does not know its own future draws either. We model the
   opponent as adversarial minimax over its known rack — an upper bound on
   opponent strength (safe: never over-optimistic about AI). Note this is a
   belief-state approximation, not full POMDP optimality (the opponent doesn't
   reason about *our* uncertainty). Acceptable and standard; document it.

5. **Rack-out / no-score-streak endings.** The oracle already handles rack-out
   doubling and the 6-turn no-score end ([engine.cpp:882](../src/engine.cpp),
   `NO_SCORE_STREAK_LENGTH = 6`). These affect the final margin `Δ`, hence W/D/L —
   verify they're inside `Δ` before comparing to `T` (they are, since the oracle
   returns the fully-played-out margin).

6. **Meaning of `endgameSolved`.** With Win-Rate the result is a *probability*,
   not a proof. Redefine: `endgameSolved = complete` (every (move,world) solved in
   budget) and report `winRate` + `expMargin`. A `winRate == 1.0 && complete`
   *is* a genuine "provably cannot lose" — surface that specifically so the
   existing "100% win" UX still means what it says.

7. **Determinism.** Aggregation is a deterministic sum over enumerated worlds
   (no sampling), so results are reproducible regardless of `seed`. Keep world
   iteration order fixed for stable tie-breaking.

8. **Tie-breaking.** Win-Rate can prefer "win-by-1 in 44 worlds, lose-by-100 in
   1" over "win-by-100 in 40, draw in 5". For endgame that's usually the right
   call, but break exact ties by `expMargin`, then immediate `score`, for stable,
   sensible play.

---

## 11. Scaling to bag 3–5 without architectural change

The architecture is **already bag-size agnostic** — only constants and cost
change, not structure:

- **Enumeration** — `enumerateWorlds` generalizes to any `B` (nested loops → a
  recursive/odometer submultiset walk with weights). No structural change.
- **In-world solver** — the draw prefix simply recurses `B` deep instead of 2;
  `drawExpected`/`mm` are already recursive in `draw`. No change.
- **Memory** — flat in `B` (worlds streamed). Stays ~64 MB + O(W'). No change.
- **What actually grows** — `W' ` (worlds) and the draw prefix `D^B`. This is
  purely a **time** budget question, handled by knobs, not redesign:

  | knob | role |
  |------|------|
  | `endgameExactBagMax` | hard cap on which bag sizes attempt the exact path |
  | `maxWorlds` (`endgameMaxAssignments`, today 4000) | abort to fallback if `W'` too large |
  | win-rate branch-and-bound (§8) | prune dominated moves before touching all worlds |
  | null-window probes (§8) | make each world a cheap boolean |
  | shared TT | amortize `S` across the growing world count |

**Recommended rollout:** ship bag 2 with the driver + weights + chance draws +
validation. Then, *without code restructuring*, raise `endgameExactBagMax` to 3
and measure the bench distribution; keep raising while the "solved in budget"
rate stays acceptable, letting the fallback catch the rest. bag 5 (≤ ~250
kind-worlds) is plausibly reachable on narrow endgame boards but will fall back
on wide ones — and falling back is safe by construction (§4.3).

---

## Appendix — validation plan (before flipping the gate)

1. Extend `scripts/endgame_exact_reference.hpp` to a brute-force
   hidden-world win-rate over bag 2 (enumerate worlds + full expectiminimax, no
   TT, no pruning) as ground truth.
2. Cross-check `HiddenWorldDriver` vs the reference: `winRate`, `expMargin`, and
   chosen move must match bit-exact on a generated suite (target parity with the
   existing bag-0 86/86, bag-1 16/16 gauntlets).
3. Extend `scripts/bench_endgame.cpp` to capture positions at `bag == 2` and
   report the latency distribution + "solved within ceiling" rate.
4. Only then raise `endgameExactBagMax` to 2.
