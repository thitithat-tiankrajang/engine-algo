// ── Turning benchmark JSONL into the two tables the decision needs ───────────
//
//   node scripts/bench_report.mjs build/bench_*.jsonl
//
// Table 1 — LATENCY. Per run: p50, p95, max, and the same split by game phase.
// A single p50 over a whole game is close to meaningless on its own: an opening
// is the widest search a game contains and an endgame with an empty bag is
// solved exactly and instantly, so the aggregate is a weighted average of two
// completely different regimes. Both are reported.
//
// Table 2 — STRENGTH. Every reduced-budget run compared against the full Super
// schedule on the SAME positions: how often it plays the same move, and where
// it does not, how much equity separates the two.
//
// Latency without strength is half an answer, and it is the flattering half. A
// smaller budget always wins on time; the only question is what it costs.

import { readFileSync } from "node:fs";

function load(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
}

/**
 * Game phase, by how much of the board is occupied.
 *
 * The cut points are where the engine's own behaviour changes, not round
 * numbers: an early board has the widest root generation a game will ever see,
 * and once the bag empties the exact end-game solver takes over and the
 * sampling search stops running at all.
 */
function phase(row) {
  if (row.bagCount === 0) return "endgame (bag 0)";
  if (row.boardTiles <= 20) return "opening (≤20 tiles)";
  if (row.boardTiles <= 60) return "midgame (21–60)";
  return "late (61+, bag>0)";
}

const PHASES = ["opening (≤20 tiles)", "midgame (21–60)", "late (61+, bag>0)", "endgame (bag 0)"];

const runs = new Map();
for (const path of process.argv.slice(2)) {
  const rows = load(path).filter((row) => !row.error);
  if (rows.length === 0) continue;
  runs.set(`${rows[0].engine}/${rows[0].tier}`, rows);
}

const seconds = (ms) => (ms / 1000).toFixed(1);

console.log("## Latency\n");
console.log("| run | n | p50 | p95 | max | mean |");
console.log("|---|---:|---:|---:|---:|---:|");
for (const [name, rows] of runs) {
  const wall = rows.map((row) => row.wallMs);
  const mean = wall.reduce((total, value) => total + value, 0) / wall.length;
  console.log(
    `| \`${name}\` | ${rows.length} | ${seconds(percentile(wall, 0.5))}s | ` +
      `${seconds(percentile(wall, 0.95))}s | ${seconds(Math.max(...wall))}s | ${seconds(mean)}s |`,
  );
}

console.log("\n## Latency by phase (p50 / max)\n");
console.log(`| run | ${PHASES.join(" | ")} |`);
console.log(`|---|${PHASES.map(() => "---:").join("|")}|`);
for (const [name, rows] of runs) {
  const cells = PHASES.map((label) => {
    const wall = rows.filter((row) => phase(row) === label).map((row) => row.wallMs);
    if (wall.length === 0) return "—";
    return `${seconds(percentile(wall, 0.5))} / ${seconds(Math.max(...wall))}`;
  });
  console.log(`| \`${name}\` | ${cells.join(" | ")} |`);
}

// ── strength ────────────────────────────────────────────────────────────────

const reference = [...runs.entries()].find(([name]) => name.endsWith("/super"));
if (reference) {
  const [referenceName, referenceRows] = reference;
  const byPosition = new Map(referenceRows.map((row) => [`${row.game}:${row.turn}`, row]));

  console.log(`\n## Strength, against \`${referenceName}\` on the same positions\n`);
  console.log("| run | compared | same move | differs | median |Δequity| | max |Δequity| |");
  console.log("|---|---:|---:|---:|---:|---:|");
  for (const [name, rows] of runs) {
    if (name === referenceName) continue;
    let compared = 0;
    let agreed = 0;
    const losses = [];
    for (const row of rows) {
      const full = byPosition.get(`${row.game}:${row.turn}`);
      if (!full || row.move === undefined || full.move === undefined) continue;
      compared += 1;
      if (row.move === full.move) {
        agreed += 1;
        continue;
      }
      // Equity is the engine's own risk-adjusted value for the move it chose,
      // and the two runs computed it with different amounts of search. A
      // shallower search is systematically optimistic about its own choice, so
      // a SIGNED difference would often come out negative and read as the
      // capped search being better — which it is no evidence of. The magnitude
      // separates "picked a different move worth about the same" from "the two
      // decisions were far apart", and claims nothing about which was right.
      if (typeof row.equity === "number" && typeof full.equity === "number") {
        losses.push(Math.abs(full.equity - row.equity));
      }
    }
    if (compared === 0) continue;
    losses.sort((a, b) => a - b);
    const mean = losses.length ? losses[Math.floor(losses.length / 2)].toFixed(2) : "—";
    const worst = losses.length ? Math.max(...losses).toFixed(2) : "—";
    console.log(
      `| \`${name}\` | ${compared} | ${agreed} (${Math.round((100 * agreed) / compared)}%) | ` +
        `${compared - agreed} | ${mean} | ${worst} |`,
    );
  }
}

// ── WASM overhead, where the same tier was run both ways ────────────────────

const pairs = [];
for (const [name, rows] of runs) {
  if (!name.startsWith("wasm/")) continue;
  const nativeName = name.replace("wasm/", "native/");
  const nativeRows = runs.get(nativeName);
  if (!nativeRows) continue;
  const nativeBy = new Map(nativeRows.map((row) => [`${row.game}:${row.turn}`, row]));
  const ratios = [];
  for (const row of rows) {
    const twin = nativeBy.get(`${row.game}:${row.turn}`);
    // Sub-100ms positions are dominated by process startup and JSON, not by the
    // search. Including them would report the harness, not the engine.
    if (!twin || twin.engineMs < 100) continue;
    ratios.push(row.engineMs / twin.engineMs);
  }
  if (ratios.length) {
    pairs.push([
      name,
      ratios.length,
      (ratios.reduce((total, value) => total + value, 0) / ratios.length).toFixed(2),
      percentile(ratios, 0.95).toFixed(2),
    ]);
  }
}
if (pairs.length) {
  console.log("\n## WASM overhead (engine clock, same positions, same tier)\n");
  console.log("| tier | positions | mean ×native | p95 ×native |");
  console.log("|---|---:|---:|---:|");
  for (const [name, n, mean, p95] of pairs) {
    console.log(`| \`${name}\` | ${n} | ${mean}× | ${p95}× |`);
  }
}

// ── memory across a game ────────────────────────────────────────────────────

for (const [name, rows] of runs) {
  const rss = rows.map((row) => row.rssBytes).filter((value) => typeof value === "number");
  if (rss.length < 2) continue;
  const mb = (bytes) => (bytes / (1024 * 1024)).toFixed(1);
  console.log(
    `\nMemory (RSS), \`${name}\`: first ${mb(rss[0])} MB → last ${mb(rss[rss.length - 1])} MB, ` +
      `peak ${mb(Math.max(...rss))} MB across ${rss.length} consecutive moves on ONE module ` +
      `instance. The module is instantiated once and reused, exactly as the browser worker ` +
      `reuses it for a whole game, so this is the shape a leak would show up in.`,
  );
}
