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
    expect(r.input).toEqual([
      { role: "user", parts: [{ type: "text", content: "hi" }] },
    ]);
    expect(r.output).toEqual([
      { role: "assistant", parts: [{ type: "text", content: "hello" }] },
    ]);
  });

  // An empty `role` string is treated as missing and defaults to "user" — an
  // empty role would otherwise produce a malformed canonical message.
  it("defaults empty role to 'user'", () => {
    const span = makeSpan({
      attrs: {
        "gen_ai.input.messages": JSON.stringify([
          { role: "", content: "hi" },
        ]),
      },
    });
    const r = obs(transformSpans([span], "w", "c"));
    expect(r.input).toEqual([
      { role: "user", parts: [{ type: "text", content: "hi" }] },
    ]);
  });

  it("text-wraps legacy gen_ai.prompt / gen_ai.completion", () => {
    const span = makeSpan({
      attrs: { "gen_ai.prompt": "hi", "gen_ai.completion": "there" },
    });
    const r = obs(transformSpans([span], "w", "c"));
    expect(r.input).toEqual([
      { role: "user", parts: [{ type: "text", content: "hi" }] },
    ]);
    expect(r.output).toEqual([
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
    expect(r.output).toEqual([
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

  // OpenLLMetry / Traceloop's LangChain instrumentation serializes Anthropic-
  // style content arrays containing `tool_use` blocks by stringifying each
  // block into a TextPart while ALSO emitting a parallel `tool_call` part.
  // Drop the redundant text mirror; keep the structured tool_call.
  it("dedupes stringified tool_use TextPart paired with tool_call", () => {
    const span = makeSpan({
      attrs: {
        "gen_ai.output.messages": JSON.stringify([
          {
            role: "assistant",
            parts: [
              {
                type: "text",
                content: JSON.stringify({
                  id: "toolu_X",
                  input: { a: 1, b: 2 },
                  name: "add",
                  type: "tool_use",
                }),
              },
              {
                type: "tool_call",
                id: "toolu_X",
                name: "add",
                arguments: { a: 1, b: 2 },
              },
            ],
          },
        ]),
      },
    });
    const r = obs(transformSpans([span], "w", "c"));
    expect(r.output).toEqual([
      {
        role: "assistant",
        parts: [
          { type: "tool_call", id: "toolu_X", name: "add", arguments: { a: 1, b: 2 } },
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
    expect(r.input).toEqual([
      { role: "system", parts: [{ type: "text", content: "Be helpful." }] },
      { role: "user", parts: [{ type: "text", content: "Hi!" }] },
    ]);
    expect(r.output).toEqual([
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
    expect(r.output).toEqual([
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
    expect(r.input).toEqual([
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
    expect(r.output).toEqual([
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
    expect(r.output).toEqual([
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
    const parts = asMessages(r.output)[0].parts;
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
    expect(r.input).toEqual([
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
    expect(r.input).toEqual([
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
    const msgs = asMessages(r.input);
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
    expect(r.input).toEqual([
      { role: "user", parts: [{ type: "text", content: "hi" }] },
      { role: "assistant", parts: [{ type: "text", content: "hello" }] },
    ]);
  });

  // LangChain JS LLMResult shape: `output.value` is wrapped as
  // {generations: [[{text, message: <Serializable AIMessage>}, ...]], llmOutput}.
  // Without unwrapping, the indexed-flat fallback (`llm.output_messages.0.message.role`)
  // produces an empty assistant message because the AIMessage's content is a
  // tool_use array, not a string.
  it("unwraps LangChain LLMResult `generations` wrapper for output.value", () => {
    const attrs: Record<string, unknown> = {
      "openinference.span.kind": "llm",
      "llm.output_messages.0.message.role": "assistant",
      "output.value": JSON.stringify({
        generations: [
          [{
            text: "",
            message: lcMsg("AIMessage", {
              content: [
                { type: "tool_use", id: "toolu_X", name: "add", input: { a: 47, b: 38 } },
              ],
            }),
          }],
        ],
        llmOutput: { model: "claude-sonnet-4-5" },
      }),
    };
    const r = obs(transformSpans([makeSpan({ attrs })], "w", "c"));
    expect(r.output).toEqual([
      {
        role: "assistant",
        parts: [
          { type: "tool_call", id: "toolu_X", name: "add", arguments: { a: 47, b: 38 } },
        ],
      },
    ]);
  });

  // LangChain JS BaseChatModel.invoke uses a batch convention: `messages` is
  // BaseMessage[][] (each outer slot = one conversation in the batch). For
  // single-conversation invocations the outer array still wraps the inner
  // turn list. Flatten one level so the inner Serializables are translated.
  it("flattens LangChain JS double-array `messages: [[...]]` nesting", () => {
    const attrs: Record<string, unknown> = {
      "openinference.span.kind": "llm",
      "input.value": JSON.stringify({
        messages: [[
          lcMsg("HumanMessage", { content: "What is 47 + 38?" }),
          lcMsg("AIMessage", {
            content: [
              { type: "tool_use", id: "toolu_X", name: "add", input: { a: 47, b: 38 } },
            ],
          }),
          lcMsg("ToolMessage", { content: "85", tool_call_id: "toolu_X", name: "add" }),
        ]],
      }),
    };
    const r = obs(transformSpans([makeSpan({ attrs })], "w", "c"));
    expect(r.input).toEqual([
      { role: "user", parts: [{ type: "text", content: "What is 47 + 38?" }] },
      {
        role: "assistant",
        parts: [
          { type: "tool_call", id: "toolu_X", name: "add", arguments: { a: 47, b: 38 } },
        ],
      },
      {
        role: "tool",
        parts: [{ type: "tool_call_response", id: "toolu_X", response: "85" }],
        name: "add",
      },
    ]);
  });

  // `langchain_core.messages.utils.messages_to_dict` (used by LangGraph state
  // serialization and many CHAIN-span outputs) emits each BaseMessage as
  // {type: "<role>", data: {<actual fields>}} rather than the flat
  // BaseMessage.dict() shape. The plain-dict translator must descend into
  // `data` to reach `content` / `tool_calls` / `tool_call_id`.
  it("translates messages_to_dict envelope (full human → ai+tool_calls → tool → ai)", () => {
    const attrs: Record<string, unknown> = {
      "openinference.span.kind": "chain",
      "input.value": JSON.stringify({
        messages: [
          { type: "human", data: { content: "What is 47 + 38?", type: "human", id: "h1" } },
          { type: "ai", data: {
              content: "",
              type: "ai",
              id: "a1",
              tool_calls: [
                { name: "add", args: { a: 47, b: 38 }, id: "toolu_x", type: "tool_call" },
              ],
            } },
          { type: "tool", data: {
              content: "85", type: "tool", name: "add", tool_call_id: "toolu_x", id: "t1",
            } },
          { type: "ai", data: { content: "47 + 38 = 85", type: "ai", id: "a2" } },
        ],
      }),
    };
    const r = obs(transformSpans([makeSpan({ attrs })], "w", "c"));
    expect(r.input).toEqual([
      { role: "user", parts: [{ type: "text", content: "What is 47 + 38?" }] },
      { role: "assistant", parts: [
          { type: "tool_call", name: "add", id: "toolu_x", arguments: { a: 47, b: 38 } },
        ] },
      {
        role: "tool",
        parts: [{ type: "tool_call_response", response: "85", id: "toolu_x" }],
        name: "add",
      },
      { role: "assistant", parts: [{ type: "text", content: "47 + 38 = 85" }] },
    ]);
  });

  // Single bare {type:"ai", data:{...}} envelope (LangChain's `message_to_dict`
  // of a lone AIMessage with tool_calls) — observed on `_ConfigurableModel`
  // CHAIN spans whose `output.value` carries one assistant turn rather than a
  // conversation list.
  it("translates single messages_to_dict AI envelope with tool_calls", () => {
    const attrs: Record<string, unknown> = {
      "openinference.span.kind": "chain",
      "output.value": JSON.stringify({
        type: "ai",
        data: {
          content: "",
          type: "ai",
          id: "lc_run--xxx",
          tool_calls: [
            { name: "ConductResearch", args: { research_topic: "capital of Australia" },
              id: "call_w", type: "tool_call" },
          ],
        },
      }),
    };
    const r = obs(transformSpans([makeSpan({ attrs })], "w", "c"));
    expect(r.output).toEqual([
      {
        role: "assistant",
        parts: [
          { type: "tool_call", name: "ConductResearch", id: "call_w",
            arguments: { research_topic: "capital of Australia" } },
        ],
      },
    ]);
  });

  // `langgraph.types.Command` (returned by every node that wants to steer the
  // graph + update state) is serialized by OpenInference as
  // {graph: null, update: {...}, resume: ..., goto: "<node>"}. Recurse into
  // `update` so the inner `messages` list is reachable.
  it("unwraps LangGraph Command envelope and reaches inner messages", () => {
    const attrs: Record<string, unknown> = {
      "openinference.span.kind": "chain",
      "output.value": JSON.stringify({
        graph: null,
        update: {
          messages: [
            { type: "ai", data: {
                content: "Thank you for your request.",
                type: "ai",
                id: "a1",
                tool_calls: [],
              } },
          ],
        },
        resume: null,
        goto: "write_research_brief",
      }),
    };
    const r = obs(transformSpans([makeSpan({ attrs })], "w", "c"));
    expect(r.output).toEqual([
      { role: "assistant", parts: [
          { type: "text", content: "Thank you for your request." },
        ] },
    ]);
  });

  // `Command` whose `update` is a state delta with no message-shaped values
  // carries no canonical messages — return null rather than fabricating one.
  // (Empty `researcher_messages` list, no other channels.)
  it("returns null for Command envelope without inner messages", () => {
    const attrs: Record<string, unknown> = {
      "openinference.span.kind": "chain",
      "output.value": JSON.stringify({
        graph: null,
        update: { researcher_messages: [] },
        resume: null,
        goto: "compress_research",
      }),
    };
    const r = obs(transformSpans([makeSpan({ attrs })], "w", "c"));
    expect(r.output).toBeNull();
  });

  // `Command` with a *custom* state-channel name (multi-agent LangGraph apps
  // almost always rename their message channels — `researcher_messages`,
  // `supervisor_messages`, `chat_history`…). The default `MessagesState` uses
  // `messages`, but every nontrivial graph customises it. The unwrapper
  // should walk all values of `update` and pick up any list of LangChain
  // messages, not only the `messages` key. Mirrors the `researcher_tools`
  // ToolNode output shape we observed in deep_researcher traces — a
  // `ToolMessage` carrying `tool_call_id` linkage that would otherwise be
  // lost.
  it("unwraps Command envelope with custom message channel", () => {
    const attrs: Record<string, unknown> = {
      "openinference.span.kind": "chain",
      "output.value": JSON.stringify({
        graph: null,
        update: {
          researcher_messages: [
            { type: "tool", data: {
                content: "Reflection recorded",
                type: "tool",
                name: "ResearchComplete",
                tool_call_id: "call_ULHX17O2dpHDuDjzLlxZZFcP",
                id: null,
              } },
          ],
        },
        resume: null,
        goto: "compress_research",
      }),
    };
    const r = obs(transformSpans([makeSpan({ attrs })], "w", "c"));
    expect(r.output).toEqual([
      {
        role: "tool",
        parts: [{
          type: "tool_call_response",
          response: "Reflection recorded",
          id: "call_ULHX17O2dpHDuDjzLlxZZFcP",
        }],
        name: "ResearchComplete",
      },
    ]);
  });

  // When `update` mixes a message channel with non-message scalars (`notes`
  // is a plain string list in deep_researcher's `supervisor_tools` output),
  // only the message channel is unwrapped — arbitrary scalars must not be
  // text-wrapped into fake messages.
  it("Command envelope picks up messages alongside scalar state", () => {
    const attrs: Record<string, unknown> = {
      "openinference.span.kind": "chain",
      "output.value": JSON.stringify({
        graph: null,
        update: {
          supervisor_messages: [
            { type: "ai", data: {
                content: "Delegating to researcher.",
                type: "ai",
                id: "a1",
                tool_calls: [],
              } },
          ],
          notes: ["Reflection recorded: ..."],
        },
        resume: null,
        goto: "supervisor",
      }),
    };
    const r = obs(transformSpans([makeSpan({ attrs })], "w", "c"));
    expect(r.output).toEqual([
      { role: "assistant", parts: [
          { type: "text", content: "Delegating to researcher." },
        ] },
    ]);
  });

  // Non-conversational CHAIN spans (e.g. LangGraph's RunnableLambda routing
  // {output:[{lg_name:"Send",...}]}) used to be text-wrapped into a fake
  // `[{role:"assistant", parts:[{type:"text", content:"<entire JSON blob>"}]}]`.
  // Mirror the call we made on Traceloop entity blobs: return null canonical;
  // the raw `output` field still carries the blob for debugging.
  it("returns null canonical for non-conversational CHAIN output blobs", () => {
    const attrs: Record<string, unknown> = {
      "openinference.span.kind": "chain",
      "output.value": JSON.stringify({
        output: [
          { lg_name: "Send", node: "tools", args: { messages: [] } },
        ],
      }),
    };
    const r = obs(transformSpans([makeSpan({ attrs })], "w", "c"));
    expect(r.output).toBeNull();
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
    expect(r.input).toEqual([
      { role: "user", parts: [{ type: "text", content: "hi" }] },
    ]);
    expect(r.output).toEqual([
      { role: "assistant", parts: [{ type: "text", content: "hello" }] },
    ]);
  });

  // When the indexed primary `tool_call_id` is an empty string but the dotted
  // alias `tool_call.id` carries a real value, the canonical
  // `tool_call_response` part picks up the alt-key id rather than emitting an
  // empty `id` that would break call/response linking downstream.
  it("falls through empty tool_call_id to dotted tool_call.id alias", () => {
    const attrs: Record<string, unknown> = {
      "gen_ai.prompt.0.role": "tool",
      "gen_ai.prompt.0.tool_call_id": "",
      "gen_ai.prompt.0.tool_call.id": "call_abc123",
      "gen_ai.prompt.0.content": "weather: sunny",
    };
    const r = obs(transformSpans([makeSpan({ attrs })], "w", "c"));
    expect(r.input).toEqual([
      {
        role: "tool",
        parts: [
          { type: "tool_call_response", response: "weather: sunny", id: "call_abc123" },
        ],
      },
    ]);
  });

  // OpenLLMetry's @workflow / @task decorators dump opaque entity blobs
  // (`{"inputs":{...},"tags":[...],"metadata":{...}}`) into
  // `traceloop.entity.input` / `traceloop.entity.output`. Wrapping those into
  // a single fake `[{role:"user", parts:[text:<blob>]}]` envelope misrepresents
  // them as a conversational message. Canonical view stays null; consumers
  // fall back to the raw `input`/`output` string.
  it("returns null canonical for non-conversational entity blobs", () => {
    const attrs: Record<string, unknown> = {
      "traceloop.span.kind": "task",
      "traceloop.entity.input": JSON.stringify({
        input_str: "{'a': 47, 'b': 38}",
        tags: ["seq:step:1"],
        metadata: { langgraph_node: "tools" },
      }),
      "traceloop.entity.output": JSON.stringify({
        output: { lc: 1, type: "constructor", id: ["x"], kwargs: { v: 1 } },
        kwargs: { tags: [] },
      }),
    };
    const r = obs(transformSpans([makeSpan({ attrs })], "w", "c"));
    expect(r.input).toBeNull();
    expect(r.output).toBeNull();
  });

  // When the entity blob does carry a real `messages` array (LangGraph
  // workflow input), unpack it via the LangChain-envelope translator —
  // including OpenAI-shape `{role,content}` items.
  it("unpacks LangGraph workflow inputs.{messages} as canonical", () => {
    const attrs: Record<string, unknown> = {
      "traceloop.span.kind": "workflow",
      "traceloop.entity.input": JSON.stringify({
        inputs: { messages: [{ role: "user", content: "What is 47 + 38?" }] },
        tags: [],
      }),
    };
    const r = obs(transformSpans([makeSpan({ attrs })], "w", "c"));
    expect(r.input).toEqual([
      { role: "user", parts: [{ type: "text", content: "What is 47 + 38?" }] },
    ]);
  });

  // Same for outputs (plural) wrapping a {messages:[Serializable,...]} array.
  it("unpacks LangGraph workflow outputs.{messages: [Serializable]}", () => {
    const lcAi = (content: string) => ({
      lc: 1,
      type: "constructor",
      id: ["langchain_core", "messages", "AIMessage"],
      kwargs: { content },
    });
    const attrs: Record<string, unknown> = {
      "traceloop.span.kind": "workflow",
      "traceloop.entity.output": JSON.stringify({
        outputs: { messages: [lcAi("47 + 38 = 85")] },
        kwargs: { tags: [] },
      }),
    };
    const r = obs(transformSpans([makeSpan({ attrs })], "w", "c"));
    expect(r.output).toEqual([
      { role: "assistant", parts: [{ type: "text", content: "47 + 38 = 85" }] },
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
    expect(r.input).toEqual([
      { role: "user", parts: [{ type: "text", content: "hi" }] },
    ]);
    expect(r.output).toEqual([
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
    expect(r.input).toEqual([
      {
        role: "user",
        parts: [
          { type: "text", content: "What is this?" },
          { type: "uri", modality: "image", uri: "https://x/y.png" },
        ],
      },
    ]);
    expect(r.output).toEqual([
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
    expect(asMessages(r.input)[0].parts[0]).toEqual({
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
    expect(r.input).toEqual([
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
    expect(r.output).toEqual([
      {
        role: "tool",
        parts: [{ type: "tool_call_response", response: { temp: 22 } }],
      },
    ]);
  });

  it("unpacks ai.prompt {system, messages:[...]} blob on agent-level spans", () => {
    // ai.streamText / ai.generateText emit the full prompt as a single JSON
    // blob in `ai.prompt` (no `ai.prompt.messages` at the agent level), with
    // shape {system: string, messages: [{role, content: [...]}]}. The blob
    // must be unpacked: `system` becomes a leading system message, and
    // `messages` are routed through the existing OpenAI/Vercel-shape coercer.
    const attrs: Record<string, unknown> = {
      "ai.operationId": "ai.streamText",
      "ai.prompt": JSON.stringify({
        system: "Be concise.",
        messages: [
          { role: "user", content: [{ type: "text", text: "who am I?" }] },
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "call_1",
                toolName: "lookup",
                input: { q: "user" },
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call_1",
                toolName: "lookup",
                output: { type: "json", value: { name: "Rado" } },
              },
            ],
          },
        ],
      }),
      "ai.response.text": "You are Rado.",
    };
    const r = obs(transformSpans([makeSpan({ attrs })], "w", "c"));
    expect(r.input).toEqual([
      { role: "system", parts: [{ type: "text", content: "Be concise." }] },
      { role: "user", parts: [{ type: "text", content: "who am I?" }] },
      {
        role: "assistant",
        parts: [
          {
            type: "tool_call",
            name: "lookup",
            id: "call_1",
            arguments: { q: "user" },
          },
        ],
      },
      {
        role: "tool",
        parts: [
          {
            type: "tool_call_response",
            response: { name: "Rado" },
            id: "call_1",
          },
        ],
      },
    ]);
    expect(r.output).toEqual([
      { role: "assistant", parts: [{ type: "text", content: "You are Rado." }] },
    ]);
  });

  it("unpacks ai.prompt blob without system field", () => {
    const attrs: Record<string, unknown> = {
      "ai.operationId": "ai.generateText",
      "ai.prompt": JSON.stringify({
        messages: [{ role: "user", content: "hi" }],
      }),
    };
    const r = obs(transformSpans([makeSpan({ attrs })], "w", "c"));
    expect(r.input).toEqual([
      { role: "user", parts: [{ type: "text", content: "hi" }] },
    ]);
  });

  it("falls back to user text when ai.prompt is a plain string", () => {
    const attrs: Record<string, unknown> = {
      "ai.operationId": "ai.generateText",
      "ai.prompt": "Just a freeform prompt",
    };
    const r = obs(transformSpans([makeSpan({ attrs })], "w", "c"));
    expect(r.input).toEqual([
      { role: "user", parts: [{ type: "text", content: "Just a freeform prompt" }] },
    ]);
  });

  it("projects ai.embed (singular) input as canonical user-text + maps ai.usage.tokens", () => {
    const attrs: Record<string, unknown> = {
      "ai.operationId": "ai.embed",
      "ai.value": "How would you describe me?",
      "ai.usage.tokens": 6,
      "ai.model.id": "text-embedding-ada-002",
    };
    const r = obs(transformSpans([makeSpan({ attrs })], "w", "c"));
    expect(r.input).toEqual([
      { role: "user", parts: [{ type: "text", content: "How would you describe me?" }] },
    ]);
    // Core auto-derives `total` from `input + output` when total is unset.
    expect(r.usage_details).toEqual({ input: 6, total: 6 });
  });

  it("projects ai.embedMany inputs (JSON-stringified array) as one user message per entry", () => {
    // Vercel JSON.stringify-encodes each entry in `ai.values` to fit OTel's
    // string-array attribute constraint, so a value of "User's name is Rado"
    // arrives as the literal `"\"User's name is Rado\""`. Each entry must be
    // unwrapped before going into a TextPart.
    const attrs: Record<string, unknown> = {
      "ai.operationId": "ai.embedMany",
      "ai.values": ['"User\'s name is Rado"', '"Loves espresso"'],
      "ai.usage.tokens": 12,
      "ai.model.id": "text-embedding-ada-002",
    };
    const r = obs(transformSpans([makeSpan({ attrs })], "w", "c"));
    expect(r.input).toEqual([
      { role: "user", parts: [{ type: "text", content: "User's name is Rado" }] },
      { role: "user", parts: [{ type: "text", content: "Loves espresso" }] },
    ]);
    expect(r.usage_details).toEqual({ input: 12, total: 12 });
  });

  it("ai.embed unwraps JSON.stringify-encoded ai.value", () => {
    // Vercel emits ai.value as JSON.stringify(input), so the literal value
    // arriving on the span is `"\"actual text\""` (with quote chars). Must
    // unwrap to canonical text without the surrounding quotes.
    const attrs: Record<string, unknown> = {
      "ai.operationId": "ai.embed",
      "ai.value": '"Who do I admire the most among tennis athletes?"',
    };
    const r = obs(transformSpans([makeSpan({ attrs })], "w", "c"));
    expect(r.input).toEqual([
      {
        role: "user",
        parts: [
          {
            type: "text",
            content: "Who do I admire the most among tennis athletes?",
          },
        ],
      },
    ]);
  });

  it("ai.embedMany handles non-JSON entries by passing them through as text", () => {
    // Defensive: if an upstream emits already-decoded strings (no JSON
    // escaping), keep them verbatim instead of producing null parts.
    const attrs: Record<string, unknown> = {
      "ai.operationId": "ai.embedMany",
      "ai.values": ["raw entry one", "raw entry two"],
    };
    const r = obs(transformSpans([makeSpan({ attrs })], "w", "c"));
    expect(r.input).toEqual([
      { role: "user", parts: [{ type: "text", content: "raw entry one" }] },
      { role: "user", parts: [{ type: "text", content: "raw entry two" }] },
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
    expect(r.input).toEqual([
      { role: "system", parts: [{ type: "text", content: "Be concise" }] },
      { role: "user", parts: [{ type: "text", content: "hi" }] },
    ]);
    expect(r.output).toEqual([
      {
        role: "assistant",
        parts: [
          { type: "text", content: "ok" },
          { type: "tool_call", name: "x", arguments: { a: 1 }, id: "c1" },
        ],
      },
    ]);
  });

  // An empty `part_kind` string falls through the switch's named cases and
  // lands on the default branch — the generic part is built with kind
  // "unknown" rather than passing the empty string through.
  it("defaults empty part_kind to 'unknown' on pydantic-ai parts", () => {
    const envelope = JSON.stringify([
      {
        kind: "request",
        parts: [{ part_kind: "", content: "x" }],
      },
    ]);
    const r = obs(
      transformSpans(
        [makeSpan({ attrs: { "pydantic_ai.all_messages": envelope } })],
        "w",
        "c",
      ),
    );
    const part = (r.input as Array<{ parts: Array<{ type: string }> }>)[0]
      .parts[0];
    expect(part.type).toBe("unknown");
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
    expect(r.input).toEqual([
      { role: "user", parts: [{ type: "text", content: "hi" }] },
    ]);
    expect(r.output).toEqual([
      {
        role: "assistant",
        parts: [
          { type: "text", content: "ok" },
          { type: "tool_call", name: "lookup", id: "c1", arguments: { q: "x" } },
        ],
      },
    ]);
  });

  // The Langfuse Python SDK serializes the trailing AIMessage from a
  // LangChain ChatAnthropic tool-use turn as a single object (not wrapped in
  // an array) with `content: [{type:"tool_use",...}]` plus a parallel
  // `tool_calls` array. Producing a clean canonical `tool_call` part requires
  // routing through the LangChain envelope translator and a single-object
  // shim before falling back to text-wrap.
  it("normalizes langchain ChatAnthropic tool_use output to a tool_call part", () => {
    const attrs: Record<string, unknown> = {
      "langfuse.observation.input": JSON.stringify([
        { role: "user", content: "What is 47 + 38?" },
      ]),
      "langfuse.observation.output": JSON.stringify({
        role: "assistant",
        content: [
          {
            id: "toolu_01SL9hqG8nmgqKPF4jirTY8a",
            caller: { type: "direct" },
            input: { a: 47, b: 38 },
            name: "add",
            type: "tool_use",
          },
        ],
        tool_calls: [
          {
            name: "add",
            args: { a: 47, b: 38 },
            id: "toolu_01SL9hqG8nmgqKPF4jirTY8a",
            type: "tool_call",
          },
        ],
      }),
    };
    const r = obs(transformSpans([makeSpan({ attrs })], "w", "c"));
    expect(r.output).toEqual([
      {
        role: "assistant",
        parts: [
          {
            type: "tool_call",
            name: "add",
            id: "toolu_01SL9hqG8nmgqKPF4jirTY8a",
            arguments: { a: 47, b: 38 },
          },
        ],
      },
    ]);
    expect(r.tool_calls).toEqual([
      {
        type: "tool_call",
        name: "add",
        id: "toolu_01SL9hqG8nmgqKPF4jirTY8a",
        arguments: { a: 47, b: 38 },
      },
    ]);
    expect(r.tool_call_names).toEqual(["add"]);
  });

  // The Langfuse Python LangChain integration injects each tool definition
  // as a phantom `{role:"tool", content:{name, input_schema, description}}`
  // entry inside `langfuse.observation.input` alongside the actual user
  // turn. These are tool *definitions*, not chat messages — drop them from
  // input_messages and surface them via the top-level `tool_definitions`
  // field instead.
  it("routes langfuse tool-definition phantom messages into tool_definitions", () => {
    const toolDef = {
      name: "add",
      input_schema: {
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"],
        type: "object",
      },
      description: "Adds two numbers together.",
    };
    const attrs: Record<string, unknown> = {
      "langfuse.observation.input": JSON.stringify([
        { role: "user", content: "What is 47 + 38?" },
        { role: "tool", content: toolDef },
      ]),
    };
    const r = obs(transformSpans([makeSpan({ attrs })], "w", "c"));
    expect(r.input).toEqual([
      { role: "user", parts: [{ type: "text", content: "What is 47 + 38?" }] },
    ]);
    expect(r.tool_definitions).toEqual([toolDef]);
  });

  // The Langfuse JS LangChain integration projects LangChain ToolMessage
  // into `{role: <tool_name>, content: <result>, additional_kwargs: {}}`
  // (using the tool name as the role, no tool_call_id link). The langfuse
  // adapter recovers the canonical `role:"tool"` + `tool_call_response` part
  // by matching the role string against tool_call.name on the preceding
  // assistant message.
  it("retags tool-name roles back to 'tool' with tool_call_response linkage", () => {
    const attrs: Record<string, unknown> = {
      "langfuse.observation.input": JSON.stringify([
        { content: "What is 47 + 38?", role: "user" },
        {
          content: [
            {
              type: "tool_use",
              id: "toolu_0183unn5QaJzKbi2w9yqPNdq",
              name: "add",
              input: { a: 47, b: 38 },
            },
          ],
          role: "assistant",
          tool_calls: [
            {
              name: "add",
              args: { a: 47, b: 38 },
              id: "toolu_0183unn5QaJzKbi2w9yqPNdq",
              type: "tool_call",
            },
          ],
        },
        { content: "85", additional_kwargs: {}, role: "add" },
        { content: "47 + 38 = 85", role: "assistant" },
      ]),
    };
    const r = obs(transformSpans([makeSpan({ attrs })], "w", "c"));
    const msgs = asMessages(r.input);
    expect(msgs).toHaveLength(4);
    expect(msgs[0]).toEqual({
      role: "user",
      parts: [{ type: "text", content: "What is 47 + 38?" }],
    });
    expect(msgs[1]).toEqual({
      role: "assistant",
      parts: [
        {
          type: "tool_call",
          name: "add",
          id: "toolu_0183unn5QaJzKbi2w9yqPNdq",
          arguments: { a: 47, b: 38 },
        },
      ],
    });
    expect(msgs[2]).toEqual({
      role: "tool",
      name: "add",
      parts: [
        {
          type: "tool_call_response",
          id: "toolu_0183unn5QaJzKbi2w9yqPNdq",
          response: "85",
        },
      ],
    });
    expect(msgs[3]).toEqual({
      role: "assistant",
      parts: [{ type: "text", content: "47 + 38 = 85" }],
    });
  });

  it("preserves developer role and does not rewrite it to tool", () => {
    const attrs: Record<string, unknown> = {
      "langfuse.observation.input": JSON.stringify([
        { role: "developer", content: "Always respond as strict JSON." },
        { role: "user", content: "hi" },
      ]),
    };
    const r = obs(transformSpans([makeSpan({ attrs })], "w", "c"));
    expect(r.input).toEqual([
      {
        role: "developer",
        parts: [{ type: "text", content: "Always respond as strict JSON." }],
      },
      { role: "user", parts: [{ type: "text", content: "hi" }] },
    ]);
  });

  // The Langfuse Python LangChain integration serializes a ToolMessage as a
  // plain `BaseMessage.dict()` blob — `{type:"tool", content, tool_call_id,
  // name, ...}` — without the `lc:1, type:"constructor"` Serializable
  // envelope and without an OpenAI-shape `role` field. Recover the canonical
  // role:"tool" + tool_call_response part by matching on the `type` field.
  it("normalizes PY plain-dict ToolMessage as role:tool with tool_call_id", () => {
    const attrs: Record<string, unknown> = {
      "langfuse.observation.input": JSON.stringify({ a: 47, b: 38 }),
      "langfuse.observation.output": JSON.stringify({
        content: "85.0",
        additional_kwargs: {},
        response_metadata: {},
        type: "tool",
        name: "add",
        id: null,
        tool_call_id: "toolu_01SL9hqG8nmgqKPF4jirTY8a",
        artifact: null,
        status: "success",
      }),
    };
    const r = obs(transformSpans([makeSpan({ attrs })], "w", "c"));
    expect(r.output).toEqual([
      {
        role: "tool",
        name: "add",
        parts: [
          {
            type: "tool_call_response",
            id: "toolu_01SL9hqG8nmgqKPF4jirTY8a",
            response: "85.0",
          },
        ],
      },
    ]);
  });

  // PY langchain CHAIN spans wrap the conversation as `{messages: [...]}`
  // where every entry is a plain `BaseMessage.dict()` blob (`type:"human"`,
  // `type:"ai"`, `type:"tool"`). All entries should normalize cleanly.
  it("normalizes PY plain-dict {messages:[...]} array end-to-end", () => {
    const attrs: Record<string, unknown> = {
      "langfuse.observation.output": JSON.stringify({
        messages: [
          { content: "What is 47 + 38?", type: "human" },
          {
            content: [
              {
                id: "toolu_x",
                input: { a: 47, b: 38 },
                name: "add",
                type: "tool_use",
              },
            ],
            type: "ai",
            tool_calls: [
              {
                name: "add",
                args: { a: 47, b: 38 },
                id: "toolu_x",
                type: "tool_call",
              },
            ],
          },
          {
            content: "85",
            type: "tool",
            name: "add",
            tool_call_id: "toolu_x",
          },
        ],
      }),
    };
    const r = obs(transformSpans([makeSpan({ attrs })], "w", "c"));
    expect(asMessages(r.output)).toEqual([
      { role: "user", parts: [{ type: "text", content: "What is 47 + 38?" }] },
      {
        role: "assistant",
        parts: [
          {
            type: "tool_call",
            name: "add",
            id: "toolu_x",
            arguments: { a: 47, b: 38 },
          },
        ],
      },
      {
        role: "tool",
        name: "add",
        parts: [{ type: "tool_call_response", id: "toolu_x", response: "85" }],
      },
    ]);
  });

  // Standalone tool-name role: the JS langfuse `tools` CHAIN span carries a
  // single-message output `[{role:"add", content:"85"}]` with no preceding
  // assistant tool_call message in the same array. The role should still be
  // rewritten to canonical "tool" with the tool name preserved, even without
  // a recoverable tool_call_id.
  it("rewrites standalone tool-name role even without a preceding tool_call", () => {
    const attrs: Record<string, unknown> = {
      "langfuse.observation.output": JSON.stringify([
        { content: "85", role: "add" },
      ]),
    };
    const r = obs(transformSpans([makeSpan({ attrs })], "w", "c"));
    expect(r.output).toEqual([
      {
        role: "tool",
        name: "add",
        parts: [{ type: "tool_call_response", response: "85" }],
      },
    ]);
  });

  // TOOL-span synthesis: a `langfuse.observation.type == "tool"` span carries
  // structured tool args under `input` and a tool-result envelope under
  // `output`. Wrap them as a canonical assistant tool_call request +
  // tool tool_call_response reply, mirroring how the same call appears in
  // the parent generation's transcript. Lifts tool name and tool_call_id
  // from the normalized output so input/output stay linked.
  it("synthesizes assistant tool_call from plain-dict TOOL output", () => {
    const attrs: Record<string, unknown> = {
      "langfuse.observation.type": "tool",
      "langfuse.observation.input": JSON.stringify({ a: 47, b: 38 }),
      "langfuse.observation.output": JSON.stringify({
        content: "85.0",
        type: "tool",
        name: "add",
        tool_call_id: "toolu_X",
        status: "success",
      }),
    };
    const r = obs(transformSpans([makeSpan({ attrs })], "w", "c"));
    expect(r.input).toEqual([
      {
        role: "assistant",
        parts: [
          {
            type: "tool_call",
            name: "add",
            id: "toolu_X",
            arguments: { a: 47, b: 38 },
          },
        ],
      },
    ]);
    expect(r.output).toEqual([
      {
        role: "tool",
        name: "add",
        parts: [
          {
            type: "tool_call_response",
            id: "toolu_X",
            response: "85.0",
          },
        ],
      },
    ]);
  });

  // Same synthesis but with a LangChain Serializable ToolMessage envelope on
  // the output (the JS langfuse-sdk shape). The envelope translator extracts
  // the same name + tool_call_id; the synthesized input mirrors them.
  it("synthesizes assistant tool_call from Serializable TOOL output", () => {
    const attrs: Record<string, unknown> = {
      "langfuse.observation.type": "tool",
      "langfuse.observation.input": JSON.stringify({ a: 47, b: 38 }),
      "langfuse.observation.output": JSON.stringify({
        lc: 1,
        type: "constructor",
        id: ["langchain_core", "messages", "ToolMessage"],
        kwargs: {
          name: "add",
          tool_call_id: "toolu_Y",
          content: "85",
          status: "success",
        },
      }),
    };
    const r = obs(transformSpans([makeSpan({ attrs })], "w", "c"));
    expect(r.input).toEqual([
      {
        role: "assistant",
        parts: [
          {
            type: "tool_call",
            name: "add",
            id: "toolu_Y",
            arguments: { a: 47, b: 38 },
          },
        ],
      },
    ]);
    expect(r.output).toEqual([
      {
        role: "tool",
        name: "add",
        parts: [
          {
            type: "tool_call_response",
            id: "toolu_Y",
            response: "85",
          },
        ],
      },
    ]);
  });

  // Output envelope unrecognized (bare-string output): synthesis can't lift
  // a tool name, so input falls through to existing blobToMessages
  // text-wrap. Output gets the fallback synthesis -- a tool message with
  // the raw response and no id linkage.
  it("falls back to raw-string output wrap when envelope unrecognized", () => {
    const attrs: Record<string, unknown> = {
      "langfuse.observation.type": "tool",
      "langfuse.observation.input": JSON.stringify({ x: 1 }),
      "langfuse.observation.output": JSON.stringify("85"),
    };
    const r = obs(transformSpans([makeSpan({ attrs })], "w", "c"));
    expect(r.input).toEqual([
      {
        role: "user",
        parts: [{ type: "text", content: '{"x":1}' }],
      },
    ]);
    expect(r.output).toEqual([
      {
        role: "tool",
        parts: [{ type: "tool_call_response", response: "85" }],
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
    expect(r.input).toEqual([
      { role: "user", parts: [{ type: "text", content: "hi" }] },
    ]);
    expect(r.output).toEqual([
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
    expect(r.input).toEqual([
      { role: "user", parts: [{ type: "text", content: "what's the weather?" }] },
      {
        role: "tool",
        parts: [{ type: "tool_call_response", response: "72F", id: "call_42" }],
      },
    ]);
    expect(r.output).toEqual([
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
    expect(r.input).toEqual([
      { role: "user", parts: [{ type: "text", content: "hi" }] },
    ]);
    expect(r.output).toEqual([
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
    expect(asMessages(r.input)[0]).toEqual({
      role: "system",
      parts: [{ type: "text", content: "Be helpful" }],
    });
    expect(asMessages(r.input)[1].role).toBe("user");
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
    expect(asMessages(r.input)[0].parts[0]).toEqual({
      type: "text",
      content: "Be terse",
    });
    expect(r.input).toHaveLength(2);
  });

  it("text-wraps non-string non-object items in array form", () => {
    // Out-of-spec input (the schema wants Parts), but cross-SDK parity
    // requires both SDKs produce the same shape. Numbers wrap as text;
    // null/undefined items drop.
    const span = makeSpan({
      attrs: {
        "gen_ai.system_instructions": JSON.stringify([42, 7, "ok", null]),
        "gen_ai.input.messages": JSON.stringify([
          { role: "user", content: "hi" },
        ]),
      },
    });
    const r = obs(transformSpans([span], "w", "c"));
    expect(asMessages(r.input)[0]).toEqual({
      role: "system",
      parts: [
        { type: "text", content: "42" },
        { type: "text", content: "7" },
        { type: "text", content: "ok" },
      ],
    });
  });
});

describe("non-LLM spans", () => {
  it("returns null for both directions when no recognizable attrs", () => {
    const span = makeSpan({
      attrs: { "http.method": "GET", "http.url": "https://x/y" },
      kind: SpanKind.CLIENT,
    });
    const r = obs(transformSpans([span], "w", "c"));
    expect(r.input).toBeNull();
    expect(r.output).toBeNull();
  });
});
