"""Tests for :mod:`kubit_otel.transformer`.

Focus on the attribute-alias + JSON-blob-merge logic that turns raw
OTel spans emitted by LLM-framework SDKs into Kubit records.
"""

from __future__ import annotations

import json
from unittest.mock import MagicMock

from opentelemetry.trace import SpanKind, StatusCode

from kubit_otel.transformer import transform_spans


def _mock_span(
    *,
    name: str = "span",
    trace_id: int = 0x01,
    span_id: int = 0x02,
    parent_span_id: int | None = None,
    kind=SpanKind.INTERNAL,
    attributes: dict | None = None,
    resource_attrs: dict | None = None,
    scope_name: str | None = "langfuse-sdk",
    scope_version: str | None = "4.5.0",
    start_time_ns: int = 1_700_000_000_000_000_000,
    end_time_ns: int = 1_700_000_001_000_000_000,
    status_code=StatusCode.UNSET,
    status_description: str | None = None,
    events: list | None = None,
):
    span = MagicMock()
    span.name = name
    span.kind = kind
    span.attributes = attributes or {}
    span.events = events or []
    span.resource = MagicMock()
    span.resource.attributes = resource_attrs or {}
    span.instrumentation_scope = MagicMock()
    span.instrumentation_scope.name = scope_name
    span.instrumentation_scope.version = scope_version
    span.start_time = start_time_ns
    span.end_time = end_time_ns
    span.status = MagicMock()
    span.status.status_code = status_code
    span.status.description = status_description

    ctx = MagicMock()
    ctx.trace_id = trace_id
    ctx.span_id = span_id
    span.context = ctx

    if parent_span_id is None:
        span.parent = None
    else:
        parent = MagicMock()
        parent.span_id = parent_span_id
        span.parent = parent

    return span


def _observations(records):
    return [r for r in records if r["entity_type"] == "enriched_observation"]


def _trace(records):
    traces = [r for r in records if r["entity_type"] == "trace"]
    assert len(traces) == 1, f"expected one trace record, got {len(traces)}"
    return traces[0]


class TestLangfuseV4GenerationSpan:
    """Langfuse SDK v4.x emits GENERATION-type spans with a specific
    attribute schema — verify the transformer extracts model, params,
    usage, cost, and forces type=GENERATION even on INTERNAL kind spans
    (which Langfuse uses for every observation)."""

    def _attrs(self):
        return {
            "langfuse.observation.type": "generation",
            "langfuse.observation.model.name": "gpt-4o-mini-2024-07-18",
            "langfuse.observation.model.parameters": json.dumps(
                {"temperature": 0.7}
            ),
            "langfuse.observation.input": json.dumps({"messages": []}),
            "langfuse.observation.output": json.dumps({"content": "hi"}),
            "langfuse.observation.usage_details": json.dumps(
                {
                    "input": 1009,
                    "output": 130,
                    "total": 1139,
                    "input_cache_read": 0,
                }
            ),
            "langfuse.observation.cost_details": json.dumps(
                {"input": 0.001, "output": 0.0002, "total": 0.0012}
            ),
        }

    def test_model_extracted_from_model_dot_name(self):
        span = _mock_span(name="ChatOpenAI", attributes=self._attrs())
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["model"] == "gpt-4o-mini-2024-07-18"

    def test_model_parameters_parsed_from_json_blob(self):
        span = _mock_span(attributes=self._attrs())
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        # Langfuse v4 emits a JSON-serialised dict; the transformer parses it
        # so downstream consumers get a real object rather than a string.
        assert obs["model_parameters"] == {"temperature": 0.7}

    def test_usage_details_parsed_from_json_blob(self):
        span = _mock_span(attributes=self._attrs())
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["usage_details"]["input"] == 1009
        assert obs["usage_details"]["output"] == 130
        assert obs["usage_details"]["total"] == 1139
        # Non-standard Langfuse keys are preserved.
        assert obs["usage_details"]["input_cache_read"] == 0

    def test_cost_details_parsed_from_json_blob(self):
        span = _mock_span(attributes=self._attrs())
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["cost_details"] == {
            "input": 0.001,
            "output": 0.0002,
            "total": 0.0012,
        }

    def test_total_cost_recovered_from_cost_blob(self):
        span = _mock_span(attributes=self._attrs())
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["total_cost"] == 0.0012

    def test_type_forced_to_generation_despite_internal_kind(self):
        span = _mock_span(kind=SpanKind.INTERNAL, attributes=self._attrs())
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["type"] == "GENERATION"


class TestLangfuseV4SpanType:
    """Non-generation Langfuse observations are passed through verbatim
    (uppercased); usage/cost should not populate; input/output still captured."""

    def test_type_span_stays_span(self):
        span = _mock_span(
            name="RunnableSequence",
            attributes={
                "langfuse.observation.type": "span",
                "langfuse.observation.input": json.dumps({"x": 1}),
                "langfuse.observation.output": json.dumps({"y": 2}),
            },
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["type"] == "SPAN"
        assert obs["model"] is None
        assert obs["usage_details"] == {}
        assert obs["cost_details"] == {}
        assert obs["input"] == json.dumps({"x": 1})
        assert obs["output"] == json.dumps({"y": 2})

    def test_type_tool_maps_to_tool(self):
        span = _mock_span(
            attributes={"langfuse.observation.type": "tool"},
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["type"] == "TOOL"

    def test_type_chain_maps_to_chain(self):
        span = _mock_span(
            attributes={"langfuse.observation.type": "chain"},
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["type"] == "CHAIN"

    def test_type_agent_maps_to_agent(self):
        span = _mock_span(
            attributes={"langfuse.observation.type": "agent"},
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["type"] == "AGENT"

    # The Langfuse JS SDK emits ``langfuse.observation.type=span`` for the
    # LangChain wrapper spans (LangGraph root, ``tools``, ``model_request``,
    # ``RunnableLambda``, ``__start__``) where the Python SDK emits ``chain``.
    # Fold the JS literal back to CHAIN when the integration metadata says
    # we're inside a langchain run, so cross-SDK observation types stay
    # aligned.
    def test_type_span_folds_to_chain_when_ls_integration_is_langchain(self):
        span = _mock_span(
            attributes={
                "langfuse.observation.type": "span",
                "langfuse.observation.metadata.ls_integration": "langchain_create_agent",
            },
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["type"] == "CHAIN"

    def test_type_span_without_langchain_integration_stays_span(self):
        span = _mock_span(
            attributes={
                "langfuse.observation.type": "span",
                "langfuse.observation.metadata.ls_integration": "openai",
            },
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["type"] == "SPAN"


class TestLangfuseProviderModelAliases:
    def test_populates_provider_from_metadata_ls_provider(self):
        span = _mock_span(
            attributes={"langfuse.observation.metadata.ls_provider": "anthropic"},
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["provider"] == "anthropic"

    def test_populates_provided_model_name_from_metadata_ls_model_name(self):
        span = _mock_span(
            attributes={"langfuse.observation.metadata.ls_model_name": "claude-sonnet-4-6"},
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["provided_model_name"] == "claude-sonnet-4-6"

    # Confirms that finding #7 (tool-span output stringified as ToolMessage
    # Serializable JSON-blob) is closed by the langchain envelope routing
    # already in place from the previous fix. ToolMessage Serializables in
    # ``langfuse.observation.output`` should produce a clean
    # ``tool_call_response`` part, lifting the ``tool_call_id`` linkage and
    # the tool name onto the canonical message.
    def test_normalizes_toolmessage_serializable_output_to_tool_call_response(self):
        span = _mock_span(
            attributes={
                "langfuse.observation.type": "tool",
                "langfuse.observation.output": json.dumps({
                    "lc": 1,
                    "type": "constructor",
                    "id": ["langchain_core", "messages", "ToolMessage"],
                    "kwargs": {
                        "status": "success",
                        "content": "85",
                        "tool_call_id": "toolu_0183unn5QaJzKbi2w9yqPNdq",
                        "name": "add",
                        "additional_kwargs": {},
                        "response_metadata": {},
                    },
                }),
            },
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["output_messages"] == [
            {
                "role": "tool",
                "name": "add",
                "parts": [
                    {
                        "type": "tool_call_response",
                        "id": "toolu_0183unn5QaJzKbi2w9yqPNdq",
                        "response": "85",
                    },
                ],
            },
        ]


class TestJsonBlobRobustness:
    def test_malformed_usage_json_is_ignored(self):
        span = _mock_span(
            attributes={
                "langfuse.observation.type": "generation",
                "langfuse.observation.model.name": "gpt-4o",
                "langfuse.observation.usage_details": "{not: valid json",
            },
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["usage_details"] == {}

    def test_empty_usage_blob_is_ignored(self):
        span = _mock_span(
            attributes={
                "langfuse.observation.type": "generation",
                "langfuse.observation.model.name": "gpt-4o",
                "langfuse.observation.usage_details": "",
            },
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["usage_details"] == {}

    def test_non_object_json_is_ignored(self):
        span = _mock_span(
            attributes={
                "langfuse.observation.type": "generation",
                "langfuse.observation.model.name": "gpt-4o",
                "langfuse.observation.usage_details": "[1, 2, 3]",
            },
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["usage_details"] == {}

    def test_semconv_keys_win_on_collision(self):
        """Semconv tokens pre-populate the dict; the Langfuse blob must
        not overwrite them."""
        span = _mock_span(
            attributes={
                "gen_ai.usage.input_tokens": 500,
                "gen_ai.usage.output_tokens": 50,
                "langfuse.observation.usage_details": json.dumps(
                    {"input": 9999, "output": 9999, "total": 9999}
                ),
                "langfuse.observation.model.name": "gpt-4o",
                "langfuse.observation.type": "generation",
            },
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["usage_details"]["input"] == 500
        assert obs["usage_details"]["output"] == 50
        # total: was not in semconv, so the blob value fills it.
        assert obs["usage_details"]["total"] == 9999


class TestOTelGenAISemConvStillWorks:
    """Regression: non-Langfuse spans using OTel GenAI semconv should
    continue to populate correctly."""

    def test_otel_genai_generation(self):
        span = _mock_span(
            scope_name="opentelemetry.instrumentation.openai",
            scope_version="0.56",
            kind=SpanKind.CLIENT,
            attributes={
                "gen_ai.response.model": "gpt-4o-2024",
                "gen_ai.usage.input_tokens": 100,
                "gen_ai.usage.output_tokens": 20,
                "gen_ai.usage.total_tokens": 120,
            },
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["model"] == "gpt-4o-2024"
        assert obs["type"] == "GENERATION"
        assert obs["usage_details"] == {"input": 100, "output": 20, "total": 120}


class TestRootAndResourceMapping:
    """Smoke test: trace record emission, parent/child, and resource
    mapping unchanged by this patch."""

    def test_root_span_produces_trace_plus_observation(self):
        root = _mock_span(
            name="plan_trip",
            trace_id=0xAAA,
            span_id=0xBBB,
            parent_span_id=None,
            resource_attrs={
                "service.name": "trip-planner",
                "service.version": "0.1.0",
                "deployment.environment": "dev",
            },
            attributes={
                "langfuse.observation.type": "span",
                "langfuse.observation.input": "{}",
                "langfuse.observation.output": "{}",
            },
        )
        records = transform_spans([root], "int/11476", "claim-xyz")
        trace = _trace(records)
        assert trace["id"] == format(0xAAA, "032x")
        assert trace["name"] == "plan_trip"
        assert trace["release"] == "0.1.0"
        assert trace["version"] == "0.1.0"
        assert trace["environment"] == "dev"
        assert trace["wid"] == "int/11476"
        assert trace["_wid_claim"] == "claim-xyz"

        [obs] = _observations(records)
        assert obs["trace_id"] == format(0xAAA, "032x")
        assert obs["parent_observation_id"] is None
        assert obs["trace_name"] == "plan_trip"

    def test_child_span_has_parent_observation_id(self):
        child = _mock_span(
            trace_id=0xAAA,
            span_id=0xCCC,
            parent_span_id=0xBBB,
            attributes={"langfuse.observation.type": "span"},
        )
        records = transform_spans([child], "wid", "claim")
        [obs] = _observations(records)
        assert obs["parent_observation_id"] == format(0xBBB, "016x")
        # No trace record emitted for non-root spans.
        assert not [r for r in records if r["entity_type"] == "trace"]


class TestObservationTypePassThrough:
    """Framework-native span-kind discriminators should survive to the exported
    record rather than collapsing to SPAN.

    Only the otel_genai + langfuse cases live here; discriminators emitted by
    other adapters (openinference, langsmith, braintrust, traceloop) are
    covered in ``tests/test_transformer_broad.py``.
    """

    def test_gen_ai_operation_embedding_maps_to_embedding(self):
        span = _mock_span(attributes={"gen_ai.operation.name": "embedding"})
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["type"] == "EMBEDDING"

    def test_gen_ai_operation_execute_tool_maps_to_tool(self):
        span = _mock_span(attributes={"gen_ai.operation.name": "execute_tool"})
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["type"] == "TOOL"

    def test_model_fallback_forces_generation_when_no_discriminator(self):
        span = _mock_span(attributes={"gen_ai.request.model": "gpt-4o"})
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["type"] == "GENERATION"

    def test_empty_discriminator_falls_through(self):
        span = _mock_span(
            kind=SpanKind.INTERNAL,
            attributes={"langfuse.observation.type": "   "},
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["type"] == "SPAN"


class TestProviderExtraction:
    """Provider/system id lands on a dedicated top-level field.

    Only the otel_genai cases live here; the openinference ``llm.system``
    case is covered in ``tests/test_transformer_broad.py``.
    """

    def test_gen_ai_provider_name_preferred(self):
        span = _mock_span(
            attributes={
                "gen_ai.provider.name": "openai",
                "gen_ai.system": "anthropic",
            },
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["provider"] == "openai"

    def test_gen_ai_system_fallback(self):
        span = _mock_span(attributes={"gen_ai.system": "anthropic"})
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["provider"] == "anthropic"

    def test_missing_provider_is_none(self):
        span = _mock_span(attributes={})
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["provider"] is None


class TestLangfuseMetadataPromotion:
    """Langfuse trace/observation metadata prefixes promoted to first-level keys."""

    def test_metadata_keys_promoted(self):
        span = _mock_span(
            parent_span_id=None,
            attributes={
                "langfuse.trace.metadata.environment": "prod",
                "langfuse.observation.metadata.retry": "2",
            },
        )
        records = transform_spans([span], "wid", "claim")
        trace = _trace(records)
        [obs] = _observations(records)
        assert trace["metadata"]["environment"] == "prod"
        assert obs["metadata"]["retry"] == "2"


class TestGenAiSpanEvents:
    """OTel GenAI semconv 2024+ stores conversation messages as span events
    rather than flattened attributes. The transformer must fall back to
    events when attribute chains return nothing."""

    def _event(self, name, attrs, ts=0):
        ev = MagicMock()
        ev.name = name
        ev.attributes = attrs
        ev.timestamp = ts
        return ev

    def test_input_assembled_from_user_and_system_message_events(self):
        span = _mock_span(
            events=[
                self._event("gen_ai.system.message", {"content": "be helpful"}, ts=1),
                self._event("gen_ai.user.message", {"content": "hello"}, ts=2),
            ],
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        inp = json.loads(obs["input"])
        assert inp == [
            {"role": "system", "content": "be helpful"},
            {"role": "user", "content": "hello"},
        ]

    def test_output_assembled_from_choice_events(self):
        span = _mock_span(
            events=[
                self._event(
                    "gen_ai.choice",
                    {"index": 0, "finish_reason": "stop", "message": "hi"},
                    ts=3,
                ),
            ],
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        out = json.loads(obs["output"])
        assert out == [{"index": 0, "finish_reason": "stop", "message": "hi"}]

    def test_attribute_input_beats_event_input(self):
        # If the emitter sends both attrs AND events, attrs still win.
        span = _mock_span(
            attributes={"gen_ai.input.messages": "attr-form"},
            events=[self._event("gen_ai.user.message", {"content": "event-form"})],
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["input"] == "attr-form"

    def test_event_role_overrides_event_name_fallback(self):
        # Explicit role in event attrs wins over the name-derived default.
        span = _mock_span(
            events=[
                self._event("gen_ai.assistant.message", {"role": "developer", "content": "x"}),
            ],
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert json.loads(obs["input"])[0]["role"] == "developer"


class TestLangfuseTraceNameOverride:
    """``langfuse.trace.name`` supersedes the auto-instrumentation span name
    on the trace record and the root observation's ``trace_name`` field."""

    def test_overrides_trace_record_name(self):
        span = _mock_span(
            name="POST /chat",
            attributes={"langfuse.trace.name": "Onboarding Flow"},
        )
        records = transform_spans([span], "wid", "claim")
        assert _trace(records)["name"] == "Onboarding Flow"

    def test_overrides_observation_trace_name(self):
        span = _mock_span(
            name="POST /chat",
            attributes={"langfuse.trace.name": "Onboarding Flow"},
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["trace_name"] == "Onboarding Flow"

    def test_span_name_used_when_override_absent(self):
        span = _mock_span(name="root-span")
        records = transform_spans([span], "wid", "claim")
        assert _trace(records)["name"] == "root-span"


class TestVercelAiSdk:
    """Vercel AI SDK (``ai.*`` namespace) adapter coverage."""

    def test_generate_text_maps_to_agent_with_function_id(self):
        span = _mock_span(
            scope_name="ai",
            attributes={
                "ai.operationId": "ai.generateText",
                "ai.telemetry.functionId": "calcbot.turn",
                "ai.model.provider": "anthropic.messages",
                "ai.prompt": '{"prompt":"What is 47 + 38?"}',
                "ai.response.text": "The result of 47 + 38 is 85.",
                "ai.usage.promptTokens": 704,
                "ai.usage.completionTokens": 17,
            },
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["type"] == "AGENT"
        assert obs["agent_name"] == "calcbot.turn"
        assert obs["input"] == '{"prompt":"What is 47 + 38?"}'
        assert obs["output"] == "The result of 47 + 38 is 85."
        assert obs["provider"] == "anthropic"
        usage = obs["usage_details"]
        assert usage["input"] == 704
        assert usage["output"] == 17
        assert usage["total"] == 721

    def test_tool_call_maps_to_tool(self):
        span = _mock_span(
            scope_name="ai",
            attributes={
                "ai.operationId": "ai.toolCall",
                "ai.toolCall.name": "add",
                "ai.toolCall.id": "toolu_01ChBBJ3Y8k8kaBzAeEjuxyP",
                "ai.toolCall.args": '{"a":47,"b":38}',
                "ai.toolCall.result": "85",
            },
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["type"] == "TOOL"
        assert obs["tool_name"] == "add"
        assert obs["input"] == '{"a":47,"b":38}'
        assert obs["output"] == "85"

    def test_stream_text_maps_to_agent(self):
        span = _mock_span(
            scope_name="ai",
            attributes={"ai.operationId": "ai.streamText"},
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["type"] == "AGENT"

    def test_embed_maps_to_embedding(self):
        span = _mock_span(
            scope_name="ai",
            attributes={"ai.operationId": "ai.embed"},
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["type"] == "EMBEDDING"

    def test_do_generate_with_tool_calls_output(self):
        span = _mock_span(
            scope_name="ai",
            attributes={
                "ai.operationId": "ai.generateText.doGenerate",
                "ai.prompt.messages": (
                    '[{"role":"user","content":'
                    '[{"type":"text","text":"What is 47 + 38?"}]}]'
                ),
                "ai.response.toolCalls": (
                    '[{"toolCallId":"toolu_1","toolName":"add",'
                    '"input":"{\\"a\\":47,\\"b\\":38}"}]'
                ),
                "gen_ai.system": "anthropic.messages",
            },
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["input"] == (
            '[{"role":"user","content":'
            '[{"type":"text","text":"What is 47 + 38?"}]}]'
        )
        assert obs["output"] == (
            '[{"toolCallId":"toolu_1","toolName":"add",'
            '"input":"{\\"a\\":47,\\"b\\":38}"}]'
        )

    def test_do_generate_with_text_output(self):
        span = _mock_span(
            scope_name="ai",
            attributes={
                "ai.operationId": "ai.generateText.doGenerate",
                "ai.prompt.messages": '[{"role":"user","content":"hi"}]',
                "ai.response.text": "hello",
                "gen_ai.system": "openai",
            },
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["input"] == '[{"role":"user","content":"hi"}]'
        assert obs["output"] == "hello"

    def test_do_generate_falls_through_to_otel_genai(self):
        span = _mock_span(
            scope_name="ai",
            attributes={
                "ai.operationId": "ai.generateText.doGenerate",
                "gen_ai.system": "anthropic.messages",
                "gen_ai.request.model": "claude-sonnet-4-6",
                "gen_ai.usage.input_tokens": 622,
                "gen_ai.usage.output_tokens": 69,
            },
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["type"] == "GENERATION"
        assert obs["model"] == "claude-sonnet-4-6"
        assert obs["provider"] == "anthropic"

    def test_provider_normalisation_via_hook(self):
        cases = [
            ("amazon-bedrock.claude-3-5", "aws_bedrock"),
            ("google-vertex.gemini", "vertex_ai"),
            ("openai.chat", "openai"),
            ("anthropic.messages", "anthropic"),
            ("xai.grok-1", "xai"),
        ]
        for raw, normalised in cases:
            span = _mock_span(
                attributes={
                    "ai.operationId": "ai.generateText",
                    "ai.model.provider": raw,
                },
            )
            [obs] = _observations(transform_spans([span], "wid", "claim"))
            assert obs["provider"] == normalised, f"{raw} -> {normalised}"

    def test_non_vercel_provider_passes_through_untouched(self):
        # Guards against resolve_provider firing on spans without `ai.operationId`.
        span = _mock_span(attributes={"gen_ai.system": "some.custom.value"})
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["provider"] == "some.custom.value"

    def test_ai_request_params_remapped_to_snake_case(self):
        span = _mock_span(
            attributes={
                "ai.operationId": "ai.generateText",
                "ai.request.temperature": 0.3,
                "ai.request.topP": 0.9,
                "ai.request.maxTokens": 256,
                "ai.request.stopSequences": ["\n\n"],
            },
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["model_parameters"] == {
            "temperature": 0.3,
            "top_p": 0.9,
            "max_tokens": 256,
            "stop_sequences": ["\n\n"],
        }


class TestLangfuseEnvAndReleaseSpanAttrs:
    """``langfuse.environment`` / ``langfuse.release`` on the span take
    precedence over ``deployment.environment`` / ``service.version`` on the
    resource — apps set these per-request."""

    def test_span_attrs_win_over_resource(self):
        span = _mock_span(
            attributes={
                "langfuse.environment": "staging",
                "langfuse.release": "git-abc123",
            },
            resource_attrs={
                "deployment.environment": "prod",
                "service.version": "1.0.0",
            },
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["environment"] == "staging"
        assert obs["release"] == "git-abc123"
        assert obs["version"] == "git-abc123"

    def test_resource_attrs_used_when_span_attrs_absent(self):
        span = _mock_span(
            resource_attrs={
                "deployment.environment": "prod",
                "service.version": "1.0.0",
            },
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["environment"] == "prod"
        assert obs["release"] == "1.0.0"
