// Emit the measured calibration reference for `service/src/superConfig.ts`.
//
//   node scripts/bench_reference.mjs build/bench_wasm_*.jsonl
//
// The served reference has to BE the measurement. Retyping numbers out of a
// report into a config is how a threshold ends up describing a run nobody can
// find, so this prints the literal to paste — and prints the corpus and the
// spread alongside it so the paste is checkable.
//
// Only WASM runs are read. The reference exists to predict what a BROWSER will
// wait; a native number would predict a wait no player experiences.
//
// ── What is the reference, and what is only evidence ────────────────────────
//
// The FULL Super run is the reference. It is the schedule every device runs, so
// it is the only latency the client needs in order to predict its own wait, and
// it is printed first as the `fullSuper` block.
//
// The capped runs are printed too, into `EXPERIMENTAL_BUDGETS`, and they are
// not a reference at all — they are the latency half of a strength experiment
// nobody has run. They must never become the thing a device is tiered against:
// a client that picks a schedule to fit a latency is a client whose bot gets
// weaker on slower hardware, which is the arrangement this file's output
// replaced. See the header of `service/src/superConfig.ts`.

import { readFileSync } from "node:fs";

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
}

const runs = [];
for (const path of process.argv.slice(2)) {
  const rows = readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((row) => !row.error);
  if (rows.length === 0 || rows[0].engine !== "wasm") continue;
  const tier = rows[0].tier;
  const sampleCap = tier === "super" ? null : Number(tier.slice("sample:".length));
  const wall = rows.map((row) => row.wallMs);
  runs.push({
    sampleCap,
    p50Ms: Math.round(percentile(wall, 0.5)),
    p95Ms: Math.round(percentile(wall, 0.95)),
    n: rows.length,
    maxMs: Math.round(Math.max(...wall)),
  });
}
runs.sort((a, b) => (a.sampleCap ?? Infinity) - (b.sampleCap ?? Infinity));

const full = runs.find((run) => run.sampleCap === null);
if (!full) {
  // Refused rather than defaulted. A reference assembled out of capped runs
  // would predict a wait for a schedule no device is ever given, and every
  // device tiered against it would be tiered against nothing.
  console.error(
    "No full-schedule (`--tier super`) WASM run found.\n" +
      "The full schedule is the reference — it is what every device actually runs.\n" +
      "Run: node scripts/bench_latency.mjs --engine wasm --tier super --corpus <corpus>",
  );
  process.exit(1);
}

console.log("// ── paste into CALIBRATION_REFERENCE ─────────────────────────");
console.log(
  `  // Measured over ${full.n} positions, max ${(full.maxMs / 1000).toFixed(1)}s.`,
);
console.log(
  `  fullSuper: { p50Ms: ${full.p50Ms}, p95Ms: ${full.p95Ms}, positions: ${full.n} },`,
);

const capped = runs.filter((run) => run.sampleCap !== null);
if (capped.length > 0) {
  console.log("");
  console.log("// ── paste into EXPERIMENTAL_BUDGETS ──────────────────────────");
  console.log("// NOT a reference. Latency for a strength experiment nobody has run,");
  console.log("// and inert unless SUPER_ADAPTIVE_BUDGET is deliberately switched on.");
  console.log("export const EXPERIMENTAL_BUDGETS: BudgetMeasurement[] = [");
  for (const run of [...capped, full]) {
    const cap = run.sampleCap === null ? "null" : String(run.sampleCap);
    console.log(`  // n=${run.n}, max ${(run.maxMs / 1000).toFixed(1)}s`);
    console.log(`  { sampleCap: ${cap}, p50Ms: ${run.p50Ms}, p95Ms: ${run.p95Ms} },`);
  }
  console.log("];");
}
