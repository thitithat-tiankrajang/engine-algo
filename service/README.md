# A-Math engine service

The C++ engine, exposed over HTTP so the browser never has to carry it.

Two computations are offered, and they are the **same search** read out
differently — there is no second engine, no second evaluator, and no second
move generator:

| Endpoint | Question |
|---|---|
| `POST /v1/games/:gameId/bot-move` | What does the room's bot play on its own turn? |
| `POST /v1/games/:gameId/analysis` | What would the engine do on *your* turn, and why? |
| `GET /v1/games/:gameId/bot-move/reasoning` | Why did the bot play what it played? (paged, after the fact) |

## The rule that shapes the API

**Neither endpoint accepts a position.** A caller names a game and the revision
it believes that game is at; the server reads the authoritative canonical state
out of Postgres and refuses if the two disagree.

This is not a convenience. An endpoint that evaluated a client-supplied board
would be two bad things at once: a free compute service with a strong engine
attached, and an oracle that leaks hidden information the moment someone
describes a position they are not entitled to know.

## Authorization

The service **grants itself nothing**. It holds no service-role key. It calls
Postgres with the *caller's* Supabase access token, so `auth.uid()` inside the
database is the person who made the request and every existing policy —
`can_read_live_game`, `can_write_live_game`, region scoping, approval status —
applies with no help from this process.

Four gates, cheapest first:

1. **Authentication** — the access token is verified cryptographically (`auth.ts`).
   The verifier derives `/auth/v1/.well-known/jwks.json` and the
   `/auth/v1` issuer from `SUPABASE_URL`, selects a public signing key by `kid`,
   and validates the asymmetric signature, issuer, audience, expiration,
   subject, and `authenticated` role. A non-user token can neither be metered
   nor authorized.
2. **Metering** — per-user concurrency and compute budget (`rateLimit.ts`).
   An account holds **one analysis at a time**; the sliding-window budget
   applies to **bot turns**, and to analysis only under
   `ENGINE_ANALYSIS_BUDGETED=true`. See below.
3. **Authorization** — whatever Postgres says (`roomContext.ts`).
4. **Turn rules** — enforced in `app.ts`, and only there.

### Analysis: one at a time, never rationed

The analysis limit is **one in flight per account**, and that is the whole of
it. There is no per-window quota: press analyse as often as you like, on as
many games as you like, for as long as you like — each request simply waits for
the previous one.

"In flight" includes **queued**, not just running. If the analysis of game 3 is
still sitting in the queue, asking about another game is refused with
`analysis_in_progress` (429) until game 3's answer comes back. The waiting job
is not cancelled, hurried, or overtaken to make room: it keeps its place in
line. Asking the *same* question again — the same game, revision and level from
a second tab or a reconnect — is not a second analysis at all: it attaches to
the search already running and takes no slot.

Everything else is the **queue**, which is the honest place for a load limit:
it bounds how many searches run at once (`ENGINE_CONCURRENCY`) and how many may
wait (`ENGINE_MAX_WAITING`, `ENGINE_MAX_QUEUE_WAIT_MS`), and every analysis
level queues *behind* every bot turn (`BOT_PRIORITY` in `levels.ts`). Heavy
analysis use therefore makes analysis slower — the analyser's own included —
and can never slow down a game waiting on its opponent, or oversubscribe the
CPU. A saturated instance still answers `queue_full` (503, retry).

What a caller is no longer told for analysis is `budget_exhausted`: that code
is reachable for analysis only under `ENGINE_ANALYSIS_BUDGETED=true`, because
rationing fails a player mid-game, on the turn they stopped to think about, and
no amount of waiting gets them the answer. Bot moves are budgeted either way —
nobody is sitting and waiting on a press for those.

### Analysis permission

Analysis is help with **your own decision**, so:

- the turn must be controlled by a **human** — on the bot's turn there is no
  human decision to assist, and answering would hand the player the engine's
  read of a rack they cannot see;
- the caller must be the one who **controls that turn** — in a human-vs-human
  room either player may analyse on their own turn; a spectator may analyse on
  nobody's.

Hiding the button is not one of these conditions. The endpoint answers the same
way whether or not a button exists.

## Hidden information

Protection is **structural, not filtered**. `adapter.ts` builds the engine
request from canonical state and hands over one rack: the analysed side's. The
opponent reaches the engine process as an integer count, and the bag as an
integer count. There is no field on the wire that *could* carry a tile the
requester may not see, so no engine output — not a move, not a candidate row,
not a progress line — can leak one.

The bot MOVE endpoint returns **only the move**. The candidate report is the
engine's reasoning about the *bot's* rack, so it is not shipped alongside an
answer a client applies mid-turn.

It is served instead by `GET /v1/games/:gameId/bot-move/reasoning?revision=N`,
after the fact and **a page at a time**, out of the completed search the registry
already holds — no second search, and no payload paid for on turns where nobody
asks. The gate is the one the move endpoint applies: the caller must control this
bot room, so a spectator is refused there and here alike, and a room with no
engine player has nothing to explain.

## Compute protection

Every user's browser used to supply its own CPU. It no longer does: every bot
turn and every analysis in the whole deployment now competes for the CPU of one
container. The engine is CPU-bound and a `max` search legitimately runs for
minutes, so **every** run goes through one queue (`queue.ts`) — there is no path
from either endpoint to `amath_cli` that does not.

- **Bounded running** — at most `ENGINE_CONCURRENCY` engine PROCESSES exist at
  once. Not HTTP requests: processes. On a 1-CPU instance that means job A runs
  while B and C wait, rather than three searches each getting a third of a core
  and all three overshooting their deadlines.
- **Ordered** — bot turns carry priority 0. Active gameplay is never queued
  behind a study request, no matter how much analysis is pending. A running
  analysis is *not* killed when a bot turn arrives — there is no safe
  preemption point inside a search — but nothing waiting gets ahead of
  gameplay.
- **Admission-controlled in depth** — past `ENGINE_MAX_WAITING`, work is
  refused (`queue_full`, HTTP 503, `Retry-After`) rather than accepted into a
  line it will never reach.
- **Admission-controlled in time** — a job that waits longer than
  `ENGINE_MAX_QUEUE_WAIT_MS` is refused with the same `queue_full` code.
  Depth alone does not bound a wait: at concurrency 1, eight queued `max`
  searches is forty minutes.
- **Deduplicated** — two callers asking the identical question share one run.
- **Promptly released** — a cancelled job that is still waiting is dropped from
  the queue immediately, not when its turn eventually comes. A burst of
  disconnects therefore leaves an empty queue rather than a full one.

Each run is one OS process (`amath_cli worker`), which makes a wall-clock
timeout and a user cancellation the same always-available operation: kill it.

### Sizing the pool

`os.availableParallelism()` reports the size of the process's CPU **affinity
mask**. Container platforms — Render included — limit CPU with a cgroup
**quota**, which does not touch that mask. A service pinned to 1 CPU on a
16-core host still sees 16, and sizing the pool from that number is the specific
way this service would silently destroy its own throughput.

So `cpu.ts` reads the quota directly (cgroup v2 `cpu.max`, then v1
`cpu.cfs_quota_us`/`cpu.cfs_period_us`) and takes the smaller of quota and
affinity. From that allowance:

| Effective CPUs | Default `ENGINE_CONCURRENCY` |
|---|---|
| ≤ 2 | 1 |
| > 2 | *n* − 1 |

`amath_cli` is single-threaded, so one process saturates exactly one core and
never more. The reserve is for Node: it is the thread that answers `/health`,
accepts the cancellation that stops a runaway search, and writes the SSE bytes
that keep a proxy from closing a live connection. Starving it is how a busy
server becomes an unreachable one.

An explicit `ENGINE_CONCURRENCY` always wins, and is validated: a value that is
not a whole number between 1 and 32 stops the service at boot rather than
being silently clamped. `/health` reports which source was used.

## Request lifecycle over SSE

`Accept: text/event-stream` gets the full lifecycle. Everything decidable before
the search starts — authentication, authorization, turn rules, staleness,
metering — is still answered with a real HTTP status code; only failures after
the response head is written become events.

| Event | Data | When |
|---|---|---|
| `queued` | `{ahead, position}` | Accepted, but no CPU yet. Re-sent whenever the place in line changes. **Not sent at all** if the job started immediately. |
| `running` | `{}` | An engine process now exists for this job. |
| `progress` | `{phase, percent, elapsedMs, etaMs, detail}` | The engine's own report, throttled to one per 400ms. |
| `result` | the answer | Terminal. |
| `error` | `{code, error, …}` | Terminal. |

`ahead` is a **fact about the queue at the moment it was sent**, not a
prediction: a bot turn arriving later legitimately overtakes queued analysis,
and every such change is re-sent. No percentage anywhere in this path is
synthesised — a job with nothing to report has nothing reported for it, and the
client renders that as an indeterminate state.

### Staleness across a wait

Queueing widens the window in which an answer can go stale, from "while the
search ran" to "while it waited **and** ran". So the revision is checked twice
on the server: once at admission, and again at the moment a job that actually
waited reaches the front — **before** a process is spawned, so a shared CPU is
never spent on a position the game has already left. The client checks a third
time, on the way in, because a result can also go stale during the search
itself.

## Strength tiers

Bot tiers preserve the browser's behaviour exactly, including `max` inheriting
the engine's own 120s midgame / 300s endgame ceilings.

Analysis levels are chosen by the player and are **independent of the room's
bot** — a player may study deeply while playing a weak opponent. They are bounded
by **sample count**, not wall clock, because a time cutoff stops the simulation
at whatever sample the machine happened to reach; the same position could then
rank candidates differently on a busy server. Bounding the work makes a level
reproducible.

| Level | Samples | Timeout | Candidates | Cost |
|---|---|---|---|---|
| quick | 4 | 30s | 8 | 1 |
| normal | 12 | 60s | 12 | 3 |
| deep | 40 | 150s | 16 | 10 |
| max | 160 | 330s | 24 | 30 |

Measured on the reference machine at an opening position, the simulation costs
roughly **1 second per sample**. Midgame and endgame positions differ.

## Configuration

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `PORT` | no | `8787` | Listen port |
| `ENGINE_BINARY_PATH` | no | `/usr/local/bin/amath_cli` | Compiled engine |
| `SUPABASE_URL` | **yes** | — | Project URL |
| `SUPABASE_PUBLISHABLE_KEY` | **yes** | — | Low-privilege public API key, used with the caller's token |
| `ENGINE_ALLOWED_ORIGINS` | **yes** | — | Comma-separated. `*` is refused. |
| `ENGINE_CONCURRENCY` | no | derived from the cgroup CPU quota (see above) | Simultaneous engine **processes**. 1–32; anything else refuses to boot. |
| `ENGINE_MAX_WAITING` | no | `concurrency × 8`, clamped to 8–64 | Queue depth before refusing |
| `ENGINE_MAX_QUEUE_WAIT_MS` | no | `120000` | How long a job may wait before it is refused |
| `ENGINE_MAX_BODY_BYTES` | no | `8192` | Request body ceiling |
| `ENGINE_BUDGET_PER_WINDOW` | no | `60` | Cost units per user per window. Always charged for bot turns; charged for analysis only when `ENGINE_ANALYSIS_BUDGETED` is on. |
| `ENGINE_BUDGET_WINDOW_MS` | no | `600000` | Budget window |
| `ENGINE_MAX_ANALYSIS_PER_USER` | no | `1` | Analyses **in flight** per account — queued counts, not only running. This is the analysis limit; a second one is told to wait (`analysis_in_progress`), never that it is out of quota. |
| `ENGINE_ANALYSIS_BUDGETED` | no | `false` | Whether analysis *also* spends the window budget above. Off: **analysis is never rationed**, only serialised by the cap. On: it can exhaust the budget like a bot turn. |
| `ENGINE_ANALYSIS_RESULT_TTL_MS` | no | `1800000` | How long a completed analysis is served from the result cache. Analysis is a pure function of an immutable (position, settings), so a returning player reads it without recomputing. |
| `ENGINE_BOT_RESULT_TTL_MS` | no | `1800000` | How long a completed bot move is cached. The cache key includes the revision, so it pins one move only to that same canonical turn and cannot carry into a later turn. This is also the window in which `bot-move/reasoning` can still explain that move; past it the report is gone and the client is told so. |
| `ENGINE_JOB_CACHE_MAX` | no | `256` | Ceiling on cached engine results, evicted least-recently-used. 1–100000. |

An engine job (a bot turn or an analysis) now outlives the request that started
it: an observer disconnecting — a page navigating away, a tab closing, a dropped
socket — no longer cancels the search. A returning client reconnects to the job,
or reads its cached result, over the GET reconnect routes:

- `GET /v1/games/:gameId/bot-move?revision=N`
- `GET /v1/games/:gameId/analysis?revision=N&level=L`

These pass every gate the POST does (authentication, authorization, staleness),
start nothing, spend no budget, and answer `queued` / `running` / `result` /
`idle`. A running analysis is stopped only by an explicit
`POST /v1/games/:gameId/analysis/cancel`, by a superseded revision, by timeout,
or by shutdown — never by a lost connection. The registry and its result cache
are in-memory: a process restart drops them, after which clients recover from
server truth by re-requesting.

For an existing environment, replace `SUPABASE_ANON_KEY` with
`SUPABASE_PUBLISHABLE_KEY` and set it to the project's `sb_publishable_...`
value; do not merely rename the old anon JWT value. Remove
`SUPABASE_JWT_SECRET` from the service environment.

The service refuses to start if a required variable is missing. It does not
read or require `SUPABASE_JWT_SECRET`, a private signing key, `service_role`, or
a secret API key. User tokens are verified against the project's cached public
JWKS; database RPCs use the caller's same token so existing RLS remains
authoritative.

## Running

```bash
npm install
npm test
```

Locally, against a built engine:

```bash
make cli && ENGINE_BINARY_PATH=$PWD/build/amath_cli npm --prefix service run dev
```

## Building the image

The build context is the **repository root**, not this directory — the image
compiles the engine from `src/` and the service from `service/`:

```bash
docker build -f service/Dockerfile -t amath-engine-service .
```

## Deploying on Render

The service is CPU-bound, single-purpose, and holds queue state in memory. Two
consequences for the plan you pick:

- **Keep it to one instance.** The queue, the per-user budget, the per-account
  analysis cap, the job registry and the result cache are all per-process. Job
  DISCOVERY (`GET /v1/games/:id/jobs`) reads that same in-memory registry, so
  behind two replicas a returning player could ask the instance that is not
  running their search and be told there is none. Two replicas behind a load balancer means
  two independent queues, each sized for a whole CPU it does not have, and a
  per-user budget that is trivially doubled. Scaling out needs Redis first.
- **Buy CPU, not RAM.** Memory use is a few hundred MB regardless of plan; the
  only thing that changes how many players the instance serves is cores.

### Starting values

These are deliberately conservative — the point is to start somewhere that
cannot be *wrong*, then raise it against measurements from a real instance.

| Plan | CPU | `ENGINE_CONCURRENCY` | `ENGINE_MAX_WAITING` | Notes |
|---|---|---|---|---|
| Starter | 0.5 | `1` | `8` (default) | A single `max` search already exceeds this instance's whole allowance; expect `max` bot turns to run several times slower than the reference machine, and `super` — which has no clock to cut it short — to run until it is done. Fine for `medium`/`hard` and `quick`/`normal` analysis. |
| **Standard** | **1** | **`1`** | **`8` (default)** | **The expected initial deployment.** One search at full speed, everything else queued. |
| Pro | 2 | `1` (default) — try `2` only after measuring | `8`–`16` | Two engine processes will each finish roughly on time and leave nothing for Node. Raise only if the evidence below says the event loop is not suffering. |
| Pro Plus | 4 | `3` (default) | `24` (default) | Three searches, one core reserved. |

**CPU count alone does not determine the right setting.** It bounds it. What
actually decides it is the mix of work this deployment sees: a room full of
`medium` bots is a completely different load from two people running `max`
analysis — or from one `super` bot, which holds its slot until the search
finishes rather than until a deadline fires — and the same concurrency is right
for one and wrong for the other.

### What to measure before raising `ENGINE_CONCURRENCY`

Raise it only when **all** of these hold at the current setting:

1. **`/health` shows sustained `waiting > 0`.** If the queue is usually empty,
   more concurrency buys nothing and costs latency on the searches you do get.
2. **Render's CPU graph is not pinned at 100%.** If it already is, adding a
   process divides the same CPU into smaller pieces — every search gets slower
   and none finishes sooner.
3. **`/health` still answers promptly under load.** A slow or timing-out health
   check means the event loop is already starved, which is the failure the
   reserve exists to prevent. Raising concurrency makes it worse.
4. **Bot `stats.elapsedMs` has not drifted upward** for a given difficulty. The
   engine sets its own deadlines in wall-clock time, so a throttled process
   does not just take longer — it *searches less* in the time it has, and the
   bot gets quietly weaker. This is the symptom to watch for above all others,
   because nothing else reports it.
5. **`queue_full` responses are rare.** If they are common, the honest fixes are
   a bigger plan or a longer `ENGINE_MAX_QUEUE_WAIT_MS`, not more processes on
   the same CPU.

If you raise it, raise it by one, and re-check (4) afterwards.

### Environment to set on Render

Required: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `ENGINE_ALLOWED_ORIGINS`.
Recommended: `ENGINE_CONCURRENCY` set explicitly, so the pool size is a decision
in the dashboard rather than an inference from a file the platform may change.

For the client-side Super beta, one more:

| Variable | Value | Effect |
|---|---|---|
| `CLIENT_SIDE_SUPER` | `true` | Every **authenticated** player computes their own Super moves. Off, every Super turn takes the backend path. |

One switch, and deliberately only one. Who may use the client-side path is
"anyone signed in", because `/v1/bot-config` authenticates the caller and the
project's account-approval process already decides who holds an account. An
allowlist of user ids beside that would be a second answer to a question the
platform has answered once, and two lists that must agree about the same people
is one more thing to keep in step.

Read the state off `/health`:

```json
"clientSuper": {
  "enabled": true,
  "engineVersion": "super-v11",
  "weightsVersion": "v1",
  "adaptiveBudget": "off"
}
```

`"adaptiveBudget"` is the one to check on sight: anything other than `"off"`
means the bot is playing deliberately weaker than Super.
`PORT` and `ENGINE_BINARY_PATH` are already correct in the image.

## Client-side Super (Champion beta)

The `super` tier can run **in the player's browser** instead of on this
container. That is the one change that breaks the linear relationship between
concurrent Super players and this service's CPU.

The arithmetic it exists to fix: a Super move is a search that runs to
completion rather than to a deadline, measured at **180 CPU-seconds per move**
on the reference machine (p50 197 s, range 106–213 s). At
`ENGINE_CONCURRENCY=1` that is **20 Super moves an hour** against the dozen a
game needs — one to two concurrent Super games, with the rest queued behind a
search that cannot be interrupted and refused once the queue fills. Nothing
about tuning the queue changes that; the CPU is the bound.

After the change, the same turn costs this service **one legality check —
measured at 2.5 ms including process spawn**, a factor of roughly 72,000.

### What moved and what did not

| | Runs where |
|---|---|
| Super search | **The player's device** (WASM, in a Web Worker) |
| Every other bot tier, and all analysis | This service, unchanged |
| Game state, turn order, revisions | Postgres, unchanged |
| Move legality | **This service**, per submitted move — no search |
| Bot configuration and weights | **This service**, versioned |

The backend Super path is **still here and still works**. Every client-side
refusal — the flag is off, the browser cannot run a module worker, the config
could not be fetched, the pinned weights version is gone — falls back to it.
That is why it was not removed.

Being **slow** is not on that list. A slow device runs full Super locally and
takes longer over it; it is never quietly moved onto a different engine or a
smaller search.

### `GET /v1/bot-config`

What a client-side engine should be configured with, and whether it may run.

```json
{
  "clientSuperEnabled": true,
  "engineVersion": "super-v11",
  "weightsVersion": "v1",
  "weights": {},
  "calibration": {
    "benchmark": "gen-nodes-v1",
    "reference": {
      "device": "Apple M3 (8 core, 16 GB), macOS 14.6.1, WASM",
      "nodesPerSec": 8700000,
      "fullSuper": { "p50Ms": 225466, "p95Ms": 334240, "positions": 13 }
    },
    "tiers": [ { "tier": "EXCELLENT", "maxEstimatedMoveMs": 30000 } ],
    "warnAboveMs": 60000,
    "adaptiveBudget": { "enabled": false, "budgets": [], "targets": {} }
  }
}
```

The client runs the same `gen-nodes-v1` benchmark and scales `fullSuper` by its
own throughput ratio. That is the whole calculation, and its output is a
**prediction and a label** — nothing here selects a search.

**Every device runs the full 160-sample Super schedule.** There is one latency
in `reference` rather than a table of them, and there is no `targets` and no
`minimumTier` at this level, both deliberately: a latency target reachable from
the default path is how the schedule came to be chosen to fit a stopwatch in an
earlier revision, which gave reference-class hardware 8 of 160 samples while
this service's fallback went on running all 160.

`warnAboveMs` is the estimated p50 above which the UI tells the player the wait
will be long. It changes what is **said**, never what is searched.

`adaptiveBudget` is the retired experiment, off unless `SUPER_ADAPTIVE_BUDGET`
is deliberately set, and it is the one switch that changes how **strong** the
client-side bot plays rather than how fast. Its state is readable off `/health`
so nobody has to inspect an environment to find out. Turning it on is a strength
change with no strength measurement behind it.

Authenticated, cached privately for five minutes, and **not a security
mechanism**: the weights are handed to a WASM module in a browser the player
controls. What versioning buys is remote tuning, A/B testing, rollback,
reproducibility, and being able to say afterwards which evaluator played a game.

`?weightsVersion=v1` asks for a **specific** version. A version this deployment
does not carry is **refused** (`400 bad_request`) rather than substituted —
answering with different weights under the pinned version's name is precisely
what pinning exists to prevent, and the client falls back to the backend engine
instead.

### Version pinning

A game records the versions its first device-computed move used
(`superEngineVersion` / `superWeightsVersion` on the stored game). Every later
turn of that game fetches that version by name. A retune shipped mid-match
therefore applies to **new games only**, and a finished game can be replayed
under the weights it was actually played with.

### `POST /v1/games/:gameId/bot-move/validate`

> Is this move legal, from the position this server is holding?

That is the whole claim, and it is deliberately smaller than "is this the move
the engine would have played" — proving the latter means running the Super
search again, which is the exact CPU cost this whole path removes.

The board and the rack come from canonical state at a revision the caller had to
name correctly; the caller supplies only the move. So a caller cannot make an
illegal move legal by also describing a board on which it would be.

It runs the engine in `mode: "validate"` — rules arithmetic, no search,
microseconds — and it deliberately **does not go through the search queue**.
Queueing it would mean a player whose device computed a move in ten seconds then
waited minutes behind a running `max` analysis for permission to play it. It is
bounded instead by `ENGINE_VALIDATION_CONCURRENCY` per account.

`valid: false` is a **successful call** reporting an illegal move — an engine
bug, a desynced rack, or a position that moved. The client discards the move and
recomputes; it never converts it into a pass.

### What this is not

For this beta, the Champion group is trusted, and the following are deliberately
**not** implemented: obfuscated WASM, hidden weights, cryptographic proof that
the client ran the search, server-side re-search to verify a move, or any
anti-cheat infrastructure. A client could commit a move it did not compute — as
it could before any of this existed, because the browser has always been the
thing that submits moves in a bot room.

### Configuration

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `CLIENT_SIDE_SUPER` | no | `false` | Whether clients may run Super locally. Server-controlled rollout switch: turning it off must never require shipping anything to a browser. |
| `ENGINE_VALIDATION_CONCURRENCY` | no | `4` | Simultaneous legality checks per account. Not a CPU protection — a validation is microseconds — but the bound that stops one account spawning processes in a loop. |

`/health` reports `clientSuper.enabled` along with the versions this instance
would hand out, so the rollout state is readable from the same page as the
queue.

## Limitations

- Rate limiting, the per-account analysis cap and the queue are **in-memory and
  per-instance**. Correct for a single instance; behind more than one replica
  they would need Redis — two replicas would let one account run two analyses
  at once, one per instance.
- Completed results are cached in memory, TTL'd and LRU-bounded
  (`ENGINE_ANALYSIS_RESULT_TTL_MS`, `ENGINE_BOT_RESULT_TTL_MS`,
  `ENGINE_JOB_CACHE_MAX`). Like the queue and the rate limiter, the cache is
  **per-process**: a restart empties it, and a second replica would not see it.
- Deduplicated callers share the run but only the first one's connection
  receives `progress` events; the others see `queued`/`running` and then the
  result. This affects two tabs of the same game, and nothing else.
- The `queued` position is a snapshot of the queue, not an ETA. It cannot
  account for higher-priority work that has not arrived yet, which is why the
  UI phrases it as a place in line rather than as a time.
