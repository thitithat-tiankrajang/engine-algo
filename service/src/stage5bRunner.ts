import { resolve } from "node:path";
import { runEngine, type RunOptions } from "./engineRunner.js";

const runtime = resolve(process.cwd(), "stage5b/runtime.mjs");

/** Run the original Stage 5B decision with the Stage 5A model at deepTop=64. */
export function runStage5bOnServer(options: Omit<RunOptions, "binaryPath" | "args">) {
  return runEngine({ ...options, binaryPath: process.execPath, args: [runtime] });
}
