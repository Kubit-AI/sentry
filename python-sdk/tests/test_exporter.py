"""Tests for :class:`kubit_otel.exporter.KubitExporter`."""

from __future__ import annotations

import logging
from unittest.mock import patch

import pytest

from opentelemetry.sdk.trace.export import SpanExportResult


DEFAULT_URL = "https://otel.kubit.ai/v1/traces"


@pytest.fixture
def clean_otlp_env(monkeypatch):
    """Clear endpoint-related env vars so each test starts from a known state."""
    monkeypatch.delenv("KUBIT_OTEL_ENDPOINT", raising=False)


@pytest.fixture
def propagating_logger(monkeypatch):
    """
    Re-enable propagation on the ``kubit_otel`` logger for the test duration so
    pytest's ``caplog`` (which attaches to root) can capture records. The
    package installs the logger with ``propagate=False`` to avoid double-logging
    when apps configure root logging.
    """
    lg = logging.getLogger("kubit_otel")
    monkeypatch.setattr(lg, "propagate", True)


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

    def test_standard_otlp_env_vars_are_ignored(self, clean_otlp_env, monkeypatch):
        # The standard OTel OTLP env vars are intentionally NOT consulted —
        # they are process-wide and would silently redirect Kubit traces if
        # another OTel-based SDK in the same process sets them.
        monkeypatch.setenv(
            "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "https://otel.example/v1/traces"
        )
        monkeypatch.setenv(
            "OTEL_EXPORTER_OTLP_ENDPOINT", "https://otel-base.example/v1/traces"
        )
        from kubit_otel.exporter import KubitExporter

        with patch("kubit_otel.exporter.OTLPSpanExporter") as mock_otlp:
            KubitExporter(api_key="rg.v1.x.y")

        assert mock_otlp.call_args.kwargs["endpoint"] == DEFAULT_URL


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


class TestExportLogging:
    def test_logs_debug_with_span_count_on_success(
        self, clean_otlp_env, propagating_logger, caplog
    ):
        from kubit_otel.exporter import KubitExporter

        with patch("kubit_otel.exporter.OTLPSpanExporter") as mock_cls:
            mock_cls.return_value.export.return_value = SpanExportResult.SUCCESS
            ex = KubitExporter(api_key="rg.v1.x.y")

            with caplog.at_level(logging.DEBUG, logger="kubit_otel"):
                ex.export([object(), object()])

        records = [r for r in caplog.records if r.name == "kubit_otel.exporter"]
        assert any(
            r.levelno == logging.DEBUG and "span_count=2" in r.getMessage()
            for r in records
        ), records

    def test_logs_warning_on_failure(
        self, clean_otlp_env, propagating_logger, caplog
    ):
        from kubit_otel.exporter import KubitExporter

        with patch("kubit_otel.exporter.OTLPSpanExporter") as mock_cls:
            mock_cls.return_value.export.return_value = SpanExportResult.FAILURE
            ex = KubitExporter(api_key="rg.v1.x.y")

            with caplog.at_level(logging.WARNING, logger="kubit_otel"):
                ex.export([object()])

        records = [r for r in caplog.records if r.name == "kubit_otel.exporter"]
        assert any(
            r.levelno == logging.WARNING and "span_count=1" in r.getMessage()
            for r in records
        ), records
