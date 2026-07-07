import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ENDPOINT, resolveConfig } from "../src/config";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveConfig — precedence: options > env > default", () => {
  it("falls back to built-in defaults when nothing is set", () => {
    const config = resolveConfig();

    expect(config.apiKey).toBe("");
    expect(config.endpoint).toBe(DEFAULT_ENDPOINT);
    expect(config.serviceName).toBeUndefined();
    expect(config.debug).toBe(false);
    expect(config.getSessionId).toBeUndefined();
  });

  it("reads KUBIT_OTEL_API_KEY / KUBIT_OTEL_ENDPOINT / KUBIT_SERVICE_NAME from env", () => {
    vi.stubEnv("KUBIT_OTEL_API_KEY", "rg.v1.env");
    vi.stubEnv("KUBIT_OTEL_ENDPOINT", "https://otel-int.kubit.ai/v1/traces");
    vi.stubEnv("KUBIT_SERVICE_NAME", "env-app");

    const config = resolveConfig();

    expect(config.apiKey).toBe("rg.v1.env");
    expect(config.endpoint).toBe("https://otel-int.kubit.ai/v1/traces");
    expect(config.serviceName).toBe("env-app");
  });

  it("lets explicit options win over env vars", () => {
    vi.stubEnv("KUBIT_OTEL_API_KEY", "rg.v1.env");
    vi.stubEnv("KUBIT_OTEL_ENDPOINT", "https://env.example/v1/traces");
    vi.stubEnv("KUBIT_SERVICE_NAME", "env-app");

    const config = resolveConfig({
      apiKey: "rg.v1.option",
      endpoint: "https://option.example/v1/traces",
      serviceName: "option-app",
    });

    expect(config.apiKey).toBe("rg.v1.option");
    expect(config.endpoint).toBe("https://option.example/v1/traces");
    expect(config.serviceName).toBe("option-app");
  });
});

describe("resolveConfig — sessionId normalization", () => {
  it("wraps a string sessionId into a constant reader", () => {
    const config = resolveConfig({ sessionId: "sess-fixed" });

    expect(config.getSessionId?.()).toBe("sess-fixed");
    expect(config.getSessionId?.()).toBe("sess-fixed");
  });

  it("passes a function sessionId through as the reader (called per event)", () => {
    let n = 0;
    const config = resolveConfig({ sessionId: () => `sess-${(n += 1)}` });

    expect(config.getSessionId?.()).toBe("sess-1");
    expect(config.getSessionId?.()).toBe("sess-2");
  });
});
