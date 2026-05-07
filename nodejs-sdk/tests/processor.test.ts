import { describe, expect, it, vi } from "vitest";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";

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
