import { describe, expect, it, vi } from "vitest";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

import {
  KNOWN_LLM_INSTRUMENTATION_SCOPE_PREFIXES,
  KUBIT_TRACER_NAME,
  isDefaultExportSpan,
  isGenAISpan,
  isKnownLLMInstrumentor,
  isKubitSpan,
} from "./spanFilter";

function makeSpan(opts: {
  scopeName?: string | null;
  attrs?: Record<string, unknown>;
  name?: string;
}): ReadableSpan {
  const { scopeName, attrs = {}, name = "test-span" } = opts;
  return {
    name,
    attributes: attrs,
    instrumentationScope:
      scopeName === null || scopeName === undefined
        ? undefined
        : { name: scopeName, version: "0" },
  } as unknown as ReadableSpan;
}

describe("isKubitSpan", () => {
  it("matches kubit-sdk scope", () => {
    expect(isKubitSpan(makeSpan({ scopeName: KUBIT_TRACER_NAME }))).toBe(true);
  });
  it("rejects other scopes", () => {
    expect(isKubitSpan(makeSpan({ scopeName: "langfuse-sdk" }))).toBe(false);
  });
  it("rejects null scope", () => {
    expect(isKubitSpan(makeSpan({ scopeName: null }))).toBe(false);
  });
});

describe("isGenAISpan", () => {
  it("matches gen_ai.* attribute", () => {
    expect(
      isGenAISpan(makeSpan({ attrs: { "gen_ai.request.model": "gpt-4" } })),
    ).toBe(true);
  });
  it("rejects non-genai attrs", () => {
    expect(isGenAISpan(makeSpan({ attrs: { "http.method": "GET" } }))).toBe(
      false,
    );
  });
  it("rejects empty attrs", () => {
    expect(isGenAISpan(makeSpan({}))).toBe(false);
  });
});

describe("isKnownLLMInstrumentor", () => {
  const accepted = [
    "kubit-sdk",
    "langfuse-sdk",
    "langfuse-sdk.generation",
    "ai",
  ];
  const rejected = [
    "",
    "my_framework",
    "opentelemetry.instrumentation.requests",
    "opentelemetry.instrumentation.fastapi",
  ];
  it.each(accepted)("accepts scope %s", (scope) => {
    expect(isKnownLLMInstrumentor(makeSpan({ scopeName: scope }))).toBe(true);
  });
  it.each(rejected)("rejects scope %s", (scope) => {
    expect(isKnownLLMInstrumentor(makeSpan({ scopeName: scope }))).toBe(false);
  });
  it("rejects null scope", () => {
    expect(isKnownLLMInstrumentor(makeSpan({ scopeName: null }))).toBe(false);
  });
});

describe("isDefaultExportSpan", () => {
  it("true when kubit-sdk", () => {
    expect(isDefaultExportSpan(makeSpan({ scopeName: KUBIT_TRACER_NAME }))).toBe(
      true,
    );
  });
  it("true when gen_ai attr present even on unknown scope", () => {
    expect(
      isDefaultExportSpan(
        makeSpan({
          scopeName: "random_scope",
          attrs: { "gen_ai.request.model": "gpt-4" },
        }),
      ),
    ).toBe(true);
  });
  it("true for known LLM instrumentor", () => {
    expect(
      isDefaultExportSpan(makeSpan({ scopeName: "langfuse-sdk" })),
    ).toBe(true);
  });
  it("false for generic http span", () => {
    expect(
      isDefaultExportSpan(
        makeSpan({
          scopeName: "opentelemetry.instrumentation.requests",
          attrs: { "http.method": "GET" },
        }),
      ),
    ).toBe(false);
  });
});

describe("known prefixes includes kubit", () => {
  it("KNOWN_LLM_INSTRUMENTATION_SCOPE_PREFIXES contains kubit-sdk", () => {
    expect(KNOWN_LLM_INSTRUMENTATION_SCOPE_PREFIXES).toContain(
      KUBIT_TRACER_NAME,
    );
  });
});

describe("KubitSpanProcessor filtering", () => {
  async function loadProcessor() {
    vi.resetModules();
    vi.doMock("./exporter", () => ({
      KubitExporter: class {
        export() {}
        shutdown() {
          return Promise.resolve();
        }
        forceFlush() {
          return Promise.resolve();
        }
      },
    }));
    return (await import("./processor")).KubitSpanProcessor;
  }

  // Stub the BatchSpanProcessor's onEnd on the grandparent prototype so we can
  // observe forwarding without BatchSpanProcessor poking at span internals.
  function stubSuperOnEnd(proc: object) {
    const grandparentProto = Object.getPrototypeOf(
      Object.getPrototypeOf(proc),
    );
    const original = grandparentProto.onEnd;
    const stub = vi.fn();
    grandparentProto.onEnd = stub;
    return {
      stub,
      restore: () => {
        grandparentProto.onEnd = original;
      },
    };
  }

  it("forwards when predicate returns true", async () => {
    const KubitSpanProcessor = await loadProcessor();
    const proc = new KubitSpanProcessor({
      apiKey: "rg.v1.x.y",
      shouldExportSpan: () => true,
    });
    const { stub, restore } = stubSuperOnEnd(proc);
    const span = makeSpan({ scopeName: "langfuse-sdk" });
    proc.onEnd(span);
    expect(stub).toHaveBeenCalledWith(span);
    restore();
  });

  it("drops when predicate returns false", async () => {
    const KubitSpanProcessor = await loadProcessor();
    const proc = new KubitSpanProcessor({
      apiKey: "rg.v1.x.y",
      shouldExportSpan: () => false,
    });
    const { stub, restore } = stubSuperOnEnd(proc);
    proc.onEnd(makeSpan({ scopeName: "langfuse-sdk" }));
    expect(stub).not.toHaveBeenCalled();
    restore();
  });

  it("drops when predicate throws", async () => {
    const KubitSpanProcessor = await loadProcessor();
    const proc = new KubitSpanProcessor({
      apiKey: "rg.v1.x.y",
      shouldExportSpan: () => {
        throw new Error("predicate exploded");
      },
    });
    const { stub, restore } = stubSuperOnEnd(proc);
    proc.onEnd(makeSpan({ scopeName: "langfuse-sdk" }));
    expect(stub).not.toHaveBeenCalled();
    restore();
  });

  it("default predicate keeps langfuse-sdk, drops http", async () => {
    const KubitSpanProcessor = await loadProcessor();
    const proc = new KubitSpanProcessor({ apiKey: "rg.v1.x.y" });
    const { stub, restore } = stubSuperOnEnd(proc);
    const llm = makeSpan({ scopeName: "langfuse-sdk" });
    const http = makeSpan({
      scopeName: "opentelemetry.instrumentation.requests",
      attrs: { "http.method": "GET" },
    });
    proc.onEnd(llm);
    proc.onEnd(http);
    expect(stub).toHaveBeenCalledTimes(1);
    expect(stub).toHaveBeenCalledWith(llm);
    restore();
  });
});
