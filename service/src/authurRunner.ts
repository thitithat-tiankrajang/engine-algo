import { resolve } from "node:path";
import { type CanonicalState, otherSide, tokenOfOrdinal } from "./canonical.js";
import { noScoreStreak, seedFor, type CommittedCommand } from "./adapter.js";
import { runEngine, type RunOptions } from "./engineRunner.js";

export function authurRequest(
  state: CanonicalState,
  events: readonly CommittedCommand[],
  roomId = state.gameId,
) {
  const side = state.activeSide;
  const board: Array<{
    cell: number;
    kind: string;
    face: string;
    side: "A" | "B";
    turn: number;
  }> = [];
  const rack: Array<{ seq: number; kind: string }> = [];
  const ownPending: Array<{ seq: number; kind: string }> = [];
  let opponentRackCount = 0;
  let opponentPendingCount = 0;
  let bagCount = 0;
  state.inventory.forEach((placement, ordinal) => {
    const kind = tokenOfOrdinal(ordinal);
    if (placement.at === "board") {
      board.push({
        cell: placement.row * 15 + placement.col,
        kind,
        face:
          placement.assigned ??
          (kind === "x" ? "×" : kind === "/" ? "÷" : kind),
        side: placement.by,
        turn: placement.placedTurn,
      });
    } else if (placement.at === "rack") {
      if (placement.side === side) rack.push({ seq: placement.seq, kind });
      else opponentRackCount += 1;
    } else if (placement.at === "pendingReturn") {
      if (placement.side === side)
        ownPending.push({ seq: placement.seq, kind });
      else opponentPendingCount += 1;
    } else bagCount += 1;
  });
  board.sort((a, b) => a.cell - b.cell);
  rack.sort((a, b) => a.seq - b.seq);
  ownPending.sort((a, b) => a.seq - b.seq);
  const tailLength = Math.min(noScoreStreak(events), 6);
  const noScoreTail: Array<"A" | "B"> = [];
  for (let i = tailLength; i > 0; i -= 1) {
    noScoreTail.push(i % 2 === 1 ? otherSide(side) : side);
  }
  return {
    side,
    seed: seedFor(roomId, state.revision),
    board,
    rack: rack.map((item) => item.kind),
    ownPending: ownPending.map((item) => item.kind),
    opponentRackCount,
    opponentPendingCount,
    bagCount,
    scores: state.scores,
    turnNumber: state.turnNumber,
    noScoreTail,
  };
}

export function runAuthurOnServer(
  options: Omit<RunOptions, "binaryPath" | "args">,
) {
  return runEngine({
    ...options,
    binaryPath: process.execPath,
    args: [resolve(process.cwd(), "authur/runtime.mjs")],
  });
}
