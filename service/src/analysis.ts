// ── Turn analysis ────────────────────────────────────────────────────────────
//
// The hard rule for this file: every number and every sentence it produces is
// READ OUT of a search the engine actually ran. Nothing is invented afterwards
// to make the answer sound considered.
//
// That is affordable because the engine already reports its own reasoning. Each
// candidate it evaluated comes back decomposed into the terms it was ranked by:
//
//     value = mean − λ·stddev
//     mean  ≈ scoreComp + leave + potential − oppReply
//
// So "why this move" is not a story told about the result; it is the arithmetic
// that produced the result, with the terms named. The prose below only decides
// which of those terms is worth pointing at, and it says so using the same
// numbers it shows.
//
// Where the engine cannot support a claim, this file says nothing rather than
// filling the gap:
//
//   • The greedy path has no `potential` and no `stddev` (it never simulated),
//     so no risk sentence is written for it.
//   • The endgame path reports PROVEN margins, not estimates, and is described
//     in the language of proof.
//   • A search cut short by its timeout is reported as incomplete, and its
//     ranking is presented as provisional.

import type { EngineResponse } from "./engineRunner.js";
import type { AnalysisLevel } from "./levels.js";
import {
  AnalysisReportUnavailable,
  describeSearch,
  type AnalysisCandidate,
  type AnalysisMethod,
  type SearchDescription,
} from "./analysisReport.js";

// The ranking, the factors and the prose all live in `analysisReport.ts`, which
// imports nothing and is vendored verbatim into the browser app by
// `make deploy-ui`. What stays here is everything that is about a GAME rather
// than about a search: the room, the revision, the side on move.
export {
  AnalysisReportUnavailable,
  describeSearch,
  type AnalysisCandidate,
  type AnalysisFactor,
  type AnalysisMethod,
  type AnalysisMoveKind,
  type ReportCandidate,
  type ReportResponse,
  type SearchDescription,
} from "./analysisReport.js";

/** `describeSearch`, speaking this module's error type.
 *
 *  The portable module cannot throw `AnalysisUnavailableError` — it is defined
 *  here, alongside the HTTP status it maps to — so the translation happens at
 *  the one place the two meet. */
function describe(response: EngineResponse, requestedSamples: number) {
  try {
    return describeSearch(response, requestedSamples);
  } catch (error) {
    if (error instanceof AnalysisReportUnavailable) {
      throw new AnalysisUnavailableError(error.message);
    }
    throw error;
  }
}

export type AnalysisResult = {
  level: AnalysisLevel;
  gameId: string;
  /** The revision this analysis describes. The client must discard it if the
   *  game has moved on; an analysis is about a position, not about a game. */
  revision: number;
  turnNumber: number;
  side: "A" | "B";
  recommendation: AnalysisCandidate;
  alternatives: AnalysisCandidate[];
  summary: string;
  method: AnalysisMethod;
};

export type BuildAnalysisInput = {
  response: EngineResponse;
  level: AnalysisLevel;
  gameId: string;
  revision: number;
  turnNumber: number;
  side: "A" | "B";
  /** Samples the level asked for; fewer means the timeout bound the search. */
  requestedSamples: number;
};

export class AnalysisUnavailableError extends Error {
  override readonly name = "AnalysisUnavailableError";
}

/**
 * What `POST /v1/study/analysis` answers with.
 *
 * Deliberately not an `AnalysisResult`: there is no game id, no revision and no
 * side on move to report, and filling those in with zeroes would invite a
 * client to treat a made-up position as a game. What it adds instead is the
 * position it was asked about — so a result can be read on its own, without the
 * request that produced it — and the id of the record that was written.
 */
export type StudyAnalysisResponse = {
  /** The permanent record, or `null` when the search succeeded but the write
   *  did not. The ranking is still returned in that case: the compute is spent
   *  either way, and losing it to a database hiccup helps nobody. */
  recordId: string | null;
  saveError: string | null;
  level: string;
  position: {
    scoreSelf: number;
    scoreOpponent: number;
    board: Array<{ r: number; c: number; kind: string; token: string }>;
    rack: string[];
    oppRackCount: number;
    bagCount: number;
  };
  /** Ranked best-first, capped at `STUDY_TOP_N`. */
  candidates: AnalysisCandidate[];
  summary: string;
  method: AnalysisMethod;
};

export function buildAnalysis(input: BuildAnalysisInput): AnalysisResult {
  const described = describe(input.response, input.requestedSamples);
  const [recommendation, ...alternatives] = described.candidates;
  if (!recommendation) throw new AnalysisUnavailableError("The engine reported no chosen move.");

  return {
    level: input.level,
    gameId: input.gameId,
    revision: input.revision,
    turnNumber: input.turnNumber,
    side: input.side,
    recommendation,
    alternatives,
    summary: described.summary,
    method: described.method,
  };
}

/**
 * The same description, for a position that is not a game.
 *
 * Two differences from `buildAnalysis`, both deliberate. There is no game
 * identity to report — no room, no revision, no side on move — so none is
 * invented. And the ranking is TRUNCATED here rather than at the database:
 * `limit` is what the study record promises to hold, and a list that says "top
 * 10" while carrying twenty-four is a record nobody can reason about later.
 */
export function buildStudyAnalysis(input: {
  response: EngineResponse;
  requestedSamples: number;
  limit: number;
}): SearchDescription {
  const described = describe(input.response, input.requestedSamples);
  if (described.candidates.length === 0) {
    throw new AnalysisUnavailableError("The engine reported no chosen move.");
  }
  return { ...described, candidates: described.candidates.slice(0, input.limit) };
}
