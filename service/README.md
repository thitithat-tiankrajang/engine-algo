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

The engine is CPU-bound and a `max` search legitimately runs for minutes, so
every run goes through one queue (`queue.ts`):

- **Bounded** — at most `ENGINE_CONCURRENCY` engine processes exist at once,
  defaulting to one below the core count so the event loop always has a core to
  answer health checks and cancellations on.
- **Ordered** — bot turns carry priority 0. Active gameplay is never queued
  behind a study request, no matter how much analysis is pending.
- **Admission-controlled** — past `ENGINE_MAX_WAITING`, work is refused rather
  than accepted into a line it will never reach.
- **Deduplicated** — two callers asking the identical question share one run.

Each run is one OS process (`amath_cli worker`), which makes a wall-clock
timeout and a user cancellation the same always-available operation: kill it.

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
| `ENGINE_CONCURRENCY` | no | cores − 1 | Simultaneous engine processes |
| `ENGINE_MAX_WAITING` | no | `64` | Queue depth before refusing |
| `ENGINE_MAX_BODY_BYTES` | no | `8192` | Request body ceiling |
| `ENGINE_BUDGET_PER_WINDOW` | no | `60` | Cost units per user per window |
| `ENGINE_BUDGET_WINDOW_MS` | no | `600000` | Budget window |
| `ENGINE_MAX_ANALYSIS_PER_USER` | no | `1` | Concurrent analyses per user |

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

## Limitations

- Rate limiting is **in-memory and per-instance**. Correct for a single
  instance; behind more than one replica it would need Redis.
- There is no result cache beyond in-flight deduplication. Asking for the same
  analysis after it completes recomputes it — deterministically, so the answer
  is the same, but the CPU is spent again.
