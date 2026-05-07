"""
KubitExporter — OpenTelemetry SpanExporter for Kubit analytics.

Thin wrapper around the stock OTLP/HTTP protobuf span exporter, preconfigured
to point at the Kubit collector and inject the ``x-api-key`` header. Cylon
(the server-side collector) handles span normalization and downstream fan-out.
"""

from __future__ import annotations

import logging
import os
from typing import Optional, Sequence
from urllib.parse import urlparse

from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.sdk.trace.export import SpanExporter, SpanExportResult

logger = logging.getLogger(__name__)

DEFAULT_ENDPOINT = "https://kubit-ingest.kubit.ai/v1/traces"
KUBIT_OTEL_ENDPOINT_ENV = "KUBIT_OTEL_ENDPOINT"


def _resolve_endpoint(explicit: Optional[str]) -> Optional[str]:
    """
    Resolve the trace endpoint URL.

    Precedence (first non-empty wins):
        1. explicit ``endpoint`` arg
        2. ``KUBIT_OTEL_ENDPOINT`` env var
        3. ``None`` — let ``OTLPSpanExporter`` honour
           ``OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`` /
           ``OTEL_EXPORTER_OTLP_ENDPOINT``; if neither is set, fall back to
           Kubit's default below.
    """
    if explicit:
        return explicit
    env = os.environ.get(KUBIT_OTEL_ENDPOINT_ENV)
    if env:
        return env
    if any(
        os.environ.get(k)
        for k in ("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "OTEL_EXPORTER_OTLP_ENDPOINT")
    ):
        return None
    return DEFAULT_ENDPOINT


def _redact_endpoint(url: str) -> str:
    try:
        parsed = urlparse(url)
        if parsed.scheme and parsed.netloc:
            return f"{parsed.scheme}://{parsed.netloc}"
    except Exception:
        pass
    return "<unparseable>"


class KubitExporter(SpanExporter):
    """
    OpenTelemetry SpanExporter that ships spans to Kubit via OTLP/HTTP.

    Parameters
    ----------
    api_key : str
        Kubit API key (``rg.v1.<payload>.<sig>``). Sent in the ``x-api-key``
        request header on every batch.
    endpoint : str, optional
        Full trace endpoint URL. Resolution precedence: explicit arg →
        ``KUBIT_OTEL_ENDPOINT`` env → ``OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`` /
        ``OTEL_EXPORTER_OTLP_ENDPOINT`` → built-in default
        ``https://kubit-ingest.kubit.ai/v1/traces``.
    """

    def __init__(
        self,
        api_key: str,
        *,
        endpoint: Optional[str] = None,
    ) -> None:
        url = _resolve_endpoint(endpoint)
        kwargs = {"headers": {"x-api-key": api_key}}
        if url is not None:
            kwargs["endpoint"] = url
        self._inner = OTLPSpanExporter(**kwargs)
        log_target = url or "<from OTEL_EXPORTER_OTLP_*>"
        logger.debug(
            "KubitExporter initialised  endpoint=%s", _redact_endpoint(log_target),
        )

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        return self._inner.export(spans)

    def shutdown(self) -> None:
        logger.debug("KubitExporter shutdown")
        self._inner.shutdown()

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        logger.debug("force_flush called  timeout_ms=%d", timeout_millis)
        return self._inner.force_flush(timeout_millis)
