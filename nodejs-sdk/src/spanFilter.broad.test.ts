import { describe, expect, it } from "vitest";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

import { isKnownLLMInstrumentor } from "./spanFilter";

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

// Assertions covering the broad instrumentation-scope allow-list:
// openinference, langsmith, braintrust, logfire, traceloop, the OpenLLMetry
// vendor family, OpenAI Agents, and Vercel AI.
describe("isKnownLLMInstrumentor (broad allow-list)", () => {
  const accepted = [
    "openinference",
    "openinference.instrumentation.openai",
    "langsmith",
    "ai",
    "ai.vercel",
    "braintrust",
    "logfire",
    "opentelemetry.instrumentation.openai",
    "opentelemetry.instrumentation.anthropic",
    "opentelemetry.instrumentation.bedrock",
    "vllm",
    // Integration-skill frameworks
    "opentelemetry.instrumentation.openai_agents",
    "opentelemetry.instrumentation.openai_agents.sub",
    "traceloop.tracer",
    "@traceloop/node-server-sdk",
  ];
  const rejected = [
    "openinfer", // boundary
    "opentelemetry.instrumentation.fastapi",
    "opentelemetry.instrumentation.requests",
    "sqlalchemy",
    "my_framework",
    "",
  ];
  it.each(accepted)("accepts scope %s", (scope) => {
    expect(isKnownLLMInstrumentor(makeSpan({ scopeName: scope }))).toBe(true);
  });
  it.each(rejected)("rejects scope %s", (scope) => {
    expect(isKnownLLMInstrumentor(makeSpan({ scopeName: scope }))).toBe(false);
  });
  it("openai still matches after openai_agents prefix added", () => {
    // Guard against the more-specific `openai_agents` prefix shadowing `openai`.
    expect(
      isKnownLLMInstrumentor(
        makeSpan({ scopeName: "opentelemetry.instrumentation.openai" }),
      ),
    ).toBe(true);
    expect(
      isKnownLLMInstrumentor(
        makeSpan({ scopeName: "opentelemetry.instrumentation.openai.chat" }),
      ),
    ).toBe(true);
  });
});
