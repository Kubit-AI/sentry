"""
KubitSpanProcessor — drop-in OTel SpanProcessor for Kubit analytics.

    from kubit_otel import KubitSpanProcessor

    provider = TracerProvider()
    provider.add_span_processor(KubitSpanProcessor(api_key="rg.v1.xxx"))
"""

from __future__ import annotations

import logging
from typing import Optional

from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.sdk.trace.export import BatchSpanProcessor

from kubit_otel.exporter import KubitExporter
from kubit_otel.credentials import DEFAULT_TOKEN_ENDPOINT
from kubit_otel.span_filter import (
    ShouldExportSpan,
    is_default_export_span,
)

logger = logging.getLogger(__name__)


class KubitSpanProcessor(BatchSpanProcessor):
    """
    OTel SpanProcessor that batches spans and exports them to Kubit.

    By default, only LLM-relevant spans are forwarded — spans created by the
    Kubit SDK, spans carrying a ``gen_ai.*`` attribute, and spans from known
    LLM instrumentation scopes (Langfuse, Vercel AI SDK, …). Override via
    ``should_export_span``.

    Parameters
    ----------
    api_key : str
        Kubit API key.
    token_endpoint : str
        URL of the credential endpoint.
    should_export_span : callable, optional
        Predicate ``(span: ReadableSpan) -> bool``. Spans for which it returns
        ``False`` are dropped before they reach the batch queue. Defaults to
        :func:`kubit_otel.span_filter.is_default_export_span`. Pass
        ``lambda _s: True`` to disable filtering.
    max_queue_size : int
        Maximum queue size (default: 2048).
    schedule_delay_millis : float
        Delay between export batches in milliseconds (default: 5000).
    max_export_batch_size : int
        Maximum batch size per export (default: 512).
    export_timeout_millis : float
        Timeout for each export call (default: 30000).
    """

    def __init__(
        self,
        api_key: str,
        token_endpoint: str = DEFAULT_TOKEN_ENDPOINT,
        should_export_span: Optional[ShouldExportSpan] = None,
        max_queue_size: int = 2048,
        schedule_delay_millis: float = 5000,
        max_export_batch_size: int = 512,
        export_timeout_millis: float = 30000,
    ) -> None:
        exporter = KubitExporter(
            api_key=api_key,
            token_endpoint=token_endpoint,
        )
        super().__init__(
            span_exporter=exporter,
            max_queue_size=max_queue_size,
            schedule_delay_millis=schedule_delay_millis,
            max_export_batch_size=max_export_batch_size,
            export_timeout_millis=export_timeout_millis,
        )
        self._should_export_span: ShouldExportSpan = (
            should_export_span if should_export_span is not None else is_default_export_span
        )
        logger.debug(
            "KubitSpanProcessor initialised  max_queue_size=%d "
            "schedule_delay_millis=%.0f max_export_batch_size=%d "
            "export_timeout_millis=%.0f should_export_span=%s",
            max_queue_size, schedule_delay_millis,
            max_export_batch_size, export_timeout_millis,
            getattr(self._should_export_span, "__name__", repr(self._should_export_span)),
        )

    def on_end(self, span: ReadableSpan) -> None:  # type: ignore[override]
        try:
            keep = bool(self._should_export_span(span))
        except Exception as exc:
            scope_name = (
                span.instrumentation_scope.name
                if span.instrumentation_scope is not None
                else None
            )
            logger.debug(
                "should_export_span raised; dropping span  span_name=%s scope=%s err=%s",
                span.name, scope_name, exc,
            )
            return
        if not keep:
            scope_name = (
                span.instrumentation_scope.name
                if span.instrumentation_scope is not None
                else None
            )
            logger.debug(
                "Dropped span due to should_export_span filter  span_name=%s scope=%s",
                span.name, scope_name,
            )
            return
        super().on_end(span)

    def shutdown(self) -> None:  # type: ignore[override]
        logger.debug("KubitSpanProcessor shutdown")
        super().shutdown()

    def force_flush(self, timeout_millis: int = 30000) -> bool:  # type: ignore[override]
        logger.debug(
            "KubitSpanProcessor force_flush  timeout_ms=%d", timeout_millis,
        )
        return super().force_flush(timeout_millis)
