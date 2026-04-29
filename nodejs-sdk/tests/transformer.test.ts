import { describe, expect, it } from "vitest";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

import { transformSpans } from "../src/transformer";

type SpanEventInput = {
  name: string;
  attributes?: Record<string, unknown>;
  time?: [number, number];
};

function makeSpan(opts: {
  name?: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  kind?: SpanKind;
  attrs?: Record<string, unknown>;
  resourceAttrs?: Record<string, unknown>;
  scopeName?: string | null;
  scopeVersion?: string | null;
  startTime?: [number, number];
  endTime?: [number, number];
  statusCode?: SpanStatusCode;
  events?: SpanEventInput[];
}): ReadableSpan {
  const {
    name = "span",
    traceId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    spanId = "bbbbbbbbbbbbbbbb",
    parentSpanId,
    kind = SpanKind.INTERNAL,
    attrs = {},
    resourceAttrs = {},
    scopeName = "langfuse-sdk",
    scopeVersion = "4.5.0",
    startTime = [1_700_000_000, 0],
    endTime = [1_700_000_001, 0],
    statusCode = SpanStatusCode.UNSET,
    events = [],
  } = opts;

  return {
    name,
    kind,
    attributes: attrs,
    resource: { attributes: resourceAttrs },
    instrumentationScope:
      scopeName === null ? undefined : { name: scopeName, version: scopeVersion ?? "" },
    startTime,
    endTime,
    status: { code: statusCode },
    parentSpanContext:
      parentSpanId === undefined
        ? undefined
        : { traceId, spanId: parentSpanId, traceFlags: 1, isRemote: false },
    events,
    spanContext: () => ({
      traceId,
      spanId,
      traceFlags: 1,
      isRemote: false,
    }),
  } as unknown as ReadableSpan;
}

function observations(records: ReturnType<typeof transformSpans>) {
  return records.filter((r) => r.entity_type === "enriched_observation");
}

function trace(records: ReturnType<typeof transformSpans>) {
  const traces = records.filter((r) => r.entity_type === "trace");
  expect(traces).toHaveLength(1);
  return traces[0];
}

describe("Langfuse v4 generation span", () => {
  const attrs = () => ({
    "langfuse.observation.type": "generation",
    "langfuse.observation.model.name": "gpt-4o-mini-2024-07-18",
    "langfuse.observation.model.parameters": JSON.stringify({ temperature: 0.7 }),
    "langfuse.observation.input": JSON.stringify({ messages: [] }),
    "langfuse.observation.output": JSON.stringify({ content: "hi" }),
    "langfuse.observation.usage_details": JSON.stringify({
      input: 1009,
      output: 130,
      total: 1139,
      input_cache_read: 0,
    }),
    "langfuse.observation.cost_details": JSON.stringify({
      input: 0.001,
      output: 0.0002,
      total: 0.0012,
    }),
  });

  it("extracts model from model.name", () => {
    const [obs] = observations(
      transformSpans([makeSpan({ name: "ChatOpenAI", attrs: attrs() })], "wid", "claim"),
    );
    expect(obs.model).toBe("gpt-4o-mini-2024-07-18");
  });

  it("parses model_parameters from the Langfuse JSON blob", () => {
    const [obs] = observations(
      transformSpans([makeSpan({ attrs: attrs() })], "wid", "claim"),
    );
    expect(obs.model_parameters).toEqual({ temperature: 0.7 });
  });

  it("parses usage_details from JSON blob", () => {
    const [obs] = observations(
      transformSpans([makeSpan({ attrs: attrs() })], "wid", "claim"),
    );
    const usage = obs.usage_details as Record<string, number>;
    expect(usage.input).toBe(1009);
    expect(usage.output).toBe(130);
    expect(usage.total).toBe(1139);
    expect(usage.input_cache_read).toBe(0);
  });

  it("parses cost_details from JSON blob and recovers total_cost", () => {
    const [obs] = observations(
      transformSpans([makeSpan({ attrs: attrs() })], "wid", "claim"),
    );
    expect(obs.cost_details).toEqual({ input: 0.001, output: 0.0002, total: 0.0012 });
    expect(obs.total_cost).toBe(0.0012);
  });

  it("forces type=GENERATION even on INTERNAL kind", () => {
    const [obs] = observations(
      transformSpans(
        [makeSpan({ kind: SpanKind.INTERNAL, attrs: attrs() })],
        "wid",
        "claim",
      ),
    );
    expect(obs.type).toBe("GENERATION");
  });
});

describe("Langfuse v4 non-generation span types", () => {
  it("type=span stays SPAN", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            name: "RunnableSequence",
            attrs: {
              "langfuse.observation.type": "span",
              "langfuse.observation.input": JSON.stringify({ x: 1 }),
              "langfuse.observation.output": JSON.stringify({ y: 2 }),
            },
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect(obs.type).toBe("SPAN");
    expect(obs.model).toBeNull();
    expect(obs.usage_details).toEqual({});
    expect(obs.cost_details).toEqual({});
    expect(obs.input_messages_raw).toBe(JSON.stringify({ x: 1 }));
  });

  it("type=tool maps to TOOL", () => {
    const [obs] = observations(
      transformSpans(
        [makeSpan({ attrs: { "langfuse.observation.type": "tool" } })],
        "wid",
        "claim",
      ),
    );
    expect(obs.type).toBe("TOOL");
  });

  it("type=chain maps to CHAIN", () => {
    const [obs] = observations(
      transformSpans(
        [makeSpan({ attrs: { "langfuse.observation.type": "chain" } })],
        "wid",
        "claim",
      ),
    );
    expect(obs.type).toBe("CHAIN");
  });

  it("type=agent maps to AGENT", () => {
    const [obs] = observations(
      transformSpans(
        [makeSpan({ attrs: { "langfuse.observation.type": "agent" } })],
        "wid",
        "claim",
      ),
    );
    expect(obs.type).toBe("AGENT");
  });

  // The Langfuse JS SDK emits `langfuse.observation.type=span` for the
  // LangChain wrapper spans (LangGraph root, `tools`, `model_request`,
  // `RunnableLambda`, `__start__`) where the Python SDK emits `chain`. Fold
  // the JS literal back to CHAIN when the integration metadata says we're
  // inside a langchain run, so cross-SDK observation types stay aligned.
  it("type=span folds to CHAIN when ls_integration is langchain_*", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            attrs: {
              "langfuse.observation.type": "span",
              "langfuse.observation.metadata.ls_integration": "langchain_create_agent",
            },
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect(obs.type).toBe("CHAIN");
  });

  it("type=span without langchain integration stays SPAN", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            attrs: {
              "langfuse.observation.type": "span",
              "langfuse.observation.metadata.ls_integration": "openai",
            },
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect(obs.type).toBe("SPAN");
  });
});

describe("Langfuse provider/model alias coverage", () => {
  it("populates provider from langfuse.observation.metadata.ls_provider", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            attrs: {
              "langfuse.observation.metadata.ls_provider": "anthropic",
            },
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect(obs.provider).toBe("anthropic");
  });

  it("populates provided_model_name from langfuse.observation.metadata.ls_model_name", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            attrs: {
              "langfuse.observation.metadata.ls_model_name": "claude-sonnet-4-6",
            },
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect(obs.provided_model_name).toBe("claude-sonnet-4-6");
  });

  // Confirms that finding #7 (tool-span output stringified as ToolMessage
  // Serializable JSON-blob) is closed by the langchain envelope routing
  // already in place from the previous fix. ToolMessage Serializables in
  // `langfuse.observation.output` should produce a clean tool_call_response
  // part, lifting the `tool_call_id` linkage and the tool name onto the
  // canonical message.
  it("normalizes ToolMessage Serializable in langfuse output to tool_call_response", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            attrs: {
              "langfuse.observation.type": "tool",
              "langfuse.observation.output": JSON.stringify({
                lc: 1,
                type: "constructor",
                id: ["langchain_core", "messages", "ToolMessage"],
                kwargs: {
                  status: "success",
                  content: "85",
                  tool_call_id: "toolu_0183unn5QaJzKbi2w9yqPNdq",
                  name: "add",
                  additional_kwargs: {},
                  response_metadata: {},
                },
              }),
            },
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect(obs.output).toEqual([
      {
        role: "tool",
        name: "add",
        parts: [
          {
            type: "tool_call_response",
            id: "toolu_0183unn5QaJzKbi2w9yqPNdq",
            response: "85",
          },
        ],
      },
    ]);
  });
});

describe("JSON blob robustness", () => {
  it("malformed usage_details JSON is ignored", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            attrs: {
              "langfuse.observation.type": "generation",
              "langfuse.observation.model.name": "gpt-4o",
              "langfuse.observation.usage_details": "{not: valid json",
            },
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect(obs.usage_details).toEqual({});
  });

  it("empty usage_details blob is ignored", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            attrs: {
              "langfuse.observation.type": "generation",
              "langfuse.observation.model.name": "gpt-4o",
              "langfuse.observation.usage_details": "",
            },
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect(obs.usage_details).toEqual({});
  });

  it("non-object JSON is ignored", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            attrs: {
              "langfuse.observation.type": "generation",
              "langfuse.observation.model.name": "gpt-4o",
              "langfuse.observation.usage_details": "[1, 2, 3]",
            },
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect(obs.usage_details).toEqual({});
  });

  it("semconv keys win on collision with Langfuse blob", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            attrs: {
              "gen_ai.usage.input_tokens": 500,
              "gen_ai.usage.output_tokens": 50,
              "langfuse.observation.model.name": "gpt-4o",
              "langfuse.observation.type": "generation",
              "langfuse.observation.usage_details": JSON.stringify({
                input: 9999,
                output: 9999,
                total: 9999,
              }),
            },
          }),
        ],
        "wid",
        "claim",
      ),
    );
    const usage = obs.usage_details as Record<string, number>;
    expect(usage.input).toBe(500);
    expect(usage.output).toBe(50);
    // 'total' not in semconv dict, so blob value fills it.
    expect(usage.total).toBe(9999);
  });
});

describe("OTel GenAI semconv still works", () => {
  it("extracts model + usage from semconv keys", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            scopeName: "opentelemetry.instrumentation.openai",
            scopeVersion: "0.56",
            kind: SpanKind.CLIENT,
            attrs: {
              "gen_ai.response.model": "gpt-4o-2024",
              "gen_ai.usage.input_tokens": 100,
              "gen_ai.usage.output_tokens": 20,
              "gen_ai.usage.total_tokens": 120,
            },
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect(obs.model).toBe("gpt-4o-2024");
    expect(obs.type).toBe("GENERATION");
    expect(obs.usage_details).toEqual({ input: 100, output: 20, total: 120 });
  });
});

describe("root + resource mapping", () => {
  it("root span produces a trace record + observation", () => {
    const records = transformSpans(
      [
        makeSpan({
          name: "plan_trip",
          traceId: "aaa00000000000000000000000000000",
          spanId: "bbb0000000000000",
          resourceAttrs: {
            "service.name": "trip-planner",
            "service.version": "0.1.0",
            "deployment.environment": "dev",
          },
          attrs: {
            "langfuse.observation.type": "span",
            "langfuse.observation.input": "{}",
            "langfuse.observation.output": "{}",
          },
        }),
      ],
      "int/11476",
      "claim-xyz",
    );

    const t = trace(records);
    expect(t.id).toBe("aaa00000000000000000000000000000");
    expect(t.name).toBe("plan_trip");
    expect((t as Record<string, unknown>).release).toBe("0.1.0");
    expect((t as Record<string, unknown>).version).toBe("0.1.0");
    expect((t as Record<string, unknown>).environment).toBe("dev");
    expect(t.wid).toBe("int/11476");
    expect((t as Record<string, unknown>)._wid_claim).toBe("claim-xyz");

    const [obs] = observations(records);
    expect((obs as Record<string, unknown>).parent_observation_id).toBeNull();
    expect((obs as Record<string, unknown>).trace_name).toBe("plan_trip");
  });

  it("child span carries parent_observation_id; no trace record emitted", () => {
    const records = transformSpans(
      [
        makeSpan({
          parentSpanId: "bbb0000000000000",
          attrs: { "langfuse.observation.type": "span" },
        }),
      ],
      "wid",
      "claim",
    );
    const [obs] = observations(records);
    expect((obs as Record<string, unknown>).parent_observation_id).toBe(
      "bbb0000000000000",
    );
    expect(records.filter((r) => r.entity_type === "trace")).toHaveLength(0);
  });
});

describe("Observation type pass-through", () => {
  it("gen_ai.operation.name=embedding (legacy singular) maps to EMBEDDINGS", () => {
    const [obs] = observations(
      transformSpans(
        [makeSpan({ attrs: { "gen_ai.operation.name": "embedding" } })],
        "wid",
        "claim",
      ),
    );
    expect(obs.type).toBe("EMBEDDINGS");
  });

  it("gen_ai.operation.name=embeddings (plural, OTel v2 canonical) maps to EMBEDDINGS", () => {
    const [obs] = observations(
      transformSpans(
        [makeSpan({ attrs: { "gen_ai.operation.name": "embeddings" } })],
        "wid",
        "claim",
      ),
    );
    expect(obs.type).toBe("EMBEDDINGS");
  });

  it("gen_ai.operation.name=execute_tool maps to TOOL", () => {
    const [obs] = observations(
      transformSpans(
        [makeSpan({ attrs: { "gen_ai.operation.name": "execute_tool" } })],
        "wid",
        "claim",
      ),
    );
    expect(obs.type).toBe("TOOL");
  });

  it("model fallback forces GENERATION when no discriminator set", () => {
    const [obs] = observations(
      transformSpans(
        [makeSpan({ attrs: { "gen_ai.request.model": "gpt-4o" } })],
        "wid",
        "claim",
      ),
    );
    expect(obs.type).toBe("GENERATION");
  });

  it("empty discriminator falls through", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            kind: SpanKind.INTERNAL,
            attrs: { "langfuse.observation.type": "   " },
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect(obs.type).toBe("SPAN");
  });
});

describe("Provider extraction", () => {
  it("gen_ai.provider.name takes precedence", () => {
    const [obs] = observations(
      transformSpans(
        [makeSpan({ attrs: { "gen_ai.provider.name": "openai", "gen_ai.system": "anthropic" } })],
        "wid",
        "claim",
      ),
    );
    expect(obs.provider).toBe("openai");
  });

  it("gen_ai.system fallback", () => {
    const [obs] = observations(
      transformSpans([makeSpan({ attrs: { "gen_ai.system": "anthropic" } })], "wid", "claim"),
    );
    expect(obs.provider).toBe("anthropic");
  });

  it("missing provider is null", () => {
    const [obs] = observations(
      transformSpans([makeSpan({ attrs: {} })], "wid", "claim"),
    );
    expect(obs.provider).toBeNull();
  });
});

describe("Langfuse metadata promotion", () => {
  it("trace.metadata.* and observation.metadata.* land as first-level keys", () => {
    const records = transformSpans(
      [
        makeSpan({
          attrs: {
            "langfuse.trace.metadata.environment": "prod",
            "langfuse.observation.metadata.retry": "2",
          },
        }),
      ],
      "wid",
      "claim",
    );
    const t = trace(records);
    const [obs] = observations(records);
    expect((t.metadata as Record<string, unknown>).environment).toBe("prod");
    expect((obs.metadata as Record<string, unknown>).retry).toBe("2");
  });
});

describe("GenAI span events", () => {
  it("assembles input from system/user message events", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            events: [
              { name: "gen_ai.system.message", attributes: { content: "be helpful" }, time: [1, 0] },
              { name: "gen_ai.user.message", attributes: { content: "hello" }, time: [2, 0] },
            ],
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect(JSON.parse(obs.input_messages_raw as string)).toEqual([
      { role: "system", content: "be helpful" },
      { role: "user", content: "hello" },
    ]);
  });

  it("assembles output from gen_ai.choice events", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            events: [
              {
                name: "gen_ai.choice",
                attributes: { index: 0, finish_reason: "stop", message: "hi" },
                time: [3, 0],
              },
            ],
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect(JSON.parse(obs.output_messages_raw as string)).toEqual([
      { index: 0, finish_reason: "stop", message: "hi" },
    ]);
  });

  it("attribute-form input wins over event-form input", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            attrs: { "gen_ai.input.messages": "attr-form" },
            events: [
              { name: "gen_ai.user.message", attributes: { content: "event-form" } },
            ],
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect(obs.input_messages_raw).toBe("attr-form");
  });

  it("explicit event role overrides the event-name default", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            events: [
              {
                name: "gen_ai.assistant.message",
                attributes: { role: "developer", content: "x" },
              },
            ],
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect((JSON.parse(obs.input_messages_raw as string) as { role: string }[])[0].role).toBe(
      "developer",
    );
  });
});

describe("Langfuse trace name override", () => {
  it("overrides trace record name", () => {
    const records = transformSpans(
      [
        makeSpan({
          name: "POST /chat",
          attrs: { "langfuse.trace.name": "Onboarding Flow" },
        }),
      ],
      "wid",
      "claim",
    );
    expect(trace(records).name).toBe("Onboarding Flow");
  });

  it("overrides observation trace_name on root span", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            name: "POST /chat",
            attrs: { "langfuse.trace.name": "Onboarding Flow" },
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect(obs.trace_name).toBe("Onboarding Flow");
  });

  it("falls back to span.name when override absent", () => {
    const records = transformSpans(
      [makeSpan({ name: "root-span" })],
      "wid",
      "claim",
    );
    expect(trace(records).name).toBe("root-span");
  });
});

describe("Vercel AI SDK", () => {
  it("maps ai.operationId=ai.generateText to AGENT with agent_name from functionId", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            scopeName: "ai",
            attrs: {
              "ai.operationId": "ai.generateText",
              "ai.telemetry.functionId": "calcbot.turn",
              "ai.model.provider": "anthropic.messages",
              "ai.prompt": '{"prompt":"What is 47 + 38?"}',
              "ai.response.text": "The result of 47 + 38 is 85.",
              "ai.usage.promptTokens": 704,
              "ai.usage.completionTokens": 17,
            },
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect(obs.type).toBe("AGENT");
    expect(obs.agent_name).toBe("calcbot.turn");
    expect(obs.input_messages_raw).toBe('{"prompt":"What is 47 + 38?"}');
    expect(obs.output_messages_raw).toBe("The result of 47 + 38 is 85.");
    expect(obs.provider).toBe("anthropic");
    const usage = obs.usage_details as Record<string, number>;
    expect(usage.input).toBe(704);
    expect(usage.output).toBe(17);
    expect(usage.total).toBe(721);
  });

  it("maps ai.operationId=ai.toolCall to TOOL with tool_name/input/output", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            scopeName: "ai",
            attrs: {
              "ai.operationId": "ai.toolCall",
              "ai.toolCall.name": "add",
              "ai.toolCall.id": "toolu_01ChBBJ3Y8k8kaBzAeEjuxyP",
              "ai.toolCall.args": '{"a":47,"b":38}',
              "ai.toolCall.result": "85",
            },
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect(obs.type).toBe("TOOL");
    expect(obs.tool_name).toBe("add");
    expect(obs.input_messages_raw).toBe('{"a":47,"b":38}');
    expect(obs.output_messages_raw).toBe("85");
  });

  it("maps ai.operationId=ai.streamText to AGENT", () => {
    const [obs] = observations(
      transformSpans(
        [makeSpan({ scopeName: "ai", attrs: { "ai.operationId": "ai.streamText" } })],
        "wid",
        "claim",
      ),
    );
    expect(obs.type).toBe("AGENT");
  });

  it("maps ai.operationId=ai.embed to EMBEDDINGS", () => {
    const [obs] = observations(
      transformSpans(
        [makeSpan({ scopeName: "ai", attrs: { "ai.operationId": "ai.embed" } })],
        "wid",
        "claim",
      ),
    );
    expect(obs.type).toBe("EMBEDDINGS");
  });

  it("maps ai.operationId=ai.embedMany to EMBEDDINGS", () => {
    const [obs] = observations(
      transformSpans(
        [makeSpan({ scopeName: "ai", attrs: { "ai.operationId": "ai.embedMany" } })],
        "wid",
        "claim",
      ),
    );
    expect(obs.type).toBe("EMBEDDINGS");
  });

  it("maps ai.operationId=ai.embed.doEmbed to EMBEDDINGS even when a model is present", () => {
    // Inner provider-call spans carry `ai.model.id` — without an explicit
    // EMBEDDINGS match they would fall through to core's "model ⇒ GENERATION".
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            scopeName: "ai",
            attrs: {
              "ai.operationId": "ai.embed.doEmbed",
              "ai.model.id": "text-embedding-ada-002",
              "ai.model.provider": "openai.embeddings",
            },
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect(obs.type).toBe("EMBEDDINGS");
    expect(obs.model).toBe("text-embedding-ada-002");
  });

  it("maps ai.operationId=ai.embedMany.doEmbed to EMBEDDINGS even when a model is present", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            scopeName: "ai",
            attrs: {
              "ai.operationId": "ai.embedMany.doEmbed",
              "ai.model.id": "text-embedding-ada-002",
              "ai.model.provider": "openai.embeddings",
            },
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect(obs.type).toBe("EMBEDDINGS");
    expect(obs.model).toBe("text-embedding-ada-002");
  });

  it("aggregates ai.prompt.tools (string-array of JSON definitions) into tool_definitions", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            scopeName: "ai",
            attrs: {
              "ai.operationId": "ai.streamText.doStream",
              "ai.prompt.tools": [
                '{"type":"function","name":"addResource","description":"add a resource","inputSchema":{"type":"object","properties":{"content":{"type":"string"}},"required":["content"]}}',
                '{"type":"function","name":"getInformation","description":"look up","inputSchema":{"type":"object","properties":{"q":{"type":"string"}},"required":["q"]}}',
              ],
            },
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect(Array.isArray(obs.tool_definitions)).toBe(true);
    const defs = obs.tool_definitions as Array<Record<string, unknown>>;
    expect(defs).toHaveLength(2);
    expect(defs[0].name).toBe("addResource");
    expect(defs[0].type).toBe("function");
    expect(defs[1].name).toBe("getInformation");
  });

  it("keeps unparseable ai.prompt.tools entries verbatim", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            scopeName: "ai",
            attrs: {
              "ai.operationId": "ai.streamText.doStream",
              "ai.prompt.tools": ["not json", '{"name":"ok"}'],
            },
          }),
        ],
        "wid",
        "claim",
      ),
    );
    const defs = obs.tool_definitions as unknown[];
    expect(defs).toEqual(["not json", { name: "ok" }]);
  });

  it("doGenerate with tool-use output captures ai.response.toolCalls as output", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            scopeName: "ai",
            attrs: {
              "ai.operationId": "ai.generateText.doGenerate",
              "ai.prompt.messages":
                '[{"role":"user","content":[{"type":"text","text":"What is 47 + 38?"}]}]',
              "ai.response.toolCalls":
                '[{"toolCallId":"toolu_1","toolName":"add","input":"{\\"a\\":47,\\"b\\":38}"}]',
              "gen_ai.system": "anthropic.messages",
            },
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect(obs.input_messages_raw).toBe(
      '[{"role":"user","content":[{"type":"text","text":"What is 47 + 38?"}]}]',
    );
    expect(obs.output_messages_raw).toBe(
      '[{"toolCallId":"toolu_1","toolName":"add","input":"{\\"a\\":47,\\"b\\":38}"}]',
    );
  });

  it("doGenerate with text output captures ai.response.text as output", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            scopeName: "ai",
            attrs: {
              "ai.operationId": "ai.generateText.doGenerate",
              "ai.prompt.messages": '[{"role":"user","content":"hi"}]',
              "ai.response.text": "hello",
              "gen_ai.system": "openai",
            },
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect(obs.input_messages_raw).toBe('[{"role":"user","content":"hi"}]');
    expect(obs.output_messages_raw).toBe("hello");
  });

  it("doGenerate spans fall through to GENERATION via gen_ai.* (otelGenai adapter)", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            scopeName: "ai",
            attrs: {
              "ai.operationId": "ai.generateText.doGenerate",
              "gen_ai.system": "anthropic.messages",
              "gen_ai.request.model": "claude-sonnet-4-6",
              "gen_ai.usage.input_tokens": 622,
              "gen_ai.usage.output_tokens": 69,
            },
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect(obs.type).toBe("GENERATION");
    expect(obs.model).toBe("claude-sonnet-4-6");
    expect(obs.provider).toBe("anthropic");
  });

  it("normalises provider prefixes via resolveProvider hook", () => {
    const cases: Array<[string, string]> = [
      ["amazon-bedrock.claude-3-5", "aws_bedrock"],
      ["google-vertex.gemini", "vertex_ai"],
      ["openai.chat", "openai"],
      ["anthropic.messages", "anthropic"],
      ["xai.grok-1", "xai"],
    ];
    for (const [raw, normalised] of cases) {
      const [obs] = observations(
        transformSpans(
          [
            makeSpan({
              attrs: {
                "ai.operationId": "ai.generateText",
                "ai.model.provider": raw,
              },
            }),
          ],
          "wid",
          "claim",
        ),
      );
      expect(obs.provider).toBe(normalised);
    }
  });

  it("does not normalise provider for non-Vercel spans", () => {
    // A non-Vercel span carrying a dotted gen_ai.system should NOT be
    // rewritten by the vercelAi adapter — normalisation is gated on the
    // Vercel-specific `ai.operationId` sentinel.
    const [obs] = observations(
      transformSpans(
        [makeSpan({ attrs: { "gen_ai.system": "some.custom.value" } })],
        "wid",
        "claim",
      ),
    );
    expect(obs.provider).toBe("some.custom.value");
  });

  it("remaps ai.request.* camelCase params to snake_case model_parameters", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            attrs: {
              "ai.operationId": "ai.generateText",
              "ai.request.temperature": 0.3,
              "ai.request.topP": 0.9,
              "ai.request.maxTokens": 256,
              "ai.request.stopSequences": ["\n\n"],
            },
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect(obs.model_parameters).toEqual({
      temperature: 0.3,
      top_p: 0.9,
      max_tokens: 256,
      stop_sequences: ["\n\n"],
    });
  });
});
