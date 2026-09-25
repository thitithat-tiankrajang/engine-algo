// Bundled from the Stage 5B implementation in amath-bot-lab. The service runs
// this in a child process so a long analysis can be cancelled or timed out.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createManifest } from "../../../amath-bot-lab/src/core/tiles";
import { decisionRandom } from "../../../amath-bot-lab/src/bots/rng";
import { enumerateActions, envStateFrom } from "../../../amath-bot-lab/src/env";
import { decide, DEFAULT_BOT_CONFIG } from "../../../amath-bot-lab/src/integrated";
import { loadValueModel, ValueHead } from "../../../amath-bot-lab/src/nn";

type Cell = { r: number; c: number; kind: string; token: string; by?: "A" | "B"; placedTurn?: number };
type Request = {
  board: Cell[];
  rack: string[];
  bagCount: number;
  oppRackCount: number;
  myScore: number;
  oppScore: number;
  noScoreStreak: number;
  exchangeAllowed: boolean;
  seed: number;
  topN?: number;
  turnNumber?: number;
};

const modelDir = fileURLToPath(new URL(".", import.meta.url));
const meta = JSON.parse(readFileSync(resolve(modelDir, "model.json"), "utf8"));
const weights = readFileSync(resolve(modelDir, "weights.bin"));
const bytes = weights.buffer.slice(weights.byteOffset, weights.byteOffset + weights.byteLength);
const value = new ValueHead(loadValueModel(meta, bytes as ArrayBuffer));

function run(request: Request) {
  const manifest = createManifest();
  const available = new Map<string, string[]>();
  for (const tile of manifest.tiles) {
    const copies = available.get(tile.kind) ?? [];
    copies.push(tile.id);
    available.set(tile.kind, copies);
  }
  const take = (kind: string) => {
    const id = available.get(kind)?.shift();
    if (!id) throw new Error(`tile inventory exceeded: ${kind}`);
    return id;
  };
  const board = Array.from({ length: 225 }, () => null) as Array<{
    tileId: string; kind: string; face: string; side: "A" | "B"; turn: number
  } | null>;
  for (const cell of request.board) {
    const index = cell.r * 15 + cell.c;
    if (index < 0 || index >= 225 || board[index]) throw new Error("invalid board cell");
    board[index] = {
      tileId: take(cell.kind), kind: cell.kind,
      face: cell.token === "x" ? "×" : cell.token === "/" ? "÷" : cell.token,
      side: cell.by ?? "A", turn: cell.placedTurn ?? 1,
    };
  }
  const rack = request.rack.map(take);
  const unseen = manifest.tiles
    .map((tile) => tile.id)
    .filter((id) => available.get(manifest.kindOf.get(id)!)?.includes(id));
  if (unseen.length !== request.bagCount + request.oppRackCount) {
    throw new Error("unseen tile count does not match position");
  }
  const opponentRack = unseen.slice(0, request.oppRackCount);
  const bag = unseen.slice(request.oppRackCount);
  const noScoreTail = Array.from({ length: Math.min(6, request.noScoreStreak) }, (_, i) =>
    i % 2 === request.noScoreStreak % 2 ? "A" as const : "B" as const,
  );
  const state = envStateFrom({
    manifest, board: board as Parameters<typeof envStateFrom>[0]["board"],
    racks: { A: rack, B: opponentRack }, bag,
    scores: { A: request.myScore, B: request.oppScore }, activeSide: "A",
    turnNumber: request.turnNumber ?? 1, noScoreTail,
    hasPlacement: request.board.length > 0, seed: request.seed,
  });
  const enumerated = enumerateActions(state);
  const actionSet = request.exchangeAllowed
    ? enumerated
    : { ...enumerated, exchange: [] };
  if (actionSet.truncated) throw new Error("Stage 5B move generation was incomplete");
  const context = {
    state, legal: [...actionSet.place, ...actionSet.exchange, ...(actionSet.pass ? [actionSet.pass] : [])],
    actionSet, side: "A" as const, ply: 0, turnNumber: state.turnNumber,
    random: decisionRandom(request.seed, "A", 0), history: [],
  };
  const config = {
    ...DEFAULT_BOT_CONFIG,
    budget: { ...DEFAULT_BOT_CONFIG.budget, deepTop: 64, keepCandidates: Math.max(24, request.topN ?? 24) },
  };
  const decision = decide(context, { value, config });
  const toMove = (candidate: (typeof decision.candidates)[number]) => ({
    type: candidate.family,
    placements: candidate.action.type === "place"
      ? candidate.action.placements.map((p) => ({ r: Math.floor(p.cell / 15), c: p.cell % 15, kind: p.kind, token: p.face }))
      : [],
    exchange: candidate.action.type === "exchange" ? [...candidate.action.kinds] : [],
    score: candidate.immediateScore,
  });
  const candidates = decision.candidates.slice(0, request.topN ?? 24).map((candidate) => ({
    ...toMove(candidate), value: candidate.value, chosen: candidate.id === decision.chosen?.id,
    scoreComp: candidate.immediateScore, leave: 0, potential: 0, oppReply: 0,
    mean: candidate.value, stddev: 0, deep: candidate.deep,
    components: candidate.components.map(({ name, points }) => ({ name, points })),
  }));
  const chosen = candidates.find((candidate) => candidate.chosen) ?? candidates[0];
  if (!chosen) throw new Error("Stage 5B reported no legal action");
  return {
    ...toMove(decision.chosen ?? decision.candidates[0]!), equity: chosen.value,
    solver: "stage5b", endgameSolved: false, candidates,
    stats: {
      moves: decision.trace.legal.place + decision.trace.legal.exchange + decision.trace.legal.pass,
      nodes: decision.trace.generator.nodes, elapsedMs: decision.trace.timings.totalMs,
      candidates: decision.trace.legal.place + decision.trace.legal.exchange + decision.trace.legal.pass,
      samples: 0, depth: 64,
    },
  };
}

try {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  process.stdout.write(JSON.stringify(run(JSON.parse(input))) + "\n");
} catch (error) {
  process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + "\n");
  process.exitCode = 1;
}
