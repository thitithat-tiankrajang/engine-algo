import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

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

describe("the client-side Super rollout switch", () => {
  it("is off unless the deployment turns it on", () => {
    // The safe direction to be wrong in: an operator who sets nothing gets the
    // backend path, which is the behaviour that predates all of this.
    expect(loadConfig(minimumEnv).clientSideSuper).toBe(false);
  });

  it("is the ONE switch — there is no second list beside it", () => {
    // Deliberately asserted rather than merely absent from the code.
    //
    // An earlier revision paired this flag with `CLIENT_SIDE_SUPER_USER_IDS`,
    // an allowlist of user ids. It was removed because it duplicated a decision
    // the platform already makes: `/v1/bot-config` authenticates the caller, and
    // who holds an account at all is the approval process's answer. Two lists
    // that must agree about the same people is one more thing to keep in step
    // and one more way to be quietly wrong.
    //
    // If a future change reintroduces one, this fails.
    const config = loadConfig({ ...minimumEnv, CLIENT_SIDE_SUPER: "true" });
    expect(config.clientSideSuper).toBe(true);

    // Narrowly scoped on purpose: `allowedOrigins` (CORS) and
    // `maxAnalysisPerUser` (rate limiting) are unrelated and legitimate. What
    // must not exist is a SECOND client-side-Super key naming an audience.
    const audienceKeys = Object.keys(config).filter(
      (key) => /champion/i.test(key) || (key.startsWith("clientSideSuper") && key !== "clientSideSuper"),
    );
    expect(audienceKeys).toEqual([]);
  });

  it("ignores an allowlist variable if one is still set in the environment", () => {
    // A leftover from the removed design must not resurrect it. Setting the old
    // variable changes nothing: the flag alone decides.
    const config = loadConfig({
      ...minimumEnv,
      CLIENT_SIDE_SUPER: "true",
      CLIENT_SIDE_SUPER_USER_IDS: "some-old-uuid,another-one",
    });
    expect(config.clientSideSuper).toBe(true);
  });
});
