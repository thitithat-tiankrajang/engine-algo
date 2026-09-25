import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildAnalysis, buildStudyAnalysis } from "../src/analysis.js";
import { runEngineValidation } from "../src/engineRunner.js";
import { runStage5bOnServer } from "../src/stage5bRunner.js";

const engine = fileURLToPath(new URL("../../build/amath_cli", import.meta.url));

describe("Stage 5B analysis with the Stage 5A value model", () => {
  it("returns the same valued move to Play and Study at deepTop 64", async () => {
    const request = {
        board: [
          { r: 7, c: 6, kind: "7", token: "7" },
          { r: 7, c: 7, kind: "=", token: "=" },
          { r: 7, c: 8, kind: "7", token: "7" },
        ],
        rack: ["0", "1", "2", "+", "-", "x", "/", "="],
        oppRackCount: 8,
        bagCount: 81,
        myScore: 0,
        oppScore: 0,
        noScoreStreak: 0,
        exchangeAllowed: true,
        seed: 1,
        topN: 10,
    };
    const response = await runStage5bOnServer({
      request,
      timeoutMs: 10_000,
    });

    expect(response.solver).toBe("stage5b");
    expect(response.stats.depth).toBe(64);
    expect(response.candidates?.[0]?.components?.some((part) => part.name === "nn-value")).toBe(true);

    const play = buildAnalysis({
      response, level: "stage5b64", gameId: "example", revision: 1,
      turnNumber: 1, side: "A", requestedSamples: 0,
    });
    const study = buildStudyAnalysis({ response, requestedSamples: 0, limit: 10 });
    expect(play.recommendation.placements).toEqual(study.candidates[0]?.placements);
    expect(play.recommendation.evaluation).toBe(study.candidates[0]?.evaluation);
    expect(play.method.depth).toBe(64);
    expect(study.method.solver).toBe("stage5b");

    if (existsSync(engine)) {
      const legality = await runEngineValidation({
        binaryPath: engine,
        request: { ...request, mode: "validate", move: response },
        timeoutMs: 10_000,
      });
      expect(legality.valid).toBe(true);
      expect(legality.score).toBe(response.score);
    }
  });
});
