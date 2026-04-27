"""Broad instrumentation-scope allow-list assertions.

Covers the full allow-list spanning openinference, langsmith, braintrust,
logfire, traceloop, the OpenLLMetry vendor family, OpenAI Agents, and
Vercel AI.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from kubit_otel.span_filter import is_known_llm_instrumentor


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
