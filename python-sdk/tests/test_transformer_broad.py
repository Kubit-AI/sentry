"""Tests for the broad-adapter schemas under :mod:`kubit_otel.transformer`.

Covers the seven framework adapters re-enabled alongside the narrow set
(braintrust, langsmith, logfire, openai_agents, openinference, traceloop,
vercel_ai) — exercises ``transform_spans`` end-to-end against vendor-specific
attribute fixtures.
"""

from __future__ import annotations

import json
from unittest.mock import MagicMock

import pytest
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


class TestOpenAIAgentsSchema:
    """OpenAI Agents v2 instrumentor (``opentelemetry.instrumentation.openai_agents``).

    Uses OTel GenAI semconv natively: ``gen_ai.input.messages`` /
    ``gen_ai.output.messages`` (JSON), flat ``gen_ai.request.<param>`` keys,
    ``gen_ai.operation.name`` as the span-kind discriminator, and
    ``gen_ai.conversation.id`` as the session equivalent.
    """

    def _attrs(self):
        return {
            "gen_ai.operation.name": "chat",
            "gen_ai.provider.name": "openai",
            "gen_ai.request.model": "gpt-4o-mini",
            "gen_ai.response.model": "gpt-4o-mini-2024-07-18",
            "gen_ai.request.temperature": 0.7,
            "gen_ai.request.max_tokens": 500,
            "gen_ai.request.top_p": 0.95,
            "gen_ai.input.messages": json.dumps(
                [{"role": "user", "content": "hello"}]
            ),
            "gen_ai.output.messages": json.dumps(
                [{"role": "assistant", "content": "hi"}]
            ),
            "gen_ai.usage.input_tokens": 100,
            "gen_ai.usage.output_tokens": 20,
            "gen_ai.conversation.id": "conv-abc",
            "gen_ai.agent.name": "helpful-agent",
        }

    def test_model_resolved_from_gen_ai_response_model(self):
        span = _mock_span(
            scope_name="opentelemetry.instrumentation.openai_agents",
            kind=SpanKind.INTERNAL,
            attributes=self._attrs(),
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["model"] == "gpt-4o-mini-2024-07-18"

    def test_input_and_output_captured_from_modern_keys(self):
        span = _mock_span(attributes=self._attrs())
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert json.loads(obs["input"])[0]["content"] == "hello"
        assert json.loads(obs["output"])[0]["content"] == "hi"

    def test_model_parameters_packed_from_flat_keys(self):
        span = _mock_span(attributes=self._attrs())
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["model_parameters"] == {
            "temperature": 0.7,
            "max_tokens": 500,
            "top_p": 0.95,
        }

    def test_usage_total_computed_when_missing(self):
        span = _mock_span(attributes=self._attrs())
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["usage_details"] == {"input": 100, "output": 20, "total": 120}

    def test_conversation_id_maps_to_session(self):
        span = _mock_span(attributes=self._attrs())
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["session_id"] == "conv-abc"

    def test_type_generation_from_operation_name(self):
        # Drop the resolved model so the only GENERATION signal is operation.name
        attrs = self._attrs()
        attrs.pop("gen_ai.response.model")
        attrs.pop("gen_ai.request.model")
        span = _mock_span(attributes=attrs)
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["type"] == "GENERATION"


class TestBraintrustSchema:
    """Braintrust OTel-compat mode. Uses modern GenAI schema plus
    Braintrust-specific cost attributes and span_attributes.type kind."""

    def _attrs(self):
        return {
            "gen_ai.operation.name": "chat",
            "gen_ai.request.model": "claude-3-5-sonnet",
            "gen_ai.input.messages": json.dumps([{"role": "user", "content": "hi"}]),
            "gen_ai.output.messages": json.dumps([{"role": "assistant", "content": "ok"}]),
            "gen_ai.usage.input_tokens": 50,
            "gen_ai.usage.output_tokens": 10,
            "gen_ai.usage.cache_read.input_tokens": 30,
            "gen_ai.usage.cache_creation.input_tokens": 5,
            "gen_ai.usage.cost.prompt": 0.0015,
            "gen_ai.usage.cost.completion": 0.0005,
            "gen_ai.usage.cost.total": 0.002,
            "gen_ai.request.temperature": 0.2,
            "span_attributes.type": "llm",
        }

    def test_braintrust_cost_captured(self):
        span = _mock_span(attributes=self._attrs())
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["cost_details"] == {
            "input": 0.0015,
            "output": 0.0005,
            "total": 0.002,
        }
        assert obs["total_cost"] == 0.002

    def test_cache_tokens_mapped_to_canonical_keys(self):
        span = _mock_span(attributes=self._attrs())
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["usage_details"]["cache_read_input"] == 30
        assert obs["usage_details"]["cache_creation_input"] == 5

    def test_span_attributes_type_forces_generation(self):
        attrs = self._attrs()
        # Drop every other GENERATION signal so only span_attributes.type fires.
        attrs.pop("gen_ai.request.model")
        attrs.pop("gen_ai.operation.name")
        span = _mock_span(attributes=attrs)
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["type"] == "GENERATION"

    def test_namespaced_braintrust_span_attributes_type(self):
        # Some emitters namespace the discriminator under ``braintrust.``;
        # both forms must resolve to the same observation type.
        span = _mock_span(attributes={"braintrust.span_attributes.type": "eval"})
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["type"] == "EVAL"


class TestOpenInferenceSchema:
    """OpenInference / Arize Phoenix uses its own ``llm.*`` namespace plus
    ``openinference.span.kind`` as the span-kind discriminator. Model
    parameters come as a JSON blob under ``llm.invocation_parameters``."""

    def _attrs(self):
        return {
            "openinference.span.kind": "LLM",
            "llm.model_name": "gpt-4o",
            "llm.system": "openai",
            "llm.invocation_parameters": json.dumps(
                {"temperature": 0.1, "max_tokens": 1000}
            ),
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
        }

    def test_openinference_invocation_params_parsed(self):
        span = _mock_span(
            scope_name="openinference.instrumentation.openai",
            attributes=self._attrs(),
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["model_parameters"] == {"temperature": 0.1, "max_tokens": 1000}

    def test_openinference_cost_captured(self):
        span = _mock_span(attributes=self._attrs())
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["cost_details"] == {
            "input": 0.004,
            "output": 0.0009,
            "total": 0.0049,
        }

    def test_openinference_cache_and_reasoning_tokens(self):
        span = _mock_span(attributes=self._attrs())
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["usage_details"]["cache_read_input"] == 40
        assert obs["usage_details"]["cache_creation_input"] == 20
        assert obs["usage_details"]["completion_reasoning"] == 5

    def test_openinference_span_kind_llm_forces_generation(self):
        attrs = self._attrs()
        attrs.pop("llm.model_name")
        span = _mock_span(attributes=attrs)
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["type"] == "GENERATION"

    def test_openinference_span_kind_tool_maps_to_tool(self):
        span = _mock_span(
            attributes={"openinference.span.kind": "TOOL", "input.value": "x"},
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["type"] == "TOOL"

    def test_input_value_captured_when_messages_absent(self):
        span = _mock_span(attributes=self._attrs())
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["input"] == "what's the weather"
        assert obs["output"] == "sunny"


class TestLangSmithSchema:
    """LangSmith OTel exporter (LANGSMITH_OTEL_ENABLED=true).

    Mixes modern gen_ai.* keys and its own langsmith.* namespace. Still
    emits legacy ``gen_ai.prompt`` / ``gen_ai.completion``. Session ID comes
    from ``langsmith.trace.session_id``; run type from ``langsmith.span.kind``.
    """

    def _attrs(self):
        return {
            "langsmith.span.kind": "llm",
            "gen_ai.request.model": "gpt-4o-mini",
            "gen_ai.prompt": json.dumps([{"role": "user", "content": "q"}]),
            "gen_ai.completion": json.dumps([{"role": "assistant", "content": "a"}]),
            "gen_ai.usage.input_tokens": 25,
            "gen_ai.usage.output_tokens": 7,
            "gen_ai.usage.input_token_details": json.dumps(
                {"cache_read": 10, "audio": 0}
            ),
            "gen_ai.usage.output_token_details": json.dumps({"reasoning": 2}),
            "langsmith.trace.session_id": "ls-session-1",
            "langsmith.span.tags": "prod,green",
            "gen_ai.request.temperature": 0.5,
        }

    def test_langsmith_session_id(self):
        span = _mock_span(scope_name="langsmith", attributes=self._attrs())
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["session_id"] == "ls-session-1"

    def test_langsmith_span_kind_llm_forces_generation(self):
        attrs = self._attrs()
        attrs.pop("gen_ai.request.model")
        span = _mock_span(attributes=attrs)
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["type"] == "GENERATION"

    def test_langsmith_token_details_merged_into_usage(self):
        span = _mock_span(attributes=self._attrs())
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        # input_token_details contributed "cache_read" and "audio"
        assert obs["usage_details"]["cache_read"] == 10
        assert obs["usage_details"]["audio"] == 0
        # output_token_details contributed "reasoning"
        assert obs["usage_details"]["reasoning"] == 2

    def test_langsmith_tags_captured(self):
        span = _mock_span(attributes=self._attrs())
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["tags"] == "prod,green"

    def test_langsmith_legacy_prompt_still_wins_fallback(self):
        # No gen_ai.input.messages — fall back to gen_ai.prompt.
        span = _mock_span(attributes=self._attrs())
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert json.loads(obs["input"])[0]["content"] == "q"


class TestLogfireLatestSchema:
    """Logfire in `version='latest'` mode emits modern OTel GenAI keys
    plus a ``logfire.tags`` tuple."""

    def test_logfire_tags_captured(self):
        span = _mock_span(
            scope_name="logfire",
            attributes={
                "gen_ai.request.model": "gpt-4o",
                "gen_ai.operation.name": "chat",
                "gen_ai.input.messages": json.dumps([{"role": "user", "content": "x"}]),
                "logfire.tags": ("prod", "web"),
            },
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["tags"] == ("prod", "web")
        assert obs["type"] == "GENERATION"
        assert json.loads(obs["input"])[0]["content"] == "x"


class TestTraceloopModernSchema:
    """OpenLLMetry / Traceloop v0.5+ emits modern gen_ai.input.messages /
    gen_ai.output.messages plus underscored cache-token keys, distinct from
    the dot-separated OTel semconv variant."""

    def _attrs(self):
        return {
            "gen_ai.operation.name": "chat",
            "gen_ai.request.model": "claude-3-5-sonnet",
            "gen_ai.input.messages": json.dumps([{"role": "user", "content": "h"}]),
            "gen_ai.output.messages": json.dumps([{"role": "assistant", "content": "ok"}]),
            "gen_ai.usage.input_tokens": 40,
            "gen_ai.usage.output_tokens": 8,
            # Traceloop variant: underscored, NOT dot-separated.
            "gen_ai.usage.cache_read_input_tokens": 20,
            "gen_ai.usage.cache_creation_input_tokens": 3,
            "traceloop.association.properties.user_id": "u1",
            "traceloop.association.properties.session_id": "s1",
            "traceloop.association.properties.tags": ["dev"],
        }

    def test_traceloop_cache_tokens_underscore_variant(self):
        span = _mock_span(
            scope_name="opentelemetry.instrumentation.anthropic",
            attributes=self._attrs(),
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["usage_details"]["cache_read_input"] == 20
        assert obs["usage_details"]["cache_creation_input"] == 3

    def test_traceloop_association_properties(self):
        span = _mock_span(attributes=self._attrs())
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["session_id"] == "s1"
        assert obs["user_id"] == "u1"
        assert obs["tags"] == ["dev"]


class TestObservationTypePassThroughDisabled:
    """Framework-native span-kind discriminators emitted by disabled adapters
    (openinference, langsmith, braintrust, traceloop)."""

    def test_openinference_retriever_maps_to_retriever(self):
        span = _mock_span(attributes={"openinference.span.kind": "RETRIEVER"})
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["type"] == "RETRIEVER"

    def test_openinference_reranker_maps_to_reranker(self):
        span = _mock_span(attributes={"openinference.span.kind": "RERANKER"})
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["type"] == "RERANKER"

    def test_openinference_unknown_falls_through_to_base(self):
        span = _mock_span(
            kind=SpanKind.INTERNAL,
            attributes={"openinference.span.kind": "UNKNOWN"},
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["type"] == "SPAN"

    def test_langsmith_chain_maps_to_chain(self):
        span = _mock_span(attributes={"langsmith.span.kind": "chain"})
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["type"] == "CHAIN"

    def test_braintrust_eval_maps_to_eval(self):
        span = _mock_span(attributes={"span_attributes.type": "eval"})
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["type"] == "EVAL"

    def test_traceloop_workflow_maps_to_workflow(self):
        span = _mock_span(attributes={"traceloop.span.kind": "workflow"})
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["type"] == "WORKFLOW"

    def test_priority_langfuse_wins_over_openinference(self):
        span = _mock_span(
            attributes={
                "langfuse.observation.type": "chain",
                "openinference.span.kind": "RETRIEVER",
            },
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["type"] == "CHAIN"


class TestIndexedMessageUnpacking:
    """Traceloop and OpenInference still emit indexed message attrs. The
    transformer reconstructs them into a JSON array under input/output."""

    def test_openinference_indexed_input_messages(self):
        span = _mock_span(
            attributes={
                "openinference.span.kind": "LLM",
                "llm.model_name": "gpt-4o",
                "llm.input_messages.0.message.role": "system",
                "llm.input_messages.0.message.content": "you are helpful",
                "llm.input_messages.1.message.role": "user",
                "llm.input_messages.1.message.content": "hi",
                "llm.output_messages.0.message.role": "assistant",
                "llm.output_messages.0.message.content": "hello",
            },
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        parsed_in = json.loads(obs["input"])
        assert parsed_in == [
            {"role": "system", "content": "you are helpful"},
            {"role": "user", "content": "hi"},
        ]
        parsed_out = json.loads(obs["output"])
        assert parsed_out == [{"role": "assistant", "content": "hello"}]

    def test_traceloop_indexed_gen_ai_prompts(self):
        span = _mock_span(
            attributes={
                "gen_ai.operation.name": "chat",
                "gen_ai.request.model": "gpt-4o",
                "gen_ai.prompt.0.role": "user",
                "gen_ai.prompt.0.content": "hey",
                "gen_ai.completion.0.role": "assistant",
                "gen_ai.completion.0.content": "sup",
            },
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert json.loads(obs["input"]) == [{"role": "user", "content": "hey"}]
        assert json.loads(obs["output"]) == [
            {"role": "assistant", "content": "sup"}
        ]

    def test_non_indexed_form_still_preferred_over_unpacked(self):
        """When both the flat gen_ai.input.messages and indexed form are
        present, the flat form (higher priority) wins."""
        span = _mock_span(
            attributes={
                "gen_ai.input.messages": json.dumps([{"role": "user", "content": "flat"}]),
                "gen_ai.prompt.0.role": "user",
                "gen_ai.prompt.0.content": "indexed",
            },
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert json.loads(obs["input"])[0]["content"] == "flat"


class TestProviderExtractionDisabled:
    """Provider/system id from adapters that are currently disabled."""

    def test_openinference_llm_system(self):
        span = _mock_span(attributes={"llm.system": "openai"})
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["provider"] == "openai"


class TestOpenAIAgentsDedicatedFields:
    """Agent identity + tool name land on first-class observation fields."""

    def test_agent_fields_captured(self):
        span = _mock_span(
            attributes={
                "gen_ai.operation.name": "invoke_agent",
                "gen_ai.agent.name": "researcher",
                "gen_ai.agent.id": "agt_abc",
                "gen_ai.agent.version": "v1.2",
            },
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["agent_name"] == "researcher"
        assert obs["agent_id"] == "agt_abc"
        assert obs["agent_version"] == "v1.2"
        assert obs["type"] == "INVOKE_AGENT"

    def test_tool_name_captured(self):
        span = _mock_span(
            attributes={
                "gen_ai.operation.name": "execute_tool",
                "gen_ai.tool.name": "web_search",
            },
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["tool_name"] == "web_search"
        assert obs["type"] == "TOOL"

    def test_system_instructions_captured(self):
        span = _mock_span(
            attributes={
                "gen_ai.request.model": "gpt-4o",
                "gen_ai.system_instructions": "be concise",
            },
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["system_instructions"] == "be concise"


class TestBraintrustNativePayloads:
    """Braintrust JSON payloads + metrics promotion."""

    def test_braintrust_input_output_json(self):
        span = _mock_span(
            attributes={
                "braintrust.input_json": json.dumps({"messages": [{"role": "user"}]}),
                "braintrust.output_json": json.dumps({"content": "ok"}),
                "span_attributes.type": "llm",
            },
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert json.loads(obs["input"])["messages"][0]["role"] == "user"
        assert json.loads(obs["output"])["content"] == "ok"

    def test_gen_ai_prompt_json_fallback(self):
        span = _mock_span(
            attributes={
                "gen_ai.prompt_json": json.dumps([{"role": "user"}]),
                "gen_ai.completion_json": json.dumps([{"role": "assistant"}]),
            },
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert json.loads(obs["input"])[0]["role"] == "user"
        assert json.loads(obs["output"])[0]["role"] == "assistant"

    def test_braintrust_metrics_promoted_to_usage(self):
        span = _mock_span(
            attributes={
                "gen_ai.usage.input_tokens": 10,
                "braintrust.metrics.cache_hits": 3,
                "braintrust.metrics.retry_count": 1,
                "braintrust.metrics.not_a_number": "abc",  # ignored
            },
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["usage_details"]["cache_hits"] == 3
        assert obs["usage_details"]["retry_count"] == 1
        assert "not_a_number" not in obs["usage_details"]


class TestOpenInferenceEmbedding:
    def test_embedding_model_name_captured(self):
        span = _mock_span(
            attributes={
                "openinference.span.kind": "EMBEDDING",
                "embedding.model_name": "text-embedding-3-small",
            },
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["model"] == "text-embedding-3-small"
        assert obs["type"] == "EMBEDDINGS"


class TestLlmRequestTypeFallback:
    """``llm.request.type`` is the last-resort operation-name fallback used
    by older OpenLLMetry / Datadog emitters."""

    def test_llm_request_type_chat_maps_to_generation(self):
        span = _mock_span(attributes={"llm.request.type": "chat"})
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["type"] == "GENERATION"

    def test_llm_request_type_embedding(self):
        span = _mock_span(attributes={"llm.request.type": "embedding"})
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["type"] == "EMBEDDINGS"

    def test_llm_request_type_rerank_maps_to_workflow(self):
        span = _mock_span(attributes={"llm.request.type": "rerank"})
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["type"] == "WORKFLOW"

    def test_gen_ai_operation_name_still_wins_over_llm_request_type(self):
        span = _mock_span(
            attributes={
                "gen_ai.operation.name": "chat",
                "llm.request.type": "embedding",
            },
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["type"] == "GENERATION"


class TestTraceloopEntityPayloads:
    """OpenLLMetry/Traceloop ``@workflow`` and ``@task`` decorators emit
    input/output under ``traceloop.entity.input`` / ``traceloop.entity.output``."""

    def test_entity_input_output_captured(self):
        span = _mock_span(
            attributes={
                "traceloop.entity.input": json.dumps({"query": "hello"}),
                "traceloop.entity.output": json.dumps({"answer": "hi"}),
            },
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["input"] == json.dumps({"query": "hello"})
        assert obs["output"] == json.dumps({"answer": "hi"})


class TestOpenInferenceRetrievalDocs:
    """OpenInference retriever spans encode RAG hits as
    ``retrieval.documents.<n>.document.{content,id,score,metadata}``. When
    ``llm.output_messages`` is absent, these should populate the output slot."""

    def test_retrieval_documents_populate_output(self):
        span = _mock_span(
            attributes={
                "openinference.span.kind": "RETRIEVER",
                "retrieval.documents.0.document.content": "Paris is the capital of France.",
                "retrieval.documents.0.document.id": "doc-1",
                "retrieval.documents.0.document.score": 0.97,
                "retrieval.documents.1.document.content": "The Eiffel Tower is in Paris.",
                "retrieval.documents.1.document.id": "doc-2",
                "retrieval.documents.1.document.score": 0.91,
            },
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["type"] == "RETRIEVER"
        docs = json.loads(obs["output"])
        assert docs == [
            {"content": "Paris is the capital of France.", "id": "doc-1", "score": 0.97},
            {"content": "The Eiffel Tower is in Paris.", "id": "doc-2", "score": 0.91},
        ]

    def test_llm_output_messages_still_wins_over_retrieval_docs(self):
        span = _mock_span(
            attributes={
                "llm.output_messages.0.message.role": "assistant",
                "llm.output_messages.0.message.content": "from messages",
                "retrieval.documents.0.document.content": "from docs",
            },
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        parsed = json.loads(obs["output"])
        assert parsed == [{"role": "assistant", "content": "from messages"}]

    def test_retrieval_docs_populate_both_legacy_and_canonical_outputs(self):
        """Regression guard: retrieval docs must reach both the legacy
        ``output`` string (via unpack_messages) AND the canonical
        ``output_messages`` array (via normalize_messages). Refactoring
        either path should not silently break the other.
        """
        span = _mock_span(
            attributes={
                "openinference.span.kind": "retriever",
                "retrieval.documents.0.document.content": "Paris is the capital of France.",
                "retrieval.documents.0.document.id": "doc-1",
                "retrieval.documents.0.document.score": 0.97,
            },
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        # Legacy path (unpack_messages)
        assert obs["output"]
        assert "Paris is the capital of France." in json.dumps(obs["output"])
        # Canonical path (normalize_messages)
        assert obs["output_messages"]
        assert "Paris is the capital of France." in json.dumps(obs["output_messages"])


def _lc_msg(type_: str, kwargs: dict) -> dict:
    """LangChain Serializable shape:
    {"lc":1, "type":"constructor", "id":["langchain_core","messages",<MsgType>], "kwargs":{...}}"""
    return {
        "lc": 1,
        "type": "constructor",
        "id": ["langchain_core", "messages", type_],
        "kwargs": kwargs,
    }


class TestOpenInferenceLangChain:
    """LangChain (Python via ``openinference.instrumentation.langchain``,
    JS via ``@arizeai/openinference-instrumentation-langchain``) lands on the
    OpenInference adapter via Serializable envelopes inside ``input.value`` /
    ``output.value``. These tests exercise the integration end-to-end.
    """

    def test_tool_span_synthesis_with_tool_message_envelope(self):
        span = _mock_span(
            scope_name="openinference.instrumentation.langchain",
            attributes={
                "openinference.span.kind": "TOOL",
                "tool.name": "add",
                "input.value": json.dumps({"a": 47, "b": 38}),
                "output.value": json.dumps(_lc_msg("ToolMessage", {
                    "content": "85",
                    "tool_call_id": "toolu_xyz",
                    "name": "add",
                })),
            },
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["tool_name"] == "add"
        assert obs["input_messages"] == [{
            "role": "assistant",
            "parts": [{"type": "tool_call", "name": "add", "arguments": {"a": 47, "b": 38}}],
        }]
        assert obs["output_messages"] == [{
            "role": "tool",
            "parts": [{"type": "tool_call_response", "response": "85", "id": "toolu_xyz"}],
            "name": "add",
        }]

    def test_tool_span_with_output_wrapper(self):
        span = _mock_span(
            attributes={
                "openinference.span.kind": "TOOL",
                "tool.name": "add",
                "input.value": json.dumps({"a": 1}),
                "output.value": json.dumps({
                    "output": _lc_msg("ToolMessage", {
                        "content": "result",
                        "tool_call_id": "tc_1",
                    }),
                }),
            },
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["output_messages"] == [{
            "role": "tool",
            "parts": [{"type": "tool_call_response", "response": "result", "id": "tc_1"}],
        }]

    def test_tool_span_non_envelope_output_falls_back_to_raw(self):
        span = _mock_span(
            attributes={
                "openinference.span.kind": "TOOL",
                "tool.name": "add",
                "input.value": json.dumps({"a": 1}),
                "output.value": "85",
            },
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["input_messages"] == [{
            "role": "assistant",
            "parts": [{"type": "tool_call", "name": "add", "arguments": {"a": 1}}],
        }]
        # Raw scalar "85" survives the JSON parse round-trip (becomes 85).
        assert obs["output_messages"] == [{
            "role": "tool",
            "parts": [{"type": "tool_call_response", "response": 85}],
        }]

    def test_langchain_blob_wins_over_indexed_messages(self):
        span = _mock_span(
            attributes={
                "openinference.span.kind": "LLM",
                "llm.output_messages.0.message.role": "assistant",
                # Indexed projection has no slot for tool_use parts; the blob
                # carries the richer structure.
                "output.value": json.dumps(_lc_msg("AIMessage", {
                    "content": [
                        {"type": "tool_use", "id": "tu_1", "name": "add", "input": {"a": 1}},
                    ],
                })),
            },
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["output_messages"] == [{
            "role": "assistant",
            "parts": [{"type": "tool_call", "name": "add", "id": "tu_1", "arguments": {"a": 1}}],
        }]

    def test_provider_resolves_from_ai_message_envelope(self):
        span = _mock_span(
            attributes={
                "openinference.span.kind": "LLM",
                "llm.model_name": "claude-sonnet-4-5",
                "output.value": json.dumps(_lc_msg("AIMessage", {
                    "content": "hi",
                    "response_metadata": {"model_provider": "anthropic"},
                })),
            },
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["provider"] == "anthropic"

    def test_tool_definitions_aggregated_from_indexed_schemas(self):
        schema0 = {"type": "function", "function": {"name": "add", "parameters": {}}}
        schema1 = {"type": "function", "function": {"name": "sub", "parameters": {}}}
        span = _mock_span(
            attributes={
                "openinference.span.kind": "LLM",
                "llm.tools.0.tool.json_schema": json.dumps(schema0),
                "llm.tools.1.tool.json_schema": json.dumps(schema1),
            },
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["tool_definitions"] == [schema0, schema1]


class TestBraintrustIndexedAndMetadata:
    """Braintrust indexed input/output reconstruction, metadata promotion,
    and ``braintrust.scores`` capture."""

    def test_indexed_input_output_reconstructed(self):
        span = _mock_span(
            attributes={
                "braintrust.input.0.role": "user",
                "braintrust.input.0.content": "what's the capital of France?",
                "braintrust.input.1.role": "assistant",
                "braintrust.input.1.content": "Paris.",
                "braintrust.output.0.role": "assistant",
                "braintrust.output.0.content": "Paris.",
            },
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert json.loads(obs["input"]) == [
            {"role": "user", "content": "what's the capital of France?"},
            {"role": "assistant", "content": "Paris."},
        ]
        assert json.loads(obs["output"]) == [{"role": "assistant", "content": "Paris."}]

    def test_metadata_prefix_promoted(self):
        span = _mock_span(
            attributes={
                "braintrust.metadata.experiment": "baseline-v2",
                "braintrust.metadata.retry": 3,
            },
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["metadata"]["experiment"] == "baseline-v2"
        assert obs["metadata"]["retry"] == 3

    def test_scores_parsed_from_json_string(self):
        span = _mock_span(
            attributes={
                "braintrust.scores": json.dumps({"accuracy": 0.92, "relevance": 0.88}),
            },
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["metadata"]["scores"] == {"accuracy": 0.92, "relevance": 0.88}

    def test_scores_passthrough_when_already_structured(self):
        span = _mock_span(
            attributes={"braintrust.scores": {"accuracy": 1.0}},
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["metadata"]["scores"] == {"accuracy": 1.0}


class TestCrossVendorCachePriority:
    """When multiple vendor-flavour cache attributes coexist, the first one
    in _CACHE_TOKEN_ATTR_MAP wins — dot-form OTel semconv is preferred.

    Both aliases here come from currently-disabled adapters (otel_genai's
    dot-form vs traceloop's underscore-form), so this case lives alongside
    the disabled-adapter tests.
    """

    def test_otel_semconv_wins_over_traceloop_underscore(self):
        span = _mock_span(
            attributes={
                "gen_ai.usage.cache_read.input_tokens": 100,
                "gen_ai.usage.cache_read_input_tokens": 999,
            }
        )
        [obs] = _observations(transform_spans([span], "wid", "claim"))
        assert obs["usage_details"]["cache_read_input"] == 100
