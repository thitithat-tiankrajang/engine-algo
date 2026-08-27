# Client-side Super — benchmark

What a Super move actually costs, measured rather than reasoned about, and what
that measurement decided.

**One device.** Everything below was measured on a single machine. That is
enough to settle the architectural question (does the CPU cost move off the
server, and what budget fits a latency target) and **not** enough to set a
minimum supported device. The mechanism for collecting the Champion-device
numbers ships with the client (`src/bot/superTelemetry.ts`); the numbers
themselves do not exist yet and are not invented here.

## Reference device

| | |
|---|---|
| Machine | Apple M3, 8 cores (4P + 4E), 16 GB |
| OS | macOS 14.6.1 (23G93) |
| Native toolchain | Apple clang, `-std=c++20 -O2` |
| WASM toolchain | Emscripten 6.0.5-git, `-std=c++20 -O3 -DNDEBUG` |
| WASM host | Node 26.6.0, and Chrome via the production worker |

Most latency rows below were taken under **Node**. Node and a browser run the
same V8 and the same Wasm compiler, so the arithmetic is the same; what Node
does not reproduce is a browser's tab throttling, its memory pressure, and a
phone's thermal behaviour. Every one of those makes a real device **slower**
than this, never faster, so the numbers here are a floor.

The browser half has since been measured directly, through the real worker, on
the same machine (`EQ-Lab/tools/super-bench/`):

| | Node | Chrome (production worker) |
|---|---|---|
| `gen-nodes-v1` throughput | 8,669,750 nodes/s | 8,654,260 – 8,936,550 nodes/s (4 runs, median ~8.75M) |
| WASM instantiation | 3–8 ms | **71 ms** (worker clock); 914 ms including the dev-server chunk fetch |

The two hosts agree on throughput to within measurement noise, which is what
licenses reading the Node latency rows as browser latencies.

### A correction to the served reference

The served `CALIBRATION_REFERENCE.nodesPerSec` was **5,730,000** and is now
**8,700,000**. The old figure was ~35% low against five fresh runs on the very
machine it names.

It is worth being precise about which way that error cut, because it is the
denominator of every device estimate — a device is judged by
`reference.nodesPerSec / its own`. Understating the reference makes **every**
device look faster than it is: a machine identical to this one was told to
expect ~147 s a move when it will in fact wait ~225 s. The warning that exists
to prepare a player for a long wait was the thing under-promising it.

Both halves of the reference now come from the same machine, which is the
condition under which the ratio means anything at all.

## Corpus

Positions are engine requests dumped from self-played games
(`amath_cli positions`), so they are positions a real game passes through rather
than positions chosen to be fast or slow.

```bash
make cli
./build/amath_cli positions 6 20260827 build/positions.jsonl   # 131 positions
```

Two measurement corpora are cut from it:

- **`bench_game.jsonl`** — every turn of one side across two complete games, 23
  positions. Used for the capped-budget runs. It is a *whole game*, so its
  phase mix is the mix a player experiences: a handful of wide early boards,
  then progressively narrower ones, then nine bag-empty endgames.
- **`bench_super.jsonl`** — 13 of those. The full Super schedule costs minutes a
  move, so the expensive baseline runs on a subset spanning the same phases.

Both are reproducible from the seed above.

## Method

```bash
node scripts/bench_latency.mjs --engine wasm   --tier sample:8 --corpus build/bench_game.jsonl
node scripts/bench_latency.mjs --engine native --tier super    --corpus build/bench_super.jsonl
node scripts/bench_report.mjs build/bench_*.jsonl
```

Both engines receive **byte-identical requests**, so the difference between them
is the WASM boundary and nothing else. Runs are **strictly sequential** — one
CPU-bound process at a time.

That rule was learned rather than assumed, and the discarded evidence is worth
recording. An early pass ran two benchmark processes at once by accident. It
inflated ordinary positions by roughly 30% and produced one 313-second outlier
on a position that measures 33 s when run alone — a 9× artifact that would have
been reported as a pathological search tail and would have changed the
recommendation. Every number in this document comes from a run with nothing else
CPU-bound on the machine; the contaminated pass was thrown away, not corrected.

`--tier` selects how the search is bounded, with the same three fields the
service sends:

| tier | request | meaning |
|---|---|---|
| `super` | `unlimited: true` | the full schedule: 160 opponent-rack samples, no clock |
| `sample:N` | `unlimited: true, sampleCap: N` | N samples, no clock |
| `max` | *(nothing)* | the engine's own 120s/300s ceilings |

Every budget bounds **work**, not time. That is what makes a reduced budget
honest: the same position runs the same search on a fast device and a slow one,
so the move is reproducible and only the wall clock differs. A wall-clock budget
would stop the sampler at whichever sample the machine happened to reach and
make the bot's *choice* depend on how busy the laptop was.

## Latency is not one number

An A-Math game passes through two completely different regimes, and an aggregate
p50 is a weighted average of them:

- **Bag empty.** The exact end-game solver takes the position and answers in
  **under 50 ms**, at every budget. Nine of the 23 positions in a whole game are
  like this. They are not "fast Super moves" — the sampling search does not run
  at all.
- **Bag non-empty.** The sampling search runs, and its cost scales with the
  sample count and with how wide the board is. This is where every second goes.

So every table below is also reported by phase. A single number that mixes them
flatters the result, and the tail is what a player actually complains about.

## Results

### Latency, by search budget

| Budget | n | p50 | p95 | max | mean | Meets 15 s / 30 s |
|---|---:|---:|---:|---:|---:|:---|
| 4 samples | 23 | **3.5 s** | **8.2 s** | 9.0 s | 3.2 s | yes |
| **8 samples** | 23 | **7.7 s** | **14.3 s** | 17.2 s | 6.7 s | **yes** |
| 16 samples | 23 | 15.7 s | 33.1 s | 37.7 s | 15.5 s | no — both |
| 160 (full Super) | 13 | 225.5 s | 334.2 s | 358.4 s | 200.2 s | no, by ~20× |

WASM engine, reference device. The capped rows are every turn of one side across
two complete games; the full schedule is 13 of those.

### The same numbers, by phase (p50 / max)

| Budget | Opening (≤20 tiles) | Midgame (21–60) | Late (61+, bag>0) | Endgame (bag 0) |
|---|---:|---:|---:|---:|
| 4 samples | 6.3 / 9.0 | 5.4 / 8.2 | 3.2 / 4.8 | 0.0 / 0.0 |
| 8 samples | 13.1 / 17.2 | 10.7 / 16.6 | 6.2 / 11.7 | 0.0 / 0.0 |
| 16 samples | 31.7 / 37.1 | 19.0 / 37.7 | 18.5 / 27.9 | 0.0 / 0.0 |
| 160 (full) | 306.3 / 334.2 | 275.9 / 358.4 | 171.6 / 175.3 | 0.0 / 0.0 |

Two things this splits out that the aggregate hides:

- the **opening is the whole cost** — the widest root generation a game contains,
  and where the 8-sample budget spends 13 s against 6 s late;
- the **endgame is free at every budget**. Once the bag empties the exact solver
  takes the position and answers in under 50 ms. Nine of the 23 positions in a
  whole game are like that, which is why the aggregate p50 sits well below the
  opening number and must not be quoted alone.

### The finding

**No device can run the full Super schedule inside the original 15 s / 30 s
latency targets.** Not the reference machine, not one twenty times faster. 160
opponent-rack samples is ~3.75 minutes of work per move.

An earlier reading of that finding concluded that the adaptive budget was
therefore "the only way Super runs on a device at all", and shipped **8 samples**
— 5% of the schedule — as the default on reference-class hardware.

That conclusion is withdrawn, and the targets are what turned out to be wrong.
Super is the strongest bot on offer and searching exhaustively is what makes it
that; a schedule cut to fit a stopwatch is a different, weaker bot wearing the
name, and the table above measures its *latency* while saying nothing about its
*strength*. A player who does not want to wait already has `max`, `hard` and
`medium` to choose from — a choice they make, rather than one their laptop makes
for them.

So the finding now reads: **full Super costs minutes a move, and that is the
product.** The targets do not apply to Super. The rows for 4, 8 and 16 samples
are retained as the latency half of a strength experiment nobody has run, behind
`SUPER_ADAPTIVE_BUDGET`, which is off.

### Backend cost, before and after

| | Per Super move |
|---|---|
| **Before** — backend runs the search | **180 CPU-seconds** (mean of 5; p50 197 s, range 106–213 s) |
| **After** — backend checks legality | **2.5 ms** (p50 over 12 runs, including process spawn) |

That is a factor of roughly **72,000** in backend AI CPU per move.

At `ENGINE_CONCURRENCY=1`, 180 CPU-seconds a move is **20 Super moves an hour**.
A game needs about a dozen. That is **one to two concurrent Super games per CPU**
— and each of those players is waiting three minutes a move regardless.

### WASM overhead

| Tier | Positions | Mean ×native | p95 ×native |
|---|---:|---:|---:|
| Full schedule | 5 | **1.54×** | 1.57× |
| Calibration benchmark (fixed 2M nodes) | 3 | 1.42× | — |

Native and WASM chose the **same move on 5 of 5** positions at the full schedule,
and the same move at a fixed `sampleCap` in the parity harness. Same engine, two
compilers.

### Strength, and what the controls actually show

The obvious test is whether a reduced budget still plays the move the full
schedule played. Run alone it looks damning; run with a control it turns out to
be measuring something else; run with **both** controls it says something real.

| Comparison | Positions | Same move | |
|---|---:|---:|---|
| 4 samples vs 160 | 11 | 2 (18%) | |
| **8 samples vs 160** | 11 | **4 (36%)** | the budget's apparent cost |
| 16 samples vs 160 | 11 | 5 (45%) | |
| **8 samples vs 8, new seed** | 11 | **2 (18%)** | how stable that budget's own decision is |
| **160 vs 160, new seed** | 3 | **2 (67%)** | how stable the full schedule's decision is |
| native vs WASM, same seed | 5 | 5 (100%) | parity — same engine, two compilers |

Bag-empty endgames are excluded from every row: the exact solver answers those
deterministically and seed-independently, so counting them pads each rate with
guaranteed agreements.

**Read the first block alone and you would conclude the 8-sample bot throws away
two moves in three.** That is wrong: it agrees with the full schedule (36%) more
often than it agrees with *itself* at a different seed (18%). Most of the
disagreement is not the budget losing to the full schedule, it is the same
search landing somewhere else.

**Read both controls and the real finding appears: stability rises sharply with
the budget.** At 8 samples the decision is essentially seed-determined — the
only two positions that reproduced were the two narrowest boards in the set (81
and 82 tiles placed, where few candidates remain). At 160 samples the two open
boards tested both reproduced. The reduced budget is not "as good but noisier
about ties"; it has not sampled enough opponent racks for its ranking to settle
at all.

Three things follow, and the third is the one that gates the beta:

1. **Move agreement is not usable as a strength metric here**, in either
   direction. Quoting the 36% is misleading and so is quoting the 100%
   native/WASM parity as though it said anything about budgets.
2. **A reduced budget demonstrably produces a less converged decision.** That is
   a measured property, not an inference.
3. **Whether that costs points is unmeasured.** An unconverged choice among
   genuinely near-equal candidates costs nothing; an unconverged choice that
   sometimes ranks a materially worse move first costs real games, and nothing
   here distinguishes them. Settling it needs a head-to-head gauntlet
   (`amath_cli selfplay`), which at these per-move costs is a multi-day run.

**Caveat on the control that matters most:** the full-schedule stability figure
is **3 positions**. 2/3 against 2/11 is directionally clear and statistically
almost nothing. Widening it is the cheapest high-value measurement left, at
roughly 20 minutes per additional position.

### Memory across a game

Measured across 13 consecutive searches on ONE module instance — the browser worker
reuses it for a whole game exactly this way.

| Moves | Resident |
|---|---|
| 11 sampling searches (bag > 0) | 57–74 MB, flat |
| the 2 bag-empty endgames | **129 MB** |

The step is not a leak and it is not gradual: it is the exact end-game solver's
transposition table, a 4M-slot direct-mapped array the engine sizes at ~64 MB
(`initTT(22)` in `engine.cpp`). It appears the first time the bag empties and
stays. Nothing accumulates across the sampling moves — resident memory over the
first eleven searches drifts within a 17 MB band and ends lower than it started.

Two consequences worth carrying into the beta:

- **Peak device memory is ~130 MB, not ~60 MB**, and the peak arrives in the
  end-game — the phase a player is most likely to be on a phone for by then.
  A device that cannot spare it will fail inside the worker, `onerror` fires, and
  the turn falls back to the backend engine; it will not corrupt a game. But it
  will show up as "Super stopped working near the end", so it is worth watching
  for specifically.
- The table size is a compiled constant, not served configuration. Lowering it
  for low-memory devices would need an engine change and would weaken the exact
  proof, so it is deliberately not something calibration can tune today.

Recorded only on the seed-control pass — the harness gained the counter after the
earlier passes had run, and they were not re-run for it.

### Minimum device, as a measurement

**There is no minimum device, and that is deliberate.** No measurement here
disqualifies a machine from running Super, because a slow machine is answered
with a longer wait rather than a smaller search or a refusal.

What the numbers support is a *recommendation*, which is a different thing:

| Throughput on `gen-nodes-v1` | Estimated full-Super p50 | Tier | What the player is told |
|---|---|---|---|
| ≥ 29,000,000 nodes/s | ≤ 30 s | `EXCELLENT` | nothing |
| ≥ 7,300,000 nodes/s | ≤ 120 s | `GOOD` | nothing below 60 s; the wait above it |
| ≥ 1,460,000 nodes/s | ≤ 600 s | `SLOW` | "Super thinks at full strength on every device — on this one it may take about N minutes a move" |
| below that | > 10 min | `NOT_RECOMMENDED` | the same line, with a larger N |

The reference M3 measures ~8.75M nodes/s and lands in **`SLOW`** at ~225 s a
move. That reads badly and is simply true: full Super is minutes of single-core
work, and `EXCELLENT` needs roughly 3.3× this machine.

`NOT_RECOMMENDED` is a description of a wait, not a refusal — the device still
runs the identical 160-sample schedule. Every row here is derived from **one**
device and should be the first thing the beta corrects.


## Threats to validity

- **One device, one architecture.** Apple silicon has unusually good
  single-thread performance and memory bandwidth. A mid-range x86 laptop and a
  phone will be slower by factors this benchmark cannot predict — which is the
  entire reason the client measures itself instead of being told what it is.
- **Node, not a browser.** No tab throttling, no background-tab timer clamping,
  no thermal ceiling, no other tabs. All of those are one-directional: real is
  slower.
- **Self-played corpus.** The positions come from engine-vs-engine games at the
  cheap static tier. A human's board may be more or less open than the engine's,
  and openness is the main driver of generation cost.
- **Move agreement is not strength, and here it is not even a proxy.** The
  control run settles this: two runs at the *same* budget with different seeds
  agree on fewer positions than the capped budget agrees with the full schedule.
  On an open board the top candidates are near-tied and which one wins depends on
  which opponent racks were sampled — at any budget. So the agreement rate
  measures the search's seed variance, not the budget's cost, and a report that
  quoted it without the control would have said the capped bot throws away two
  moves in three. **Playing strength is unmeasured.** Settling it needs a
  head-to-head gauntlet (`amath_cli selfplay`), which at these per-move costs is a
  multi-day run.
- **Small n on the expensive rows.** The full schedule was run on 13 positions
  and its seed control on 3. The capped rows are 23 each. A p95 over 13 points is
  the second-largest value, and should be read as one.
- **The linear calibration model.** The client scales the reference's per-budget
  latencies by a throughput ratio. That assumes Super latency tracks
  move-generation throughput, which is true to the extent the search is
  generation-bound. It is a first-order estimate for *choosing a budget*, never
  a promise about a particular move — which is why the client also records what
  it actually waited.
