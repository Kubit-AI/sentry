"""Tests for :mod:`kubit_otel.span_filter` and processor-level filtering."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from kubit_otel.span_filter import (
    KNOWN_LLM_INSTRUMENTATION_SCOPE_PREFIXES,
    KUBIT_TRACER_NAME,
    is_default_export_span,
    is_genai_span,
    is_known_llm_instrumentor,
    is_kubit_span,
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


class TestIsKubitSpan:
    def test_matches_kubit_tracer(self):
        assert is_kubit_span(_span(KUBIT_TRACER_NAME)) is True

    def test_other_scope_is_false(self):
        assert is_kubit_span(_span("langfuse-sdk")) is False

    def test_null_scope_is_false(self):
        assert is_kubit_span(_span(None)) is False


class TestIsGenAISpan:
    def test_gen_ai_prefix(self):
        assert is_genai_span(_span(attrs={"gen_ai.request.model": "gpt-4"})) is True

    def test_non_genai_attrs(self):
        assert is_genai_span(_span(attrs={"http.method": "GET"})) is False

    def test_no_attrs(self):
        assert is_genai_span(_span()) is False

    def test_non_string_key_is_ignored(self):
        # defensive: attribute maps should be string-keyed, but don't crash
        assert is_genai_span(_span(attrs={42: "x"})) is False


class TestIsKnownLLMInstrumentor:
    @pytest.mark.parametrize(
        "scope",
        [
            "openinference",
            "openinference.instrumentation.openai",
            "langsmith",
            "litellm",
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

    def test_null_scope(self):
        assert is_known_llm_instrumentor(_span(None)) is False


class TestIsDefaultExportSpan:
    def test_true_if_kubit(self):
        assert is_default_export_span(_span(KUBIT_TRACER_NAME)) is True

    def test_true_if_genai_attr(self):
        # non-LLM scope but gen_ai attribute
        assert (
            is_default_export_span(
                _span("random_scope", {"gen_ai.request.model": "gpt-4"})
            )
            is True
        )

    def test_true_if_known_instrumentor(self):
        assert is_default_export_span(_span("openinference.instrumentation.openai")) is True

    def test_false_for_generic_span(self):
        assert (
            is_default_export_span(
                _span("opentelemetry.instrumentation.requests", {"http.method": "GET"})
            )
            is False
        )


def test_known_prefixes_contains_kubit():
    assert KUBIT_TRACER_NAME in KNOWN_LLM_INSTRUMENTATION_SCOPE_PREFIXES


class TestProcessorFiltering:
    """Integration: KubitSpanProcessor.on_end drops based on predicate."""

    def _make_processor(self, should_export_span=None):
        # Patch KubitExporter so the processor can be built without credentials.
        with patch("kubit_otel.processor.KubitExporter") as exporter_cls:
            exporter_cls.return_value = MagicMock()
            from kubit_otel.processor import KubitSpanProcessor
            return KubitSpanProcessor(
                api_key="rg.v1.x.y",
                should_export_span=should_export_span,
            )

    def test_drops_span_when_predicate_false(self):
        proc = self._make_processor(should_export_span=lambda _s: False)
        span = _span("openinference")
        span.name = "chat"
        with patch.object(
            type(proc).__mro__[1], "on_end"
        ) as parent_on_end:  # BatchSpanProcessor.on_end
            proc.on_end(span)
            parent_on_end.assert_not_called()

    def test_forwards_span_when_predicate_true(self):
        proc = self._make_processor(should_export_span=lambda _s: True)
        span = _span("openinference")
        span.name = "chat"
        with patch.object(
            type(proc).__mro__[1], "on_end"
        ) as parent_on_end:
            proc.on_end(span)
            parent_on_end.assert_called_once_with(span)

    def test_drops_when_predicate_raises(self):
        def boom(_s):
            raise RuntimeError("predicate exploded")

        proc = self._make_processor(should_export_span=boom)
        span = _span("openinference")
        span.name = "chat"
        with patch.object(
            type(proc).__mro__[1], "on_end"
        ) as parent_on_end:
            proc.on_end(span)
            parent_on_end.assert_not_called()

    def test_default_filter_is_llm_only(self):
        proc = self._make_processor()  # default predicate
        llm_span = _span("openinference", {})
        llm_span.name = "chat"
        http_span = _span("opentelemetry.instrumentation.requests", {"http.method": "GET"})
        http_span.name = "GET /foo"
        with patch.object(
            type(proc).__mro__[1], "on_end"
        ) as parent_on_end:
            proc.on_end(llm_span)
            proc.on_end(http_span)
            parent_on_end.assert_called_once_with(llm_span)
