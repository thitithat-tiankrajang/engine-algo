// ── Running the C++ engine ───────────────────────────────────────────────────
//
// One OS process per request, talking JSON over stdio (`amath_cli worker`).
//
// Why a process and not a long-lived worker or an in-process WASM instance:
//
//   • A wall-clock timeout and a user cancellation become the SAME operation —
//     kill the process — and that operation is always available. The engine's
//     search loops check their own deadline, but a search that has wandered
//     into a long uninterruptible stretch cannot be talked out of it; it can
//     only be stopped from outside.
//   • A crash, an assertion, or an out-of-memory takes down one request instead
//     of the service.
//   • Nothing is retained between requests, so no request can influence the
//     search of another. That matters for a shared server in a way it never did
//     in a single-user browser tab.
//
// The cost is process startup, which is negligible here: the engine loads no
// tables and no model, and measured startup is under a millisecond against
// searches measured in seconds.

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export type EngineProgress = {
  phase: "movegen" | "sim" | "endgame";
  percent: number;
  elapsedMs: number;
  etaMs: number;
  bestScore: number;
  detail: string;
};

export type EngineCandidate = {
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

export type EngineResponse = {
  type: "place" | "exchange" | "pass";
  placements: Array<{ r: number; c: number; kind: string; token: string }>;
  exchange: string[];
  score: number;
  equity: number;
  solver: "greedy" | "sim" | "endgame";
  endgameSolved: boolean;
  expectedFinalDiff?: number;
  stats: {
    moves: number;
    nodes: number;
    elapsedMs: number;
    candidates: number;
    samples: number;
  };
  candidates?: EngineCandidate[];
  error?: string;
};

export class EngineTimeoutError extends Error {
  override readonly name = "EngineTimeoutError";
  constructor(readonly timeoutMs: number) {
    super(`The engine did not finish within ${timeoutMs}ms.`);
  }
}

export class EngineCancelledError extends Error {
  override readonly name = "EngineCancelledError";
  constructor() {
    super("The engine run was cancelled.");
  }
}

export class EngineFailureError extends Error {
  override readonly name = "EngineFailureError";
  constructor(message: string, readonly detail?: string) {
    super(message);
  }
}

export type RunOptions = {
  binaryPath: string;
  request: unknown;
  /** Hard wall-clock ceiling. The engine's own `budgetMs` should be comfortably
   *  below this; reaching this bound means the engine overshot and is killed. */
  timeoutMs: number;
  signal?: AbortSignal;
  onProgress?: (progress: EngineProgress) => void;
  /** Refuse an engine response larger than this. The engine's own output is
   *  bounded by `topN`, so anything near this bound is a malfunction. */
  maxResponseBytes?: number;
};

const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
/** Grace between SIGTERM and SIGKILL. The engine has no cleanup to do, so this
 *  only covers a process that is already wedged. */
const KILL_GRACE_MS = 2_000;

export async function runEngine(options: RunOptions): Promise<EngineResponse> {
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  if (options.signal?.aborted) throw new EngineCancelledError();

  const child = spawn(options.binaryPath, ["worker"], {
    stdio: ["pipe", "pipe", "pipe"],
    // No shell: the binary path is configuration, but there is never a reason
    // to let a shell interpret it.
    shell: false,
  });

  let stdout = "";
  let stderrTail = "";
  let overflowed = false;
  // Held in an object because it is only ever written from callbacks, and
  // narrowing a `let` to its initializer would make the checks after the wait
  // look unreachable.
  const state: { outcome: "running" | "timeout" | "cancelled" } = { outcome: "running" };

  const stopProcess = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await delay(KILL_GRACE_MS);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  };

  const timer = setTimeout(() => {
    state.outcome = "timeout";
    void stopProcess();
  }, options.timeoutMs);

  const onAbort = () => {
    state.outcome = "cancelled";
    void stopProcess();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (overflowed) return;
    stdout += chunk;
    if (stdout.length > maxBytes) {
      overflowed = true;
      void stopProcess();
    }
  });

  // Progress is NDJSON on stderr. A malformed line is dropped rather than
  // failing the run: progress is a courtesy to the UI, never part of the result.
  let stderrBuffer = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrBuffer += chunk;
    let newline = stderrBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = stderrBuffer.slice(0, newline).trim();
      stderrBuffer = stderrBuffer.slice(newline + 1);
      newline = stderrBuffer.indexOf("\n");
      if (!line) continue;
      stderrTail = line;
      if (!options.onProgress) continue;
      try {
        const parsed = JSON.parse(line) as EngineProgress;
        if (parsed && typeof parsed.phase === "string") options.onProgress(parsed);
      } catch {
        // not a progress line
      }
    }
  });

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code, signal) => resolve({ code, signal }));
    },
  );

  try {
    child.stdin.end(JSON.stringify(options.request));
  } catch (error) {
    await stopProcess();
    throw new EngineFailureError(
      "The engine process could not be given its request.",
      error instanceof Error ? error.message : undefined,
    );
  }

  let closed: { code: number | null; signal: NodeJS.Signals | null };
  try {
    closed = await exit;
  } catch (error) {
    throw new EngineFailureError(
      "The engine process could not be started.",
      error instanceof Error ? error.message : undefined,
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }

  if (state.outcome === "cancelled") throw new EngineCancelledError();
  if (state.outcome === "timeout") throw new EngineTimeoutError(options.timeoutMs);
  if (overflowed) {
    throw new EngineFailureError("The engine produced an implausibly large response.");
  }
  if (closed.code !== 0) {
    throw new EngineFailureError(
      `The engine exited with ${closed.signal ?? `code ${closed.code}`}.`,
      stderrTail || undefined,
    );
  }

  let parsed: EngineResponse;
  try {
    parsed = JSON.parse(stdout.trim()) as EngineResponse;
  } catch {
    throw new EngineFailureError("The engine produced output that is not a response.");
  }
  if (parsed.error) {
    throw new EngineFailureError(`The engine rejected the position: ${parsed.error}`);
  }
  if (parsed.type !== "place" && parsed.type !== "exchange" && parsed.type !== "pass") {
    throw new EngineFailureError("The engine returned a move of no known kind.");
  }
  return parsed;
}
