import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExport = vi.fn();
const mockShutdown = vi.fn().mockResolvedValue(undefined);
const mockForceFlush = vi.fn().mockResolvedValue(undefined);
const constructorCalls: any[] = [];

vi.mock("@opentelemetry/exporter-trace-otlp-proto", () => ({
  OTLPTraceExporter: class {
    constructor(opts: any) {
      constructorCalls.push(opts);
    }
    export = mockExport;
    shutdown = mockShutdown;
    forceFlush = mockForceFlush;
  },
}));

const DEFAULT = "https://otel.kubit.ai/v1/traces";

beforeEach(() => {
  constructorCalls.length = 0;
  mockExport.mockReset();
  mockShutdown.mockReset().mockResolvedValue(undefined);
  mockForceFlush.mockReset().mockResolvedValue(undefined);
  delete process.env.KUBIT_OTEL_ENDPOINT;
  delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
});

describe("KubitExporter — endpoint resolution", () => {
  it("uses default endpoint when nothing set", async () => {
    const { KubitExporter } = await import("../src/exporter");
    new KubitExporter({ apiKey: "rg.v1.x.y" });
    expect(constructorCalls[0].url).toBe(DEFAULT);
    expect(constructorCalls[0].headers).toEqual({ "x-api-key": "rg.v1.x.y" });
  });

  it("explicit endpoint beats env var", async () => {
    process.env.KUBIT_OTEL_ENDPOINT = "https://env.example/v1/traces";
    const { KubitExporter } = await import("../src/exporter");
    new KubitExporter({
      apiKey: "rg.v1.x.y",
      endpoint: "https://explicit.example/v1/traces",
    });
    expect(constructorCalls[0].url).toBe("https://explicit.example/v1/traces");
  });

  it("KUBIT_OTEL_ENDPOINT env wins when no explicit arg", async () => {
    process.env.KUBIT_OTEL_ENDPOINT = "https://env.example/v1/traces";
    const { KubitExporter } = await import("../src/exporter");
    new KubitExporter({ apiKey: "rg.v1.x.y" });
    expect(constructorCalls[0].url).toBe("https://env.example/v1/traces");
  });

  it("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT skips our default and lets the inner exporter resolve", async () => {
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT =
      "https://otel.example/v1/traces";
    const { KubitExporter } = await import("../src/exporter");
    new KubitExporter({ apiKey: "rg.v1.x.y" });
    expect(constructorCalls[0].url).toBeUndefined();
    expect(constructorCalls[0].headers).toEqual({ "x-api-key": "rg.v1.x.y" });
  });
});

describe("KubitExporter — delegation", () => {
  it("export delegates to inner OTLPTraceExporter", async () => {
    const { KubitExporter } = await import("../src/exporter");
    const e = new KubitExporter({ apiKey: "rg.v1.x.y" });
    const spans: any = [{}, {}];
    const cb = vi.fn();
    e.export(spans, cb);
    expect(mockExport).toHaveBeenCalledWith(spans, cb);
  });

  it("shutdown delegates", async () => {
    const { KubitExporter } = await import("../src/exporter");
    const e = new KubitExporter({ apiKey: "rg.v1.x.y" });
    await e.shutdown();
    expect(mockShutdown).toHaveBeenCalled();
  });

  it("forceFlush delegates", async () => {
    const { KubitExporter } = await import("../src/exporter");
    const e = new KubitExporter({ apiKey: "rg.v1.x.y" });
    await e.forceFlush();
    expect(mockForceFlush).toHaveBeenCalled();
  });
});
