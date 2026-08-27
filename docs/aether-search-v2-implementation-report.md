# Aether Decision Search Revision 2 — implementation report

Date: 2026-08-13

This report records what is implemented, what the measurements establish, and
what is deliberately not enabled in production. The governing architecture and
gate definitions remain in
[`aether-search-v2-design.md`](aether-search-v2-design.md).

## Outcome

The benchmark implementation now has one `DecisionSearch` seam with three
internally selectable comparison policies:

- `SimV2Reference`: candidate-specific complete opponent generation, uniform
  shared worlds, no statistical elimination;
- `ReplyIndexUniform`: exact base reply index plus candidate-local delta
  generation on the same roots and worlds;
- `PairedReplyIndex`: the same exact replies with paired-race allocation.

`SearchQuery` contains only the position and effort. Experiment selection is
available only through `DecisionSearch::benchmark`, so product tiers cannot
select an experiment accidentally. `DecisionSearch::decide` remains pinned to
the trustworthy `SimV2Reference` until an optimized policy passes its gates.
The JSON adapter and shipped `static`/`sim` routes remain unchanged until the
strength and latency gates pass.

The old fake `bestPlaceScore` term is unreachable from every v2 policy. It
still exists only inside the legacy rollback path.

## Implemented modules and invariants

| Module | Implemented contract |
|---|---|
| `WorkLedger` | request-local full/delta call and node ceilings; purpose accounting; complete-world commit/discard; transition, revalidation, policy, and endpoint counters |
| `StateTransition` | placement, draw, exchange draw-before-return, deterministic exchange shuffle, pass, rack-out-before-refill, no-score terminal, undo |
| `RootCatalogue` | one assignment-aware placement generation; every unique exchange multiset; pass; canonical total order |
| `WorldDeck` | seed-independent canonical position schedule; shared draw prefixes; event-keyed exchange randomness |
| `EndpointEvaluator` | fixed-point symmetric score/rack objective over one post-reply world state |
| `OpponentSearch` | complete placements plus every legal exchange and pass; explicit non-clairvoyant information projection; deterministic ties |
| `ReplyIndex` | base reply generation, exact revalidation/rescoring, dependency-mask delta generation, labeled full fallback |
| `PairedRace` | only complete active-candidate batches commit; paired-difference elimination after minimum batches |
| `DecisionSearch` | root build, static admission, shared worlds, reference/index/racing composition, last-complete-checkpoint fallback, diagnostics |

The move generator's node-limit overshoot was also corrected: it now stops
before visiting node `limit + 1`, which is required for a hard ledger bound.

## Correctness findings

Two defects were found while establishing the reference:

1. `GameSim` ended a versus game after six opening passes/exchanges even though
   no equation had ever been placed. EQ-Lab's canonical rule requires a prior
   opening placement. `GameSim` now matches that rule, with a regression test.
2. The first opponent-policy implementation evaluated a placement's rack before
   its expected refill and inherited the static defense penalty. The reference
   policy now uses immediate score plus post-play leave plus the analytical
   expected value of the replacement draws; terminal rack-out is handled
   separately.

The observed six-exchange seed used during diagnosis had zero legal placements
at each of those six roots. That fixture therefore did not show exchange
beating a legal placement; it showed the simulator applying the terminal rule
too early. The separate known 24-sample fixture is still required before
calibrating admission or evaluation weights.

## ReplyIndex exactness gate

Command:

```text
make verify-reply-index
```

Result:

```text
reply-index randomized equality: 10000/10000 triples (seed=20260813)
ALL REPLY-INDEX TESTS PASSED
```

Each randomized triple compares the assignment-distinct move-to-score map from
`ReplyIndex + DeltaReplyGenerator` with full generation. It also compares the
chosen opponent action, opponent policy value, and post-transition endpoint
value. Focused fixtures cover an opening and extension/cross dependencies.

This satisfies the randomized portion of G5. The broader exhaustive
small-rack matrix remains a release-gate item.

## Performance measurements

Eight real positions built by deterministic static self-play were measured on
this machine. Every indexed candidate was checked for exact set equality before
its result was included.

### Direct full generation versus ReplyIndex

| Metric | Candidate-specific full | ReplyIndex + delta | Change |
|---|---:|---:|---:|
| aggregate DFS nodes | 117,580,063 | 51,527,534 | -56.2% |
| aggregate time | 8,453.1 ms | 3,899.9 ms | -53.9% |

Per-position node reduction ranged from 35.1% to 67.7%. The highest-branching
measured position fell from 91,316,197 nodes / 7,100.6 ms to 35,632,657 nodes /
2,978.9 ms.

### Composed interactive search

| Metric | `SimV2Reference` | `ReplyIndexUniform` | Change |
|---|---:|---:|---:|
| mean latency | 445.6 ms | 199.6 ms | -55.2% |
| observed p50 | 268.1 ms | 86.2 ms | -67.8% |
| observed p95 | 468.9 ms | 328.3 ms | -30.0% |
| full generations / decision | 8.00 | 2.00 | -75.0% |
| delta generations / decision | 0.00 | 1.38 | labeled separately |
| mean DFS nodes / decision | 8,500,338 | 2,974,497 | -65.0% |

The eight-position sample is sufficient to confirm the optimization direction,
not to establish production p95/p99. A larger frozen held-out corpus is still
required.

## Regression results

- base move-generation tests: passed;
- incremental-board consistency: 589 committed steps and 589 undo round trips
  passed; existing microbenchmark remained 3.3x–9.4x faster than rebuild;
- static path: 81 decisions, including 21 exact endgames; one full generation
  on every non-endgame decision; seed-invariant on 16 positions; complete-list
  best equity matched on 29 positions;
- exact endgame: 8/8 positions matched brute-force negamax;
- all focused Revision 2 module tests: passed.

The exact-endgame fixture builder was changed from the unrelated legacy sampler
to deterministic static play. This reduced test runtime from more than six
minutes to about one minute without changing the endgame assertions.

## Gate status and production decision

| Gate | Status | Reason |
|---|---|---|
| G0–G1 accounting | partial | v2 accounting/enforcement is tested; legacy shadow reconciliation over 500 positions is not complete |
| G2 transitions | partial | focused canonical-rule fixtures and undo pass; 10,000-sequence differential corpus is not yet built |
| G3 root catalogue | partial | assignment/exchange fixtures and one-root v2 invariant pass; 500-position corpus and shared exact-endgame root are outstanding |
| G4 reference | partial | real reference exists, deterministic paired rows and hidden-information tests pass; known 24-sample opening fixture remains unresolved |
| G5 ReplyIndex | strong partial | 10,000 randomized exact triples and measured node/p95 reductions pass; exhaustive small-rack matrix remains |
| G6 admission | **measured, fails** | 95.8% recall at Deep's cap against a required 99%; the reference variant's effective cap of 12 reaches 75%. See [`deep-compute-allocation-report.md`](deep-compute-allocation-report.md) |
| G7 PairedRace | **measured, fails** | at equal credits paired allocation agrees 93.8% with uniform against a required 95%, raises generation calls instead of cutting them 30%, and carries 15x the reference regret |
| G8 strength/latency | not run | blocked by G6 and G7; requires paired self-play and latency percentiles on the frozen corpus |

Therefore no production solver route, service tier, or public wire field was
changed. Threat Oracle and selective third ply remain absent, as required.

G6 and G7 have since been measured on a frozen 24-position corpus and both fail.
`PairedRace` in particular does not buy strength per unit of compute: the
follow-up report recommends retaining uniform allocation over a wide admitted
set and treating admission, not allocation, as the next thing to fix.

## Smallest next sequence

1. Import or reconstruct the known 24-sample opening fixture and finish the G4
   per-action value trace.
2. Build the canonical differential transition corpus and the remaining
   RootCatalogue/exhaustive-small-rack gates.
3. Freeze train and held-out position manifests, then register G6/G7 thresholds
   before measuring them.
4. Keep `SimV2Reference` and `ReplyIndexUniform` as immutable oracles while
   fitting admission and deciding whether paired elimination earns its place.
5. Run G8 paired self-play and p50/p95/p99. Only a passing result authorizes a
   canary route; exact endgame must first be refactored to consume the shared
   `RootCatalogue` rather than generating root moves again.
