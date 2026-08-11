import type { EngineResponse } from "./engineRunner.js";
import type { AnalysisLevel } from "./levels.js";
export type AnalysisMoveKind = "place" | "exchange" | "pass";
export type AnalysisFactor = {
    key: "score" | "leave" | "potential" | "oppReply" | "risk" | "margin";
    label: string;
    value: number;
    /** How this candidate compares with the recommendation on this term.
     *  Absent on the recommendation itself. */
    delta?: number;
};
export type AnalysisCandidate = {
    rank: number;
    kind: AnalysisMoveKind;
    placements: Array<{
        r: number;
        c: number;
        kind: string;
        token: string;
    }>;
    exchange: string[];
    /** Points this move scores on the board right now. */
    immediateScore: number;
    /** The engine's ranking key for this move. */
    evaluation: number;
    /** Difference from the recommendation's evaluation. 0 for the recommendation. */
    evaluationGap: number;
    factors: AnalysisFactor[];
    /** Exact proven final-score margin, endgame solver only. */
    provenMargin: number | null;
    recommended: boolean;
    /** One sentence about this candidate specifically, grounded in its factors. */
    note: string;
};
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
    /** How the recommendation was reached, in the engine's own terms. */
    method: {
        solver: "greedy" | "sim" | "endgame";
        /** Opponent-rack scenarios actually simulated. */
        samples: number;
        /** Root moves the generator found. */
        legalMoves: number;
        candidatesEvaluated: number;
        nodes: number;
        elapsedMs: number;
        /** True when the endgame result is an exact proof rather than an estimate. */
        proven: boolean;
        /** False when a timeout cut the search short; the ranking is provisional. */
        complete: boolean;
    };
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
export declare class AnalysisUnavailableError extends Error {
    readonly name = "AnalysisUnavailableError";
}
export declare function buildAnalysis(input: BuildAnalysisInput): AnalysisResult;
