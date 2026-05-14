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

DEFAULT_ENDPOINT = "https://otel.kubit.ai/v1/traces"
KUBIT_OTEL_ENDPOINT_ENV = "KUBIT_OTEL_ENDPOINT"


def _resolve_endpoint(explicit: Optional[str]) -> str:
    """
    Resolve the trace endpoint URL.

    Precedence (first non-empty wins):
        1. explicit ``endpoint`` arg
        2. ``KUBIT_OTEL_ENDPOINT`` env var
        3. built-in default (``DEFAULT_ENDPOINT``).

    The standard ``OTEL_EXPORTER_OTLP_*`` env vars are intentionally **not**
    honoured — they are process-wide and would silently redirect Kubit
    traces if another OTel-based SDK in the same process sets them.
    """
    if explicit:
        return explicit
    env = os.environ.get(KUBIT_OTEL_ENDPOINT_ENV)
    if env:
        return env
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
        ``KUBIT_OTEL_ENDPOINT`` env → built-in default
        ``https://otel.kubit.ai/v1/traces``. The standard
        ``OTEL_EXPORTER_OTLP_*`` env vars are not consulted.

    Notes
    -----
    The default span filter (:func:`kubit_otel.span_filter.is_default_export_span`)
    and the user-supplied ``mask`` hook both live in
    :class:`kubit_otel.KubitSpanProcessor`, not here. Consumers who wrap this
    exporter in their own ``SpanProcessor`` must compose the filter and mask
    themselves; otherwise un-filtered, un-masked spans will ship.
    """

    def __init__(
        self,
        api_key: str,
        *,
        endpoint: Optional[str] = None,
    ) -> None:
        url = _resolve_endpoint(endpoint)
        self._inner = OTLPSpanExporter(
            endpoint=url,
            headers={"x-api-key": api_key},
        )
        logger.debug(
            "KubitExporter initialised  endpoint=%s", _redact_endpoint(url),
        )

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        result = self._inner.export(spans)
        span_count = len(spans)
        if result == SpanExportResult.SUCCESS:
            logger.debug("Exported batch to kubit  span_count=%d", span_count)
        else:
            logger.warning(
                "KubitExporter export failed  span_count=%d", span_count,
            )
        return result

    def shutdown(self) -> None:
        logger.debug("KubitExporter shutdown")
        self._inner.shutdown()

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        logger.debug("force_flush called  timeout_ms=%d", timeout_millis)
        return self._inner.force_flush(timeout_millis)
