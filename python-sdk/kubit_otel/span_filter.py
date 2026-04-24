"""
Span filter predicates for controlling which OTel spans ship to Kubit.

The default predicate :func:`is_default_export_span` keeps only LLM-relevant
spans:

  * spans created by the Kubit SDK tracer (``kubit-sdk``)
  * spans carrying any ``gen_ai.*`` semantic-convention attribute
  * spans whose instrumentation-scope name matches a known LLM instrumentor
    prefix (see :data:`KNOWN_LLM_INSTRUMENTATION_SCOPE_PREFIXES`)

Consumers can compose their own rule::

    from kubit_otel import KubitSpanProcessor
    from kubit_otel.span_filter import is_default_export_span

    provider.add_span_processor(KubitSpanProcessor(
        api_key="rg.v1.xxx",
        should_export_span=lambda span: (
            is_default_export_span(span)
            or (span.instrumentation_scope is not None
                and span.instrumentation_scope.name.startswith("my_framework"))
        ),
    ))

Or disable filtering entirely::

    KubitSpanProcessor(api_key="rg.v1.xxx", should_export_span=lambda _span: True)
"""

from __future__ import annotations

from typing import Callable

from opentelemetry.sdk.trace import ReadableSpan

KUBIT_TRACER_NAME = "kubit-sdk"

ShouldExportSpan = Callable[[ReadableSpan], bool]

KNOWN_LLM_INSTRUMENTATION_SCOPE_PREFIXES = frozenset(
    {
        KUBIT_TRACER_NAME,
        "langfuse-sdk",
    }
)


def is_kubit_span(span: ReadableSpan) -> bool:
    """Return whether the span was created by the Kubit SDK tracer."""
    return (
        span.instrumentation_scope is not None
        and span.instrumentation_scope.name == KUBIT_TRACER_NAME
    )


def is_genai_span(span: ReadableSpan) -> bool:
    """Return whether the span has any ``gen_ai.*`` semantic-convention attribute."""
    if span.attributes is None:
        return False
    return any(
        isinstance(key, str) and key.startswith("gen_ai.")
        for key in span.attributes.keys()
    )


def _matches_scope_prefix(scope_name: str, prefix: str) -> bool:
    return scope_name == prefix or scope_name.startswith(f"{prefix}.")


def is_known_llm_instrumentor(span: ReadableSpan) -> bool:
    """Return whether the span's scope matches a known LLM instrumentor prefix."""
    if span.instrumentation_scope is None:
        return False
    scope_name = span.instrumentation_scope.name
    return any(
        _matches_scope_prefix(scope_name, prefix)
        for prefix in KNOWN_LLM_INSTRUMENTATION_SCOPE_PREFIXES
    )


def is_default_export_span(span: ReadableSpan) -> bool:
    """Default Kubit export predicate — keeps LLM-relevant spans only."""
    return (
        is_kubit_span(span)
        or is_genai_span(span)
        or is_known_llm_instrumentor(span)
    )
