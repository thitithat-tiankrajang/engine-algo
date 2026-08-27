# Client-side Super — architecture

The Super bot's search now runs on the player's device. This document is what
changed, why, and what the change does and does not buy.

The measurements that drove every threshold in here are in
[client-side-super-benchmark.md](client-side-super-benchmark.md). Read that one
first if you want the numbers; read this one for the shape.

## The problem

A Super move is a search that runs to **completion** rather than to a deadline —
that is the entire difference between `super` and `max`. On the reference
machine it costs a measured **180 CPU-seconds a move** — p50 197 s, range
106–213 s over five positions spanning the phases where the sampling search runs.

At `ENGINE_CONCURRENCY=1`, which is what a 1-CPU container supports, that is
**one Super player at a time**. Not one slow player — one player, with everyone
else queued behind a search that will not be interrupted, and refused once the
queue fills. No amount of queue tuning changes that, because the constraint is
the CPU and the CPU is fully spent by one move.

## The shape

```
                        Backend
        ┌──────────────────────────────────────┐
        │  game state · turn order · revisions │   (Postgres, unchanged)
        │  bot configuration + weights         │   GET  /v1/bot-config
        │  move legality                       │   POST /bot-move/validate
        │  the OLD Super path, as fallback     │   POST /bot-move
        └───────────────────┬──────────────────┘
                            │ config + versioned weights (cached, ~10 min)
                            ▼
        ┌──────────────────────────────────────┐
        │              Browser                 │
        │  ┌────────────────────────────────┐  │
        │  │  UI thread                     │  │
        │  │    engineSessions.observeBot   │  │
        │  └──────────────┬─────────────────┘  │
        │                 │ postMessage        │
        │  ┌──────────────▼─────────────────┐  │
        │  │  Web Worker                    │  │
        │  │    WASM engine + weights       │  │
        │  │    FULL Super search, 160      │  │
        │  │    samples, every device       │  │
        │  └──────────────┬─────────────────┘  │
        └─────────────────┼────────────────────┘
                          │ move
                          ▼
              legality check → apply → commit
```

## What runs where

| | Before | Now |
|---|---|---|
| Super search | Backend container | **The player's device** |
| `medium` / `hard` / `max` | Backend | Backend, unchanged |
| Analysis (all levels) | Backend | Backend, unchanged |
| Game state, turn order, revisions | Postgres | Postgres, unchanged |
| Move legality | Client validator only | Client validator **and** the server, per move |
| Bot weights | Compiled into the engine | **Served and versioned** by the backend |

## The files

### Engine (`amath-engine/src/`)

| File | Change |
|---|---|
| `engine.cpp` | `weights` request field (applied over compiled defaults, reset per request, unknown keys **rejected**); `mode: "calibrate"`; `mode: "validate"` |
| `cli.cpp` | `positions` mode — dumps engine requests from self-play, for the latency corpus |
| `wasm_api.cpp` | unchanged — the existing entry point was already right |
| `Makefile` | `deploy-ui` now copies into EQ-Lab's bundled source tree |

The search itself is **untouched**. No new solver, no new evaluator, no new move
generator. What changed is how the same search is configured and how its cost is
bounded.

### Backend (`amath-engine/service/src/`)

| File | Change |
|---|---|
| `superConfig.ts` | **new** — versions, the weights registry, the calibration reference, the latency targets |
| `app.ts` | `GET /v1/bot-config`, `POST /:gameId/bot-move/validate`, `clientSuper` on `/health` |
| `config.ts` | `CLIENT_SIDE_SUPER`, `ENGINE_VALIDATION_CONCURRENCY` |
| `engineRunner.ts` | split into `runEngineRaw` (transport) + `runEngine` / `runEngineValidation` (shape) |

### Client (`EQ-Lab/src/bot/`)

| File | Role |
|---|---|
| `engine/amath_engine.mjs` | the WASM artifact, moved here from `tools/` so Vite can resolve it |
| `engine/superWorker.ts` | the Web Worker; dynamically imports the engine |
| `superEngine.ts` | owns the worker: `initialize` / `calibrate` / `think` / `cancel` / `getStatus` |
| `superTypes.ts` | the `postMessage` protocol |
| `superRequest.ts` | the client-side adapter — the twin of `service/src/adapter.ts` |
| `superConfig.ts` | fetch, cache and **pin** the versioned configuration |
| `calibration.ts` | measure the device, choose its budget |
| `clientSuper.ts` | one whole turn: readiness → search → legality → `BotMoveResult` |
| `superTelemetry.ts` | what this device actually waited, move by move |

One build-config file was needed and is the only one this project has:
`vite.config.ts` sets `worker.format: "es"`. The default is `"iife"`, which
cannot code-split, so the worker's dynamic `import()` of the engine fails the
build outright rather than silently inlining a 250 KB module into everyone's
first load. Module workers need Chrome 80+, Safari 15+, or Firefox 114+;
anything older fails to construct the worker and falls back to the backend
engine, which is what the fallback is for.

The built output, for the record:

```
dist/assets/superWorker-….js       1.0 kB   the worker
dist/assets/amath_engine-….js    312   kB   the engine, its own chunk
dist/assets/index-….js           418   kB   the app's entry (unchanged)
```

`engineSessions.ts` gained one branch; `App.tsx` gained a readiness effect and
one option on the call it already made. Everything downstream — `toBotResponse`,
`mapBotResponse`, `applyBotResult`, the official validator, the commit — is
untouched and cannot tell where a move came from, because the local path returns
the **same `BotMoveResult` type** the HTTP endpoint returns.

## Five decisions worth arguing with

### 1. Cancellation is `terminate()`, and it has to be

`_engine_handle` is one synchronous C++ call that does not return until the
search is finished. While it runs, the worker's message loop is **not running**
— so a `cancel` message would be read only *after* the search it was meant to
stop had already completed. Cooperative cancellation across this boundary is not
a design choice that was rejected; it is unavailable.

`superEngine.cancel()` therefore terminates the worker, and the next `think()`
starts a fresh one. The cost is re-instantiating the module — measured at 3–8 ms
under Node and **71 ms** in Chrome through the production worker — against a
superseded search spending another *four minutes* of a player's CPU and battery. Every path that invalidates a search (the position moved, the player
left the room, a newer request arrived) goes through that one function.

### 2. Every device runs the same full Super. Only the wait changes.

This is the product requirement, and it is the one thing in this document that
is not open to a performance argument.

**Super plays identically on every device.** The same 160-sample schedule, the
same weights, the same solver, the same seed for a given position. What a slow
device gets is not a smaller search — it is a longer wait.

| Device | Search | Wait |
|---|---|---|
| Fast | Full Super, 160 samples | Finishes sooner |
| Medium | Full Super, 160 samples | Finishes later |
| Slow | Full Super, 160 samples | Several minutes |

Concretely: `buildSuperRequest` sets `unlimited: true` and **omits `sampleCap`
entirely**. The engine reads a missing `sampleCap` as `cfg.simSamples` — all 160
(`src/engine.cpp:1972`). `unlimited` makes the search stop when its *schedule* is
complete rather than when a clock fires, which is precisely what converts a slow
device into a long wait instead of a truncated search.

#### This was got wrong once, which is why it is written down

An earlier revision of this work served a table of per-budget latencies and had
the client pick the largest sample cap that fitted a 15 s / 30 s latency target.
On the reference M3 that resolved to **8 of 160 samples** — 5% of the schedule —
while the backend fallback, which was never changed, went on running all 160.

Nothing failed. There was no error, no warning, and both engines returned legal,
plausible moves. A Champion on a slower laptop simply played a weaker opponent
than a Champion on a faster one, and the code that did it read like a sensible
latency optimisation.

The measurements that would have told anybody what that cost were never taken.
Move-agreement cannot stand in for them: `sample:8` agreed with the full
schedule on 36% of positions, but `sample:8` at one seed agreed with *itself* at
another on only 18% — so a low agreement number is what Monte Carlo search does,
not evidence of a strength change in either direction. **Playing strength
remains unmeasured**, which is exactly why a reduced budget cannot be a default.

### 3. There is no latency target and no tier gate on the Super path

Not "the targets are generous". There is no target to reach.

Super is the strongest bot on offer, and searching exhaustively is what makes it
that; a Super that fits a stopwatch is a different bot wearing the name. The
original 15 s / 30 s figures survive only inside the flagged experiment, where
fitting a schedule to a clock is a legitimate thing to be doing.

The same reasoning removed the `minimumTier` gate. It sent a device below a
performance band to the backend engine, which — since the backend runs the same
full schedule — cost nothing in strength. It was still a latency-based cutoff
sitting in the middle of the Super path, and the next person to want one would
have found it already built.

So a device estimated at ten minutes a move runs full Super and is **told** the
wait will be long. A player who does not want to wait has a real remedy that
does not involve weakening Super: pick `max`, `hard` or `medium`.

Calibration's entire output is therefore a prediction and a label:

```
estimated full-Super wait = reference full-Super latency
                          × (reference throughput / this device's throughput)
```

used to tier the device, to warn its owner, and for the beta report. It selects
nothing.

### 4. Calibration does not run a Super search

It runs a fixed number of move-generation nodes over a fixed embedded position,
capped so the cap always binds — every device does **exactly** 2,000,000 nodes,
so only the time varies. Generation is the right primitive because a Super
decision is generation-bound: roughly candidates × samples × 2 generations, with
every heuristic between them costing under a microsecond.

Running an actual Super search to find out how long a Super search takes would
cost the player the very minutes the calibration exists to warn about.

### 5. The server checks legality, not the move

> Is this move legal, from the position the server is holding?

That is the whole claim. Proving *"this is the move the engine would have
played"* means running the Super search again on the server, which is exactly
the cost this entire path removes.

Legality is the useful half. It catches the three ways a client-computed move
actually goes wrong — an engine bug, a rack that has drifted out of sync, and a
position that moved while the search ran — and all three are silent failures the
client's own validator either shares or cannot see. The board and rack come from
canonical state at a revision the caller had to name correctly; the caller
contributes only the move.

Three outcomes, three different handlings, and keeping them apart matters:

| Outcome | Meaning | What happens |
|---|---|---|
| `valid: true` | the move is legal here | applied, committed |
| `valid: false` | the search was wrong | **never** applied, never converted to a pass; the turn goes to the backend engine |
| `stale_revision` / `turn_rule` | the position moved | not a verdict about the move at all; the client waits for sync and re-derives, exactly as it does on the backend path |
| unreachable | nobody could confirm it | retried twice, then the turn goes to the backend engine — which computes its own move and needs no confirmation |

The last row is why the check does not cost a re-search: a `queue_full` on an
endpoint that runs no search used to be worth throwing a finished 8-second
search away for.

## Version pinning

A game records the versions of its first device-computed move
(`superEngineVersion` / `superWeightsVersion`, written in the **same commit** as
that move). Every later turn fetches that version **by name**.

A version this deployment no longer carries is refused, not substituted — the
client falls back to the backend engine rather than play the rest of a match
under weights it was not started under. A game that switched evaluators at move
12 was played by two different opponents, and nothing recorded afterwards could
say which one made which decision.

## What this is deliberately not

The Champion group is trusted, so none of the following exists and none of it
should be added for this phase: obfuscated WASM, hidden weights, cryptographic
proof that the client ran the search, server-side re-search to verify a move, or
anti-cheat infrastructure. A client could commit a move it did not compute — as
it could before any of this existed, because in a bot room the browser has
always been the thing that submits moves.

## Rollback

`CLIENT_SIDE_SUPER=false` on the service. Every client's next config fetch (≤10
minutes) sends it back to the backend path, which was never removed and is still
exercised by every fallback case. No client deploy is involved, which is the
point of making the flag server-side.
