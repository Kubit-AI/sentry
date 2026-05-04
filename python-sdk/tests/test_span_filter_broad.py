"""Broad instrumentation-scope allow-list assertions.

Covers the full allow-list spanning openinference, langsmith, braintrust,
logfire, traceloop, the OpenLLMetry vendor family, OpenAI Agents, and
Vercel AI.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from kubit_otel.span_filter import (
    is_default_export_span,
    is_known_llm_instrumentor,
    is_mastra_internal_span,
)


def _span(scope_name: str | None = None, attrs: dict | None = None):
    span = MagicMock()
    if scope_name is None:
        span.instrumentation_scope = None
    else:
        span.instrumentation_scope = MagicMock()
        span.instrumentation_scope.name = scope_name
    span.attributes = attrs or {}
    return span


class TestIsKnownLLMInstrumentorBroad:
    @pytest.mark.parametrize(
        "scope",
        [
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
            # Integration-skill frameworks
            "opentelemetry.instrumentation.openai_agents",
            "opentelemetry.instrumentation.openai_agents.sub",
            "traceloop.tracer",
            "@traceloop/node-server-sdk",
            # Mastra AI framework
            "@mastra/kubit",
            "@mastra/core",
            "@mastra/otel-exporter",
        ],
    )
    def test_matches(self, scope):
        assert is_known_llm_instrumentor(_span(scope)) is True

    def test_openai_still_matches_after_openai_agents_added(self):
        """Ensure the more specific `openai_agents` prefix does not shadow `openai`."""
        assert is_known_llm_instrumentor(_span("opentelemetry.instrumentation.openai")) is True
        assert (
            is_known_llm_instrumentor(_span("opentelemetry.instrumentation.openai.chat"))
            is True
        )

    @pytest.mark.parametrize(
        "scope",
        [
            "openinfer",                        # boundary — not a prefix
            "opentelemetry.instrumentation.fastapi",
            "opentelemetry.instrumentation.requests",
            "sqlalchemy",
            "my_framework",
            "",
        ],
    )
    def test_rejects(self, scope):
        assert is_known_llm_instrumentor(_span(scope)) is False


class TestMastraSpanFiltering:
    """Mastra-specific filter behaviour.

    Every Mastra-emitted span carries a ``mastra.span.type`` discriminator.
    The ``model_chunk`` value flags stream-coordination spans (payload always
    ``"{}"``); the default Kubit filter drops them on ingest.
    """

    KEEP_TYPES = [
        "agent_run",
        "workflow_run",
        "model_generation",
        "model_step",
        "processor_run",
        "tool_call",
        "mcp_tool_call",
        "generic",
    ]

    def test_is_mastra_internal_flags_only_model_chunk(self):
        assert is_mastra_internal_span(_span(attrs={"mastra.span.type": "model_chunk"})) is True
        for t in self.KEEP_TYPES:
            assert is_mastra_internal_span(_span(attrs={"mastra.span.type": t})) is False
        # Span without the discriminator at all
        assert is_mastra_internal_span(_span()) is False

    def test_default_export_drops_model_chunk_even_with_genai_attrs(self):
        assert (
            is_default_export_span(
                _span(
                    "@mastra/kubit",
                    attrs={
                        "mastra.span.type": "model_chunk",
                        "gen_ai.operation.name": "model_chunk",
                    },
                )
            )
            is False
        )

    @pytest.mark.parametrize("span_type", KEEP_TYPES)
    def test_default_export_keeps_other_mastra_spans(self, span_type):
        assert (
            is_default_export_span(
                _span(
                    "@mastra/kubit",
                    attrs={
                        "mastra.span.type": span_type,
                        "gen_ai.operation.name": span_type,
                    },
                )
            )
            is True
        )

    def test_scope_only_no_genai_attrs_passes_via_prefix_allow_list(self):
        # ``@mastra/kubit`` is in KNOWN_LLM_INSTRUMENTATION_SCOPE_PREFIXES;
        # the scope match alone is sufficient even without ``gen_ai.*`` attrs.
        span = _span("@mastra/kubit", attrs={"mastra.span.type": "generic"})
        # The MagicMock-based _span doesn't set a `name` attribute, so make
        # sure it stringifies to something safe for is_langgraph_internal_span.
        span.name = "agent.run"
        assert is_default_export_span(span) is True
