// The number this file computes decides how many `amath_cli` processes may run
// at once. Getting it from the wrong source is not a rounding error: on a
// 1-CPU container scheduled onto a 16-core host, the affinity mask says 16 and
// every search would run at a sixteenth of the speed it was benchmarked at.
import { describe, expect, it } from "vitest";

import { MAX_CONCURRENCY, defaultConcurrency, detectCpuLimit } from "../src/cpu.js";

/** A cgroup filesystem that exists only in this test. Anything not listed
 *  throws, exactly as `readFileSync` does for a path a container has not
 *  mounted. */
function fakeCgroup(files: Record<string, string>) {
  return (path: string): string => {
    const value = files[path];
    if (value === undefined) throw new Error(`ENOENT: ${path}`);
    return value;
  };
}

const V2 = "/sys/fs/cgroup/cpu.max";
const V1_QUOTA = "/sys/fs/cgroup/cpu/cpu.cfs_quota_us";
const V1_PERIOD = "/sys/fs/cgroup/cpu/cpu.cfs_period_us";

describe("detecting the CPU we are actually allowed to use", () => {
  it("reads a cgroup v2 quota instead of trusting the host core count", () => {
    // The exact Render Standard shape: 1 CPU of quota on a large host.
    const detected = detectCpuLimit(fakeCgroup({ [V2]: "100000 100000" }), 16);
    expect(detected.cpus).toBe(1);
    expect(detected.source).toBe("cgroup-v2");
    // The misleading number is kept, so an operator can see the discrepancy.
    expect(detected.parallelism).toBe(16);
  });

  it("understands a fractional quota", () => {
    const detected = detectCpuLimit(fakeCgroup({ [V2]: "50000 100000" }), 8);
    expect(detected.cpus).toBe(0.5);
  });

  it("treats an unlimited v2 quota as no limit at all", () => {
    const detected = detectCpuLimit(fakeCgroup({ [V2]: "max 100000" }), 4);
    expect(detected.cpus).toBe(4);
    expect(detected.source).toBe("parallelism");
  });

  it("falls back to cgroup v1 when v2 is not mounted", () => {
    const detected = detectCpuLimit(
      fakeCgroup({ [V1_QUOTA]: "200000", [V1_PERIOD]: "100000" }),
      16,
    );
    expect(detected.cpus).toBe(2);
    expect(detected.source).toBe("cgroup-v1");
  });

  it("treats a v1 quota of -1 as unlimited", () => {
    const detected = detectCpuLimit(
      fakeCgroup({ [V1_QUOTA]: "-1", [V1_PERIOD]: "100000" }),
      4,
    );
    expect(detected.cpus).toBe(4);
    expect(detected.source).toBe("parallelism");
  });

  it("uses the affinity count on a plain host with no cgroup limit", () => {
    const detected = detectCpuLimit(fakeCgroup({}), 6);
    expect(detected.cpus).toBe(6);
    expect(detected.source).toBe("parallelism");
  });

  it("never reports more than the affinity mask allows", () => {
    // A quota larger than the mask cannot be spent: both are ceilings and the
    // smaller one binds.
    const detected = detectCpuLimit(fakeCgroup({ [V2]: "800000 100000" }), 2);
    expect(detected.cpus).toBe(2);
  });

  it("ignores an unparsable quota rather than deriving nonsense from it", () => {
    const detected = detectCpuLimit(fakeCgroup({ [V2]: "banana 100000" }), 3);
    expect(detected.cpus).toBe(3);
    expect(detected.source).toBe("parallelism");
  });
});

describe("the conservative default", () => {
  it("serialises on a half-CPU instance", () => {
    expect(defaultConcurrency(0.5)).toBe(1);
  });

  it("serialises on a single-CPU instance", () => {
    // The property the brief names explicitly: one CPU means one search at a
    // time, so job B queues instead of fighting job A for the same core.
    expect(defaultConcurrency(1)).toBe(1);
  });

  it("still serialises on two CPUs, leaving one for the event loop", () => {
    expect(defaultConcurrency(2)).toBe(1);
  });

  it("keeps one CPU in reserve above two", () => {
    expect(defaultConcurrency(4)).toBe(3);
    expect(defaultConcurrency(8)).toBe(7);
  });

  it("refuses to derive a runaway pool from an implausible reading", () => {
    expect(defaultConcurrency(10_000)).toBe(MAX_CONCURRENCY);
  });

  it("never derives zero", () => {
    expect(defaultConcurrency(0)).toBe(1);
    expect(defaultConcurrency(Number.NaN)).toBe(1);
    expect(defaultConcurrency(-4)).toBe(1);
  });
});
