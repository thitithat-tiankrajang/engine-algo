# A-Math engine service

The C++ engine, exposed over HTTP so the browser never has to carry it.

Two computations are offered, and they are the **same search** read out
differently — there is no second engine, no second evaluator, and no second
move generator:

| Endpoint | Question |
|---|---|
| `POST /v1/games/:gameId/bot-move` | What does the room's bot play on its own turn? |
| `POST /v1/games/:gameId/analysis` | What would the engine do on *your* turn, and why? |

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
2. **Metering** — per-user compute budget and concurrency (`rateLimit.ts`).
3. **Authorization** — whatever Postgres says (`roomContext.ts`).
4. **Turn rules** — enforced in `app.ts`, and only there.

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

The bot endpoint additionally returns **only the move**. The candidate report is
the engine's reasoning about the *bot's* rack, and the human across the board is
not entitled to it.

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
| `ENGINE_BUDGET_PER_WINDOW` | no | `60` | Cost units per user per window |
| `ENGINE_BUDGET_WINDOW_MS` | no | `600000` | Budget window |
| `ENGINE_MAX_ANALYSIS_PER_USER` | no | `1` | Concurrent analyses per user |
| `ENGINE_ANALYSIS_RESULT_TTL_MS` | no | `1800000` | How long a completed analysis is served from the result cache. Analysis is a pure function of an immutable (position, settings), so a returning player reads it without recomputing. |
| `ENGINE_BOT_RESULT_TTL_MS` | no | `1800000` | How long a completed bot move is cached. The cache key includes the revision, so it pins one move only to that same canonical turn and cannot carry into a later turn. |
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

- **Keep it to one instance.** The queue, the per-user budget, the per-user
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
| Starter | 0.5 | `1` | `8` (default) | A single `max` search already exceeds this instance's whole allowance; expect `max` bot turns to run several times slower than the reference machine. Fine for `easy`–`hard` and `quick`/`normal` analysis. |
| **Standard** | **1** | **`1`** | **`8` (default)** | **The expected initial deployment.** One search at full speed, everything else queued. |
| Pro | 2 | `1` (default) — try `2` only after measuring | `8`–`16` | Two engine processes will each finish roughly on time and leave nothing for Node. Raise only if the evidence below says the event loop is not suffering. |
| Pro Plus | 4 | `3` (default) | `24` (default) | Three searches, one core reserved. |

**CPU count alone does not determine the right setting.** It bounds it. What
actually decides it is the mix of work this deployment sees: a room full of
`easy` bots is a completely different load from two people running `max`
analysis, and the same concurrency is right for one and wrong for the other.

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
`PORT` and `ENGINE_BINARY_PATH` are already correct in the image.

## Limitations

- Rate limiting, the queue and the per-user analysis cap are **in-memory and
  per-instance**. Correct for a single instance; behind more than one replica
  they would need Redis.
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
