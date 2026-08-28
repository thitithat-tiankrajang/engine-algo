# Parallel sample loop

Super's cost is the 160-sample schedule, and the schedule is not negotiable. So
the only honest way to shorten the wait is to run the same samples on more than
one core. This records what that buys, what it costs, and the one property the
implementation exists to protect.

## The property that gates everything

**A parallel Super must return the move a sequential Super would have returned,
bit for bit.** Not "an equally good move" — the same one. Playing strength at any
reduced budget is unmeasured (see
[`client-side-super-benchmark.md`](client-side-super-benchmark.md)), and a search
whose answer depends on how many cores the player's laptop has is a different bot
per device with no evidence behind either version.

The thing that would break it is not the search — it is the arithmetic.
`accum[i] += rowVal[i]` runs 160 times per candidate in `double`, and double
addition is not associative. Threads racing to that accumulator would sum in
whatever order they happened to finish, and on an open board where the top
candidates are near-tied, the winner would be decided by thread timing.

So samples are not allowed to touch the totals. Each writes its own `SampleRow`,
and after the join the rows are reduced **in sample order** — same values, same
sequence, therefore the same doubles. Everything else in the design follows from
keeping that reduction ordered.

The other shared state is handled the same way rather than locked:

| State | Sequential | Parallel |
|---|---|---|
| `board` | applied/undone in place | one copy per thread |
| `placeMemo`, `exPlaceScore` | one shared cache | one cache per thread |
| `stats.nodesVisited` | incremented in place | per-thread, summed after join |
| `g_genCalls` | plain `long long` | `std::atomic<long long>` |
| progress `report()` | once per sample | calling thread only (see below) |

The memos are pure-function caches — what they hold changes how often a value is
recomputed, never what the value is — so splitting them per thread is free of
correctness consequences and costs only cache hits.

## Verification

Every thread count was diffed against the **unpatched** engine's response on the
same request:

| Field | Result |
|---|---|
| chosen move, equity, solver | identical at T = 1, 2, 4, 6, 8 |
| every candidate's mean / stddev / leave / potential / oppReply | identical |
| `stats.nodes` | identical — 853,222,467 at every T |
| `stats.genCalls` | +1.4% (T=2) … +3.1% (T=8) — split memos, see below |
| `stats.elapsedMs` | differs, which is the point |

## Latency

Position: `bench_super.jsonl` #2 — midgame, 32 tiles placed, bag 52, 42
candidates. Full 160-sample schedule, `unlimited: true`. Reference device is the
same Apple M3 (4P + 4E) the rest of the Super measurements use, one CPU-bound
process at a time.

### Native (`-O2`)

| threads | wall | vs unpatched |
|---:|---:|---:|
| unpatched | 97.8 s | 1.00× |
| 1 | 100.3 s | 0.98× |
| 2 | 53.1 s | 1.84× |
| 4 | 32.2 s | **3.04×** |
| 6 | 25.8 s | 3.80× |
| 8 | 21.5 s | **4.55×** |

### WASM, in a real browser

Chromium, cross-origin isolated, the chunks Vite actually built, one module
instance per page load — instantiating several in one page leaves every earlier
pool's workers alive and turns the later runs into a measurement of contention.

| threads | module | wall | speedup |
|---:|---|---:|---:|
| 1 | `amath_engine.mjs` | 130.5 s | 1.00× |
| 4 | `amath_engine_mt.mjs` | 54.0 s | **2.42×** |
| 8 | `amath_engine_mt.mjs` | 27.9 s | **4.68×** |

Equity `2.26314` and 853,222,467 nodes at all three, which is the same move and
the same work the native engine reports for this position.

Scaled onto the published full-Super p50 of 225 s, four threads put the reference
device at roughly 93 s a move and eight at roughly 48 s — which moves this machine
out of the `SLOW` recommendation band and into `GOOD` (≤ 120 s) without touching a
single search parameter.

Node 26 was measured too (133.3 s / 52.5 s / 35.8 s, so 2.54× and 3.72×) and is
kept only as a note: it runs the same V8 and the same Wasm compiler but its
worker_threads are not Web Workers, and on the 4→8 step it disagrees with the
browser by enough to matter. The browser rows are the ones to quote.

**Scaling is sub-linear and the shape of that is not settled.** Natively, 8
threads returns 4.55× and the 4→8 step is worth only 1.46× — this machine has
four P-cores and four much slower E-cores. In the browser the same step is worth
1.94×. Both were measured on the same laptop and they do not agree; the browser
number may be the more relevant one, or the native 8-thread run may have been
thermally limited late in a long benchmarking session. Either way a phone with
two big and four little cores should be read as considerably less than eight, and
a phone that throttles through a minutes-long move gives back more.

## Cost

### Memory

Measured in Chromium, as the resident memory of the renderer process hosting the
page — Chromium runs a page's dedicated workers inside that renderer, so one
number covers the host worker, every pthread, and all of their WASM heaps.
Driven through the real `superEngine.ts` from `tools/super-bench/`.

Two false starts are worth recording, because both produce numbers that look
fine and mean nothing. `performance.measureUserAgentSpecificMemory()` is the
right API and is present in this browser as a function that throws
`SecurityError` on call, so a `typeof === "function"` feature check turns the
first measurement into an unhandled rejection. And `lsof` on the dev-server port
names Chromium's **network service**, not the renderer: sampling it gives a
perfectly flat line through a search that is pegging eight cores.

| phase | threads | peak MB | settled MB | peak CPU |
|---|---:|---:|---:|---:|
| baseline, no worker | — | 124 | 124 | 0% |
| after WASM init | 1 | 133 | 118 | 1% |
| during Full Super | 1 | 132 | 130 | **100%** |
| after cancel | 1 | 130 | 119 | 0% |
| after WASM init | 4 | 169 | 169 | 27% |
| during Full Super | 4 | 173 | 173 | **385%** |
| after cancel | 4 | 173 | 130 | 0% |
| after WASM init | 8 | 212 | 212 | 6% |
| during Full Super | 8 | 215 | 215 | **722%** |
| after cancel | 8 | 215 | 137 | 0% |
| 5 rapid start/cancel cycles | 8 | **471** | 194 | ~700% |
| one Full Super to completion after all of that | 8 | 271 | 255 | 746% |

**The engine costs about 12 MB per thread, and the browser agrees with Node.**
Above the ~119–124 MB the renderer holds before any engine exists: +9–14 MB at
one thread, +50 MB at four, +93 MB at eight. That is the number
`superThreads.ts` budgets against, and it is now measured where it will be paid
rather than inferred from a Node process.

The CPU column is the other half of the claim: 100% → 385% → 722% is the sample
loop actually occupying the cores it asked for, not merely being handed them.

**Rapid start/cancel is the one place memory spikes.** Five cycles in ten
seconds reached 471 MB before settling back to 194 MB. Nothing accumulates — the
line comes down — but a device tight on memory is most at risk when a player
changes their mind repeatedly, not while a search is running.

### Bundle

Bigger than the artifact sizes suggest, because Vite emits the threaded module
twice. Emscripten's pthread startup spawns its workers from the module's own URL,
and the bundler turns that into a second, separate worker chunk:

| built chunk | size | fetched by |
|---|---:|---|
| `amath_engine-*.js` | 334.6 KB | the host worker, single-threaded devices |
| `amath_engine_mt-*.js` | 437.2 KB | the host worker, threaded devices |
| `amath_engine_mt-*.js` (worker copy) | 437.2 KB | every pooled pthread |

So a threaded device downloads ~874 KB before Super's first move against ~335 KB
today. It is a lazily-imported chunk either way — nobody pays it who never plays
Super — and the second copy is fetched once and then served from cache to all
eight workers, but it is not the +113 KB the raw artifacts imply.

The single-threaded module also grew, 263,021 → 281,921 bytes (**+19 KB**), and
that one is paid by every device including the ones that will never thread: the
refactor links `<thread>` and `<atomic>` machinery that its own path never
enters. It could be compiled out, and has not been.

### Wasted work

Per-thread memos lose the hits a shared cache would have had: `genCalls` rises
1.4% at two threads to 3.1% at eight. `stats.nodes` is unchanged at every thread
count, so the extra work is entirely in `bestPlaceScore`, whose nodes that counter
does not include.

### Cancellation, and what it actually frees

Super is cancelled by `worker.terminate()`, which is the only thing that can stop
a search already inside the engine's synchronous call. Whether that reliably
takes the pthread pool with it was the open question. Measured in Chromium, on a
live Full Super at 1, 4 and 8 threads:

| | result |
|---|---|
| the promise settles | rejected as `cancelled` in **0 ms**, at every thread count |
| CPU after cancel | **0%**, from 100% / 385% / 722% |
| memory after cancel | back to 119 / 130 / 137 MB, against a 124 MB no-engine baseline |
| stale results | none — the request counter never advanced past 0 resolutions across three cancels |
| five rapid start/cancel cycles | no result delivered from any of them; memory peaked at 471 MB and settled to 194 MB |
| a Full Super started after all of that | completed, **160 samples**, 1,551,222,214 nodes, one resolution |

So `terminate()` does take the pool with it: an orphaned pthread would keep a
core busy and show up in the CPU column, and eight orphaned pools across the
cycle test would show up in the memory one. Neither does.

### Cross-origin isolation

A `-pthread` module needs `SharedArrayBuffer`, which needs the page to be
cross-origin isolated (`COOP: same-origin` + `COEP: require-corp`). Without it the
threaded module **cannot instantiate at all** — which is why `deploy-ui` ships
both artifacts and the client picks on `crossOriginIsolated` rather than assuming.

### What the timed tiers get

Nothing. The parallel path is gated on `req.unlimited`, so only Super takes it.
`max`, `hard` and `medium` stop at whichever sample the wall clock reached, and
that is a sequential idea — parallelising it would make the stopping point, and
therefore the move, a function of how busy the machine was. Bounding work is what
makes a budget reproducible; a clock-bounded search cannot be handed to threads
without giving that up.

## Progress

`report()` reaches the UI through an EM_JS hook installed on the host worker's
global scope. A pthread is its own Worker with its own global scope, where that
hook does not exist, so **only the calling thread may report** — a worker's report
would silently vanish.

The calling thread is therefore worker 0: it takes a share of the samples and
reports between its own, throttled to 250 ms, the same heartbeat the end-game
solver uses. When its queue empties it sits on the tail with a 50 ms poll until
the last sample lands, so the bar keeps moving instead of freezing at whichever
sample it handed out last.

`bestScore` in those reports is summed over whatever rows have landed, so it can
differ run to run. That is deliberate and it is a UI hint only: it is computed
into a scratch vector, never into `accum`, and the decision still comes from the
ordered reduction after the join.

## Threats to validity

- **One position, one device.** Every latency number above is
  `bench_super.jsonl` #2 on one M3. The sweep has not been run across the phase
  mix, and the opening — the widest and most expensive board a game contains —
  is not in it.
- **One browser, on a desktop.** Chromium on the reference laptop, mains power,
  nothing else in the tab. No thermal ceiling, no phone. Every per-thread cost
  here is a desktop cost.
- **A hidden tab throttles its timers, hard.** A scripted benchmark that paces
  itself with `setTimeout` stretches by 5x or more when the pane is not visible,
  which silently turns "cancel took 12 s to arrive" into a finding that is not
  real. The phases above were driven from outside the page for that reason, and
  every duration in this document comes from a clock that was not the page's.
- **Absolute times drifted late in the session.** Repeat runs of the same
  configuration varied by ~10% after the machine had been benchmarking for a
  while, almost certainly thermal. The ratios held; the absolute seconds should
  be read with that spread.
- **Pool overflow is unverified in a browser.** Asking for more threads than the
  pool holds returned the correct answer under Node rather than aborting. In a
  browser `pthread_create` would need the host worker's event loop, which is
  blocked inside `_engine_handle` for the whole search. The design avoids the
  case entirely — one number sizes the pool and fills the request's `threads` —
  and `PTHREAD_POOL_SIZE_STRICT=2` is a guard behind that, not a tested path.
- **Cancellation is untested against the pool.** Super is cancelled by
  `worker.terminate()`. Whether that reliably tears down the pooled workers, or
  leaks ~12 MB per cancelled move, has not been measured.
- **Nested workers on iOS.** Super already runs inside a Web Worker and pthreads
  spawn Workers from there. This has not been run on a real iOS device.
