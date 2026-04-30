"""Canonical OTel GenAI v2 message-shape tests.

Each class exercises one adapter's ``normalize_messages`` hook plus the core
resolution chain (events fallback, text-wrap fallback, system-instructions
injection). Mirrored byte-for-byte by the Node suite at
``nodejs-sdk/src/transformer.normalization.test.ts``.
"""

from __future__ import annotations

import json
from unittest.mock import MagicMock

from opentelemetry.trace import SpanKind, StatusCode

from kubit_otel.transformer import transform_spans


def _mock_span(
    *,
    name: str = "span",
    attrs: dict | None = None,
    parent_span_id: int | None = None,
    events: list | None = None,
    kind=SpanKind.CLIENT,
    scope_name: str = "kubit-sdk",
):
    span = MagicMock()
    span.name = name
    span.kind = kind
    span.attributes = attrs or {}
    span.events = events or []
    span.resource = MagicMock()
    span.resource.attributes = {}
    span.instrumentation_scope = MagicMock()
    span.instrumentation_scope.name = scope_name
    span.instrumentation_scope.version = "0.6.0"
    span.start_time = 1_700_000_000_000_000_000
    span.end_time = 1_700_000_001_000_000_000
    span.status = MagicMock()
    span.status.status_code = StatusCode.UNSET
    span.status.description = None
    ctx = MagicMock()
    ctx.trace_id = 0xAAAA
    ctx.span_id = 0xBBBB
    span.context = ctx
    if parent_span_id is None:
        span.parent = None
    else:
        parent = MagicMock()
        parent.span_id = parent_span_id
        span.parent = parent
    return span


def _obs(records):
    return next(r for r in records if r["entity_type"] == "enriched_observation")


def _transform(span):
    return transform_spans([span], wid="w", wid_claim="c")


# ── otelGenai ──────────────────────────────────────────────────────────────


class TestOtelGenaiNormalizer:
    def test_translates_input_messages_json(self):
        span = _mock_span(attrs={
            "gen_ai.input.messages": json.dumps([{"role": "user", "content": "hi"}]),
            "gen_ai.output.messages": json.dumps([
                {"role": "assistant", "content": "hello"}
            ]),
        })
        r = _obs(_transform(span))
        assert r["input"] == [
            {"role": "user", "parts": [{"type": "text", "content": "hi"}]}
        ]
        assert r["output"] == [
            {"role": "assistant", "parts": [{"type": "text", "content": "hello"}]}
        ]

    # An empty ``role`` string is treated as missing and defaults to "user" —
    # an empty role would otherwise produce a malformed canonical message.
    def test_defaults_empty_role_to_user(self):
        span = _mock_span(attrs={
            "gen_ai.input.messages": json.dumps([{"role": "", "content": "hi"}]),
        })
        r = _obs(_transform(span))
        assert r["input"] == [
            {"role": "user", "parts": [{"type": "text", "content": "hi"}]}
        ]

    def test_legacy_prompt_completion(self):
        span = _mock_span(attrs={"gen_ai.prompt": "hi", "gen_ai.completion": "there"})
        r = _obs(_transform(span))
        assert r["input"] == [
            {"role": "user", "parts": [{"type": "text", "content": "hi"}]}
        ]
        assert r["output"] == [
            {"role": "assistant", "parts": [{"type": "text", "content": "there"}]}
        ]

    def test_merges_tool_calls_into_assistant_output(self):
        span = _mock_span(attrs={
            "gen_ai.completion": "one moment",
            "gen_ai.tool.calls": json.dumps([
                {"id": "c1", "name": "lookup", "arguments": {"q": "x"}}
            ]),
        })
        r = _obs(_transform(span))
        assert r["output"] == [{
            "role": "assistant",
            "parts": [
                {"type": "text", "content": "one moment"},
                {"type": "tool_call", "name": "lookup", "id": "c1", "arguments": {"q": "x"}},
            ],
        }]

    # OpenLLMetry / Traceloop's LangChain instrumentation serializes Anthropic-
    # style content arrays containing ``tool_use`` blocks by stringifying each
    # block into a TextPart while ALSO emitting a parallel ``tool_call`` part.
    # Drop the redundant text mirror; keep the structured tool_call.
    def test_dedupes_stringified_tool_use_text_mirror(self):
        span = _mock_span(attrs={
            "gen_ai.output.messages": json.dumps([{
                "role": "assistant",
                "parts": [
                    {
                        "type": "text",
                        "content": json.dumps({
                            "id": "toolu_X",
                            "input": {"a": 1, "b": 2},
                            "name": "add",
                            "type": "tool_use",
                        }),
                    },
                    {
                        "type": "tool_call",
                        "id": "toolu_X",
                        "name": "add",
                        "arguments": {"a": 1, "b": 2},
                    },
                ],
            }]),
        })
        r = _obs(_transform(span))
        assert r["output"] == [{
            "role": "assistant",
            "parts": [
                {"type": "tool_call", "id": "toolu_X", "name": "add", "arguments": {"a": 1, "b": 2}},
            ],
        }]


# ── openinference ──────────────────────────────────────────────────────────


class TestOpeninferenceNormalizer:
    def test_indexed_flat_with_tool_calls(self):
        span = _mock_span(attrs={
            "llm.input_messages.0.message.role": "system",
            "llm.input_messages.0.message.content": "Be helpful.",
            "llm.input_messages.1.message.role": "user",
            "llm.input_messages.1.message.content": "Hi!",
            "llm.output_messages.0.message.role": "assistant",
            "llm.output_messages.0.message.content": "Hello!",
            "llm.output_messages.0.message.tool_calls.0.tool_call.id": "call_a",
            "llm.output_messages.0.message.tool_calls.0.tool_call.function.name": "lookup",
            "llm.output_messages.0.message.tool_calls.0.tool_call.function.arguments": '{"q":"x"}',
        })
        r = _obs(_transform(span))
        assert r["input"] == [
            {"role": "system", "parts": [{"type": "text", "content": "Be helpful."}]},
            {"role": "user", "parts": [{"type": "text", "content": "Hi!"}]},
        ]
        assert r["output"] == [{
            "role": "assistant",
            "parts": [
                {"type": "text", "content": "Hello!"},
                {"type": "tool_call", "name": "lookup", "id": "call_a", "arguments": {"q": "x"}},
            ],
        }]

    def test_retrieval_documents(self):
        span = _mock_span(attrs={
            "openinference.span.kind": "retriever",
            "retrieval.documents.0.document.content": "doc one",
            "retrieval.documents.0.document.id": "d1",
            "retrieval.documents.0.document.score": 0.9,
        })
        r = _obs(_transform(span))
        assert r["output"] == [{
            "role": "tool",
            "parts": [{
                "type": "retrieval_document",
                "content": "doc one",
                "id": "d1",
                "score": 0.9,
            }],
        }]


# ── openinference (LangChain envelope) ────────────────────────────────────


def _lc_msg(type_: str, kwargs: dict) -> dict:
    """LangChain Serializable shape:
    {"lc":1, "type":"constructor", "id":["langchain_core","messages",<MsgType>], "kwargs":{...}}"""
    return {
        "lc": 1,
        "type": "constructor",
        "id": ["langchain_core", "messages", type_],
        "kwargs": kwargs,
    }


class TestOpeninferenceLangchainEnvelope:
    def test_messages_wrapper_with_human_message(self):
        span = _mock_span(attrs={
            "openinference.span.kind": "llm",
            "input.value": json.dumps({
                "messages": [_lc_msg("HumanMessage", {"content": "What is 2+2?"})],
            }),
        })
        r = _obs(_transform(span))
        assert r["input"] == [
            {"role": "user", "parts": [{"type": "text", "content": "What is 2+2?"}]},
        ]

    def test_ai_message_content_array_tool_use(self):
        span = _mock_span(attrs={
            "openinference.span.kind": "llm",
            "output.value": json.dumps(
                _lc_msg("AIMessage", {
                    "content": [
                        {"type": "tool_use", "id": "toolu_1", "name": "add", "input": {"a": 1, "b": 2}},
                    ],
                }),
            ),
        })
        r = _obs(_transform(span))
        assert r["output"] == [{
            "role": "assistant",
            "parts": [{"type": "tool_call", "name": "add", "id": "toolu_1", "arguments": {"a": 1, "b": 2}}],
        }]

    def test_ai_message_kwargs_tool_calls_only(self):
        span = _mock_span(attrs={
            "openinference.span.kind": "llm",
            "output.value": json.dumps(
                _lc_msg("AIMessage", {
                    "content": "calling add",
                    "tool_calls": [{"name": "add", "args": {"a": 1, "b": 2}, "id": "toolu_2", "type": "tool_call"}],
                }),
            ),
        })
        r = _obs(_transform(span))
        assert r["output"] == [{
            "role": "assistant",
            "parts": [
                {"type": "text", "content": "calling add"},
                {"type": "tool_call", "name": "add", "id": "toolu_2", "arguments": {"a": 1, "b": 2}},
            ],
        }]

    def test_ai_message_dedup_content_and_kwargs_tool_calls(self):
        span = _mock_span(attrs={
            "openinference.span.kind": "llm",
            "output.value": json.dumps(
                _lc_msg("AIMessage", {
                    "content": [{"type": "tool_use", "id": "toolu_3", "name": "add", "input": {"a": 1}}],
                    "tool_calls": [{"name": "add", "args": {"a": 1}, "id": "toolu_3", "type": "tool_call"}],
                }),
            ),
        })
        r = _obs(_transform(span))
        parts = r["output"][0]["parts"]
        assert parts == [
            {"type": "tool_call", "name": "add", "id": "toolu_3", "arguments": {"a": 1}},
        ]

    def test_tool_message_with_tool_call_id(self):
        span = _mock_span(attrs={
            "openinference.span.kind": "llm",
            "input.value": json.dumps({
                "messages": [_lc_msg("ToolMessage", {"content": "85", "tool_call_id": "toolu_4", "name": "add"})],
            }),
        })
        r = _obs(_transform(span))
        assert r["input"] == [{
            "role": "tool",
            "parts": [{"type": "tool_call_response", "response": "85", "id": "toolu_4"}],
            "name": "add",
        }]

    def test_system_message(self):
        span = _mock_span(attrs={
            "openinference.span.kind": "llm",
            "input.value": json.dumps({
                "messages": [_lc_msg("SystemMessage", {"content": "Be terse."})],
            }),
        })
        r = _obs(_transform(span))
        assert r["input"] == [
            {"role": "system", "parts": [{"type": "text", "content": "Be terse."}]},
        ]

    def test_full_transcript_human_ai_tool_ai(self):
        span = _mock_span(attrs={
            "openinference.span.kind": "llm",
            "input.value": json.dumps({
                "messages": [
                    _lc_msg("HumanMessage", {"content": "What is 47 + 38?"}),
                    _lc_msg("AIMessage", {
                        "content": [{"type": "tool_use", "id": "toolu_x", "name": "add", "input": {"a": 47, "b": 38}}],
                        "tool_calls": [{"name": "add", "args": {"a": 47, "b": 38}, "id": "toolu_x", "type": "tool_call"}],
                    }),
                    _lc_msg("ToolMessage", {"content": "85", "tool_call_id": "toolu_x", "name": "add"}),
                    _lc_msg("AIMessage", {"content": "47 + 38 = 85"}),
                ],
            }),
        })
        r = _obs(_transform(span))
        msgs = r["input"]
        assert len(msgs) == 4
        assert msgs[0]["role"] == "user"
        assert msgs[1]["role"] == "assistant"
        assert msgs[1]["parts"] == [
            {"type": "tool_call", "name": "add", "id": "toolu_x", "arguments": {"a": 47, "b": 38}},
        ]
        assert msgs[2]["role"] == "tool"
        assert msgs[2]["parts"][0]["type"] == "tool_call_response"
        assert msgs[2]["parts"][0]["response"] == "85"
        assert msgs[2]["parts"][0]["id"] == "toolu_x"
        assert msgs[3] == {
            "role": "assistant",
            "parts": [{"type": "text", "content": "47 + 38 = 85"}],
        }

    def test_bare_array_serializables(self):
        span = _mock_span(attrs={
            "openinference.span.kind": "llm",
            "input.value": json.dumps([
                _lc_msg("HumanMessage", {"content": "hi"}),
                _lc_msg("AIMessage", {"content": "hello"}),
            ]),
        })
        r = _obs(_transform(span))
        assert r["input"] == [
            {"role": "user", "parts": [{"type": "text", "content": "hi"}]},
            {"role": "assistant", "parts": [{"type": "text", "content": "hello"}]},
        ]

    # LangChain JS LLMResult shape: ``output.value`` is wrapped as
    # ``{generations: [[{text, message: <Serializable AIMessage>}, ...]], llmOutput}``.
    # Without unwrapping, the indexed-flat fallback (``llm.output_messages.0.message.role``)
    # produces an empty assistant message because the AIMessage's content is a
    # tool_use array, not a string.
    def test_unwraps_llmresult_generations_wrapper(self):
        span = _mock_span(attrs={
            "openinference.span.kind": "llm",
            "llm.output_messages.0.message.role": "assistant",
            "output.value": json.dumps({
                "generations": [
                    [{
                        "text": "",
                        "message": _lc_msg("AIMessage", {
                            "content": [
                                {"type": "tool_use", "id": "toolu_X", "name": "add",
                                 "input": {"a": 47, "b": 38}},
                            ],
                        }),
                    }],
                ],
                "llmOutput": {"model": "claude-sonnet-4-5"},
            }),
        })
        r = _obs(_transform(span))
        assert r["output"] == [{
            "role": "assistant",
            "parts": [
                {"type": "tool_call", "id": "toolu_X", "name": "add",
                 "arguments": {"a": 47, "b": 38}},
            ],
        }]

    # LangChain JS BaseChatModel.invoke uses a batch convention: ``messages``
    # is BaseMessage[][] (each outer slot = one conversation in the batch).
    # For single-conversation invocations the outer array still wraps the
    # inner turn list. Flatten one level so the inner Serializables are
    # translated.
    def test_flattens_double_array_messages(self):
        span = _mock_span(attrs={
            "openinference.span.kind": "llm",
            "input.value": json.dumps({
                "messages": [[
                    _lc_msg("HumanMessage", {"content": "What is 47 + 38?"}),
                    _lc_msg("AIMessage", {
                        "content": [
                            {"type": "tool_use", "id": "toolu_X", "name": "add",
                             "input": {"a": 47, "b": 38}},
                        ],
                    }),
                    _lc_msg("ToolMessage", {
                        "content": "85", "tool_call_id": "toolu_X", "name": "add",
                    }),
                ]],
            }),
        })
        r = _obs(_transform(span))
        assert r["input"] == [
            {"role": "user", "parts": [{"type": "text", "content": "What is 47 + 38?"}]},
            {
                "role": "assistant",
                "parts": [
                    {"type": "tool_call", "id": "toolu_X", "name": "add",
                     "arguments": {"a": 47, "b": 38}},
                ],
            },
            {
                "role": "tool",
                "parts": [{"type": "tool_call_response", "id": "toolu_X", "response": "85"}],
                "name": "add",
            },
        ]

    # ``langchain_core.messages.utils.messages_to_dict`` (used by LangGraph state
    # serialization and many CHAIN-span outputs) emits each BaseMessage as
    # ``{"type": "<role>", "data": {<actual fields>}}`` rather than the flat
    # ``BaseMessage.dict()`` shape. The plain-dict translator must descend into
    # ``data`` to reach ``content`` / ``tool_calls`` / ``tool_call_id``.
    def test_messages_to_dict_envelope_full_transcript(self):
        span = _mock_span(attrs={
            "openinference.span.kind": "chain",
            "input.value": json.dumps({
                "messages": [
                    {"type": "human", "data": {"content": "What is 47 + 38?", "type": "human", "id": "h1"}},
                    {"type": "ai", "data": {
                        "content": "",
                        "type": "ai",
                        "id": "a1",
                        "tool_calls": [
                            {"name": "add", "args": {"a": 47, "b": 38}, "id": "toolu_x", "type": "tool_call"},
                        ],
                    }},
                    {"type": "tool", "data": {
                        "content": "85", "type": "tool", "name": "add", "tool_call_id": "toolu_x", "id": "t1",
                    }},
                    {"type": "ai", "data": {"content": "47 + 38 = 85", "type": "ai", "id": "a2"}},
                ],
            }),
        })
        r = _obs(_transform(span))
        assert r["input"] == [
            {"role": "user", "parts": [{"type": "text", "content": "What is 47 + 38?"}]},
            {"role": "assistant", "parts": [
                {"type": "tool_call", "name": "add", "id": "toolu_x", "arguments": {"a": 47, "b": 38}},
            ]},
            {
                "role": "tool",
                "parts": [{"type": "tool_call_response", "response": "85", "id": "toolu_x"}],
                "name": "add",
            },
            {"role": "assistant", "parts": [{"type": "text", "content": "47 + 38 = 85"}]},
        ]

    # Single bare ``{"type": "ai", "data": {...}}`` envelope (LangChain's
    # ``message_to_dict`` of a lone AIMessage with tool_calls) — observed on
    # ``_ConfigurableModel`` CHAIN spans whose ``output.value`` carries one
    # assistant turn rather than a conversation list.
    def test_messages_to_dict_single_ai_with_tool_calls(self):
        span = _mock_span(attrs={
            "openinference.span.kind": "chain",
            "output.value": json.dumps({
                "type": "ai",
                "data": {
                    "content": "",
                    "type": "ai",
                    "id": "lc_run--xxx",
                    "tool_calls": [
                        {"name": "ConductResearch", "args": {"research_topic": "capital of Australia"},
                         "id": "call_w", "type": "tool_call"},
                    ],
                },
            }),
        })
        r = _obs(_transform(span))
        assert r["output"] == [{
            "role": "assistant",
            "parts": [
                {"type": "tool_call", "name": "ConductResearch", "id": "call_w",
                 "arguments": {"research_topic": "capital of Australia"}},
            ],
        }]

    # ``langgraph.types.Command`` (returned by every node that wants to steer
    # the graph + update state) is serialized by OpenInference as
    # ``{"graph": null, "update": {...}, "resume": ..., "goto": "<node>"}``.
    # Recurse into ``update`` so the inner ``messages`` list is reachable.
    def test_unwraps_langgraph_command_envelope(self):
        span = _mock_span(attrs={
            "openinference.span.kind": "chain",
            "output.value": json.dumps({
                "graph": None,
                "update": {
                    "messages": [
                        {"type": "ai", "data": {
                            "content": "Thank you for your request.",
                            "type": "ai",
                            "id": "a1",
                            "tool_calls": [],
                        }},
                    ],
                },
                "resume": None,
                "goto": "write_research_brief",
            }),
        })
        r = _obs(_transform(span))
        assert r["output"] == [
            {"role": "assistant", "parts": [
                {"type": "text", "content": "Thank you for your request."},
            ]},
        ]

    # ``Command`` whose ``update`` is a state delta with no message-shaped
    # values carries no canonical messages — return null rather than
    # fabricating one. (Empty ``researcher_messages`` list, no other channels.)
    def test_command_envelope_without_messages_returns_null(self):
        span = _mock_span(attrs={
            "openinference.span.kind": "chain",
            "output.value": json.dumps({
                "graph": None,
                "update": {"researcher_messages": []},  # app-specific state, not `messages`
                "resume": None,
                "goto": "compress_research",
            }),
        })
        r = _obs(_transform(span))
        assert r["output"] is None

    # ``Command`` with a *custom* state-channel name (multi-agent LangGraph
    # apps almost always rename their message channels — ``researcher_messages``,
    # ``supervisor_messages``, ``chat_history``…). The default ``MessagesState``
    # uses ``messages``, but every nontrivial graph customises it. The
    # unwrapper should walk all values of ``update`` and pick up any list of
    # LangChain messages, not only the ``messages`` key. Mirrors the
    # ``researcher_tools`` ToolNode output shape we observed in deep_researcher
    # traces — a ``ToolMessage`` carrying ``tool_call_id`` linkage that would
    # otherwise be lost.
    def test_unwraps_langgraph_command_with_custom_message_channel(self):
        span = _mock_span(attrs={
            "openinference.span.kind": "chain",
            "output.value": json.dumps({
                "graph": None,
                "update": {
                    "researcher_messages": [
                        {"type": "tool", "data": {
                            "content": "Reflection recorded",
                            "type": "tool",
                            "name": "ResearchComplete",
                            "tool_call_id": "call_ULHX17O2dpHDuDjzLlxZZFcP",
                            "id": None,
                        }},
                    ],
                },
                "resume": None,
                "goto": "compress_research",
            }),
        })
        r = _obs(_transform(span))
        assert r["output"] == [
            {
                "role": "tool",
                "parts": [{
                    "type": "tool_call_response",
                    "response": "Reflection recorded",
                    "id": "call_ULHX17O2dpHDuDjzLlxZZFcP",
                }],
                "name": "ResearchComplete",
            },
        ]

    # When ``update`` mixes a message channel with non-message scalars
    # (``notes`` is a plain string list in deep_researcher's
    # ``supervisor_tools`` output), only the message channel is unwrapped —
    # arbitrary scalars must not be text-wrapped into fake messages.
    def test_command_envelope_picks_up_messages_alongside_scalar_state(self):
        span = _mock_span(attrs={
            "openinference.span.kind": "chain",
            "output.value": json.dumps({
                "graph": None,
                "update": {
                    "supervisor_messages": [
                        {"type": "ai", "data": {
                            "content": "Delegating to researcher.",
                            "type": "ai",
                            "id": "a1",
                            "tool_calls": [],
                        }},
                    ],
                    "notes": ["Reflection recorded: ..."],  # plain strings, must be ignored
                },
                "resume": None,
                "goto": "supervisor",
            }),
        })
        r = _obs(_transform(span))
        assert r["output"] == [
            {"role": "assistant", "parts": [
                {"type": "text", "content": "Delegating to researcher."},
            ]},
        ]

    # Non-conversational CHAIN spans (e.g. LangGraph's RunnableLambda routing
    # ``{output:[{lg_name:"Send",...}]}``) used to be text-wrapped into a fake
    # ``[{role:"assistant", parts:[{type:"text", content:"<entire JSON blob>"}]}]``.
    # Mirror the call we made on Traceloop entity blobs: return null canonical;
    # the raw ``output`` field still carries the blob for debugging.
    def test_returns_null_for_non_conversational_chain_blob(self):
        span = _mock_span(attrs={
            "openinference.span.kind": "chain",
            "output.value": json.dumps({
                "output": [
                    {"lg_name": "Send", "node": "tools", "args": {"messages": []}},
                ],
            }),
        })
        r = _obs(_transform(span))
        assert r["output"] is None


# ── traceloop ──────────────────────────────────────────────────────────────


class TestTraceloopNormalizer:
    def test_indexed_flat(self):
        span = _mock_span(attrs={
            "gen_ai.prompt.0.role": "user",
            "gen_ai.prompt.0.content": "hi",
            "gen_ai.completion.0.role": "assistant",
            "gen_ai.completion.0.content": "hello",
        })
        r = _obs(_transform(span))
        assert r["input"] == [
            {"role": "user", "parts": [{"type": "text", "content": "hi"}]}
        ]
        assert r["output"] == [
            {"role": "assistant", "parts": [{"type": "text", "content": "hello"}]}
        ]

    # When the indexed primary ``tool_call_id`` is an empty string but the
    # dotted alias ``tool_call.id`` carries a real value, the canonical
    # ``tool_call_response`` part picks up the alt-key id rather than emitting
    # an empty ``id`` that would break call/response linking downstream.
    def test_empty_tool_call_id_falls_through_to_dotted_alias(self):
        span = _mock_span(attrs={
            "gen_ai.prompt.0.role": "tool",
            "gen_ai.prompt.0.tool_call_id": "",
            "gen_ai.prompt.0.tool_call.id": "call_abc123",
            "gen_ai.prompt.0.content": "weather: sunny",
        })
        r = _obs(_transform(span))
        assert r["input"] == [
            {
                "role": "tool",
                "parts": [
                    {"type": "tool_call_response", "response": "weather: sunny", "id": "call_abc123"},
                ],
            }
        ]

    # OpenLLMetry's @workflow / @task decorators dump opaque entity blobs
    # (``{"inputs":{...},"tags":[...],"metadata":{...}}``) into
    # ``traceloop.entity.input`` / ``traceloop.entity.output``. Wrapping those
    # into a single fake ``[{role:"user", parts:[text:<blob>]}]`` envelope
    # misrepresents them as a conversational message. Canonical view stays
    # ``None``; consumers fall back to the raw ``input``/``output`` string.
    def test_returns_null_canonical_for_non_conversational_blobs(self):
        span = _mock_span(attrs={
            "traceloop.span.kind": "task",
            "traceloop.entity.input": json.dumps({
                "input_str": "{'a': 47, 'b': 38}",
                "tags": ["seq:step:1"],
                "metadata": {"langgraph_node": "tools"},
            }),
            "traceloop.entity.output": json.dumps({
                "output": {"lc": 1, "type": "constructor", "id": ["x"], "kwargs": {"v": 1}},
                "kwargs": {"tags": []},
            }),
        })
        r = _obs(_transform(span))
        assert r["input"] is None
        assert r["output"] is None

    # When the entity blob does carry a real ``messages`` array (LangGraph
    # workflow input), unpack it via the LangChain envelope translator —
    # including OpenAI-shape ``{role,content}`` items.
    def test_unpacks_inputs_messages_workflow(self):
        span = _mock_span(attrs={
            "traceloop.span.kind": "workflow",
            "traceloop.entity.input": json.dumps({
                "inputs": {"messages": [{"role": "user", "content": "What is 47 + 38?"}]},
                "tags": [],
            }),
        })
        r = _obs(_transform(span))
        assert r["input"] == [
            {"role": "user", "parts": [{"type": "text", "content": "What is 47 + 38?"}]},
        ]

    def test_unpacks_outputs_messages_workflow_serializable(self):
        lc_ai = {
            "lc": 1,
            "type": "constructor",
            "id": ["langchain_core", "messages", "AIMessage"],
            "kwargs": {"content": "47 + 38 = 85"},
        }
        span = _mock_span(attrs={
            "traceloop.span.kind": "workflow",
            "traceloop.entity.output": json.dumps({
                "outputs": {"messages": [lc_ai]},
                "kwargs": {"tags": []},
            }),
        })
        r = _obs(_transform(span))
        assert r["output"] == [
            {"role": "assistant", "parts": [{"type": "text", "content": "47 + 38 = 85"}]},
        ]


# ── braintrust ─────────────────────────────────────────────────────────────


class TestBraintrustNormalizer:
    def test_input_output_json(self):
        span = _mock_span(attrs={
            "braintrust.input_json": json.dumps([{"role": "user", "content": "hi"}]),
            "braintrust.output_json": json.dumps([
                {"role": "assistant", "content": "hello"}
            ]),
        })
        r = _obs(_transform(span))
        assert r["input"] == [
            {"role": "user", "parts": [{"type": "text", "content": "hi"}]}
        ]
        assert r["output"] == [
            {"role": "assistant", "parts": [{"type": "text", "content": "hello"}]}
        ]


# ── vercelAi ───────────────────────────────────────────────────────────────


class TestVercelAiNormalizer:
    def test_multimodal_image_url_to_uri_part(self):
        span = _mock_span(attrs={
            "ai.operationId": "ai.generateText",
            "ai.prompt.messages": json.dumps([{
                "role": "user",
                "content": [
                    {"type": "text", "text": "What is this?"},
                    {"type": "image_url", "image_url": {"url": "https://x/y.png"}},
                ],
            }]),
            "ai.response.text": "A cat.",
        })
        r = _obs(_transform(span))
        assert r["input"] == [{
            "role": "user",
            "parts": [
                {"type": "text", "content": "What is this?"},
                {"type": "uri", "modality": "image", "uri": "https://x/y.png"},
            ],
        }]
        assert r["output"] == [
            {"role": "assistant", "parts": [{"type": "text", "content": "A cat."}]}
        ]

    def test_decodes_data_image_url_to_blob_part(self):
        span = _mock_span(attrs={
            "ai.operationId": "ai.generateText",
            "ai.prompt.messages": json.dumps([{
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
                ],
            }]),
        })
        r = _obs(_transform(span))
        assert r["input"][0]["parts"][0] == {
            "type": "blob",
            "modality": "image",
            "content": "AAAA",
            "mime_type": "image/png",
        }

    def test_tool_execution_span(self):
        span = _mock_span(attrs={
            "ai.operationId": "ai.toolCall",
            "ai.toolCall.name": "getWeather",
            "ai.toolCall.args": '{"city":"Paris"}',
            "ai.toolCall.result": {"temp": 22},
        })
        r = _obs(_transform(span))
        assert r["input"] == [{
            "role": "assistant",
            "parts": [
                {"type": "tool_call", "name": "getWeather", "arguments": {"city": "Paris"}}
            ],
        }]
        assert r["output"] == [{
            "role": "tool",
            "parts": [{"type": "tool_call_response", "response": {"temp": 22}}],
        }]

    def test_unpacks_ai_prompt_system_messages_blob_on_agent_span(self):
        # ai.streamText / ai.generateText emit the full prompt as a single JSON
        # blob in ``ai.prompt`` (no ``ai.prompt.messages`` at the agent level),
        # with shape {system: str, messages: [{role, content: [...]}]}. The
        # blob must be unpacked: ``system`` becomes a leading system message,
        # and ``messages`` are routed through the existing OpenAI/Vercel-shape
        # coercer.
        span = _mock_span(attrs={
            "ai.operationId": "ai.streamText",
            "ai.prompt": json.dumps({
                "system": "Be concise.",
                "messages": [
                    {"role": "user", "content": [{"type": "text", "text": "who am I?"}]},
                    {
                        "role": "assistant",
                        "content": [
                            {
                                "type": "tool-call",
                                "toolCallId": "call_1",
                                "toolName": "lookup",
                                "input": {"q": "user"},
                            }
                        ],
                    },
                    {
                        "role": "tool",
                        "content": [
                            {
                                "type": "tool-result",
                                "toolCallId": "call_1",
                                "toolName": "lookup",
                                "output": {"type": "json", "value": {"name": "Rado"}},
                            }
                        ],
                    },
                ],
            }),
            "ai.response.text": "You are Rado.",
        })
        r = _obs(_transform(span))
        assert r["input"] == [
            {"role": "system", "parts": [{"type": "text", "content": "Be concise."}]},
            {"role": "user", "parts": [{"type": "text", "content": "who am I?"}]},
            {
                "role": "assistant",
                "parts": [
                    {
                        "type": "tool_call",
                        "name": "lookup",
                        "id": "call_1",
                        "arguments": {"q": "user"},
                    }
                ],
            },
            {
                "role": "tool",
                "parts": [
                    {
                        "type": "tool_call_response",
                        "response": {"name": "Rado"},
                        "id": "call_1",
                    }
                ],
            },
        ]
        assert r["output"] == [
            {"role": "assistant", "parts": [{"type": "text", "content": "You are Rado."}]},
        ]

    def test_unpacks_ai_prompt_blob_without_system_field(self):
        span = _mock_span(attrs={
            "ai.operationId": "ai.generateText",
            "ai.prompt": json.dumps({
                "messages": [{"role": "user", "content": "hi"}],
            }),
        })
        r = _obs(_transform(span))
        assert r["input"] == [
            {"role": "user", "parts": [{"type": "text", "content": "hi"}]}
        ]

    def test_ai_prompt_plain_string_still_wrapped_as_user_text(self):
        span = _mock_span(attrs={
            "ai.operationId": "ai.generateText",
            "ai.prompt": "Just a freeform prompt",
        })
        r = _obs(_transform(span))
        assert r["input"] == [
            {"role": "user", "parts": [{"type": "text", "content": "Just a freeform prompt"}]}
        ]

    def test_projects_ai_embed_singular_input_and_maps_ai_usage_tokens(self):
        span = _mock_span(attrs={
            "ai.operationId": "ai.embed",
            "ai.value": "How would you describe me?",
            "ai.usage.tokens": 6,
            "ai.model.id": "text-embedding-ada-002",
        })
        r = _obs(_transform(span))
        assert r["input"] == [
            {"role": "user", "parts": [{"type": "text", "content": "How would you describe me?"}]}
        ]
        # Core auto-derives ``total`` from ``input + output`` when total is unset.
        assert r["usage_details"] == {"input": 6, "total": 6}

    def test_projects_ai_embed_many_inputs_per_entry(self):
        # Vercel JSON.stringify-encodes each entry in ``ai.values`` to fit
        # OTel's string-array attribute constraint, so a value of "User's name
        # is Rado" arrives as the literal ``"\"User's name is Rado\""``. Each
        # entry must be unwrapped before going into a TextPart.
        span = _mock_span(attrs={
            "ai.operationId": "ai.embedMany",
            "ai.values": ['"User\'s name is Rado"', '"Loves espresso"'],
            "ai.usage.tokens": 12,
            "ai.model.id": "text-embedding-ada-002",
        })
        r = _obs(_transform(span))
        assert r["input"] == [
            {"role": "user", "parts": [{"type": "text", "content": "User's name is Rado"}]},
            {"role": "user", "parts": [{"type": "text", "content": "Loves espresso"}]},
        ]
        assert r["usage_details"] == {"input": 12, "total": 12}

    def test_ai_embed_unwraps_json_stringified_ai_value(self):
        # Vercel emits ai.value as JSON.stringify(input), so the literal
        # value arriving on the span is ``"\"actual text\""`` (with quote
        # chars). Must unwrap to canonical text without surrounding quotes.
        span = _mock_span(attrs={
            "ai.operationId": "ai.embed",
            "ai.value": '"Who do I admire the most among tennis athletes?"',
        })
        r = _obs(_transform(span))
        assert r["input"] == [
            {
                "role": "user",
                "parts": [
                    {
                        "type": "text",
                        "content": "Who do I admire the most among tennis athletes?",
                    }
                ],
            }
        ]

    def test_ai_embed_many_handles_non_json_entries_as_text(self):
        # Defensive: if an upstream emits already-decoded strings (no JSON
        # escaping), keep them verbatim instead of producing empty parts.
        span = _mock_span(attrs={
            "ai.operationId": "ai.embedMany",
            "ai.values": ["raw entry one", "raw entry two"],
        })
        r = _obs(_transform(span))
        assert r["input"] == [
            {"role": "user", "parts": [{"type": "text", "content": "raw entry one"}]},
            {"role": "user", "parts": [{"type": "text", "content": "raw entry two"}]},
        ]


# ── logfire (Pydantic AI envelope) ────────────────────────────────────────


class TestLogfireNormalizer:
    def test_translates_request_response_envelopes(self):
        envelope = json.dumps([
            {
                "kind": "request",
                "parts": [
                    {"part_kind": "system-prompt", "content": "Be concise"},
                    {"part_kind": "user-prompt", "content": "hi"},
                ],
            },
            {
                "kind": "response",
                "parts": [
                    {"part_kind": "text", "content": "ok"},
                    {"part_kind": "tool-call", "tool_name": "x", "args": {"a": 1}, "tool_call_id": "c1"},
                ],
            },
        ])
        span = _mock_span(attrs={"pydantic_ai.all_messages": envelope})
        r = _obs(_transform(span))
        assert r["input"] == [
            {"role": "system", "parts": [{"type": "text", "content": "Be concise"}]},
            {"role": "user", "parts": [{"type": "text", "content": "hi"}]},
        ]
        assert r["output"] == [{
            "role": "assistant",
            "parts": [
                {"type": "text", "content": "ok"},
                {"type": "tool_call", "name": "x", "arguments": {"a": 1}, "id": "c1"},
            ],
        }]


    # An empty ``part_kind`` string falls through the named cases and lands on
    # the default branch — the generic part is built with kind ``"unknown"``
    # rather than passing the empty string through.
    def test_defaults_empty_part_kind_to_unknown(self):
        envelope = json.dumps([
            {"kind": "request", "parts": [{"part_kind": "", "content": "x"}]}
        ])
        span = _mock_span(attrs={"pydantic_ai.all_messages": envelope})
        r = _obs(_transform(span))
        assert r["input"][0]["parts"][0]["type"] == "unknown"


# ── langfuse ───────────────────────────────────────────────────────────────


class TestLangfuseNormalizer:
    def test_merges_tool_calls_into_assistant_output(self):
        span = _mock_span(attrs={
            "langfuse.observation.input": json.dumps([{"role": "user", "content": "hi"}]),
            "langfuse.observation.output": "ok",
            "langfuse.observation.tool_calls": json.dumps([
                {"id": "c1", "name": "lookup", "arguments": {"q": "x"}}
            ]),
        })
        r = _obs(_transform(span))
        assert r["input"] == [
            {"role": "user", "parts": [{"type": "text", "content": "hi"}]}
        ]
        assert r["output"] == [{
            "role": "assistant",
            "parts": [
                {"type": "text", "content": "ok"},
                {"type": "tool_call", "name": "lookup", "id": "c1", "arguments": {"q": "x"}},
            ],
        }]

    # The Langfuse Python SDK serializes the trailing AIMessage from a
    # LangChain ChatAnthropic tool-use turn as a single object (not wrapped
    # in an array) with ``content: [{type:"tool_use",...}]`` plus a parallel
    # ``tool_calls`` array. Producing a clean canonical ``tool_call`` part
    # requires routing through the LangChain envelope translator and a
    # single-object shim before falling back to text-wrap.
    def test_normalizes_langchain_tool_use_output_to_tool_call_part(self):
        span = _mock_span(attrs={
            "langfuse.observation.input": json.dumps([
                {"role": "user", "content": "What is 47 + 38?"},
            ]),
            "langfuse.observation.output": json.dumps({
                "role": "assistant",
                "content": [
                    {
                        "id": "toolu_01SL9hqG8nmgqKPF4jirTY8a",
                        "caller": {"type": "direct"},
                        "input": {"a": 47, "b": 38},
                        "name": "add",
                        "type": "tool_use",
                    },
                ],
                "tool_calls": [
                    {
                        "name": "add",
                        "args": {"a": 47, "b": 38},
                        "id": "toolu_01SL9hqG8nmgqKPF4jirTY8a",
                        "type": "tool_call",
                    },
                ],
            }),
        })
        r = _obs(_transform(span))
        assert r["output"] == [{
            "role": "assistant",
            "parts": [
                {
                    "type": "tool_call",
                    "name": "add",
                    "id": "toolu_01SL9hqG8nmgqKPF4jirTY8a",
                    "arguments": {"a": 47, "b": 38},
                },
            ],
        }]
        assert r["tool_calls"] == [
            {
                "type": "tool_call",
                "name": "add",
                "id": "toolu_01SL9hqG8nmgqKPF4jirTY8a",
                "arguments": {"a": 47, "b": 38},
            },
        ]
        assert r["tool_call_names"] == ["add"]

    # The Langfuse Python LangChain integration injects each tool definition
    # as a phantom ``{role:"tool", content:{name, input_schema, description}}``
    # entry inside ``langfuse.observation.input`` alongside the actual user
    # turn. These are tool *definitions*, not chat messages — drop them from
    # input_messages and surface them via the top-level ``tool_definitions``
    # field instead.
    def test_routes_tool_definition_phantom_messages_into_tool_definitions(self):
        tool_def = {
            "name": "add",
            "input_schema": {
                "properties": {"a": {"type": "number"}, "b": {"type": "number"}},
                "required": ["a", "b"],
                "type": "object",
            },
            "description": "Adds two numbers together.",
        }
        span = _mock_span(attrs={
            "langfuse.observation.input": json.dumps([
                {"role": "user", "content": "What is 47 + 38?"},
                {"role": "tool", "content": tool_def},
            ]),
        })
        r = _obs(_transform(span))
        assert r["input"] == [
            {"role": "user", "parts": [{"type": "text", "content": "What is 47 + 38?"}]},
        ]
        assert r["tool_definitions"] == [tool_def]

    # The Langfuse JS LangChain integration projects LangChain ToolMessage
    # into ``{role: <tool_name>, content: <result>, additional_kwargs: {}}``
    # (using the tool name as the role, no tool_call_id link). The langfuse
    # adapter recovers the canonical ``role:"tool"`` + ``tool_call_response``
    # part by matching the role string against tool_call.name on the
    # preceding assistant message.
    def test_retags_tool_name_roles_back_to_tool_with_tool_call_response_linkage(self):
        span = _mock_span(attrs={
            "langfuse.observation.input": json.dumps([
                {"content": "What is 47 + 38?", "role": "user"},
                {
                    "content": [
                        {
                            "type": "tool_use",
                            "id": "toolu_0183unn5QaJzKbi2w9yqPNdq",
                            "name": "add",
                            "input": {"a": 47, "b": 38},
                        },
                    ],
                    "role": "assistant",
                    "tool_calls": [
                        {
                            "name": "add",
                            "args": {"a": 47, "b": 38},
                            "id": "toolu_0183unn5QaJzKbi2w9yqPNdq",
                            "type": "tool_call",
                        },
                    ],
                },
                {"content": "85", "additional_kwargs": {}, "role": "add"},
                {"content": "47 + 38 = 85", "role": "assistant"},
            ]),
        })
        r = _obs(_transform(span))
        msgs = r["input"]
        assert len(msgs) == 4
        assert msgs[0] == {
            "role": "user",
            "parts": [{"type": "text", "content": "What is 47 + 38?"}],
        }
        assert msgs[1] == {
            "role": "assistant",
            "parts": [
                {
                    "type": "tool_call",
                    "name": "add",
                    "id": "toolu_0183unn5QaJzKbi2w9yqPNdq",
                    "arguments": {"a": 47, "b": 38},
                },
            ],
        }
        assert msgs[2] == {
            "role": "tool",
            "name": "add",
            "parts": [
                {
                    "type": "tool_call_response",
                    "id": "toolu_0183unn5QaJzKbi2w9yqPNdq",
                    "response": "85",
                },
            ],
        }
        assert msgs[3] == {
            "role": "assistant",
            "parts": [{"type": "text", "content": "47 + 38 = 85"}],
        }

    def test_preserves_developer_role_and_does_not_rewrite_to_tool(self):
        span = _mock_span(attrs={
            "langfuse.observation.input": json.dumps([
                {"role": "developer", "content": "Always respond as strict JSON."},
                {"role": "user", "content": "hi"},
            ]),
        })
        r = _obs(_transform(span))
        assert r["input"] == [
            {
                "role": "developer",
                "parts": [{"type": "text", "content": "Always respond as strict JSON."}],
            },
            {"role": "user", "parts": [{"type": "text", "content": "hi"}]},
        ]

    # The Langfuse Python LangChain integration serializes a ToolMessage as a
    # plain ``BaseMessage.dict()`` blob — ``{type:"tool", content,
    # tool_call_id, name, ...}`` — without the ``lc:1, type:"constructor"``
    # Serializable envelope and without an OpenAI-shape ``role`` field.
    # Recover the canonical role:"tool" + tool_call_response part by matching
    # on the ``type`` field.
    def test_normalizes_py_plain_dict_tool_message_with_tool_call_id(self):
        span = _mock_span(attrs={
            "langfuse.observation.input": json.dumps({"a": 47, "b": 38}),
            "langfuse.observation.output": json.dumps({
                "content": "85.0",
                "additional_kwargs": {},
                "response_metadata": {},
                "type": "tool",
                "name": "add",
                "id": None,
                "tool_call_id": "toolu_01SL9hqG8nmgqKPF4jirTY8a",
                "artifact": None,
                "status": "success",
            }),
        })
        r = _obs(_transform(span))
        assert r["output"] == [
            {
                "role": "tool",
                "name": "add",
                "parts": [
                    {
                        "type": "tool_call_response",
                        "id": "toolu_01SL9hqG8nmgqKPF4jirTY8a",
                        "response": "85.0",
                    },
                ],
            },
        ]

    # PY langchain CHAIN spans wrap the conversation as ``{messages: [...]}``
    # where every entry is a plain ``BaseMessage.dict()`` blob
    # (``type:"human"``, ``type:"ai"``, ``type:"tool"``). All entries should
    # normalize cleanly.
    def test_normalizes_py_plain_dict_messages_array_end_to_end(self):
        span = _mock_span(attrs={
            "langfuse.observation.output": json.dumps({
                "messages": [
                    {"content": "What is 47 + 38?", "type": "human"},
                    {
                        "content": [
                            {
                                "id": "toolu_x",
                                "input": {"a": 47, "b": 38},
                                "name": "add",
                                "type": "tool_use",
                            },
                        ],
                        "type": "ai",
                        "tool_calls": [
                            {
                                "name": "add",
                                "args": {"a": 47, "b": 38},
                                "id": "toolu_x",
                                "type": "tool_call",
                            },
                        ],
                    },
                    {
                        "content": "85",
                        "type": "tool",
                        "name": "add",
                        "tool_call_id": "toolu_x",
                    },
                ],
            }),
        })
        r = _obs(_transform(span))
        assert r["output"] == [
            {"role": "user", "parts": [{"type": "text", "content": "What is 47 + 38?"}]},
            {
                "role": "assistant",
                "parts": [
                    {
                        "type": "tool_call",
                        "name": "add",
                        "id": "toolu_x",
                        "arguments": {"a": 47, "b": 38},
                    },
                ],
            },
            {
                "role": "tool",
                "name": "add",
                "parts": [{"type": "tool_call_response", "id": "toolu_x", "response": "85"}],
            },
        ]

    # Standalone tool-name role: the JS langfuse ``tools`` CHAIN span carries
    # a single-message output ``[{role:"add", content:"85"}]`` with no
    # preceding assistant tool_call message in the same array. The role
    # should still be rewritten to canonical "tool" with the tool name
    # preserved, even without a recoverable tool_call_id.
    def test_rewrites_standalone_tool_name_role_without_preceding_tool_call(self):
        span = _mock_span(attrs={
            "langfuse.observation.output": json.dumps([
                {"content": "85", "role": "add"},
            ]),
        })
        r = _obs(_transform(span))
        assert r["output"] == [
            {
                "role": "tool",
                "name": "add",
                "parts": [{"type": "tool_call_response", "response": "85"}],
            },
        ]

    # TOOL-span synthesis: a ``langfuse.observation.type == "tool"`` span
    # carries structured tool args under ``input`` and a tool-result envelope
    # under ``output``. Wrap them as a canonical assistant tool_call request
    # + tool tool_call_response reply, mirroring how the same call appears
    # in the parent generation's transcript. Lifts tool name and
    # tool_call_id from the normalized output so input/output stay linked.
    def test_synthesizes_assistant_tool_call_from_plain_dict_tool_output(self):
        span = _mock_span(attrs={
            "langfuse.observation.type": "tool",
            "langfuse.observation.input": json.dumps({"a": 47, "b": 38}),
            "langfuse.observation.output": json.dumps({
                "content": "85.0",
                "type": "tool",
                "name": "add",
                "tool_call_id": "toolu_X",
                "status": "success",
            }),
        })
        r = _obs(_transform(span))
        assert r["input"] == [
            {
                "role": "assistant",
                "parts": [
                    {
                        "type": "tool_call",
                        "name": "add",
                        "id": "toolu_X",
                        "arguments": {"a": 47, "b": 38},
                    },
                ],
            },
        ]
        assert r["output"] == [
            {
                "role": "tool",
                "name": "add",
                "parts": [
                    {
                        "type": "tool_call_response",
                        "id": "toolu_X",
                        "response": "85.0",
                    },
                ],
            },
        ]

    # Same synthesis but with a LangChain Serializable ToolMessage envelope
    # on the output (the JS langfuse-sdk shape). The envelope translator
    # extracts the same name + tool_call_id; the synthesized input mirrors
    # them.
    def test_synthesizes_assistant_tool_call_from_serializable_tool_output(self):
        span = _mock_span(attrs={
            "langfuse.observation.type": "tool",
            "langfuse.observation.input": json.dumps({"a": 47, "b": 38}),
            "langfuse.observation.output": json.dumps({
                "lc": 1,
                "type": "constructor",
                "id": ["langchain_core", "messages", "ToolMessage"],
                "kwargs": {
                    "name": "add",
                    "tool_call_id": "toolu_Y",
                    "content": "85",
                    "status": "success",
                },
            }),
        })
        r = _obs(_transform(span))
        assert r["input"] == [
            {
                "role": "assistant",
                "parts": [
                    {
                        "type": "tool_call",
                        "name": "add",
                        "id": "toolu_Y",
                        "arguments": {"a": 47, "b": 38},
                    },
                ],
            },
        ]
        assert r["output"] == [
            {
                "role": "tool",
                "name": "add",
                "parts": [
                    {
                        "type": "tool_call_response",
                        "id": "toolu_Y",
                        "response": "85",
                    },
                ],
            },
        ]

    # Output envelope unrecognized (bare-string output): synthesis can't
    # lift a tool name, so input falls through to existing blob_to_messages
    # text-wrap. Output gets the fallback synthesis -- a tool message with
    # the raw response and no id linkage.
    def test_falls_back_to_raw_string_output_wrap_when_envelope_unrecognized(self):
        span = _mock_span(attrs={
            "langfuse.observation.type": "tool",
            "langfuse.observation.input": json.dumps({"x": 1}),
            "langfuse.observation.output": json.dumps("85"),
        })
        r = _obs(_transform(span))
        assert r["input"] == [
            {
                "role": "user",
                "parts": [{"type": "text", "content": '{"x": 1}'}],
            },
        ]
        assert r["output"] == [
            {
                "role": "tool",
                "parts": [{"type": "tool_call_response", "response": "85"}],
            },
        ]

    # PY-only: the Langfuse PY callback serializes tool args via
    # ``repr(dict)`` (single-quoted), which is invalid JSON. Recover the
    # parsed dict via ``ast.literal_eval`` so the canonical tool_call's
    # ``arguments`` field stays parsed (parity with JS, which sees JSON).
    def test_synthesis_recovers_python_repr_args_via_literal_eval(self):
        span = _mock_span(attrs={
            "langfuse.observation.type": "tool",
            "langfuse.observation.input": "{'a': 47, 'b': 38}",
            "langfuse.observation.output": json.dumps({
                "content": "85.0",
                "type": "tool",
                "name": "add",
                "tool_call_id": "toolu_Z",
                "status": "success",
            }),
        })
        r = _obs(_transform(span))
        assert r["input"] == [
            {
                "role": "assistant",
                "parts": [
                    {
                        "type": "tool_call",
                        "name": "add",
                        "id": "toolu_Z",
                        "arguments": {"a": 47, "b": 38},
                    },
                ],
            },
        ]
        assert r["output"] == [
            {
                "role": "tool",
                "name": "add",
                "parts": [
                    {
                        "type": "tool_call_response",
                        "id": "toolu_Z",
                        "response": "85.0",
                    },
                ],
            },
        ]


# ── Span-event fallback ────────────────────────────────────────────────────


class TestSpanEventFallback:
    def test_canonicalizes_gen_ai_events(self):
        ev_user = MagicMock()
        ev_user.name = "gen_ai.user.message"
        ev_user.attributes = {"content": "hi"}
        ev_user.timestamp = 1_700_000_000_000_000_000
        ev_choice = MagicMock()
        ev_choice.name = "gen_ai.choice"
        ev_choice.attributes = {"content": "hello", "finish_reason": "stop"}
        ev_choice.timestamp = 1_700_000_000_000_000_001
        span = _mock_span(events=[ev_user, ev_choice])
        r = _obs(_transform(span))
        assert r["input"] == [
            {"role": "user", "parts": [{"type": "text", "content": "hi"}]}
        ]
        assert r["output"] == [{
            "role": "assistant",
            "parts": [{"type": "text", "content": "hello"}],
            "finish_reason": "stop",
        }]

    def test_canonicalizes_gen_ai_tool_message(self):
        ev_user = MagicMock()
        ev_user.name = "gen_ai.user.message"
        ev_user.attributes = {"content": "what's the weather?"}
        ev_user.timestamp = 1_700_000_000_000_000_000
        ev_tool = MagicMock()
        ev_tool.name = "gen_ai.tool.message"
        ev_tool.attributes = {"id": "call_42", "content": "72F"}
        ev_tool.timestamp = 1_700_000_000_000_000_001
        ev_choice = MagicMock()
        ev_choice.name = "gen_ai.choice"
        ev_choice.attributes = {"content": "It's 72F", "finish_reason": "stop"}
        ev_choice.timestamp = 1_700_000_000_000_000_002
        span = _mock_span(events=[ev_user, ev_tool, ev_choice])
        r = _obs(_transform(span))
        assert r["input"] == [
            {"role": "user", "parts": [{"type": "text", "content": "what's the weather?"}]},
            {
                "role": "tool",
                "parts": [{"type": "tool_call_response", "response": "72F", "id": "call_42"}],
            },
        ]
        assert r["output"] == [{
            "role": "assistant",
            "parts": [{"type": "text", "content": "It's 72F"}],
            "finish_reason": "stop",
        }]


# ── Cross-adapter resolution ──────────────────────────────────────────────


class TestCrossAdapterResolution:
    def test_input_from_vercel_output_from_langfuse(self):
        # Locks the doc'd "per-side first-non-null wins" guarantee. Langfuse
        # (registry position 5) sees the output blob first; vercel_ai (position
        # 8) fills the still-empty input side from ``ai.prompt.messages``.
        span = _mock_span(attrs={
            "ai.prompt.messages": json.dumps([{"role": "user", "content": "hi"}]),
            "langfuse.observation.output": json.dumps([
                {"role": "assistant", "content": "hello"}
            ]),
        })
        r = _obs(_transform(span))
        assert r["input"] == [
            {"role": "user", "parts": [{"type": "text", "content": "hi"}]}
        ]
        assert r["output"] == [
            {"role": "assistant", "parts": [{"type": "text", "content": "hello"}]}
        ]


# ── System instructions injection ─────────────────────────────────────────


class TestSystemInstructionsInjection:
    def test_prepends_array_form(self):
        span = _mock_span(attrs={
            "gen_ai.system_instructions": json.dumps([
                {"type": "text", "content": "Be helpful"}
            ]),
            "gen_ai.input.messages": json.dumps([{"role": "user", "content": "hi"}]),
        })
        r = _obs(_transform(span))
        assert r["input"][0] == {
            "role": "system",
            "parts": [{"type": "text", "content": "Be helpful"}],
        }
        assert r["input"][1]["role"] == "user"

    def test_no_double_inject_when_input_already_has_system(self):
        span = _mock_span(attrs={
            "gen_ai.system_instructions": "Be helpful",
            "gen_ai.input.messages": json.dumps([
                {"role": "system", "content": "Be terse"},
                {"role": "user", "content": "hi"},
            ]),
        })
        r = _obs(_transform(span))
        assert r["input"][0]["parts"][0] == {"type": "text", "content": "Be terse"}
        assert len(r["input"]) == 2

    def test_text_wraps_non_string_non_object_items_in_array_form(self):
        # Out-of-spec input (the schema wants Parts), but cross-SDK parity
        # requires both SDKs produce the same shape. Numbers wrap as text;
        # null items drop.
        span = _mock_span(attrs={
            "gen_ai.system_instructions": json.dumps([42, 7, "ok", None]),
            "gen_ai.input.messages": json.dumps([{"role": "user", "content": "hi"}]),
        })
        r = _obs(_transform(span))
        assert r["input"][0] == {
            "role": "system",
            "parts": [
                {"type": "text", "content": "42"},
                {"type": "text", "content": "7"},
                {"type": "text", "content": "ok"},
            ],
        }


# ── Non-LLM spans ─────────────────────────────────────────────────────────


class TestNonLLMSpans:
    def test_returns_null_when_no_recognizable_attrs(self):
        span = _mock_span(attrs={"http.method": "GET", "http.url": "https://x/y"})
        r = _obs(_transform(span))
        assert r["input"] is None
        assert r["output"] is None
