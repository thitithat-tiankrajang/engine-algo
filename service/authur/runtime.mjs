import { readFile } from "node:fs/promises";
import { createManifest, decideStrong, envStateFrom, loadStrongModels } from "./strong.mjs";

// This process handles one position. Its fetch shim is process-local, so model
// reads cannot change the HTTP behaviour of the API process.
globalThis.fetch = async (url) => {
  const name = String(url).split("/").pop();
  if (!["reply-self.json", "reply-opponent.json", "next-turn.json"].includes(name)) {
    throw new Error("Unknown Authur model");
  }
  const data = await readFile(new URL(`./models/${name}`, import.meta.url));
  return new Response(data, { status: 200, headers: { "Content-Type": "application/json" } });
};

function makeState(request) {
  const manifest = createManifest();
  const free = new Map();
  for (const tile of manifest.tiles) {
    const copies = free.get(tile.kind) ?? [];
    copies.push(tile.id);
    free.set(tile.kind, copies);
  }
  const take = (kind) => {
    const id = free.get(kind)?.shift();
    if (!id) throw new Error(`Authur tile inventory mismatch: ${kind}`);
    return id;
  };
  const board = Array.from({ length: 225 }, () => null);
  for (const placed of request.board) {
    if (placed.cell < 0 || placed.cell >= 225 || board[placed.cell]) {
      throw new Error("Invalid Authur board cell");
    }
    board[placed.cell] = { ...placed, tileId: take(placed.kind) };
  }
  const ownRack = request.rack.map(take);
  const ownPending = request.ownPending.map(take);
  const unknown = [...free.values()].flat().sort();
  const needed = request.opponentRackCount + request.opponentPendingCount + request.bagCount;
  if (unknown.length !== needed) throw new Error("Authur tile count does not conserve 100 tiles");
  const theirRack = unknown.slice(0, request.opponentRackCount);
  const theirPending = unknown.slice(
    request.opponentRackCount,
    request.opponentRackCount + request.opponentPendingCount,
  );
  const other = request.side === "A" ? "B" : "A";
  return envStateFrom({
    manifest,
    board,
    racks: { [request.side]: ownRack, [other]: theirRack },
    pendingReturn: { [request.side]: ownPending, [other]: theirPending },
    bag: unknown.slice(request.opponentRackCount + request.opponentPendingCount),
    scores: request.scores,
    activeSide: request.side,
    turnNumber: request.turnNumber,
    noScoreTail: request.noScoreTail,
    hasPlacement: request.board.length > 0,
    seed: request.seed,
    rngStep: 0,
  });
}

function moveOf(action, score = 0) {
  return {
    type: action.type,
    placements: action.type === "place"
      ? action.placements.map((p) => ({
          r: Math.floor(p.cell / 15), c: p.cell % 15, kind: p.kind, token: p.face,
        }))
      : [],
    exchange: action.type === "exchange" ? [...action.kinds] : [],
    score,
  };
}

try {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const request = JSON.parse(input);
  const state = makeState(request);
  const models = request.bagCount + request.ownPending.length + request.opponentPendingCount > 0
    ? await loadStrongModels("authur-models")
    : null;
  const decision = await decideStrong(state, request.seed, models, {
    onProgress: (progress) => {
      process.stderr.write(JSON.stringify({
        phase: progress.phase.startsWith("endgame") ? "endgame" :
          progress.phase === "generating" ? "movegen" : "sim",
        percent: progress.fraction == null ? 0 : Math.max(0, Math.min(100, progress.fraction * 100)),
        elapsedMs: progress.generationMs + progress.strategyMs,
        etaMs: 0,
        bestScore: 0,
        detail: `Authur · ${progress.phase} · ${progress.legalPlace} moves`,
      }) + "\n");
    },
  });
  if (decision.cancelled || !decision.trace.generationComplete || decision.trace.spaceMapTruncated) {
    throw new Error("Authur did not finish complete move generation");
  }
  const solved = decision.endgame?.exact === true;
  const chosen = decision.candidates.find((item) => item.chosen);
  const response = {
    ...moveOf(decision.action, decision.trace.chosenImmediateScore),
    equity: chosen?.q ?? 0,
    solver: solved ? "endgame" : "sim",
    endgameSolved: solved,
    ...(solved ? { expectedFinalDiff: decision.endgame.selectedOptimalMargin } : {}),
    stats: {
      moves: decision.trace.legalPlace + decision.trace.legalExchange + 1,
      nodes: decision.trace.generationNodes + decision.trace.tier3Nodes,
      elapsedMs: decision.trace.totalMs,
      candidates: decision.candidates.length,
      samples: decision.trace.evaluations,
    },
    candidates: decision.candidates.map((candidate) => ({
      ...moveOf(candidate.action, candidate.immediateScore),
      scoreComp: candidate.immediateScore,
      leave: candidate.meanNext,
      potential: 0,
      oppReply: candidate.meanReply,
      mean: candidate.q,
      stddev: 0,
      value: candidate.adjusted,
      chosen: candidate.chosen,
      ...(solved ? { proven: true } : {}),
    })),
  };
  process.stdout.write(JSON.stringify(response));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
}
