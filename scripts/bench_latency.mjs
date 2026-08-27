// ── Super-tier latency, native vs WASM, on the SAME positions ────────────────
//
// The question this answers is the only one that decides whether the Super bot
// can run on a player's device: how long does one Super move take there? Not
// how many cores the device has, not what the CPU is called — how many seconds
// the player waits.
//
// Usage:
//   node scripts/bench_latency.mjs --engine native --corpus build/bench_subset.jsonl
//   node scripts/bench_latency.mjs --engine wasm   --corpus build/bench_subset.jsonl
//
// Both engines get byte-identical requests, so the ratio between them is the
// WASM overhead and nothing else. Results are written as JSONL (one line per
// position) so a partial run is still data: a Super search can legitimately run
// for minutes and a benchmark that only reports at the end reports nothing when
// it is interrupted.
//
// `--tier` selects the bounding, using the same three fields the service sends
// (service/src/levels.ts):
//   super      unlimited, no wall clock              — the tier under test
//   max        engine ceilings (120s/300s)           — today's strongest timed tier
//   sample:N   sampleCap N, no wall clock            — a reproducible reduced budget
//
// A sampleCap run is the honest way to price a smaller budget: it bounds the
// WORK, so the same position takes the same search on a fast and a slow device
// and only the wall clock differs.

import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const engineKind = arg("engine", "native");
const corpusPath = arg("corpus", "build/bench_subset.jsonl");
const tier = arg("tier", "super");
const outPath = arg("out", `build/bench_${engineKind}_${tier.replace(":", "")}.jsonl`);
const binary = arg("binary", "build/amath_cli");
const wasmPath = arg("wasm", "../build/amath_engine.mjs");
const limit = Number(arg("limit", "0"));
/**
 * Shift every position's RNG seed by a constant.
 *
 * The control for the strength table. "The capped search picked a different
 * move" only means something against how often the search picks a different
 * move ANYWAY — an open board offers dozens of near-equal candidates, and two
 * runs of the same budget at different seeds will disagree on plenty of them.
 * Re-running one budget with the seed shifted measures exactly that floor.
 */
const seedOffset = Number(arg("seed-offset", "0"));

/** Turn a bare position into a request at the tier under test. */
function withTier(request) {
  const out = { ...request, solver: "sim", topN: 24 };
  if (seedOffset) out.seed = ((request.seed + seedOffset) % 2147483647 || 1) >>> 0;
  if (tier === "super") out.unlimited = true;
  else if (tier === "max") {
    /* engine's own ceilings: send nothing */
  } else if (tier.startsWith("sample:")) {
    out.unlimited = true;
    out.sampleCap = Number(tier.slice("sample:".length));
  } else throw new Error(`unknown tier ${tier}`);
  return out;
}

// ── native: one process per request, exactly as the service runs it ──────────
function runNative(request) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["worker"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.resume();
    child.on("error", reject);
    child.on("close", () => {
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        reject(new Error("native engine produced no response"));
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

// ── wasm: one module instance, reused across requests ────────────────────────
//
// Reused deliberately. The browser will reuse it too — the worker instantiates
// once and answers every turn of the game from that instance — so a benchmark
// that paid instantiation per request would measure a cost production does not
// pay, and would hide the one that matters: whether memory grows across a game.
let wasm;
async function getWasm() {
  if (!wasm) {
    globalThis.__amathProgress = () => {};
    const createModule = (await import(wasmPath)).default;
    const started = performance.now();
    wasm = await createModule();
    wasm.__initMs = performance.now() - started;
  }
  return wasm;
}

async function runWasm(request) {
  const mod = await getWasm();
  const text = JSON.stringify(request);
  const bytes = mod.lengthBytesUTF8(text) + 1;
  const inPtr = mod._engine_alloc(bytes);
  mod.stringToUTF8(text, inPtr, bytes);
  const outPtr = mod._engine_handle(inPtr);
  const responseText = mod.UTF8ToString(outPtr);
  mod._engine_free(inPtr);
  mod._engine_free(outPtr);
  return JSON.parse(responseText);
}

/** A move as a comparable string. Placements are sorted so two runs that
 *  enumerate the same move in a different order still compare equal. */
function moveKey(response) {
  if (response.type === "pass") return "pass";
  if (response.type === "exchange") return `exchange:${[...response.exchange].sort().join(",")}`;
  const cells = response.placements
    .map((cell) => `${cell.r},${cell.c},${cell.kind},${cell.token}`)
    .sort();
  return `place:${cells.join("|")}`;
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
}

const corpus = readFileSync(corpusPath, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const positions = limit > 0 ? corpus.slice(0, limit) : corpus;

writeFileSync(outPath, "");
const latencies = [];

for (const [index, row] of positions.entries()) {
  const request = withTier(row.request);
  const started = performance.now();
  let response;
  let failure;
  try {
    response = engineKind === "wasm" ? await runWasm(request) : await runNative(request);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  const wallMs = performance.now() - started;
  if (!failure) latencies.push(wallMs);
  const record = {
    engine: engineKind,
    tier,
    game: row.game,
    turn: row.turn,
    boardTiles: row.boardTiles,
    bagCount: row.bagCount,
    unplayed: row.unplayed,
    wallMs: Math.round(wallMs),
    ...(failure
      ? { error: failure }
      : {
          engineMs: Math.round(response.stats?.elapsedMs ?? 0),
          nodes: response.stats?.nodes ?? 0,
          samples: response.stats?.samples ?? 0,
          candidates: response.stats?.candidates ?? 0,
          moves: response.stats?.moves ?? 0,
          solver: response.solver,
          endgameSolved: Boolean(response.endgameSolved),
          moveType: response.type,
          equity: response.equity,
          // The move itself, canonicalised, so two runs at different sample
          // budgets can be compared for AGREEMENT and not just for speed.
          //
          // Latency without strength is half an answer. A smaller budget always
          // wins on time; the only question that matters is what it costs in
          // play, and the cheapest honest measure of that is whether the
          // reduced search still picks the move the full one did — and when it
          // does not, how much equity separates the two.
          move: moveKey(response),
        }),
    // Watched across a whole GAME rather than per position: the failure worth
    // catching is growth that never comes back, not one large search.
    //
    // Three numbers because no single one is the answer. `rss` is what the OS
    // thinks the process holds and is the one a user would notice; `external`
    // and `arrayBuffers` are Node's own accounting, and WASM linear memory does
    // not reliably appear in either. A leak shows up in `rss` whether or not
    // Node has a name for it.
    ...(engineKind === "wasm"
      ? {
          rssBytes: process.memoryUsage().rss,
          externalBytes: process.memoryUsage().external,
          arrayBufferBytes: process.memoryUsage().arrayBuffers,
        }
      : {}),
  };
  appendFileSync(outPath, `${JSON.stringify(record)}\n`);
  process.stderr.write(
    `[${index + 1}/${positions.length}] board=${String(row.boardTiles).padStart(3)} ` +
      `bag=${String(row.bagCount).padStart(2)} ${(wallMs / 1000).toFixed(1)}s` +
      `${failure ? ` FAILED ${failure}` : ` ${record.solver}`}\n`,
  );
}

process.stderr.write(
  `\n${engineKind}/${tier}: n=${latencies.length} ` +
    `p50=${(percentile(latencies, 0.5) / 1000).toFixed(1)}s ` +
    `p95=${(percentile(latencies, 0.95) / 1000).toFixed(1)}s ` +
    `max=${(Math.max(...latencies) / 1000).toFixed(1)}s` +
    `${engineKind === "wasm" ? ` init=${wasm.__initMs.toFixed(0)}ms` : ""}\n`,
);
