import { describe, expect, it } from "vitest";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

import { transformSpans } from "./transformer";

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
    expect(obs.input).toBe(JSON.stringify({ x: 1 }));
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

// ── Per-framework schema regressions ────────────────────────────────────────

describe("OpenAI Agents v2 schema", () => {
  const attrs = () => ({
    "gen_ai.operation.name": "chat",
    "gen_ai.provider.name": "openai",
    "gen_ai.request.model": "gpt-4o-mini",
    "gen_ai.response.model": "gpt-4o-mini-2024-07-18",
    "gen_ai.request.temperature": 0.7,
    "gen_ai.request.max_tokens": 500,
    "gen_ai.request.top_p": 0.95,
    "gen_ai.input.messages": JSON.stringify([{ role: "user", content: "hello" }]),
    "gen_ai.output.messages": JSON.stringify([{ role: "assistant", content: "hi" }]),
    "gen_ai.usage.input_tokens": 100,
    "gen_ai.usage.output_tokens": 20,
    "gen_ai.conversation.id": "conv-abc",
  });

  it("resolves model from gen_ai.response.model", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            scopeName: "opentelemetry.instrumentation.openai_agents",
            kind: SpanKind.INTERNAL,
            attrs: attrs(),
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect(obs.model).toBe("gpt-4o-mini-2024-07-18");
  });

  it("captures input/output from modern gen_ai.*.messages keys", () => {
    const [obs] = observations(
      transformSpans([makeSpan({ attrs: attrs() })], "wid", "claim"),
    );
    expect(JSON.parse(obs.input as string)[0].content).toBe("hello");
    expect(JSON.parse(obs.output as string)[0].content).toBe("hi");
  });

  it("packs model_parameters from flat gen_ai.request.* keys", () => {
    const [obs] = observations(
      transformSpans([makeSpan({ attrs: attrs() })], "wid", "claim"),
    );
    expect(obs.model_parameters).toEqual({
      temperature: 0.7,
      max_tokens: 500,
      top_p: 0.95,
    });
  });

  it("maps gen_ai.conversation.id to session_id", () => {
    const [obs] = observations(
      transformSpans([makeSpan({ attrs: attrs() })], "wid", "claim"),
    );
    expect(obs.session_id).toBe("conv-abc");
  });

  it("forces type=GENERATION via gen_ai.operation.name", () => {
    const a = attrs();
    delete (a as Record<string, unknown>)["gen_ai.response.model"];
    delete (a as Record<string, unknown>)["gen_ai.request.model"];
    const [obs] = observations(
      transformSpans([makeSpan({ attrs: a })], "wid", "claim"),
    );
    expect(obs.type).toBe("GENERATION");
  });
});

describe("Braintrust schema", () => {
  const attrs = () => ({
    "gen_ai.operation.name": "chat",
    "gen_ai.request.model": "claude-3-5-sonnet",
    "gen_ai.input.messages": JSON.stringify([{ role: "user", content: "hi" }]),
    "gen_ai.output.messages": JSON.stringify([{ role: "assistant", content: "ok" }]),
    "gen_ai.usage.input_tokens": 50,
    "gen_ai.usage.output_tokens": 10,
    "gen_ai.usage.cache_read.input_tokens": 30,
    "gen_ai.usage.cache_creation.input_tokens": 5,
    "gen_ai.usage.cost.prompt": 0.0015,
    "gen_ai.usage.cost.completion": 0.0005,
    "gen_ai.usage.cost.total": 0.002,
    "gen_ai.request.temperature": 0.2,
    "span_attributes.type": "llm",
  });

  it("captures Braintrust-specific cost attributes", () => {
    const [obs] = observations(
      transformSpans([makeSpan({ attrs: attrs() })], "wid", "claim"),
    );
    expect(obs.cost_details).toEqual({ input: 0.0015, output: 0.0005, total: 0.002 });
    expect(obs.total_cost).toBe(0.002);
  });

  it("maps cache tokens to canonical keys", () => {
    const [obs] = observations(
      transformSpans([makeSpan({ attrs: attrs() })], "wid", "claim"),
    );
    const usage = obs.usage_details as Record<string, number>;
    expect(usage.cache_read_input).toBe(30);
    expect(usage.cache_creation_input).toBe(5);
  });

  it("forces type=GENERATION via span_attributes.type==llm", () => {
    const a = attrs();
    delete (a as Record<string, unknown>)["gen_ai.request.model"];
    delete (a as Record<string, unknown>)["gen_ai.operation.name"];
    const [obs] = observations(
      transformSpans([makeSpan({ attrs: a })], "wid", "claim"),
    );
    expect(obs.type).toBe("GENERATION");
  });
});

describe("OpenInference schema", () => {
  const attrs = () => ({
    "openinference.span.kind": "LLM",
    "llm.model_name": "gpt-4o",
    "llm.system": "openai",
    "llm.invocation_parameters": JSON.stringify({ temperature: 0.1, max_tokens: 1000 }),
    "input.value": "what's the weather",
    "output.value": "sunny",
    "llm.token_count.prompt": 80,
    "llm.token_count.completion": 15,
    "llm.token_count.total": 95,
    "llm.token_count.prompt_details.cache_read": 40,
    "llm.token_count.prompt_details.cache_write": 20,
    "llm.token_count.completion_details.reasoning": 5,
    "llm.cost.prompt": 0.004,
    "llm.cost.completion": 0.0009,
    "llm.cost.total": 0.0049,
    "user.id": "user-123",
    "session.id": "sess-456",
  });

  it("parses llm.invocation_parameters into model_parameters", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            scopeName: "openinference.instrumentation.openai",
            attrs: attrs(),
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect(obs.model_parameters).toEqual({ temperature: 0.1, max_tokens: 1000 });
  });

  it("captures llm.cost.* as cost_details", () => {
    const [obs] = observations(
      transformSpans([makeSpan({ attrs: attrs() })], "wid", "claim"),
    );
    expect(obs.cost_details).toEqual({ input: 0.004, output: 0.0009, total: 0.0049 });
  });

  it("captures cache + reasoning tokens", () => {
    const [obs] = observations(
      transformSpans([makeSpan({ attrs: attrs() })], "wid", "claim"),
    );
    const usage = obs.usage_details as Record<string, number>;
    expect(usage.cache_read_input).toBe(40);
    expect(usage.cache_creation_input).toBe(20);
    expect(usage.completion_reasoning).toBe(5);
  });

  it("openinference.span.kind=LLM forces GENERATION", () => {
    const a = attrs();
    delete (a as Record<string, unknown>)["llm.model_name"];
    const [obs] = observations(
      transformSpans([makeSpan({ attrs: a })], "wid", "claim"),
    );
    expect(obs.type).toBe("GENERATION");
  });

  it("openinference.span.kind=TOOL maps to TOOL", () => {
    const [obs] = observations(
      transformSpans(
        [makeSpan({ attrs: { "openinference.span.kind": "TOOL", "input.value": "x" } })],
        "wid",
        "claim",
      ),
    );
    expect(obs.type).toBe("TOOL");
  });

  it("captures input.value/output.value when messages absent", () => {
    const [obs] = observations(
      transformSpans([makeSpan({ attrs: attrs() })], "wid", "claim"),
    );
    expect(obs.input).toBe("what's the weather");
    expect(obs.output).toBe("sunny");
  });
});

describe("LangSmith schema", () => {
  const attrs = () => ({
    "langsmith.span.kind": "llm",
    "gen_ai.request.model": "gpt-4o-mini",
    "gen_ai.prompt": JSON.stringify([{ role: "user", content: "q" }]),
    "gen_ai.completion": JSON.stringify([{ role: "assistant", content: "a" }]),
    "gen_ai.usage.input_tokens": 25,
    "gen_ai.usage.output_tokens": 7,
    "gen_ai.usage.input_token_details": JSON.stringify({ cache_read: 10, audio: 0 }),
    "gen_ai.usage.output_token_details": JSON.stringify({ reasoning: 2 }),
    "langsmith.trace.session_id": "ls-session-1",
    "langsmith.span.tags": "prod,green",
    "gen_ai.request.temperature": 0.5,
  });

  it("langsmith.trace.session_id maps to session_id", () => {
    const [obs] = observations(
      transformSpans(
        [makeSpan({ scopeName: "langsmith", attrs: attrs() })],
        "wid",
        "claim",
      ),
    );
    expect(obs.session_id).toBe("ls-session-1");
  });

  it("langsmith.span.kind==llm forces GENERATION", () => {
    const a = attrs();
    delete (a as Record<string, unknown>)["gen_ai.request.model"];
    const [obs] = observations(
      transformSpans([makeSpan({ attrs: a })], "wid", "claim"),
    );
    expect(obs.type).toBe("GENERATION");
  });

  it("token_details JSON blobs merged into usage_details", () => {
    const [obs] = observations(
      transformSpans([makeSpan({ attrs: attrs() })], "wid", "claim"),
    );
    const usage = obs.usage_details as Record<string, number>;
    expect(usage.cache_read).toBe(10);
    expect(usage.audio).toBe(0);
    expect(usage.reasoning).toBe(2);
  });

  it("langsmith.span.tags captured as tags", () => {
    const [obs] = observations(
      transformSpans([makeSpan({ attrs: attrs() })], "wid", "claim"),
    );
    expect(obs.tags).toBe("prod,green");
  });

  it("legacy gen_ai.prompt still captured when gen_ai.input.messages absent", () => {
    const [obs] = observations(
      transformSpans([makeSpan({ attrs: attrs() })], "wid", "claim"),
    );
    expect(JSON.parse(obs.input as string)[0].content).toBe("q");
  });
});

describe("Logfire 'latest' mode schema", () => {
  it("logfire.tags tuple captured", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            scopeName: "logfire",
            attrs: {
              "gen_ai.request.model": "gpt-4o",
              "gen_ai.operation.name": "chat",
              "gen_ai.input.messages": JSON.stringify([{ role: "user", content: "x" }]),
              "logfire.tags": ["prod", "web"],
            },
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect(obs.tags).toEqual(["prod", "web"]);
    expect(obs.type).toBe("GENERATION");
    expect(JSON.parse(obs.input as string)[0].content).toBe("x");
  });
});

describe("Traceloop v0.5+ schema", () => {
  const attrs = () => ({
    "gen_ai.operation.name": "chat",
    "gen_ai.request.model": "claude-3-5-sonnet",
    "gen_ai.input.messages": JSON.stringify([{ role: "user", content: "h" }]),
    "gen_ai.output.messages": JSON.stringify([{ role: "assistant", content: "ok" }]),
    "gen_ai.usage.input_tokens": 40,
    "gen_ai.usage.output_tokens": 8,
    // Traceloop underscore variant, distinct from dot-separated semconv.
    "gen_ai.usage.cache_read_input_tokens": 20,
    "gen_ai.usage.cache_creation_input_tokens": 3,
    "traceloop.association.properties.user_id": "u1",
    "traceloop.association.properties.session_id": "s1",
    "traceloop.association.properties.tags": ["dev"],
  });

  it("underscore-variant cache tokens captured", () => {
    const [obs] = observations(
      transformSpans(
        [makeSpan({ scopeName: "opentelemetry.instrumentation.anthropic", attrs: attrs() })],
        "wid",
        "claim",
      ),
    );
    const usage = obs.usage_details as Record<string, number>;
    expect(usage.cache_read_input).toBe(20);
    expect(usage.cache_creation_input).toBe(3);
  });

  it("traceloop association-properties captured", () => {
    const [obs] = observations(
      transformSpans([makeSpan({ attrs: attrs() })], "wid", "claim"),
    );
    expect(obs.session_id).toBe("s1");
    expect(obs.user_id).toBe("u1");
    expect(obs.tags).toEqual(["dev"]);
  });
});

describe("Observation type pass-through", () => {
  it("openinference RETRIEVER maps to RETRIEVER", () => {
    const [obs] = observations(
      transformSpans(
        [makeSpan({ attrs: { "openinference.span.kind": "RETRIEVER" } })],
        "wid",
        "claim",
      ),
    );
    expect(obs.type).toBe("RETRIEVER");
  });

  it("openinference RERANKER maps to RERANKER", () => {
    const [obs] = observations(
      transformSpans(
        [makeSpan({ attrs: { "openinference.span.kind": "RERANKER" } })],
        "wid",
        "claim",
      ),
    );
    expect(obs.type).toBe("RERANKER");
  });

  it("openinference UNKNOWN falls through to base SPAN", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            kind: SpanKind.INTERNAL,
            attrs: { "openinference.span.kind": "UNKNOWN" },
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect(obs.type).toBe("SPAN");
  });

  it("langsmith chain maps to CHAIN", () => {
    const [obs] = observations(
      transformSpans(
        [makeSpan({ attrs: { "langsmith.span.kind": "chain" } })],
        "wid",
        "claim",
      ),
    );
    expect(obs.type).toBe("CHAIN");
  });

  it("braintrust eval maps to EVAL", () => {
    const [obs] = observations(
      transformSpans(
        [makeSpan({ attrs: { "span_attributes.type": "eval" } })],
        "wid",
        "claim",
      ),
    );
    expect(obs.type).toBe("EVAL");
  });

  it("traceloop workflow maps to WORKFLOW", () => {
    const [obs] = observations(
      transformSpans(
        [makeSpan({ attrs: { "traceloop.span.kind": "workflow" } })],
        "wid",
        "claim",
      ),
    );
    expect(obs.type).toBe("WORKFLOW");
  });

  it("gen_ai.operation.name=embedding maps to EMBEDDING", () => {
    const [obs] = observations(
      transformSpans(
        [makeSpan({ attrs: { "gen_ai.operation.name": "embedding" } })],
        "wid",
        "claim",
      ),
    );
    expect(obs.type).toBe("EMBEDDING");
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

  it("langfuse wins over openinference when both set", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            attrs: {
              "langfuse.observation.type": "chain",
              "openinference.span.kind": "RETRIEVER",
            },
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect(obs.type).toBe("CHAIN");
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

describe("Vercel AI raw ai.* schema (no adapter)", () => {
  const attrs = () => ({
    "ai.model.provider": "amazon-bedrock.claude-3-5",
    "ai.model.id": "claude-3-5-sonnet-20241022",
    "ai.response.model": "claude-3-5-sonnet-20241022-v1:0",
    "ai.prompt": "hello",
    "ai.response": "hi there",
    "ai.usage.promptTokens": 12,
    "ai.usage.completionTokens": 4,
    "ai.request.temperature": 0.3,
    "ai.request.topP": 0.9,
    "ai.request.maxTokens": 256,
    "ai.request.stopSequences": ["\n\n"],
  });

  it("uses ai.response.model as the primary model", () => {
    const [obs] = observations(
      transformSpans([makeSpan({ scopeName: "ai", attrs: attrs() })], "wid", "claim"),
    );
    expect(obs.model).toBe("claude-3-5-sonnet-20241022-v1:0");
  });

  it("maps ai.prompt/ai.response to input/output", () => {
    const [obs] = observations(transformSpans([makeSpan({ attrs: attrs() })], "wid", "claim"));
    expect(obs.input).toBe("hello");
    expect(obs.output).toBe("hi there");
  });

  it("captures camelCase usage tokens", () => {
    const [obs] = observations(transformSpans([makeSpan({ attrs: attrs() })], "wid", "claim"));
    const usage = obs.usage_details as Record<string, number>;
    expect(usage.input).toBe(12);
    expect(usage.output).toBe(4);
    expect(usage.total).toBe(16);
  });

  it("normalises ai.model.provider prefix to OTel system id", () => {
    const [obs] = observations(transformSpans([makeSpan({ attrs: attrs() })], "wid", "claim"));
    expect(obs.provider).toBe("aws_bedrock");
  });

  it("remaps ai.request.* camelCase params to snake_case", () => {
    const [obs] = observations(transformSpans([makeSpan({ attrs: attrs() })], "wid", "claim"));
    expect(obs.model_parameters).toEqual({
      temperature: 0.3,
      top_p: 0.9,
      max_tokens: 256,
      stop_sequences: ["\n\n"],
    });
  });

  it("passes through unknown provider prefixes", () => {
    const [obs] = observations(
      transformSpans(
        [makeSpan({ attrs: { "ai.model.provider": "xai.grok-1" } })],
        "wid",
        "claim",
      ),
    );
    expect(obs.provider).toBe("xai");
  });
});

describe("Indexed message unpacking", () => {
  it("openinference indexed input messages → JSON array", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            attrs: {
              "openinference.span.kind": "LLM",
              "llm.model_name": "gpt-4o",
              "llm.input_messages.0.message.role": "system",
              "llm.input_messages.0.message.content": "you are helpful",
              "llm.input_messages.1.message.role": "user",
              "llm.input_messages.1.message.content": "hi",
              "llm.output_messages.0.message.role": "assistant",
              "llm.output_messages.0.message.content": "hello",
            },
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect(JSON.parse(obs.input as string)).toEqual([
      { role: "system", content: "you are helpful" },
      { role: "user", content: "hi" },
    ]);
    expect(JSON.parse(obs.output as string)).toEqual([
      { role: "assistant", content: "hello" },
    ]);
  });

  it("traceloop indexed gen_ai.prompt.<n>.* → JSON array", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            attrs: {
              "gen_ai.operation.name": "chat",
              "gen_ai.request.model": "gpt-4o",
              "gen_ai.prompt.0.role": "user",
              "gen_ai.prompt.0.content": "hey",
              "gen_ai.completion.0.role": "assistant",
              "gen_ai.completion.0.content": "sup",
            },
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect(JSON.parse(obs.input as string)).toEqual([{ role: "user", content: "hey" }]);
    expect(JSON.parse(obs.output as string)).toEqual([
      { role: "assistant", content: "sup" },
    ]);
  });

  it("non-indexed gen_ai.input.messages wins over indexed form", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            attrs: {
              "gen_ai.input.messages": JSON.stringify([
                { role: "user", content: "flat" },
              ]),
              "gen_ai.prompt.0.role": "user",
              "gen_ai.prompt.0.content": "indexed",
            },
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect(JSON.parse(obs.input as string)[0].content).toBe("flat");
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

  it("llm.system (OpenInference) fallback", () => {
    const [obs] = observations(
      transformSpans([makeSpan({ attrs: { "llm.system": "openai" } })], "wid", "claim"),
    );
    expect(obs.provider).toBe("openai");
  });

  it("missing provider is null", () => {
    const [obs] = observations(
      transformSpans([makeSpan({ attrs: {} })], "wid", "claim"),
    );
    expect(obs.provider).toBeNull();
  });
});

describe("OpenAI Agents dedicated fields", () => {
  it("agent identity fields captured", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            attrs: {
              "gen_ai.operation.name": "invoke_agent",
              "gen_ai.agent.name": "researcher",
              "gen_ai.agent.id": "agt_abc",
              "gen_ai.agent.version": "v1.2",
            },
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect(obs.agent_name).toBe("researcher");
    expect(obs.agent_id).toBe("agt_abc");
    expect(obs.agent_version).toBe("v1.2");
    expect(obs.type).toBe("INVOKE_AGENT");
  });

  it("tool_name captured on execute_tool spans", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            attrs: {
              "gen_ai.operation.name": "execute_tool",
              "gen_ai.tool.name": "web_search",
            },
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect(obs.tool_name).toBe("web_search");
    expect(obs.type).toBe("TOOL");
  });

  it("system_instructions captured", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            attrs: {
              "gen_ai.request.model": "gpt-4o",
              "gen_ai.system_instructions": "be concise",
            },
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect(obs.system_instructions).toBe("be concise");
  });
});

describe("Braintrust native payloads", () => {
  it("braintrust.input_json / output_json captured", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            attrs: {
              "braintrust.input_json": JSON.stringify({ messages: [{ role: "user" }] }),
              "braintrust.output_json": JSON.stringify({ content: "ok" }),
              "span_attributes.type": "llm",
            },
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect((JSON.parse(obs.input as string) as { messages: { role: string }[] }).messages[0].role).toBe("user");
    expect((JSON.parse(obs.output as string) as { content: string }).content).toBe("ok");
  });

  it("gen_ai.prompt_json / completion_json fallback", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            attrs: {
              "gen_ai.prompt_json": JSON.stringify([{ role: "user" }]),
              "gen_ai.completion_json": JSON.stringify([{ role: "assistant" }]),
            },
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect(JSON.parse(obs.input as string)[0].role).toBe("user");
    expect(JSON.parse(obs.output as string)[0].role).toBe("assistant");
  });

  it("braintrust.metrics.* promoted to usage_details", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            attrs: {
              "gen_ai.usage.input_tokens": 10,
              "braintrust.metrics.cache_hits": 3,
              "braintrust.metrics.retry_count": 1,
              "braintrust.metrics.not_a_number": "abc",
            },
          }),
        ],
        "wid",
        "claim",
      ),
    );
    const usage = obs.usage_details as Record<string, unknown>;
    expect(usage.cache_hits).toBe(3);
    expect(usage.retry_count).toBe(1);
    expect(usage.not_a_number).toBeUndefined();
  });
});

describe("OpenInference embedding", () => {
  it("embedding.model_name captured as model", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            attrs: {
              "openinference.span.kind": "EMBEDDING",
              "embedding.model_name": "text-embedding-3-small",
            },
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect(obs.model).toBe("text-embedding-3-small");
    expect(obs.type).toBe("EMBEDDING");
  });
});

describe("llm.request.type fallback", () => {
  it("chat maps to GENERATION", () => {
    const [obs] = observations(
      transformSpans([makeSpan({ attrs: { "llm.request.type": "chat" } })], "wid", "claim"),
    );
    expect(obs.type).toBe("GENERATION");
  });

  it("embedding maps to EMBEDDING", () => {
    const [obs] = observations(
      transformSpans(
        [makeSpan({ attrs: { "llm.request.type": "embedding" } })],
        "wid",
        "claim",
      ),
    );
    expect(obs.type).toBe("EMBEDDING");
  });

  it("rerank maps to WORKFLOW", () => {
    const [obs] = observations(
      transformSpans(
        [makeSpan({ attrs: { "llm.request.type": "rerank" } })],
        "wid",
        "claim",
      ),
    );
    expect(obs.type).toBe("WORKFLOW");
  });

  it("gen_ai.operation.name wins over llm.request.type", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            attrs: {
              "gen_ai.operation.name": "chat",
              "llm.request.type": "embedding",
            },
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect(obs.type).toBe("GENERATION");
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

describe("Traceloop entity payloads", () => {
  it("traceloop.entity.input/output populate input/output", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            attrs: {
              "traceloop.entity.input": JSON.stringify({ query: "hello" }),
              "traceloop.entity.output": JSON.stringify({ answer: "hi" }),
            },
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect(obs.input).toBe(JSON.stringify({ query: "hello" }));
    expect(obs.output).toBe(JSON.stringify({ answer: "hi" }));
  });
});

describe("OpenInference retrieval documents", () => {
  it("retrieval.documents populate the output slot", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            attrs: {
              "openinference.span.kind": "RETRIEVER",
              "retrieval.documents.0.document.content": "Paris is the capital of France.",
              "retrieval.documents.0.document.id": "doc-1",
              "retrieval.documents.0.document.score": 0.97,
              "retrieval.documents.1.document.content": "The Eiffel Tower is in Paris.",
              "retrieval.documents.1.document.id": "doc-2",
              "retrieval.documents.1.document.score": 0.91,
            },
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect(obs.type).toBe("RETRIEVER");
    expect(JSON.parse(obs.output as string)).toEqual([
      { content: "Paris is the capital of France.", id: "doc-1", score: 0.97 },
      { content: "The Eiffel Tower is in Paris.", id: "doc-2", score: 0.91 },
    ]);
  });

  it("llm.output_messages still wins over retrieval.documents", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            attrs: {
              "llm.output_messages.0.message.role": "assistant",
              "llm.output_messages.0.message.content": "from messages",
              "retrieval.documents.0.document.content": "from docs",
            },
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect(JSON.parse(obs.output as string)).toEqual([
      { role: "assistant", content: "from messages" },
    ]);
  });
});

describe("Braintrust indexed and metadata", () => {
  it("reconstructs indexed input/output messages", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            attrs: {
              "braintrust.input.0.role": "user",
              "braintrust.input.0.content": "what's the capital of France?",
              "braintrust.input.1.role": "assistant",
              "braintrust.input.1.content": "Paris.",
              "braintrust.output.0.role": "assistant",
              "braintrust.output.0.content": "Paris.",
            },
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect(JSON.parse(obs.input as string)).toEqual([
      { role: "user", content: "what's the capital of France?" },
      { role: "assistant", content: "Paris." },
    ]);
    expect(JSON.parse(obs.output as string)).toEqual([
      { role: "assistant", content: "Paris." },
    ]);
  });

  it("promotes braintrust.metadata.* to flat metadata", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            attrs: {
              "braintrust.metadata.experiment": "baseline-v2",
              "braintrust.metadata.retry": 3,
            },
          }),
        ],
        "wid",
        "claim",
      ),
    );
    const md = obs.metadata as Record<string, unknown>;
    expect(md.experiment).toBe("baseline-v2");
    expect(md.retry).toBe(3);
  });

  it("parses braintrust.scores from a JSON string", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            attrs: {
              "braintrust.scores": JSON.stringify({ accuracy: 0.92, relevance: 0.88 }),
            },
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect((obs.metadata as Record<string, unknown>).scores).toEqual({
      accuracy: 0.92,
      relevance: 0.88,
    });
  });

  it("passes braintrust.scores through when already structured", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            attrs: { "braintrust.scores": { accuracy: 1.0 } },
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect((obs.metadata as Record<string, unknown>).scores).toEqual({ accuracy: 1.0 });
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
    expect(JSON.parse(obs.input as string)).toEqual([
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
    expect(JSON.parse(obs.output as string)).toEqual([
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
    expect(obs.input).toBe("attr-form");
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
    expect((JSON.parse(obs.input as string) as { role: string }[])[0].role).toBe(
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

describe("Cross-vendor cache priority", () => {
  it("dot-form OTel semconv wins over Traceloop underscore", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            attrs: {
              "gen_ai.usage.cache_read.input_tokens": 100,
              "gen_ai.usage.cache_read_input_tokens": 999,
            },
          }),
        ],
        "wid",
        "claim",
      ),
    );
    const usage = obs.usage_details as Record<string, number>;
    expect(usage.cache_read_input).toBe(100);
  });
});

