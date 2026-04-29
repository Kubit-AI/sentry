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
        # Langfuse's default allow-list — kept for apps that instrument with
        # the Langfuse SDK or any of the upstream frameworks it supports.
        "langfuse-sdk",
        "agent_framework",
        "ai",                                      # Vercel AI SDK
        "haystack",
        "langsmith",
        "openinference",                           # Arize / OpenInference Python emitters
        "@arizeai/openinference",                  # OpenInference JS / npm emitters (parity with Node)
        "opentelemetry.instrumentation.anthropic",
        "strands-agents",
        "vllm",
        # Additional scopes this project's transformer aliases per CLAUDE.md
        # (Braintrust, Logfire, OpenLLMetry/Traceloop family, OpenAI Agents).
        "braintrust",
        "logfire",
        "opentelemetry.instrumentation.openai",
        "opentelemetry.instrumentation.bedrock",
        "opentelemetry.instrumentation.vertexai",
        "opentelemetry.instrumentation.google_generativeai",
        "opentelemetry.instrumentation.cohere",
        "opentelemetry.instrumentation.mistralai",
        "opentelemetry.instrumentation.groq",
        "opentelemetry.instrumentation.ollama",
        "opentelemetry.instrumentation.together",
        "opentelemetry.instrumentation.replicate",
        # OpenAI Agents SDK — opentelemetry-instrumentation-openai-agents-v2
        # emits under this scope. Trailing ``_agents`` keeps it distinct from
        # ``opentelemetry.instrumentation.openai``.
        "opentelemetry.instrumentation.openai_agents",
        # Traceloop / OpenLLMetry SDK workflow + task decorator spans.
        "traceloop.tracer",                        # Python SDK tracer name
        "@traceloop",                              # JS SDK package prefix (parity with Node)
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
    return (
        scope_name == prefix
        or scope_name.startswith(f"{prefix}.")
        or scope_name.startswith(f"{prefix}-")
        or scope_name.startswith(f"{prefix}/")
    )


def is_known_llm_instrumentor(span: ReadableSpan) -> bool:
    """Return whether the span's scope matches a known LLM instrumentor prefix."""
    if span.instrumentation_scope is None:
        return False
    scope_name = span.instrumentation_scope.name
    return any(
        _matches_scope_prefix(scope_name, prefix)
        for prefix in KNOWN_LLM_INSTRUMENTATION_SCOPE_PREFIXES
    )


def is_langgraph_internal_span(span: ReadableSpan) -> bool:
    """Return whether the span is a LangGraph Pregel runtime coordination span.

    LangGraph emits ``ChannelWrite<...>`` spans around every node transition
    plus ``__start__`` / ``__end__`` pseudo-nodes. They carry no LLM payload
    and Langfuse hides them at the UI layer; the default Kubit filter drops
    them on ingest so the trace tree matches Langfuse's view.
    """
    name = getattr(span, "name", None)
    if not isinstance(name, str):
        return False
    return name.startswith("ChannelWrite") or name in ("__start__", "__end__")


def is_default_export_span(span: ReadableSpan) -> bool:
    """Default Kubit export predicate — keeps LLM-relevant spans only."""
    if is_langgraph_internal_span(span):
        return False
    return (
        is_kubit_span(span)
        or is_genai_span(span)
        or is_known_llm_instrumentor(span)
    )
