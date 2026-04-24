import { describe, expect } from "vitest";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

import { isKnownLLMInstrumentor } from "../../../spanFilter";

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

// NOTE: These assertions exercise the BROAD instrumentation-scope allow-list
// that covered openinference, langsmith, braintrust, logfire, traceloop, the
// OpenLLMetry vendor family, OpenAI Agents, and Vercel AI. The shipped SDK
// currently narrows `KNOWN_LLM_INSTRUMENTATION_SCOPE_PREFIXES` to just
// `["kubit-sdk", "langfuse-sdk"]`, so these cases are kept here as a
// re-enablement reference only and are skipped.
describe.skip("isKnownLLMInstrumentor (broad allow-list, currently disabled)", () => {
  const accepted = [
    "openinference",
    "openinference.instrumentation.openai",
    "langsmith",
    "litellm",
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
