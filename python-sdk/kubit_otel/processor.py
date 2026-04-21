"""
KubitSpanProcessor — drop-in OTel SpanProcessor for Kubit analytics.

    from kubit_otel import KubitSpanProcessor

    provider = TracerProvider()
    provider.add_span_processor(KubitSpanProcessor(api_key="rg.v1.xxx"))
"""

from __future__ import annotations

import logging
from typing import Optional

from opentelemetry.context import Context
from opentelemetry.sdk.trace import ReadableSpan, Span
from opentelemetry.sdk.trace.export import BatchSpanProcessor

from kubit_otel.exporter import KubitExporter
from kubit_otel.credentials import DEFAULT_TOKEN_ENDPOINT

logger = logging.getLogger(__name__)


class KubitSpanProcessor(BatchSpanProcessor):
    """
    OTel SpanProcessor that batches spans and exports them to Kubit.

    Usage::

        from opentelemetry.sdk.trace import TracerProvider
        from kubit_otel import KubitSpanProcessor

        provider = TracerProvider()
        provider.add_span_processor(
            KubitSpanProcessor(api_key="rg.v1.<payload>.<sig>")
        )

    This is equivalent to::

        provider.add_span_processor(
            BatchSpanProcessor(KubitExporter(api_key="rg.v1.xxx"))
        )

    Parameters
    ----------
    api_key : str
        Kubit API key.
    token_endpoint : str
        URL of the credential endpoint.
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
        logger.debug(
            "KubitSpanProcessor initialised  max_queue_size=%d "
            "schedule_delay_millis=%.0f max_export_batch_size=%d "
            "export_timeout_millis=%.0f",
            max_queue_size, schedule_delay_millis,
            max_export_batch_size, export_timeout_millis,
        )

    def shutdown(self) -> None:  # type: ignore[override]
        logger.debug("KubitSpanProcessor shutdown")
        super().shutdown()

    def force_flush(self, timeout_millis: int = 30000) -> bool:  # type: ignore[override]
        logger.debug(
            "KubitSpanProcessor force_flush  timeout_ms=%d", timeout_millis,
        )
        return super().force_flush(timeout_millis)
