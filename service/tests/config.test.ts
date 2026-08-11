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
