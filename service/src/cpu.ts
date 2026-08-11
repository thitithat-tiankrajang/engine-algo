// ── How much CPU do we actually have? ────────────────────────────────────────
//
// This exists because `os.availableParallelism()` answers a different question
// than the one that matters here.
//
// On Linux it reports the size of the process's CPU AFFINITY MASK. A container
// platform that limits CPU with a cgroup QUOTA — which is what Render, Fly,
// ECS and Kubernetes all do by default — does not touch the affinity mask. A
// service pinned to 1 CPU by quota, running on a 16-core host, still sees 16.
//
// Sizing the engine queue from that number is the specific failure this file
// prevents: 15 simultaneous `amath_cli` processes sharing one CPU's worth of
// quota, each one throttled to a fifteenth of the speed it was benchmarked at,
// every one of them overshooting the deadline the engine set for itself.
//
// So the quota is read directly, from whichever cgroup interface the kernel is
// presenting, and the smaller of (quota, affinity) wins. Both are upper bounds
// on real parallelism and neither implies the other.

import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";

export type CpuDetection = {
  /** Effective CPU allowance, in cores. Fractional under a partial quota. */
  cpus: number;
  /** Which interface produced it, for the startup log and /health. */
  source: "cgroup-v2" | "cgroup-v1" | "parallelism";
  /** What the affinity mask reported, kept for the log so a mismatch is
   *  visible rather than silently corrected. */
  parallelism: number;
};

export type CpuReader = (path: string) => string;

const defaultReader: CpuReader = (path) => readFileSync(path, "utf8");

/** cgroup v2: `cpu.max` holds "<quota> <period>", or "max <period>" when
 *  unlimited. Both in microseconds. */
function fromCgroupV2(read: CpuReader): number | null {
  let raw: string;
  try {
    raw = read("/sys/fs/cgroup/cpu.max");
  } catch {
    return null;
  }
  const [quota, period] = raw.trim().split(/\s+/);
  if (!quota || quota === "max") return null;
  const quotaValue = Number(quota);
  const periodValue = Number(period ?? "100000");
  if (!Number.isFinite(quotaValue) || !Number.isFinite(periodValue) || periodValue <= 0) {
    return null;
  }
  if (quotaValue <= 0) return null;
  return quotaValue / periodValue;
}

/** cgroup v1: the same two numbers in two files. A quota of -1 is unlimited. */
function fromCgroupV1(read: CpuReader): number | null {
  let quotaRaw: string;
  let periodRaw: string;
  try {
    quotaRaw = read("/sys/fs/cgroup/cpu/cpu.cfs_quota_us");
    periodRaw = read("/sys/fs/cgroup/cpu/cpu.cfs_period_us");
  } catch {
    return null;
  }
  const quota = Number(quotaRaw.trim());
  const period = Number(periodRaw.trim());
  if (!Number.isFinite(quota) || quota <= 0) return null;
  if (!Number.isFinite(period) || period <= 0) return null;
  return quota / period;
}

/**
 * The CPU allowance this process may actually spend.
 *
 * Reading a file the container does not expose is normal, not an error — a
 * plain host has no cgroup limit and the affinity count is then the honest
 * answer.
 */
export function detectCpuLimit(
  read: CpuReader = defaultReader,
  parallelism: number = availableParallelism(),
): CpuDetection {
  const cores = Number.isFinite(parallelism) && parallelism > 0 ? parallelism : 1;

  const v2 = fromCgroupV2(read);
  if (v2 != null) {
    return { cpus: Math.min(v2, cores), source: "cgroup-v2", parallelism: cores };
  }
  const v1 = fromCgroupV1(read);
  if (v1 != null) {
    return { cpus: Math.min(v1, cores), source: "cgroup-v1", parallelism: cores };
  }
  return { cpus: cores, source: "parallelism", parallelism: cores };
}

/** Nothing sane asks for more than this, and a misread quota should not be able
 *  to fork an unbounded number of searches. */
export const MAX_CONCURRENCY = 32;

/**
 * The default number of simultaneous engine processes for a given CPU
 * allowance.
 *
 * Two facts set the shape of this. `amath_cli` is single-threaded, so one
 * process saturates exactly one core and never more. And Node needs CPU of its
 * own — not much, but it is the thread that answers `/health`, accepts the
 * cancellation that stops a runaway search, and writes the SSE bytes that keep
 * a proxy from closing a live connection. Starving it is how a busy server
 * becomes an unreachable one.
 *
 *     ≤ 2 cores → 1     the reserve is a whole core here, so there is one left
 *     > 2 cores → n − 1 the reserve costs proportionally less
 *
 * Deliberately conservative. Two engine processes on a 2-core box will each
 * finish roughly on time and leave nothing for anything else; one finishes at
 * full speed and the second waits a few seconds. Raising it is a decision to
 * make against measurements from a real instance, which is why it is an
 * environment variable and not a cleverer formula.
 */
export function defaultConcurrency(cpus: number): number {
  if (!Number.isFinite(cpus) || cpus <= 0) return 1;
  const whole = Math.floor(cpus);
  if (whole <= 2) return 1;
  return Math.min(MAX_CONCURRENCY, whole - 1);
}
