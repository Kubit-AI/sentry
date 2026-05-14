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
    const { SDK_NAME, VERSION } = await import("../src/version");
    const provider = new BasicTracerProvider({
      resource: resourceFromAttributes({ "service.name": "user-app" }),
      spanProcessors: [new KubitSpanProcessor({ apiKey: "rg.v1.x.y" })],
    });

    const tracer = provider.getTracer("test");
    const span = tracer.startSpan("op");
    span.end();

    const attrs = (span as unknown as { attributes: Record<string, unknown> })
      .attributes;
    expect(attrs["kubit.sdk.name"]).toBe(SDK_NAME);
    expect(attrs["kubit.sdk.version"]).toBe(VERSION);
  });

  it("stamps kubit.sdk.name and kubit.sdk.version when onEnd is invoked directly without onStart", async () => {
    // Mirrors bridge-exporter integrations (e.g. Mastra's KubitMastraExporter)
    // which synthesize a ReadableSpan and call `onEnd` directly — the `onStart`
    // hook never runs, so attributes must be stamped defensively in `onEnd`.
    const { KubitSpanProcessor } = await import("../src/processor");
    const { SDK_NAME, VERSION } = await import("../src/version");
    const proc = new KubitSpanProcessor({
      apiKey: "rg.v1.x.y",
      shouldExportSpan: () => true,
    });
    const superEnd = vi
      .spyOn(BatchSpanProcessor.prototype, "onEnd")
      .mockImplementation(() => {});

    const span = {
      name: "bridged-span",
      instrumentationScope: { name: "test-scope" },
      attributes: {} as Record<string, unknown>,
    } as any;

    proc.onEnd(span);

    expect(span.attributes["kubit.sdk.name"]).toBe(SDK_NAME);
    expect(span.attributes["kubit.sdk.version"]).toBe(VERSION);
    expect(superEnd).toHaveBeenCalledTimes(1);
    superEnd.mockRestore();
  });

  it("force-overwrites kubit.sdk.* on the mask path even if mask deletes them", async () => {
    // Pipeline contract: when a mask is configured, kubit.sdk.{name,version}
    // must survive the mask regardless of how aggressive it is. Cylon's
    // per-SDK identification rides on these keys.
    const { KubitSpanProcessor } = await import("../src/processor");
    const { SDK_NAME, VERSION } = await import("../src/version");
    const { deleteAttr } = await import("../src/mask");

    const proc = new KubitSpanProcessor({
      apiKey: "rg.v1.x.y",
      shouldExportSpan: () => true,
      mask: (span) => {
        deleteAttr(span, "kubit.sdk.name");
        deleteAttr(span, "kubit.sdk.version");
        return span;
      },
    });
    const superEnd = vi
      .spyOn(BatchSpanProcessor.prototype, "onEnd")
      .mockImplementation(() => {});

    const span = {
      name: "test-span",
      instrumentationScope: { name: "test-scope" },
      attributes: {
        "kubit.sdk.name": SDK_NAME,
        "kubit.sdk.version": VERSION,
      } as Record<string, unknown>,
    } as any;

    proc.onEnd(span);

    expect(span.attributes["kubit.sdk.name"]).toBe(SDK_NAME);
    expect(span.attributes["kubit.sdk.version"]).toBe(VERSION);
    expect(superEnd).toHaveBeenCalledTimes(1);
    superEnd.mockRestore();
  });

  it("does not overwrite existing kubit.sdk.* attributes in onEnd", async () => {
    const { KubitSpanProcessor } = await import("../src/processor");
    const proc = new KubitSpanProcessor({
      apiKey: "rg.v1.x.y",
      shouldExportSpan: () => true,
    });
    const superEnd = vi
      .spyOn(BatchSpanProcessor.prototype, "onEnd")
      .mockImplementation(() => {});

    const span = {
      name: "preset-span",
      instrumentationScope: { name: "test-scope" },
      attributes: {
        "kubit.sdk.name": "preset",
        "kubit.sdk.version": "0.0.0-test",
      } as Record<string, unknown>,
    } as any;

    proc.onEnd(span);

    expect(span.attributes["kubit.sdk.name"]).toBe("preset");
    expect(span.attributes["kubit.sdk.version"]).toBe("0.0.0-test");
    superEnd.mockRestore();
  });
});

describe("KubitSpanProcessor — mask integration", () => {
  function makeMaskableSpan() {
    return {
      name: "test-span",
      instrumentationScope: { name: "test-scope" },
      attributes: {} as Record<string, unknown>,
      spanContext: () => ({ traceId: "00", spanId: "00", traceFlags: 0 }),
    } as any;
  }

  it("does not invoke mask when shouldExportSpan filters the span out", async () => {
    const { KubitSpanProcessor } = await import("../src/processor");
    const calls: unknown[] = [];
    const proc = new KubitSpanProcessor({
      apiKey: "rg.v1.x.y",
      shouldExportSpan: () => false,
      mask: (s) => {
        calls.push(s);
        return s;
      },
    });
    const superEnd = vi
      .spyOn(BatchSpanProcessor.prototype, "onEnd")
      .mockImplementation(() => {});

    proc.onEnd(makeMaskableSpan());

    expect(calls).toEqual([]);
    expect(superEnd).not.toHaveBeenCalled();
    superEnd.mockRestore();
  });

  it("invokes mask when the filter keeps the span", async () => {
    const { KubitSpanProcessor } = await import("../src/processor");
    const calls: unknown[] = [];
    const proc = new KubitSpanProcessor({
      apiKey: "rg.v1.x.y",
      shouldExportSpan: () => true,
      mask: (s) => {
        calls.push(s);
        return s;
      },
    });
    const superEnd = vi
      .spyOn(BatchSpanProcessor.prototype, "onEnd")
      .mockImplementation(() => {});

    const span = makeMaskableSpan();
    proc.onEnd(span);

    expect(calls).toEqual([span]);
    expect(superEnd).toHaveBeenCalledTimes(1);
    superEnd.mockRestore();
  });

  it("drops the span fail-closed when mask throws", async () => {
    const { KubitSpanProcessor } = await import("../src/processor");
    const { logger } = await import("../src/logger");
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    const proc = new KubitSpanProcessor({
      apiKey: "rg.v1.x.y",
      shouldExportSpan: () => true,
      mask: () => {
        throw new Error("kaboom");
      },
    });
    const superEnd = vi
      .spyOn(BatchSpanProcessor.prototype, "onEnd")
      .mockImplementation(() => {});

    proc.onEnd(makeMaskableSpan());

    expect(superEnd).not.toHaveBeenCalled();
    // PRD story #11: a buggy mask must be visible without the data it was
    // meant to hide. Surface span id + exception class in the log line.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const msg = errorSpy.mock.calls[0]![0] as string;
    expect(msg).toContain("mask raised");
    expect(msg).toContain("kaboom");
    superEnd.mockRestore();
    errorSpy.mockRestore();
  });

  it("drops the span when mask returns null", async () => {
    // Returning null is a contract violation (drop via shouldExportSpan
    // instead). Treat it like an error path rather than propagate null into
    // BatchSpanProcessor.onEnd which would crash.
    const { KubitSpanProcessor } = await import("../src/processor");
    const { logger } = await import("../src/logger");
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    const proc = new KubitSpanProcessor({
      apiKey: "rg.v1.x.y",
      shouldExportSpan: () => true,
      mask: () => null as any,
    });
    const superEnd = vi
      .spyOn(BatchSpanProcessor.prototype, "onEnd")
      .mockImplementation(() => {});

    proc.onEnd(makeMaskableSpan());

    expect(superEnd).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const msg = errorSpy.mock.calls[0]![0] as string;
    expect(msg).toContain("mask returned null");
    superEnd.mockRestore();
    errorSpy.mockRestore();
  });

  it("forwards the span returned by mask, not the original", async () => {
    const { KubitSpanProcessor } = await import("../src/processor");
    const replacement = {
      name: "replaced",
      instrumentationScope: { name: "test-scope" },
      attributes: {} as Record<string, unknown>,
    } as any;
    const proc = new KubitSpanProcessor({
      apiKey: "rg.v1.x.y",
      shouldExportSpan: () => true,
      mask: () => replacement,
    });
    const superEnd = vi
      .spyOn(BatchSpanProcessor.prototype, "onEnd")
      .mockImplementation(() => {});

    proc.onEnd(makeMaskableSpan());

    expect(superEnd).toHaveBeenCalledWith(replacement);
    superEnd.mockRestore();
  });

  it("regression: with no mask configured, onEnd passes the span through unchanged", async () => {
    const { KubitSpanProcessor } = await import("../src/processor");
    const proc = new KubitSpanProcessor({
      apiKey: "rg.v1.x.y",
      shouldExportSpan: () => true,
    });
    const superEnd = vi
      .spyOn(BatchSpanProcessor.prototype, "onEnd")
      .mockImplementation(() => {});

    const span = makeMaskableSpan();
    proc.onEnd(span);

    expect(superEnd).toHaveBeenCalledTimes(1);
    expect(superEnd).toHaveBeenCalledWith(span);
    superEnd.mockRestore();
  });
});

describe("KubitSpanProcessor — mask end-to-end via real provider", () => {
  it("user attribute rewrites flow through to the exported span", async () => {
    const { KubitSpanProcessor } = await import("../src/processor");
    const { setAttr } = await import("../src/mask");

    const captured: Array<Record<string, unknown>> = [];
    const superEnd = vi
      .spyOn(BatchSpanProcessor.prototype, "onEnd")
      .mockImplementation(function (this: any, s: any) {
        captured.push({ ...(s.attributes as Record<string, unknown>) });
      });

    const provider = new BasicTracerProvider({
      resource: resourceFromAttributes({ "service.name": "user-app" }),
      spanProcessors: [
        new KubitSpanProcessor({
          apiKey: "rg.v1.x.y",
          shouldExportSpan: () => true,
          mask: (span) => {
            setAttr(span, "gen_ai.prompt", "[REDACTED]");
            return span;
          },
        }),
      ],
    });

    const tracer = provider.getTracer("kubit-sdk");
    const span = tracer.startSpan("op");
    span.setAttribute("gen_ai.prompt", "card 4111-1111-1111-1111");
    span.end();

    expect(captured).toHaveLength(1);
    expect(captured[0]!["gen_ai.prompt"]).toBe("[REDACTED]");
    superEnd.mockRestore();
  });

  it("maskEvents drops a targeted event end-to-end", async () => {
    // OTel GenAI v2 puts prompts/completions in span *events*. Verify that
    // `maskEvents` drops the targeted event in the path that reaches
    // BatchSpanProcessor.onEnd.
    const { KubitSpanProcessor } = await import("../src/processor");
    const { maskEvents } = await import("../src/mask");

    const captured: Array<string[]> = [];
    const superEnd = vi
      .spyOn(BatchSpanProcessor.prototype, "onEnd")
      .mockImplementation(function (this: any, s: any) {
        captured.push((s.events ?? []).map((e: any) => e.name));
      });

    const provider = new BasicTracerProvider({
      resource: resourceFromAttributes({ "service.name": "user-app" }),
      spanProcessors: [
        new KubitSpanProcessor({
          apiKey: "rg.v1.x.y",
          shouldExportSpan: () => true,
          mask: (span) => {
            maskEvents(span, (e) =>
              e.name === "gen_ai.user.message" ? null : e,
            );
            return span;
          },
        }),
      ],
    });

    const tracer = provider.getTracer("kubit-sdk");
    const span = tracer.startSpan("op");
    span.addEvent("gen_ai.user.message", { content: "ssn 111-22-3333" });
    span.addEvent("gen_ai.assistant.message", { content: "ok" });
    span.end();

    expect(captured).toEqual([["gen_ai.assistant.message"]]);
    superEnd.mockRestore();
  });
});
