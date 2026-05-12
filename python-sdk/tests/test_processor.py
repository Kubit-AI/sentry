"""Tests for :class:`kubit_otel.processor.KubitSpanProcessor` filtering."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from opentelemetry.sdk.trace.export import BatchSpanProcessor


@pytest.fixture
def clean_otlp_env(monkeypatch):
    monkeypatch.delenv("KUBIT_OTEL_ENDPOINT", raising=False)


def _silence_exporter():
    """Replace KubitExporter with a MagicMock so no real network exporter is wired."""
    return patch("kubit_otel.processor.KubitExporter", return_value=MagicMock())


def _make_span():
    span = MagicMock(name="span")
    span.name = "test-span"
    span.instrumentation_scope = None
    return span


class TestSpanFiltering:
    def test_should_export_span_false_drops_span(self, clean_otlp_env):
        from kubit_otel.processor import KubitSpanProcessor

        with _silence_exporter():
            proc = KubitSpanProcessor(
                api_key="rg.v1.x.y",
                should_export_span=lambda _s: False,
            )

        with patch.object(BatchSpanProcessor, "on_end") as super_end:
            proc.on_end(_make_span())

        super_end.assert_not_called()

    def test_should_export_span_true_passes_through(self, clean_otlp_env):
        from kubit_otel.processor import KubitSpanProcessor

        with _silence_exporter():
            proc = KubitSpanProcessor(
                api_key="rg.v1.x.y",
                should_export_span=lambda _s: True,
            )

        with patch.object(BatchSpanProcessor, "on_end") as super_end:
            proc.on_end(_make_span())

        super_end.assert_called_once()

    def test_predicate_exception_drops_span(self, clean_otlp_env):
        from kubit_otel.processor import KubitSpanProcessor

        def boom(_s):
            raise RuntimeError("kaboom")

        with _silence_exporter():
            proc = KubitSpanProcessor(api_key="rg.v1.x.y", should_export_span=boom)

        with patch.object(BatchSpanProcessor, "on_end") as super_end:
            proc.on_end(_make_span())

        super_end.assert_not_called()

    def test_default_filter_used_when_none_provided(self, clean_otlp_env):
        from kubit_otel.processor import KubitSpanProcessor
        from kubit_otel.span_filter import is_default_export_span

        with _silence_exporter():
            proc = KubitSpanProcessor(api_key="rg.v1.x.y")

        # Implementation detail: when no predicate is supplied, the processor
        # falls back to is_default_export_span. Pin that wiring so silent
        # default-changes show up in this test rather than only in production.
        assert proc._should_export_span is is_default_export_span


class TestKubitSdkIdentityStamping:
    def test_on_start_stamps_kubit_sdk_attrs(self, clean_otlp_env):
        # Provider whose Resource intentionally lacks kubit.sdk.* — mirrors a
        # user who assembles their own TracerProvider and just plugs
        # KubitSpanProcessor in via add_span_processor().
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider

        from kubit_otel._identity import _SDK_NAME, _sdk_version
        from kubit_otel.processor import KubitSpanProcessor

        provider = TracerProvider(
            resource=Resource.create({"service.name": "user-app"})
        )
        with _silence_exporter():
            provider.add_span_processor(KubitSpanProcessor(api_key="rg.v1.x.y"))

        tracer = provider.get_tracer("test")
        with tracer.start_as_current_span("op") as span:
            attrs = dict(span.attributes or {})

        assert attrs["kubit.sdk.name"] == _SDK_NAME
        assert attrs["kubit.sdk.version"] == _sdk_version()
