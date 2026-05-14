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

from kubit_otel._identity import _SDK_NAME, _sdk_version
from kubit_otel.exporter import KubitExporter
from kubit_otel.mask import MaskSpan
from kubit_otel.span_filter import (
    ShouldExportSpan,
    is_default_export_span,
)

logger = logging.getLogger(__name__)


def _format_span_id(span: ReadableSpan) -> str:
    ctx = getattr(span, "context", None)
    sid = getattr(ctx, "span_id", None)
    if isinstance(sid, int):
        return format(sid, "016x")
    return "-"


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
    endpoint : str, optional
        Trace endpoint URL. See :class:`kubit_otel.exporter.KubitExporter`
        for resolution precedence.
    should_export_span : callable, optional
        Predicate ``(span: ReadableSpan) -> bool``. Spans for which it returns
        ``False`` are dropped before they reach the batch queue. Defaults to
        :func:`kubit_otel.span_filter.is_default_export_span`. Pass
        ``lambda _s: True`` to disable filtering.
    mask : callable, optional
        Sync function ``(span: ReadableSpan) -> ReadableSpan`` that runs after
        ``should_export_span`` and before the batch queue. Use it together with
        the helpers in :mod:`kubit_otel.mask` to redact sensitive content from
        span attributes and events. If ``mask`` raises, the span is dropped
        (fail-closed). See :mod:`kubit_otel.mask` for the full contract.
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
        endpoint: Optional[str] = None,
        should_export_span: Optional[ShouldExportSpan] = None,
        mask: Optional[MaskSpan] = None,
        max_queue_size: int = 2048,
        schedule_delay_millis: float = 5000,
        max_export_batch_size: int = 512,
        export_timeout_millis: float = 30000,
    ) -> None:
        exporter = KubitExporter(
            api_key=api_key,
            endpoint=endpoint,
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
        self._mask: Optional[MaskSpan] = mask
        # Cache identity once; ``_sdk_version`` reaches into importlib.metadata
        # and we don't want to pay that on every span start.
        self._sdk_name = _SDK_NAME
        self._sdk_version = _sdk_version()
        logger.debug(
            "KubitSpanProcessor initialised  max_queue_size=%d "
            "schedule_delay_millis=%.0f max_export_batch_size=%d "
            "export_timeout_millis=%.0f should_export_span=%s mask=%s",
            max_queue_size, schedule_delay_millis,
            max_export_batch_size, export_timeout_millis,
            getattr(self._should_export_span, "__name__", repr(self._should_export_span)),
            "custom" if mask is not None else "none",
        )

    def on_start(  # type: ignore[override]
        self, span: Span, parent_context: Optional[Context] = None,
    ) -> None:
        # Stamp Kubit SDK identity on every span so it survives even when a
        # user constructs their TracerProvider's Resource without going through
        # ``configure()`` / ``_build_resource()``. Cylon lifts these two keys
        # into the observation ``metadata``.
        super().on_start(span, parent_context)
        span.set_attribute("kubit.sdk.name", self._sdk_name)
        span.set_attribute("kubit.sdk.version", self._sdk_version)

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
        if self._mask is not None:
            try:
                masked = self._mask(span)
            except Exception as exc:
                # Fail-closed: a mask that raises must never leak un-masked
                # data. Drop the span and surface the error in logs.
                logger.error(
                    "mask raised; dropping span  span_name=%s span_id=%s err=%s",
                    span.name,
                    _format_span_id(span),
                    exc,
                )
                return
            if masked is None:
                logger.error(
                    "mask returned None; dropping span (use should_export_span to filter)  "
                    "span_name=%s",
                    span.name,
                )
                return
            span = masked
        # Re-stamp SDK identity on every path. With a mask we overwrite (an
        # aggressive mask might have stripped the keys); without a mask we
        # fill-if-missing — covers bridge exporters that synthesize a
        # ReadableSpan and call ``on_end`` directly without going through
        # ``on_start``. Cylon's per-SDK identification rides on these keys.
        self._stamp_kubit_sdk_identity(span, force=self._mask is not None)
        super().on_end(span)

    def _stamp_kubit_sdk_identity(self, span: ReadableSpan, force: bool) -> None:
        """
        Stamp ``kubit.sdk.{name,version}`` on the span.

        ``force=True`` overwrites unconditionally — used on the mask path so an
        overzealous user mask cannot strip Cylon's per-SDK identification keys.
        ``force=False`` fills only if absent — used on the no-mask path to
        cover bridge exporters that synthesize a ReadableSpan and call
        ``on_end`` directly without going through ``on_start``.
        """
        attrs = getattr(span, "_attributes", None)
        if attrs is None:
            attrs = {}
            span._attributes = attrs  # type: ignore[attr-defined]
        try:
            if force or "kubit.sdk.name" not in attrs:  # type: ignore[operator]
                attrs["kubit.sdk.name"] = self._sdk_name  # type: ignore[index]
            if force or "kubit.sdk.version" not in attrs:  # type: ignore[operator]
                attrs["kubit.sdk.version"] = self._sdk_version  # type: ignore[index]
        except Exception:
            merged = dict(attrs)  # type: ignore[arg-type]
            if force or "kubit.sdk.name" not in merged:
                merged["kubit.sdk.name"] = self._sdk_name
            if force or "kubit.sdk.version" not in merged:
                merged["kubit.sdk.version"] = self._sdk_version
            span._attributes = merged  # type: ignore[attr-defined]

    def shutdown(self) -> None:  # type: ignore[override]
        logger.debug("KubitSpanProcessor shutdown")
        super().shutdown()

    def force_flush(self, timeout_millis: int = 30000) -> bool:  # type: ignore[override]
        logger.debug(
            "KubitSpanProcessor force_flush  timeout_ms=%d", timeout_millis,
        )
        return super().force_flush(timeout_millis)
