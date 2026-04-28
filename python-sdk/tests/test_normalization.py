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
        assert r["input_messages"] == [
            {"role": "user", "parts": [{"type": "text", "content": "hi"}]}
        ]
        assert r["output_messages"] == [
            {"role": "assistant", "parts": [{"type": "text", "content": "hello"}]}
        ]

    def test_legacy_prompt_completion(self):
        span = _mock_span(attrs={"gen_ai.prompt": "hi", "gen_ai.completion": "there"})
        r = _obs(_transform(span))
        assert r["input_messages"] == [
            {"role": "user", "parts": [{"type": "text", "content": "hi"}]}
        ]
        assert r["output_messages"] == [
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
        assert r["output_messages"] == [{
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
        assert r["output_messages"] == [{
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
        assert r["input_messages"] == [
            {"role": "system", "parts": [{"type": "text", "content": "Be helpful."}]},
            {"role": "user", "parts": [{"type": "text", "content": "Hi!"}]},
        ]
        assert r["output_messages"] == [{
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
        assert r["output_messages"] == [{
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
        assert r["input_messages"] == [
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
        assert r["output_messages"] == [{
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
        assert r["output_messages"] == [{
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
        parts = r["output_messages"][0]["parts"]
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
        assert r["input_messages"] == [{
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
        assert r["input_messages"] == [
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
        msgs = r["input_messages"]
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
        assert r["input_messages"] == [
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
        assert r["output_messages"] == [{
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
        assert r["input_messages"] == [
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
        assert r["output_messages"] is None


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
        assert r["input_messages"] == [
            {"role": "user", "parts": [{"type": "text", "content": "hi"}]}
        ]
        assert r["output_messages"] == [
            {"role": "assistant", "parts": [{"type": "text", "content": "hello"}]}
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
        assert r["input_messages"] is None
        assert r["output_messages"] is None

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
        assert r["input_messages"] == [
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
        assert r["output_messages"] == [
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
        assert r["input_messages"] == [
            {"role": "user", "parts": [{"type": "text", "content": "hi"}]}
        ]
        assert r["output_messages"] == [
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
        assert r["input_messages"] == [{
            "role": "user",
            "parts": [
                {"type": "text", "content": "What is this?"},
                {"type": "uri", "modality": "image", "uri": "https://x/y.png"},
            ],
        }]
        assert r["output_messages"] == [
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
        assert r["input_messages"][0]["parts"][0] == {
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
        assert r["input_messages"] == [{
            "role": "assistant",
            "parts": [
                {"type": "tool_call", "name": "getWeather", "arguments": {"city": "Paris"}}
            ],
        }]
        assert r["output_messages"] == [{
            "role": "tool",
            "parts": [{"type": "tool_call_response", "response": {"temp": 22}}],
        }]


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
        assert r["input_messages"] == [
            {"role": "system", "parts": [{"type": "text", "content": "Be concise"}]},
            {"role": "user", "parts": [{"type": "text", "content": "hi"}]},
        ]
        assert r["output_messages"] == [{
            "role": "assistant",
            "parts": [
                {"type": "text", "content": "ok"},
                {"type": "tool_call", "name": "x", "arguments": {"a": 1}, "id": "c1"},
            ],
        }]


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
        assert r["input_messages"] == [
            {"role": "user", "parts": [{"type": "text", "content": "hi"}]}
        ]
        assert r["output_messages"] == [{
            "role": "assistant",
            "parts": [
                {"type": "text", "content": "ok"},
                {"type": "tool_call", "name": "lookup", "id": "c1", "arguments": {"q": "x"}},
            ],
        }]


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
        assert r["input_messages"] == [
            {"role": "user", "parts": [{"type": "text", "content": "hi"}]}
        ]
        assert r["output_messages"] == [{
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
        assert r["input_messages"] == [
            {"role": "user", "parts": [{"type": "text", "content": "what's the weather?"}]},
            {
                "role": "tool",
                "parts": [{"type": "tool_call_response", "response": "72F", "id": "call_42"}],
            },
        ]
        assert r["output_messages"] == [{
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
        assert r["input_messages"] == [
            {"role": "user", "parts": [{"type": "text", "content": "hi"}]}
        ]
        assert r["output_messages"] == [
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
        assert r["input_messages"][0] == {
            "role": "system",
            "parts": [{"type": "text", "content": "Be helpful"}],
        }
        assert r["input_messages"][1]["role"] == "user"

    def test_no_double_inject_when_input_already_has_system(self):
        span = _mock_span(attrs={
            "gen_ai.system_instructions": "Be helpful",
            "gen_ai.input.messages": json.dumps([
                {"role": "system", "content": "Be terse"},
                {"role": "user", "content": "hi"},
            ]),
        })
        r = _obs(_transform(span))
        assert r["input_messages"][0]["parts"][0] == {"type": "text", "content": "Be terse"}
        assert len(r["input_messages"]) == 2


# ── Non-LLM spans ─────────────────────────────────────────────────────────


class TestNonLLMSpans:
    def test_returns_null_when_no_recognizable_attrs(self):
        span = _mock_span(attrs={"http.method": "GET", "http.url": "https://x/y"})
        r = _obs(_transform(span))
        assert r["input_messages"] is None
        assert r["output_messages"] is None
