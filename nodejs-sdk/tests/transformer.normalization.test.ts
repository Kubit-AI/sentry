/**
 * Canonical OTel GenAI v2 message-shape tests.
 *
 * Each block exercises one adapter's `normalizeMessages` hook plus the
 * core resolution chain (events fallback, text-wrap fallback, system-
 * instructions injection). Mirrored byte-for-byte by the Python suite at
 * `python-sdk/tests/test_normalization.py`.
 */

import { describe, expect, it } from "vitest";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

import { transformSpans } from "../src/transformer";
import type { Message } from "../src/transformer/frameworks/types";

const asMessages = (v: unknown) => v as Message[];

type SpanEventInput = {
  name: string;
  attributes?: Record<string, unknown>;
  time?: [number, number];
};

function makeSpan(opts: {
  name?: string;
  attrs?: Record<string, unknown>;
  parentSpanId?: string;
  events?: SpanEventInput[];
  kind?: SpanKind;
  scopeName?: string;
}): ReadableSpan {
  const {
    name = "span",
    attrs = {},
    parentSpanId,
    events = [],
    kind = SpanKind.CLIENT,
    scopeName = "kubit-sdk",
  } = opts;
  return {
    name,
    kind,
    attributes: attrs,
    resource: { attributes: {} },
    instrumentationScope: { name: scopeName, version: "0.6.0" },
    startTime: [1_700_000_000, 0] as [number, number],
    endTime: [1_700_000_001, 0] as [number, number],
    status: { code: SpanStatusCode.UNSET },
    parentSpanContext:
      parentSpanId === undefined
        ? undefined
        : {
            traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            spanId: parentSpanId,
            traceFlags: 1,
            isRemote: false,
          },
    events,
    spanContext: () => ({
      traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      spanId: "bbbbbbbbbbbbbbbb",
      traceFlags: 1,
      isRemote: false,
    }),
  } as unknown as ReadableSpan;
}

function obs(records: ReturnType<typeof transformSpans>) {
  return records.find((r) => r.entity_type === "enriched_observation")!;
}

describe("otelGenai normalizer", () => {
  it("translates OpenAI-shape gen_ai.input.messages JSON string", () => {
    const span = makeSpan({
      attrs: {
        "gen_ai.input.messages": JSON.stringify([
          { role: "user", content: "hi" },
        ]),
        "gen_ai.output.messages": JSON.stringify([
          { role: "assistant", content: "hello" },
        ]),
      },
    });
    const r = obs(transformSpans([span], "w", "c"));
    expect(r.input_messages).toEqual([
      { role: "user", parts: [{ type: "text", content: "hi" }] },
    ]);
    expect(r.output_messages).toEqual([
      { role: "assistant", parts: [{ type: "text", content: "hello" }] },
    ]);
  });

  it("text-wraps legacy gen_ai.prompt / gen_ai.completion", () => {
    const span = makeSpan({
      attrs: { "gen_ai.prompt": "hi", "gen_ai.completion": "there" },
    });
    const r = obs(transformSpans([span], "w", "c"));
    expect(r.input_messages).toEqual([
      { role: "user", parts: [{ type: "text", content: "hi" }] },
    ]);
    expect(r.output_messages).toEqual([
      { role: "assistant", parts: [{ type: "text", content: "there" }] },
    ]);
  });

  it("merges gen_ai.tool.calls into the trailing assistant message", () => {
    const span = makeSpan({
      attrs: {
        "gen_ai.completion": "one moment",
        "gen_ai.tool.calls": JSON.stringify([
          { id: "c1", name: "lookup", arguments: { q: "x" } },
        ]),
      },
    });
    const r = obs(transformSpans([span], "w", "c"));
    expect(r.output_messages).toEqual([
      {
        role: "assistant",
        parts: [
          { type: "text", content: "one moment" },
          {
            type: "tool_call",
            name: "lookup",
            id: "c1",
            arguments: { q: "x" },
          },
        ],
      },
    ]);
  });
});

describe("openinference normalizer", () => {
  it("rebuilds indexed flat messages with assistant tool_calls", () => {
    const attrs: Record<string, unknown> = {
      "llm.input_messages.0.message.role": "system",
      "llm.input_messages.0.message.content": "Be helpful.",
      "llm.input_messages.1.message.role": "user",
      "llm.input_messages.1.message.content": "Hi!",
      "llm.output_messages.0.message.role": "assistant",
      "llm.output_messages.0.message.content": "Hello!",
      "llm.output_messages.0.message.tool_calls.0.tool_call.id": "call_a",
      "llm.output_messages.0.message.tool_calls.0.tool_call.function.name": "lookup",
      "llm.output_messages.0.message.tool_calls.0.tool_call.function.arguments":
        '{"q":"x"}',
    };
    const r = obs(transformSpans([makeSpan({ attrs })], "w", "c"));
    expect(r.input_messages).toEqual([
      { role: "system", parts: [{ type: "text", content: "Be helpful." }] },
      { role: "user", parts: [{ type: "text", content: "Hi!" }] },
    ]);
    expect(r.output_messages).toEqual([
      {
        role: "assistant",
        parts: [
          { type: "text", content: "Hello!" },
          { type: "tool_call", name: "lookup", id: "call_a", arguments: { q: "x" } },
        ],
      },
    ]);
  });

  it("represents retrieval documents as a tool message of GenericParts", () => {
    const attrs: Record<string, unknown> = {
      "openinference.span.kind": "retriever",
      "retrieval.documents.0.document.content": "doc one",
      "retrieval.documents.0.document.id": "d1",
      "retrieval.documents.0.document.score": 0.9,
    };
    const r = obs(transformSpans([makeSpan({ attrs })], "w", "c"));
    expect(r.output_messages).toEqual([
      {
        role: "tool",
        parts: [
          {
            type: "retrieval_document",
            content: "doc one",
            id: "d1",
            score: 0.9,
          },
        ],
      },
    ]);
  });
});

describe("openinference normalizer (LangChain envelope)", () => {
  // LangChain Serializable shape:
  //   {lc:1, type:"constructor", id:["langchain_core","messages",<MsgType>], kwargs:{...}}
  const lcMsg = (type: string, kwargs: Record<string, unknown>) => ({
    lc: 1,
    type: "constructor",
    id: ["langchain_core", "messages", type],
    kwargs,
  });

  it("translates {messages: [HumanMessage]} input.value blob", () => {
    const attrs: Record<string, unknown> = {
      "openinference.span.kind": "llm",
      "input.value": JSON.stringify({
        messages: [lcMsg("HumanMessage", { content: "What is 2+2?" })],
      }),
    };
    const r = obs(transformSpans([makeSpan({ attrs })], "w", "c"));
    expect(r.input_messages).toEqual([
      { role: "user", parts: [{ type: "text", content: "What is 2+2?" }] },
    ]);
  });

  it("translates AIMessage with content-array tool_use parts (Anthropic-shape)", () => {
    const attrs: Record<string, unknown> = {
      "openinference.span.kind": "llm",
      "output.value": JSON.stringify(
        lcMsg("AIMessage", {
          content: [{ type: "tool_use", id: "toolu_1", name: "add", input: { a: 1, b: 2 } }],
        }),
      ),
    };
    const r = obs(transformSpans([makeSpan({ attrs })], "w", "c"));
    expect(r.output_messages).toEqual([
      {
        role: "assistant",
        parts: [{ type: "tool_call", name: "add", id: "toolu_1", arguments: { a: 1, b: 2 } }],
      },
    ]);
  });

  it("translates AIMessage with kwargs.tool_calls only", () => {
    const attrs: Record<string, unknown> = {
      "openinference.span.kind": "llm",
      "output.value": JSON.stringify(
        lcMsg("AIMessage", {
          content: "calling add",
          tool_calls: [{ name: "add", args: { a: 1, b: 2 }, id: "toolu_2", type: "tool_call" }],
        }),
      ),
    };
    const r = obs(transformSpans([makeSpan({ attrs })], "w", "c"));
    expect(r.output_messages).toEqual([
      {
        role: "assistant",
        parts: [
          { type: "text", content: "calling add" },
          { type: "tool_call", name: "add", id: "toolu_2", arguments: { a: 1, b: 2 } },
        ],
      },
    ]);
  });

  it("dedupes when content-array tool_use AND kwargs.tool_calls share the same id", () => {
    const attrs: Record<string, unknown> = {
      "openinference.span.kind": "llm",
      "output.value": JSON.stringify(
        lcMsg("AIMessage", {
          content: [{ type: "tool_use", id: "toolu_3", name: "add", input: { a: 1 } }],
          tool_calls: [{ name: "add", args: { a: 1 }, id: "toolu_3", type: "tool_call" }],
        }),
      ),
    };
    const r = obs(transformSpans([makeSpan({ attrs })], "w", "c"));
    const parts = asMessages(r.output_messages)[0].parts;
    expect(parts).toEqual([
      { type: "tool_call", name: "add", id: "toolu_3", arguments: { a: 1 } },
    ]);
  });

  it("translates ToolMessage with kwargs.tool_call_id", () => {
    const attrs: Record<string, unknown> = {
      "openinference.span.kind": "llm",
      "input.value": JSON.stringify({
        messages: [lcMsg("ToolMessage", { content: "85", tool_call_id: "toolu_4", name: "add" })],
      }),
    };
    const r = obs(transformSpans([makeSpan({ attrs })], "w", "c"));
    expect(r.input_messages).toEqual([
      {
        role: "tool",
        parts: [{ type: "tool_call_response", response: "85", id: "toolu_4" }],
        name: "add",
      },
    ]);
  });

  it("translates SystemMessage", () => {
    const attrs: Record<string, unknown> = {
      "openinference.span.kind": "llm",
      "input.value": JSON.stringify({
        messages: [lcMsg("SystemMessage", { content: "Be terse." })],
      }),
    };
    const r = obs(transformSpans([makeSpan({ attrs })], "w", "c"));
    expect(r.input_messages).toEqual([
      { role: "system", parts: [{ type: "text", content: "Be terse." }] },
    ]);
  });

  it("translates a full Human → AIMessage(tool_calls) → Tool → AIMessage transcript", () => {
    const attrs: Record<string, unknown> = {
      "openinference.span.kind": "llm",
      "input.value": JSON.stringify({
        messages: [
          lcMsg("HumanMessage", { content: "What is 47 + 38?" }),
          lcMsg("AIMessage", {
            content: [{ type: "tool_use", id: "toolu_x", name: "add", input: { a: 47, b: 38 } }],
            tool_calls: [{ name: "add", args: { a: 47, b: 38 }, id: "toolu_x", type: "tool_call" }],
          }),
          lcMsg("ToolMessage", { content: "85", tool_call_id: "toolu_x", name: "add" }),
          lcMsg("AIMessage", { content: "47 + 38 = 85" }),
        ],
      }),
    };
    const r = obs(transformSpans([makeSpan({ attrs })], "w", "c"));
    const msgs = asMessages(r.input_messages);
    expect(msgs).toHaveLength(4);
    expect(msgs[0].role).toBe("user");
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[1].parts).toEqual([
      { type: "tool_call", name: "add", id: "toolu_x", arguments: { a: 47, b: 38 } },
    ]);
    expect(msgs[2].role).toBe("tool");
    expect(msgs[2].parts[0]).toMatchObject({
      type: "tool_call_response",
      response: "85",
      id: "toolu_x",
    });
    expect(msgs[3]).toEqual({
      role: "assistant",
      parts: [{ type: "text", content: "47 + 38 = 85" }],
    });
  });

  it("recognizes a bare-array Serializable input.value (no {messages:...} wrapper)", () => {
    const attrs: Record<string, unknown> = {
      "openinference.span.kind": "llm",
      "input.value": JSON.stringify([
        lcMsg("HumanMessage", { content: "hi" }),
        lcMsg("AIMessage", { content: "hello" }),
      ]),
    };
    const r = obs(transformSpans([makeSpan({ attrs })], "w", "c"));
    expect(r.input_messages).toEqual([
      { role: "user", parts: [{ type: "text", content: "hi" }] },
      { role: "assistant", parts: [{ type: "text", content: "hello" }] },
    ]);
  });
});

describe("traceloop normalizer", () => {
  it("rebuilds indexed flat gen_ai.prompt / gen_ai.completion", () => {
    const attrs: Record<string, unknown> = {
      "gen_ai.prompt.0.role": "user",
      "gen_ai.prompt.0.content": "hi",
      "gen_ai.completion.0.role": "assistant",
      "gen_ai.completion.0.content": "hello",
    };
    const r = obs(transformSpans([makeSpan({ attrs })], "w", "c"));
    expect(r.input_messages).toEqual([
      { role: "user", parts: [{ type: "text", content: "hi" }] },
    ]);
    expect(r.output_messages).toEqual([
      { role: "assistant", parts: [{ type: "text", content: "hello" }] },
    ]);
  });
});

describe("braintrust normalizer", () => {
  it("translates braintrust.input_json / output_json (OpenAI shape)", () => {
    const attrs: Record<string, unknown> = {
      "braintrust.input_json": JSON.stringify([
        { role: "user", content: "hi" },
      ]),
      "braintrust.output_json": JSON.stringify([
        { role: "assistant", content: "hello" },
      ]),
    };
    const r = obs(transformSpans([makeSpan({ attrs })], "w", "c"));
    expect(r.input_messages).toEqual([
      { role: "user", parts: [{ type: "text", content: "hi" }] },
    ]);
    expect(r.output_messages).toEqual([
      { role: "assistant", parts: [{ type: "text", content: "hello" }] },
    ]);
  });
});

describe("vercelAi normalizer", () => {
  it("translates ai.prompt.messages with multimodal image_url to UriPart", () => {
    const attrs: Record<string, unknown> = {
      "ai.operationId": "ai.generateText",
      "ai.prompt.messages": JSON.stringify([
        {
          role: "user",
          content: [
            { type: "text", text: "What is this?" },
            { type: "image_url", image_url: { url: "https://x/y.png" } },
          ],
        },
      ]),
      "ai.response.text": "A cat.",
    };
    const r = obs(transformSpans([makeSpan({ attrs })], "w", "c"));
    expect(r.input_messages).toEqual([
      {
        role: "user",
        parts: [
          { type: "text", content: "What is this?" },
          { type: "uri", modality: "image", uri: "https://x/y.png" },
        ],
      },
    ]);
    expect(r.output_messages).toEqual([
      { role: "assistant", parts: [{ type: "text", content: "A cat." }] },
    ]);
  });

  it("decodes data: image URLs to BlobPart with mime_type", () => {
    const attrs: Record<string, unknown> = {
      "ai.operationId": "ai.generateText",
      "ai.prompt.messages": JSON.stringify([
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          ],
        },
      ]),
    };
    const r = obs(transformSpans([makeSpan({ attrs })], "w", "c"));
    expect(asMessages(r.input_messages)[0].parts[0]).toEqual({
      type: "blob",
      modality: "image",
      content: "AAAA",
      mime_type: "image/png",
    });
  });

  it("handles tool execution span (args in, result out)", () => {
    const attrs: Record<string, unknown> = {
      "ai.operationId": "ai.toolCall",
      "ai.toolCall.name": "getWeather",
      "ai.toolCall.args": '{"city":"Paris"}',
      "ai.toolCall.result": { temp: 22 },
    };
    const r = obs(transformSpans([makeSpan({ attrs })], "w", "c"));
    expect(r.input_messages).toEqual([
      {
        role: "assistant",
        parts: [
          {
            type: "tool_call",
            name: "getWeather",
            arguments: { city: "Paris" },
          },
        ],
      },
    ]);
    expect(r.output_messages).toEqual([
      {
        role: "tool",
        parts: [{ type: "tool_call_response", response: { temp: 22 } }],
      },
    ]);
  });
});

describe("logfire normalizer (Pydantic AI envelope)", () => {
  it("translates request/response envelopes with tool-call/tool-return parts", () => {
    const envelope = JSON.stringify([
      {
        kind: "request",
        parts: [
          { part_kind: "system-prompt", content: "Be concise" },
          { part_kind: "user-prompt", content: "hi" },
        ],
      },
      {
        kind: "response",
        parts: [
          { part_kind: "text", content: "ok" },
          {
            part_kind: "tool-call",
            tool_name: "x",
            args: { a: 1 },
            tool_call_id: "c1",
          },
        ],
      },
    ]);
    const r = obs(transformSpans([makeSpan({ attrs: { "pydantic_ai.all_messages": envelope } })], "w", "c"));
    expect(r.input_messages).toEqual([
      { role: "system", parts: [{ type: "text", content: "Be concise" }] },
      { role: "user", parts: [{ type: "text", content: "hi" }] },
    ]);
    expect(r.output_messages).toEqual([
      {
        role: "assistant",
        parts: [
          { type: "text", content: "ok" },
          { type: "tool_call", name: "x", arguments: { a: 1 }, id: "c1" },
        ],
      },
    ]);
  });
});

describe("langfuse normalizer", () => {
  it("merges langfuse.observation.tool_calls into the assistant output", () => {
    const attrs: Record<string, unknown> = {
      "langfuse.observation.input": JSON.stringify([
        { role: "user", content: "hi" },
      ]),
      "langfuse.observation.output": "ok",
      "langfuse.observation.tool_calls": JSON.stringify([
        { id: "c1", name: "lookup", arguments: { q: "x" } },
      ]),
    };
    const r = obs(transformSpans([makeSpan({ attrs })], "w", "c"));
    expect(r.input_messages).toEqual([
      { role: "user", parts: [{ type: "text", content: "hi" }] },
    ]);
    expect(r.output_messages).toEqual([
      {
        role: "assistant",
        parts: [
          { type: "text", content: "ok" },
          { type: "tool_call", name: "lookup", id: "c1", arguments: { q: "x" } },
        ],
      },
    ]);
  });
});

describe("span-event fallback", () => {
  it("canonicalizes gen_ai.user.message / gen_ai.choice events", () => {
    const span = makeSpan({
      events: [
        {
          name: "gen_ai.user.message",
          attributes: { content: "hi" },
          time: [1_700_000_000, 0],
        },
        {
          name: "gen_ai.choice",
          attributes: { content: "hello", finish_reason: "stop" },
          time: [1_700_000_000, 1],
        },
      ],
    });
    const r = obs(transformSpans([span], "w", "c"));
    expect(r.input_messages).toEqual([
      { role: "user", parts: [{ type: "text", content: "hi" }] },
    ]);
    expect(r.output_messages).toEqual([
      {
        role: "assistant",
        parts: [{ type: "text", content: "hello" }],
        finish_reason: "stop",
      },
    ]);
  });

  it("canonicalizes gen_ai.tool.message into a tool_call_response", () => {
    const span = makeSpan({
      events: [
        {
          name: "gen_ai.user.message",
          attributes: { content: "what's the weather?" },
          time: [1_700_000_000, 0],
        },
        {
          name: "gen_ai.tool.message",
          attributes: { id: "call_42", content: "72F" },
          time: [1_700_000_000, 1],
        },
        {
          name: "gen_ai.choice",
          attributes: { content: "It's 72F", finish_reason: "stop" },
          time: [1_700_000_000, 2],
        },
      ],
    });
    const r = obs(transformSpans([span], "w", "c"));
    expect(r.input_messages).toEqual([
      { role: "user", parts: [{ type: "text", content: "what's the weather?" }] },
      {
        role: "tool",
        parts: [{ type: "tool_call_response", response: "72F", id: "call_42" }],
      },
    ]);
    expect(r.output_messages).toEqual([
      {
        role: "assistant",
        parts: [{ type: "text", content: "It's 72F" }],
        finish_reason: "stop",
      },
    ]);
  });
});

describe("cross-adapter resolution", () => {
  it("takes input from vercelAi and output from langfuse independently", () => {
    // Locks the doc'd "per-side first-non-null wins" guarantee. Langfuse
    // (registry position 5) sees the output blob first; vercelAi (position
    // 8) fills the still-empty input side from `ai.prompt.messages`.
    const attrs: Record<string, unknown> = {
      "ai.prompt.messages": JSON.stringify([
        { role: "user", content: "hi" },
      ]),
      "langfuse.observation.output": JSON.stringify([
        { role: "assistant", content: "hello" },
      ]),
    };
    const r = obs(transformSpans([makeSpan({ attrs })], "w", "c"));
    expect(r.input_messages).toEqual([
      { role: "user", parts: [{ type: "text", content: "hi" }] },
    ]);
    expect(r.output_messages).toEqual([
      { role: "assistant", parts: [{ type: "text", content: "hello" }] },
    ]);
  });
});

describe("system_instructions injection", () => {
  it("prepends gen_ai.system_instructions array as a system message", () => {
    const span = makeSpan({
      attrs: {
        "gen_ai.system_instructions": JSON.stringify([
          { type: "text", content: "Be helpful" },
        ]),
        "gen_ai.input.messages": JSON.stringify([
          { role: "user", content: "hi" },
        ]),
      },
    });
    const r = obs(transformSpans([span], "w", "c"));
    expect(asMessages(r.input_messages)[0]).toEqual({
      role: "system",
      parts: [{ type: "text", content: "Be helpful" }],
    });
    expect(asMessages(r.input_messages)[1].role).toBe("user");
  });

  it("does not double-inject when input already starts with a system message", () => {
    const span = makeSpan({
      attrs: {
        "gen_ai.system_instructions": "Be helpful",
        "gen_ai.input.messages": JSON.stringify([
          { role: "system", content: "Be terse" },
          { role: "user", content: "hi" },
        ]),
      },
    });
    const r = obs(transformSpans([span], "w", "c"));
    expect(asMessages(r.input_messages)[0].parts[0]).toEqual({
      type: "text",
      content: "Be terse",
    });
    expect(r.input_messages).toHaveLength(2);
  });
});

describe("non-LLM spans", () => {
  it("returns null for both directions when no recognizable attrs", () => {
    const span = makeSpan({
      attrs: { "http.method": "GET", "http.url": "https://x/y" },
      kind: SpanKind.CLIENT,
    });
    const r = obs(transformSpans([span], "w", "c"));
    expect(r.input_messages).toBeNull();
    expect(r.output_messages).toBeNull();
  });
});
