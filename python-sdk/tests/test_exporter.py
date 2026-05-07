"""Tests for :class:`kubit_otel.exporter.KubitExporter`."""

from __future__ import annotations

from unittest.mock import patch

import pytest


DEFAULT_URL = "https://kubit-ingest.kubit.ai/v1/traces"


@pytest.fixture
def clean_otlp_env(monkeypatch):
    """Clear all endpoint-related env vars so each test starts from a known state."""
    for key in (
        "KUBIT_OTEL_ENDPOINT",
        "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
        "OTEL_EXPORTER_OTLP_ENDPOINT",
    ):
        monkeypatch.delenv(key, raising=False)


class TestEndpointResolution:
    def test_default_endpoint_when_nothing_set(self, clean_otlp_env):
        from kubit_otel.exporter import KubitExporter

        with patch("kubit_otel.exporter.OTLPSpanExporter") as mock_otlp:
            KubitExporter(api_key="rg.v1.x.y")

        kwargs = mock_otlp.call_args.kwargs
        assert kwargs["endpoint"] == DEFAULT_URL
        assert kwargs["headers"] == {"x-api-key": "rg.v1.x.y"}

    def test_explicit_endpoint_beats_env(self, clean_otlp_env, monkeypatch):
        monkeypatch.setenv("KUBIT_OTEL_ENDPOINT", "https://env.example/v1/traces")
        from kubit_otel.exporter import KubitExporter

        with patch("kubit_otel.exporter.OTLPSpanExporter") as mock_otlp:
            KubitExporter(
                api_key="rg.v1.x.y", endpoint="https://explicit.example/v1/traces"
            )

        assert mock_otlp.call_args.kwargs["endpoint"] == "https://explicit.example/v1/traces"

    def test_kubit_env_used_when_no_explicit(self, clean_otlp_env, monkeypatch):
        monkeypatch.setenv("KUBIT_OTEL_ENDPOINT", "https://env.example/v1/traces")
        from kubit_otel.exporter import KubitExporter

        with patch("kubit_otel.exporter.OTLPSpanExporter") as mock_otlp:
            KubitExporter(api_key="rg.v1.x.y")

        assert mock_otlp.call_args.kwargs["endpoint"] == "https://env.example/v1/traces"

    def test_otel_env_skips_our_default(self, clean_otlp_env, monkeypatch):
        monkeypatch.setenv(
            "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "https://otel.example/v1/traces"
        )
        from kubit_otel.exporter import KubitExporter

        with patch("kubit_otel.exporter.OTLPSpanExporter") as mock_otlp:
            KubitExporter(api_key="rg.v1.x.y")

        # No explicit endpoint passed — let the underlying OTLP exporter resolve it.
        assert "endpoint" not in mock_otlp.call_args.kwargs
        assert mock_otlp.call_args.kwargs["headers"] == {"x-api-key": "rg.v1.x.y"}


class TestDelegation:
    def test_export_delegates(self, clean_otlp_env):
        from kubit_otel.exporter import KubitExporter

        with patch("kubit_otel.exporter.OTLPSpanExporter") as mock_cls:
            instance = mock_cls.return_value
            instance.export.return_value = "RESULT"
            ex = KubitExporter(api_key="rg.v1.x.y")

        spans = [object(), object()]
        result = ex.export(spans)
        instance.export.assert_called_once_with(spans)
        assert result == "RESULT"

    def test_shutdown_delegates(self, clean_otlp_env):
        from kubit_otel.exporter import KubitExporter

        with patch("kubit_otel.exporter.OTLPSpanExporter") as mock_cls:
            instance = mock_cls.return_value
            ex = KubitExporter(api_key="rg.v1.x.y")

        ex.shutdown()
        instance.shutdown.assert_called_once()

    def test_force_flush_delegates(self, clean_otlp_env):
        from kubit_otel.exporter import KubitExporter

        with patch("kubit_otel.exporter.OTLPSpanExporter") as mock_cls:
            instance = mock_cls.return_value
            instance.force_flush.return_value = True
            ex = KubitExporter(api_key="rg.v1.x.y")

        assert ex.force_flush(timeout_millis=1234) is True
        instance.force_flush.assert_called_once_with(1234)
