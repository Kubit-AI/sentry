"""OTel ReadableSpan → Kubit JSON record transformer.

Converts OpenTelemetry SDK ReadableSpan objects into flat JSON-serialisable
dicts matching the Kubit analytics schema.

Two entity types are produced:
  - ``trace``                 one per unique trace_id (from root spans)
  - ``enriched_observation``  one per span (including root spans)

Almost every span received is transformed. The two zero-payload framework
noise classes — Mastra ``mastra.span.type=model_chunk`` stream-coordination
spans and LangGraph Pregel ``ChannelWrite<...>`` / ``__start__`` /
``__end__`` spans — are dropped at the top of ``transform_spans`` so
consumers wrapping :class:`kubit_otel.exporter.KubitExporter` directly
inherit the drop. Broader scope/attribute filtering lives upstream in
:class:`kubit_otel.processor.KubitSpanProcessor` (see
:mod:`kubit_otel.span_filter`).

Framework-specific attribute mappings live under
``kubit_otel.transformer.frameworks.*`` as self-contained adapter modules.
``core`` consults each in registry order to build the canonical alias tuples,
parse JSON blobs, and resolve the observation type.
"""

from __future__ import annotations

from .core import transform_spans

__all__ = ["transform_spans"]
