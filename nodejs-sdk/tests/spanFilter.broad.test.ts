import { describe, expect, it } from "vitest";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

import {
  isDefaultExportSpan,
  isKnownLLMInstrumentor,
  isMastraInternalSpan,
} from "../src/spanFilter";

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
    // Mastra AI framework
    "@mastra/kubit",
    "@mastra/core",
    "@mastra/otel-exporter",
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

describe("Mastra span filtering", () => {
  // Every Mastra-emitted span carries a `mastra.span.type` discriminator.
  // The `model_chunk` value flags stream-coordination spans (payload always
  // `"{}"`); the default Kubit filter drops them on ingest.
  const KEEP_TYPES = [
    "agent_run",
    "workflow_run",
    "model_generation",
    "model_step",
    "processor_run",
    "tool_call",
    "mcp_tool_call",
    "generic",
  ];

  it("isMastraInternalSpan flags only model_chunk", () => {
    expect(
      isMastraInternalSpan(
        makeSpan({ attrs: { "mastra.span.type": "model_chunk" } }),
      ),
    ).toBe(true);
    for (const t of KEEP_TYPES) {
      expect(
        isMastraInternalSpan(makeSpan({ attrs: { "mastra.span.type": t } })),
      ).toBe(false);
    }
    // Span without the discriminator at all
    expect(isMastraInternalSpan(makeSpan({}))).toBe(false);
  });

  it("isDefaultExportSpan drops model_chunk even with gen_ai.* attrs", () => {
    expect(
      isDefaultExportSpan(
        makeSpan({
          scopeName: "@mastra/kubit",
          attrs: {
            "mastra.span.type": "model_chunk",
            "gen_ai.operation.name": "model_chunk",
          },
        }),
      ),
    ).toBe(false);
  });

  it.each(KEEP_TYPES)(
    "isDefaultExportSpan keeps mastra.span.type=%s",
    (spanType) => {
      expect(
        isDefaultExportSpan(
          makeSpan({
            scopeName: "@mastra/kubit",
            attrs: {
              "mastra.span.type": spanType,
              "gen_ai.operation.name": spanType,
            },
          }),
        ),
      ).toBe(true);
    },
  );

  it("scope @mastra/kubit alone (no gen_ai.* attrs) passes via the prefix allow-list", () => {
    expect(
      isDefaultExportSpan(
        makeSpan({
          scopeName: "@mastra/kubit",
          attrs: { "mastra.span.type": "generic" },
        }),
      ),
    ).toBe(true);
  });
});
