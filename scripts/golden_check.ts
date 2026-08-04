// Golden cross-check: replay the C++ engine's verdicts through EQ-Lab's
// TypeScript validator and report any disagreement.
//
// Usage (from the EQ-Lab repo root, so imports resolve):
//   npx tsx ../amath-engine/scripts/golden_check.ts ../amath-engine/build/golden.jsonl
import { readFileSync } from "node:fs";
import {
  validateMove,
  type BoardSnapshot,
  type PendingPlacement,
  type AmathToken,
} from "../../EQ-Lab/src/game";
import { AMATH_TOKENS } from "../../EQ-Lab/src/constants/tileDefinitions";

type GoldenCell = { r: number; c: number; kind: string; token: string };
type GoldenCase = {
  board: GoldenCell[];
  placements: GoldenCell[];
  expectValid: boolean;
  expectScore: number;
};

const path = process.argv[2] ?? "../amath-engine/build/golden.jsonl";
const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);

function needsAssignment(kind: string): boolean {
  return kind === "+/-" || kind === "x//" || kind === "?";
}

function toBoard(cells: GoldenCell[]): BoardSnapshot {
  const board: BoardSnapshot = Array.from({ length: 15 }, () =>
    Array.from({ length: 15 }, () => null),
  );
  let id = 0;
  for (const cell of cells) {
    board[cell.r][cell.c] = {
      tile: {
        id: `g${id++}`,
        token: cell.kind as AmathToken,
        assignedToken: needsAssignment(cell.kind) ? cell.token : undefined,
      },
      placedTurn: 1,
      side: "A",
    };
  }
  return board;
}

let checked = 0;
let mismatches = 0;

for (const line of lines) {
  const g: GoldenCase = JSON.parse(line);
  const board = toBoard(g.board);
  let id = 1000;
  const placements: PendingPlacement[] = g.placements.map((p) => {
    if (!(p.kind in AMATH_TOKENS)) throw new Error(`bad kind ${p.kind}`);
    return {
      tile: { id: `p${id++}`, token: p.kind as AmathToken },
      row: p.r,
      col: p.c,
      assignedToken: needsAssignment(p.kind) ? p.token : undefined,
    };
  });

  const v = validateMove(board, placements);
  const scoreOk = !g.expectValid || v.score === g.expectScore;
  if (v.isValid !== g.expectValid || !scoreOk) {
    mismatches++;
    if (mismatches <= 10) {
      console.log("MISMATCH", {
        expectValid: g.expectValid,
        gotValid: v.isValid,
        expectScore: g.expectScore,
        gotScore: v.score,
        errors: v.errors,
        placements: g.placements,
      });
    }
  }
  checked++;
}

console.log(`${checked} cases checked, ${mismatches} mismatches`);
process.exit(mismatches === 0 ? 0 : 1);
