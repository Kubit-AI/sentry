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

// NOTE: These tests cover framework adapters that are currently disabled from
// the published `@kubit-ai/otel` bundle (braintrust, langsmith, traceloop,
// openinference, vercelAi, openaiAgents, logfire). They are preserved here so
// that re-enabling any adapter is a simple move back to the main test file.

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

describe("Observation type pass-through (disabled adapters)", () => {
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
});

describe("Indexed message unpacking (disabled adapters)", () => {
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

describe("Provider extraction (disabled adapters)", () => {
  it("llm.system (OpenInference) fallback", () => {
    const [obs] = observations(
      transformSpans([makeSpan({ attrs: { "llm.system": "openai" } })], "wid", "claim"),
    );
    expect(obs.provider).toBe("openai");
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

// LangChain (JS via `@arizeai/openinference-instrumentation-langchain`,
// Python via `openinference.instrumentation.langchain`) lands on the
// OpenInference adapter via Serializable envelopes inside `input.value` /
// `output.value`. These tests exercise the integration end-to-end.
describe("OpenInference (LangChain)", () => {
  const lcMsg = (type: string, kwargs: Record<string, unknown>) => ({
    lc: 1,
    type: "constructor",
    id: ["langchain_core", "messages", type],
    kwargs,
  });

  it("TOOL span: tool.name + raw-args input + ToolMessage envelope output", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            scopeName: "@arizeai/openinference-instrumentation-langchain",
            attrs: {
              "openinference.span.kind": "TOOL",
              "tool.name": "add",
              "input.value": JSON.stringify({ a: 47, b: 38 }),
              "output.value": JSON.stringify(
                lcMsg("ToolMessage", {
                  content: "85",
                  tool_call_id: "toolu_xyz",
                  name: "add",
                }),
              ),
            },
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect(obs.tool_name).toBe("add");
    expect(obs.input_messages).toEqual([
      {
        role: "assistant",
        parts: [{ type: "tool_call", name: "add", arguments: { a: 47, b: 38 } }],
      },
    ]);
    expect(obs.output_messages).toEqual([
      {
        role: "tool",
        parts: [{ type: "tool_call_response", response: "85", id: "toolu_xyz" }],
        name: "add",
      },
    ]);
  });

  it("TOOL span: {output: <ToolMessage>} wrapper on output.value", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            attrs: {
              "openinference.span.kind": "TOOL",
              "tool.name": "add",
              "input.value": JSON.stringify({ a: 1 }),
              "output.value": JSON.stringify({
                output: lcMsg("ToolMessage", {
                  content: "result",
                  tool_call_id: "tc_1",
                }),
              }),
            },
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect(obs.output_messages).toEqual([
      {
        role: "tool",
        parts: [{ type: "tool_call_response", response: "result", id: "tc_1" }],
      },
    ]);
  });

  it("TOOL span: non-envelope JSON output.value falls back to raw value", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            attrs: {
              "openinference.span.kind": "TOOL",
              "tool.name": "add",
              "input.value": JSON.stringify({ a: 1 }),
              "output.value": "85",
            },
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect(obs.input_messages).toEqual([
      {
        role: "assistant",
        parts: [{ type: "tool_call", name: "add", arguments: { a: 1 } }],
      },
    ]);
    // Raw scalar "85" survives the JSON parse round-trip (becomes 85).
    expect(obs.output_messages).toEqual([
      { role: "tool", parts: [{ type: "tool_call_response", response: 85 }] },
    ]);
  });

  it("LangChain output.value blob wins over indexed messages (precedence flip)", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            attrs: {
              "openinference.span.kind": "LLM",
              "llm.output_messages.0.message.role": "assistant",
              // Indexed projection has no slot for tool_use parts
              "output.value": JSON.stringify(
                lcMsg("AIMessage", {
                  content: [{ type: "tool_use", id: "tu_1", name: "add", input: { a: 1 } }],
                }),
              ),
            },
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect(obs.output_messages).toEqual([
      {
        role: "assistant",
        parts: [{ type: "tool_call", name: "add", id: "tu_1", arguments: { a: 1 } }],
      },
    ]);
  });

  it("provider resolves from AIMessage envelope's response_metadata.model_provider", () => {
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            attrs: {
              "openinference.span.kind": "LLM",
              "llm.model_name": "claude-sonnet-4-5",
              "output.value": JSON.stringify(
                lcMsg("AIMessage", {
                  content: "hi",
                  response_metadata: { model_provider: "anthropic" },
                }),
              ),
            },
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect(obs.provider).toBe("anthropic");
  });

  it("tool_definitions aggregated from indexed llm.tools.<n>.tool.json_schema", () => {
    const schema0 = { type: "function", function: { name: "add", parameters: {} } };
    const schema1 = { type: "function", function: { name: "sub", parameters: {} } };
    const [obs] = observations(
      transformSpans(
        [
          makeSpan({
            attrs: {
              "openinference.span.kind": "LLM",
              "llm.tools.0.tool.json_schema": JSON.stringify(schema0),
              "llm.tools.1.tool.json_schema": JSON.stringify(schema1),
            },
          }),
        ],
        "wid",
        "claim",
      ),
    );
    expect(obs.tool_definitions).toEqual([schema0, schema1]);
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
