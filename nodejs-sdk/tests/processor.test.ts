import { describe, expect, it, vi } from "vitest";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { resourceFromAttributes } from "@opentelemetry/resources";

vi.mock("@opentelemetry/exporter-trace-otlp-proto", () => ({
  OTLPTraceExporter: class {
    export = vi.fn();
    shutdown = vi.fn().mockResolvedValue(undefined);
    forceFlush = vi.fn().mockResolvedValue(undefined);
  },
}));

function makeSpan() {
  return {
    name: "test-span",
    instrumentationScope: { name: "test-scope" },
  } as any;
}

describe("KubitSpanProcessor — span filtering", () => {
  it("drops a span when shouldExportSpan returns false", async () => {
    const { KubitSpanProcessor } = await import("../src/processor");
    const proc = new KubitSpanProcessor({
      apiKey: "rg.v1.x.y",
      shouldExportSpan: () => false,
    });
    const superEnd = vi
      .spyOn(BatchSpanProcessor.prototype, "onEnd")
      .mockImplementation(() => {});

    proc.onEnd(makeSpan());

    expect(superEnd).not.toHaveBeenCalled();
    superEnd.mockRestore();
  });

  it("forwards a span when shouldExportSpan returns true", async () => {
    const { KubitSpanProcessor } = await import("../src/processor");
    const proc = new KubitSpanProcessor({
      apiKey: "rg.v1.x.y",
      shouldExportSpan: () => true,
    });
    const superEnd = vi
      .spyOn(BatchSpanProcessor.prototype, "onEnd")
      .mockImplementation(() => {});

    proc.onEnd(makeSpan());

    expect(superEnd).toHaveBeenCalledTimes(1);
    superEnd.mockRestore();
  });

  it("drops a span when shouldExportSpan throws", async () => {
    const { KubitSpanProcessor } = await import("../src/processor");
    const proc = new KubitSpanProcessor({
      apiKey: "rg.v1.x.y",
      shouldExportSpan: () => {
        throw new Error("kaboom");
      },
    });
    const superEnd = vi
      .spyOn(BatchSpanProcessor.prototype, "onEnd")
      .mockImplementation(() => {});

    proc.onEnd(makeSpan());

    expect(superEnd).not.toHaveBeenCalled();
    superEnd.mockRestore();
  });
});

describe("KubitSpanProcessor — kubit.sdk.* stamping", () => {
  it("stamps kubit.sdk.name and kubit.sdk.version on every span via onStart", async () => {
    // Provider whose Resource intentionally lacks kubit.sdk.* — mirrors the
    // case where a user assembles their own NodeTracerProvider and just plugs
    // KubitSpanProcessor into spanProcessors[].
    const { KubitSpanProcessor } = await import("../src/processor");
    const { VERSION } = await import("../src/version");
    const provider = new BasicTracerProvider({
      resource: resourceFromAttributes({ "service.name": "user-app" }),
      spanProcessors: [new KubitSpanProcessor({ apiKey: "rg.v1.x.y" })],
    });

    const tracer = provider.getTracer("test");
    const span = tracer.startSpan("op");
    span.end();

    const attrs = (span as unknown as { attributes: Record<string, unknown> })
      .attributes;
    expect(attrs["kubit.sdk.name"]).toBe("kubit-otel-node");
    expect(attrs["kubit.sdk.version"]).toBe(VERSION);
  });
});
