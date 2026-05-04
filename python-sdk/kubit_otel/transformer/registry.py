"""Registry of framework adapters in attribute-priority order.

Each adapter contributes its own alias tuples; ``core`` concatenates them at
import time to build the canonical ``MODEL_ATTRS``, ``INPUT_ATTRS``, … tuples.
The order here determines cross-framework priority when multiple emitters
set the same canonical field.

Ordering rationale:

1. ``otel_genai`` — the standard. Most specific, most authoritative.
2. ``openinference`` — large installed base (Arize Phoenix) with its own
   ``llm.*`` namespace; predates the OTel GenAI spec.
3. ``generic`` — short-name catch-alls (``model``, ``input``, ``output``)
   kept between OI and Langfuse to preserve pre-refactor priority.
4. ``langsmith`` — ``langsmith.*`` + token-detail JSON blobs.
5. ``langfuse`` — ``langfuse.*`` + usage/cost/params JSON blobs.
6. ``braintrust`` — ``braintrust.*`` JSON payloads + metrics.
7. ``traceloop`` — OpenLLMetry ``traceloop.*`` + underscore cache variant
   + indexed ``gen_ai.prompt.<n>.*`` legacy unpacking.
8. ``mastra`` — Mastra ``mastra.*`` namespace; per-span-type input/output
   keys + ``completion_start_time`` + ``modelMetadata`` blob. No
   discriminator hook — ``gen_ai.operation.name`` (set on every Mastra span)
   drives observation-type via ``otel_genai``.
9. ``vercel_ai`` — raw ``ai.*`` namespace (apps without the ai-sdk-otel-adapter).
10. ``openai_agents`` — reserved slot; agent keys live on ``otel_genai``.
11. ``logfire`` — ``logfire.tags`` + ``pydantic_ai.all_messages``.
"""

from __future__ import annotations

from .frameworks import (
    braintrust,
    generic,
    langfuse,
    langsmith,
    logfire,
    mastra,
    openai_agents,
    openinference,
    otel_genai,
    traceloop,
    vercel_ai,
)

FRAMEWORKS = (
    otel_genai,
    openinference,
    generic,
    langsmith,
    langfuse,
    braintrust,
    traceloop,
    mastra,
    vercel_ai,
    openai_agents,
    logfire,
)

# Observation-type discriminator priority is independent of FRAMEWORKS: when
# multiple emitters set a discriminator, the most specific wins regardless of
# alias-tuple ordering. Langfuse and Vercel keep top priority (explicit user
# intent / ``ai.operationId``); native vendor discriminators follow; OTel
# GenAI's ``gen_ai.operation.name`` is the standards fallback.
DISCRIMINATOR_ORDER = (
    langfuse,
    vercel_ai,
    openinference,
    langsmith,
    braintrust,
    traceloop,
    otel_genai,
)
