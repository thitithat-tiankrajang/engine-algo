import { describe, expect, it } from "vitest";

import { clientSuperAllowedFor, loadConfig } from "../src/config.js";

const minimumEnv = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  ENGINE_ALLOWED_ORIGINS: "https://example.com",
};

describe("service configuration", () => {
  it("requires no shared JWT secret", () => {
    const config = loadConfig(minimumEnv);
    expect(config.supabaseUrl).toBe(minimumEnv.SUPABASE_URL);
    expect(config.supabasePublishableKey).toBe(minimumEnv.SUPABASE_PUBLISHABLE_KEY);
    expect(config).not.toHaveProperty("supabaseJwtSecret");
  });

  it("requires the low-privilege Supabase publishable key", () => {
    expect(() =>
      loadConfig({
        SUPABASE_URL: minimumEnv.SUPABASE_URL,
        ENGINE_ALLOWED_ORIGINS: minimumEnv.ENGINE_ALLOWED_ORIGINS,
      }),
    ).toThrow("SUPABASE_PUBLISHABLE_KEY is required");
  });
});

const oneCpu = { cpus: 1, source: "cgroup-v2" as const, parallelism: 16 };

describe("engine concurrency", () => {
  it("defaults to one search at a time on a 1-CPU container", () => {
    // The deployment this service is actually going to: Render Standard, one
    // CPU of quota, scheduled onto a much larger host. The affinity mask of 16
    // must not reach the queue.
    const config = loadConfig(minimumEnv, { cpu: oneCpu });
    expect(config.concurrency).toBe(1);
    expect(config.concurrencySource).toBe("derived");
    expect(config.cpu.parallelism).toBe(16);
  });

  it("defaults to one on a half-CPU container", () => {
    const config = loadConfig(minimumEnv, {
      cpu: { cpus: 0.5, source: "cgroup-v2", parallelism: 16 },
    });
    expect(config.concurrency).toBe(1);
  });

  it("keeps a CPU in reserve on a larger instance", () => {
    const config = loadConfig(minimumEnv, {
      cpu: { cpus: 4, source: "cgroup-v2", parallelism: 16 },
    });
    expect(config.concurrency).toBe(3);
  });

  it("honours an explicit setting and records that it was explicit", () => {
    const config = loadConfig(
      { ...minimumEnv, ENGINE_CONCURRENCY: "2" },
      { cpu: oneCpu },
    );
    expect(config.concurrency).toBe(2);
    expect(config.concurrencySource).toBe("env");
  });

  it("refuses to start on a concurrency that is not a whole number", () => {
    expect(() => loadConfig({ ...minimumEnv, ENGINE_CONCURRENCY: "1.5" }, { cpu: oneCpu })).toThrow(
      "ENGINE_CONCURRENCY must be a whole number",
    );
  });

  it("refuses to start on a concurrency that is not a number at all", () => {
    expect(() =>
      loadConfig({ ...minimumEnv, ENGINE_CONCURRENCY: "many" }, { cpu: oneCpu }),
    ).toThrow("ENGINE_CONCURRENCY must be a whole number");
  });

  it("refuses zero, which would accept work it could never run", () => {
    expect(() => loadConfig({ ...minimumEnv, ENGINE_CONCURRENCY: "0" }, { cpu: oneCpu })).toThrow(
      "ENGINE_CONCURRENCY must be between",
    );
  });

  it("refuses a negative concurrency", () => {
    expect(() => loadConfig({ ...minimumEnv, ENGINE_CONCURRENCY: "-2" }, { cpu: oneCpu })).toThrow(
      "ENGINE_CONCURRENCY must be between",
    );
  });

  it("refuses an absurd concurrency rather than forking hundreds of searches", () => {
    expect(() => loadConfig({ ...minimumEnv, ENGINE_CONCURRENCY: "500" }, { cpu: oneCpu })).toThrow(
      "ENGINE_CONCURRENCY must be between",
    );
  });

  it("ignores an empty setting instead of reading it as zero", () => {
    const config = loadConfig({ ...minimumEnv, ENGINE_CONCURRENCY: "  " }, { cpu: oneCpu });
    expect(config.concurrency).toBe(1);
    expect(config.concurrencySource).toBe("derived");
  });
});

describe("queue bounds", () => {
  it("scales the default queue depth with what the queue can drain", () => {
    // A fixed 64 means something very different at concurrency 1 than at 8: at
    // one search at a time it is a wait no player would sit through.
    expect(loadConfig(minimumEnv, { cpu: oneCpu }).maxWaiting).toBe(8);
    expect(
      loadConfig(minimumEnv, { cpu: { cpus: 8, source: "cgroup-v2", parallelism: 8 } }).maxWaiting,
    ).toBe(56);
  });

  it("lets an operator set the depth explicitly", () => {
    expect(
      loadConfig({ ...minimumEnv, ENGINE_MAX_WAITING: "20" }, { cpu: oneCpu }).maxWaiting,
    ).toBe(20);
  });

  it("bounds the queue in time as well as in depth", () => {
    expect(loadConfig(minimumEnv, { cpu: oneCpu }).maxQueueWaitMs).toBe(120_000);
    expect(
      loadConfig({ ...minimumEnv, ENGINE_MAX_QUEUE_WAIT_MS: "45000" }, { cpu: oneCpu })
        .maxQueueWaitMs,
    ).toBe(45_000);
  });
});

describe("analysis metering", () => {
  it("serialises analysis per account without rationing it", () => {
    const config = loadConfig(minimumEnv, { cpu: oneCpu });
    // One in flight at a time — and no budget to run out of.
    expect(config.maxAnalysisPerUser).toBe(1);
    expect(config.analysisBudgeted).toBe(false);
  });

  it("lets an operator ration analysis as well", () => {
    for (const spelling of ["true", "1", "on", "YES"]) {
      const config = loadConfig(
        { ...minimumEnv, ENGINE_ANALYSIS_BUDGETED: spelling },
        { cpu: oneCpu },
      );
      expect(config.analysisBudgeted).toBe(true);
    }
    expect(
      loadConfig({ ...minimumEnv, ENGINE_ANALYSIS_BUDGETED: "false" }, { cpu: oneCpu })
        .analysisBudgeted,
    ).toBe(false);
  });

  it("refuses a spelling it does not understand rather than reading it as off", () => {
    expect(() =>
      loadConfig({ ...minimumEnv, ENGINE_ANALYSIS_BUDGETED: "ture" }, { cpu: oneCpu }),
    ).toThrow("ENGINE_ANALYSIS_BUDGETED must be true or false");
  });
});

describe("reconnect result retention", () => {
  it("keeps completed work long enough for a player to return from another app", () => {
    const config = loadConfig(minimumEnv, { cpu: oneCpu });
    expect(config.analysisResultTtlMs).toBe(30 * 60 * 1000);
    expect(config.botResultTtlMs).toBe(30 * 60 * 1000);
  });
});

describe("the Champion rollout gate", () => {
  // Two independent switches, and the deployment has to set BOTH before any
  // browser runs Super locally. The tests below are mostly about what happens
  // when only one of them is set, because that is the state a half-finished
  // deployment is actually in.

  it("admits nobody by default", () => {
    const config = loadConfig(minimumEnv);
    expect(config.clientSideSuper).toBe(false);
    expect(config.clientSideSuperUserIds).toEqual([]);
    expect(clientSuperAllowedFor(config, "user-1")).toBe(false);
  });

  it("admits nobody when the switch is on but no audience is named", () => {
    // The important one. CLIENT_SIDE_SUPER=true on its own must reach ZERO
    // players — an operator who forgets the allowlist gets a no-op rollout,
    // never a silent general release.
    const config = loadConfig({ ...minimumEnv, CLIENT_SIDE_SUPER: "true" });
    expect(clientSuperAllowedFor(config, "user-1")).toBe(false);
  });

  it("admits nobody when an audience is named but the switch is off", () => {
    // The switch is what an operator reaches for when the client-side path
    // misbehaves. An allowlist that could outvote it would make that reach
    // useless at the exact moment it matters.
    const config = loadConfig({
      ...minimumEnv,
      CLIENT_SIDE_SUPER: "false",
      CLIENT_SIDE_SUPER_USER_IDS: "user-1",
    });
    expect(clientSuperAllowedFor(config, "user-1")).toBe(false);
  });

  it("admits the named Champions and nobody else", () => {
    const config = loadConfig({
      ...minimumEnv,
      CLIENT_SIDE_SUPER: "true",
      CLIENT_SIDE_SUPER_USER_IDS: " user-1 , user-2 ",
    });
    expect(config.clientSideSuperUserIds).toEqual(["user-1", "user-2"]);
    expect(clientSuperAllowedFor(config, "user-1")).toBe(true);
    expect(clientSuperAllowedFor(config, "user-2")).toBe(true);
    expect(clientSuperAllowedFor(config, "user-3")).toBe(false);
  });

  it("ignores the case a UUID was pasted in", () => {
    const config = loadConfig({
      ...minimumEnv,
      CLIENT_SIDE_SUPER: "true",
      CLIENT_SIDE_SUPER_USER_IDS: "A1B2C3D4-0000-4000-8000-000000000000",
    });
    expect(clientSuperAllowedFor(config, "a1b2c3d4-0000-4000-8000-000000000000")).toBe(true);
  });

  it("opens the path to everyone only when `*` is spelled out alone", () => {
    const config = loadConfig({
      ...minimumEnv,
      CLIENT_SIDE_SUPER: "true",
      CLIENT_SIDE_SUPER_USER_IDS: "*",
    });
    expect(clientSuperAllowedFor(config, "anybody-at-all")).toBe(true);
  });

  it("refuses `*` mixed with named ids rather than guessing", () => {
    // "These Champions, plus everyone" is either a mistake or a half-finished
    // graduation of the beta, and both want a human to look. Refusing at boot
    // is the loudest available way to ask.
    expect(() =>
      loadConfig({
        ...minimumEnv,
        CLIENT_SIDE_SUPER: "true",
        CLIENT_SIDE_SUPER_USER_IDS: "user-1,*",
      }),
    ).toThrow(/may be "\*" \(everyone\) or a list of user ids, not both/);
  });
});
