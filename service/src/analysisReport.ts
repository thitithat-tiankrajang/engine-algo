// ── Turn analysis: from a search to sentences ────────────────────────────────
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
//
// ── Why this file is separate, and why it imports nothing ────────────────────
//
// The top analysis level runs in the PLAYER'S BROWSER now, on the same threaded
// WASM engine the Super bot uses: one process of the native binary is
// single-threaded, and 160 samples on one core is a wait nobody should be asked
// for. That moved the SEARCH off this server — but not the description of it.
//
// A second copy of this prose would mean two analysis levels eventually
// explaining the same position differently, with nothing to catch it. So this
// module is the ONE copy, and `make deploy-ui` vendors it into EQ-Lab's source
// tree, next to the engine artifact it belongs with.
//
// That is why it declares its own input types rather than importing
// `ReportCandidate`/`ReportResponse`: they are structural, the service satisfies
// them without changing a line, and a file with no imports is a file that can be
// copied.

/** One candidate as the engine reported it, decomposed into the terms it was
 *  ranked by. Structurally what `ReportCandidate` already is. */
export type ReportCandidate = {
  type: "place" | "exchange" | "pass";
  placements: Array<{ r: number; c: number; kind: string; token: string }>;
  exchange: string[];
  score: number;
  scoreComp: number;
  leave: number;
  potential: number;
  oppReply: number;
  mean: number;
  stddev: number;
  value: number;
  chosen: boolean;
  proven?: boolean;
};

/** The search as a whole. Structurally the part of `ReportResponse` this file
 *  reads — no move, because a description is not an instruction. */
export type ReportResponse = {
  solver: "greedy" | "sim" | "endgame";
  endgameSolved: boolean;
  stats: {
    moves: number;
    nodes: number;
    elapsedMs: number;
    candidates: number;
    samples: number;
  };
  candidates?: ReportCandidate[];
};

/** Raised when the position offered nothing to rank. Each caller translates it
 *  into the error its own surface already speaks. */
export class AnalysisReportUnavailable extends Error {
  override readonly name = "AnalysisReportUnavailable";
}

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
  placements: Array<{ r: number; c: number; kind: string; token: string }>;
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

/** How the recommendation was reached, in the engine's own terms. */
export type AnalysisMethod = {
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

function round(value: number, places = 1): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function describeMove(candidate: ReportCandidate): string {
  if (candidate.type === "pass") return "passing";
  if (candidate.type === "exchange") {
    const count = candidate.exchange.length;
    return `exchanging ${count} tile${count === 1 ? "" : "s"} (${candidate.exchange.join(", ")})`;
  }
  const tokens = candidate.placements.map((placement) => placement.token).join(" ");
  return `playing ${tokens} for ${candidate.score}`;
}

function factorsFor(candidate: ReportCandidate, solver: ReportResponse["solver"]): AnalysisFactor[] {
  const factors: AnalysisFactor[] = [];

  if (solver === "endgame") {
    // The endgame solver reports one thing and it is not an estimate: the final
    // score difference this move forces against best defence.
    factors.push({
      key: "margin",
      label: "Proven final margin",
      value: round(candidate.value),
    });
    if (candidate.type === "place") {
      factors.push({ key: "score", label: "Points this turn", value: candidate.score });
    }
    return factors;
  }

  factors.push({ key: "score", label: "Points this turn", value: candidate.score });
  factors.push({ key: "leave", label: "Value of the rack kept", value: round(candidate.leave) });
  if (solver === "sim") {
    factors.push({
      key: "potential",
      label: "Scoring power next turn",
      value: round(candidate.potential),
    });
  }
  factors.push({
    key: "oppReply",
    label: solver === "sim" ? "Handed to the opponent" : "Opening left behind",
    value: round(candidate.oppReply),
  });
  if (solver === "sim" && candidate.stddev > 0) {
    factors.push({
      key: "risk",
      label: "Spread across opponent racks",
      value: round(candidate.stddev),
    });
  }
  return factors;
}

/**
 * The single sentence attached to one alternative.
 *
 * It names the term that actually accounts for most of the gap to the
 * recommendation, so the reader learns which consideration decided it rather
 * than being told a conclusion.
 */
function noteFor(
  candidate: ReportCandidate,
  best: ReportCandidate,
  solver: ReportResponse["solver"],
): string {
  if (candidate === best) {
    if (solver === "endgame") {
      const margin = round(best.value);
      return margin > 0
        ? `Proven best: forces a win by ${margin} against any defence.`
        : `Proven best: limits the loss to ${Math.abs(margin)} against best defence.`;
    }
    return "Best overall balance of points now, rack left behind, and what it gives the opponent.";
  }

  if (solver === "endgame") {
    const gap = round(best.value - candidate.value);
    return gap === 0
      ? "Equally good: reaches the same proven final margin."
      : `Ends ${gap} worse than the recommendation against best defence.`;
  }

  // Which single term explains the most of the gap?
  const terms: Array<{ label: string; gap: number; better: string; worse: string }> = [
    {
      label: "score",
      gap: best.scoreComp - candidate.scoreComp,
      better: `scores ${round(candidate.score - best.score)} more now`,
      worse: `scores ${round(best.score - candidate.score)} fewer points now`,
    },
    {
      label: "leave",
      gap: best.leave - candidate.leave,
      better: `leaves a better rack (+${round(candidate.leave - best.leave)})`,
      worse: `leaves a weaker rack (${round(candidate.leave - best.leave)})`,
    },
    {
      label: "potential",
      gap: best.potential - candidate.potential,
      better: `sets up more next turn (+${round(candidate.potential - best.potential)})`,
      worse: `sets up less next turn (${round(candidate.potential - best.potential)})`,
    },
    {
      label: "oppReply",
      gap: candidate.oppReply - best.oppReply,
      better: `concedes ${round(best.oppReply - candidate.oppReply)} less to the opponent`,
      worse: `hands the opponent ${round(candidate.oppReply - best.oppReply)} more`,
    },
  ];

  // The reader is asking "why is this one not the pick?", so the note leads
  // with the term the candidate LOSES on — the largest positive gap, where the
  // recommendation is ahead.
  //
  // Leading with the largest gap in either direction, which is the obvious
  // implementation, produces sentences that argue the wrong side: an
  // alternative whose biggest difference is a strength gets described purely by
  // that strength and then told it ranks behind, which reads as a
  // contradiction rather than an explanation.
  //
  // Where the candidate is genuinely better on something, that is worth saying
  // too — it is why the move was tempting — but as the concession, after the
  // reason it still loses.
  const usable = terms.filter((term) => Number.isFinite(term.gap));
  const losses = usable.filter((term) => term.gap >= 0.05).sort((a, b) => b.gap - a.gap);
  const gains = usable.filter((term) => term.gap <= -0.05).sort((a, b) => a.gap - b.gap);

  const total = round(best.value - candidate.value);
  const capitalize = (text: string) => `${text[0]?.toUpperCase() ?? ""}${text.slice(1)}`;

  const primary = losses[0];
  if (!primary) {
    // Nothing measurably worse. Either it is a near-tie, or it trades a real
    // strength for a spread of small losses too even to name.
    const strength = gains[0];
    if (strength && total > 0.05) {
      return `${capitalize(strength.better)}, but ranks ${total} behind overall once the other terms are counted.`;
    }
    return `Close alternative, ${total} behind on the engine's overall value.`;
  }

  const concession = gains[0];
  const trailing = total > 0 ? ` Overall it ranks ${total} behind.` : "";
  return concession
    ? `${capitalize(primary.worse)}, though it ${concession.better}.${trailing}`
    : `${capitalize(primary.worse)}.${trailing}`;
}

/** The paragraph at the top: what to play, and the one thing that decided it. */
function summaryFor(
  best: ReportCandidate,
  runnerUp: ReportCandidate | undefined,
  response: ReportResponse,
  complete: boolean,
): string {
  const parts: string[] = [];
  const action = describeMove(best);

  if (response.solver === "endgame") {
    const margin = round(best.value);
    parts.push(
      `The bag is empty enough to solve exactly, so this is not an estimate: ${action} ` +
        (margin > 0
          ? `wins by ${margin} points however the opponent replies.`
          : margin === 0
            ? "draws against best defence, and nothing available does better."
            : `loses by ${Math.abs(margin)} against best defence, which is the smallest loss available.`),
    );
    if (runnerUp) {
      const gap = round(best.value - runnerUp.value);
      parts.push(
        gap === 0
          ? "At least one other move reaches the same proven result."
          : `The next best move ends ${gap} points worse.`,
      );
    }
    return parts.join(" ");
  }

  if (response.solver === "greedy") {
    parts.push(
      `With no opponent rack to reason about, the engine ranked moves on immediate value alone and chose ${action}.`,
    );
  } else {
    parts.push(
      `Across ${response.stats.samples} simulated opponent racks, ${action} came out best.`,
    );
  }

  // Name the term that actually carried the decision, using its own number.
  const contributions: Array<[string, number]> = [
    [`the ${best.score} points it scores`, best.scoreComp],
    ["the rack it leaves behind", best.leave],
    ["what it sets up for next turn", best.potential],
  ];
  const leading = contributions
    .filter(([, value]) => Number.isFinite(value))
    .sort((first, second) => Math.abs(second[1]) - Math.abs(first[1]))[0];
  if (leading && Math.abs(leading[1]) > 0.05) {
    parts.push(`Most of its value is ${leading[0]} (${round(leading[1])}).`);
  }
  if (best.oppReply > 0.05) {
    parts.push(`It concedes ${round(best.oppReply)} to the opponent's best reply.`);
  }
  if (response.solver === "sim" && best.stddev > 0.05) {
    parts.push(
      `Its value varies by about ${round(best.stddev)} depending on what the opponent actually holds, ` +
        "so treat the ranking as a lean rather than a certainty.",
    );
  }
  if (runnerUp) {
    const gap = round(best.value - runnerUp.value);
    parts.push(
      gap <= 0.5
        ? "The second choice is close enough that either is defensible."
        : `The next best alternative ranks ${gap} behind.`,
    );
  }
  if (!complete) {
    parts.push(
      "The search hit its time limit before finishing every scenario, so this ranking is provisional.",
    );
  }
  return parts.join(" ");
}

/** The part of an analysis that is about the SEARCH rather than about the game
 *  it came from. Shared by room analysis and study, so the two can never drift
 *  into describing the same engine output differently. */
export type SearchDescription = {
  /** Ranked best-first; the engine's own chosen move is always first. */
  candidates: AnalysisCandidate[];
  summary: string;
  method: AnalysisMethod;
};

export function describeSearch(response: ReportResponse, requestedSamples: number): SearchDescription {
  const rows = response.candidates ?? [];
  if (rows.length === 0) {
    // Every solver path fills the candidate report, so an empty one means the
    // position offered nothing to weigh. Saying so beats inventing advice.
    throw new AnalysisReportUnavailable(
      "The engine found no candidate moves to compare in this position.",
    );
  }

  // The engine already sorted by its ranking key and flagged the move it chose.
  // Trust that flag rather than re-deriving a winner: re-ranking here is exactly
  // how an analysis view starts disagreeing with the bot it claims to explain.
  const best = rows.find((row) => row.chosen) ?? rows[0];
  if (!best) throw new AnalysisReportUnavailable("The engine reported no chosen move.");

  const complete = response.solver !== "sim" || response.stats.samples >= requestedSamples;

  const toCandidate = (row: ReportCandidate, index: number): AnalysisCandidate => {
    const factors = factorsFor(row, response.solver);
    if (row !== best) {
      const bestFactors = factorsFor(best, response.solver);
      for (const factor of factors) {
        const counterpart = bestFactors.find((other) => other.key === factor.key);
        if (counterpart) factor.delta = round(factor.value - counterpart.value);
      }
    }
    return {
      rank: index + 1,
      kind: row.type,
      placements: row.placements,
      exchange: row.exchange,
      immediateScore: row.score,
      evaluation: round(row.value, 2),
      evaluationGap: round(best.value - row.value, 2),
      factors,
      provenMargin: row.proven ? Math.round(row.value) : null,
      recommended: row === best,
      note: noteFor(row, best, response.solver),
    };
  };

  const ordered = [best, ...rows.filter((row) => row !== best)];

  return {
    candidates: ordered.map(toCandidate),
    summary: summaryFor(best, ordered[1], response, complete),
    method: {
      solver: response.solver,
      samples: response.stats.samples,
      legalMoves: response.stats.moves,
      candidatesEvaluated: response.stats.candidates,
      nodes: response.stats.nodes,
      elapsedMs: Math.round(response.stats.elapsedMs),
      proven: response.solver === "endgame" && response.endgameSolved,
      complete,
    },
  };
}

