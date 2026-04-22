"""Vercel AI SDK (``ai.*`` namespace) attribute mappings.

Vercel emits its own ``ai.*`` telemetry that is incompatible with native
GenAI visualisers. The ``ai-sdk-otel-adapter`` translates these to
``gen_ai.*`` at the Node layer, but apps that ship raw Vercel telemetry
without the adapter still reach us. This module maps the raw keys.

Includes provider normalisation: Vercel prefixes providers with the SDK name
(e.g. ``openai.chat``, ``amazon-bedrock.claude-3``). We normalise to the
OTel-standard provider id.
"""

from __future__ import annotations

from typing import Any, Optional

NAME = "vercel_ai"

MODEL_ATTRS = (
    "ai.response.model",
    "ai.model.id",
    "ai.model",
)
PROVIDED_MODEL_ATTRS = (
    "ai.model.id",
    "ai.model",
)
INPUT_ATTRS = ("ai.prompt",)
OUTPUT_ATTRS = ("ai.response",)

INPUT_TOKENS_ATTRS = ("ai.usage.promptTokens",)
OUTPUT_TOKENS_ATTRS = ("ai.usage.completionTokens",)
TOTAL_TOKENS_ATTRS: tuple[str, ...] = ()

INPUT_COST_ATTRS: tuple[str, ...] = ()
OUTPUT_COST_ATTRS: tuple[str, ...] = ()
TOTAL_COST_ATTRS: tuple[str, ...] = ()

SESSION_ID_ATTRS: tuple[str, ...] = ()
USER_ID_ATTRS: tuple[str, ...] = ()
TAGS_ATTRS: tuple[str, ...] = ()

TIME_TO_FIRST_TOKEN_ATTRS: tuple[str, ...] = ()
TOOL_CALLS_ATTRS: tuple[str, ...] = ()
TOOL_CALL_NAMES_ATTRS: tuple[str, ...] = ()
TOOL_DEFINITIONS_ATTRS: tuple[str, ...] = ()

PROVIDER_ATTRS = ("ai.model.provider",)
AGENT_NAME_ATTRS: tuple[str, ...] = ()
AGENT_ID_ATTRS: tuple[str, ...] = ()
AGENT_VERSION_ATTRS: tuple[str, ...] = ()
TOOL_NAME_ATTRS: tuple[str, ...] = ()
SYSTEM_INSTRUCTIONS_ATTRS: tuple[str, ...] = ()

CACHE_TOKEN_MAP: tuple[tuple[str, str], ...] = ()
PARAMS_BLOB_ATTRS: tuple[str, ...] = ()

# Vercel AI SDK request-parameter camelCase → snake_case remap. Mirrors what
# the ``ai-sdk-otel-adapter`` does before re-emitting as gen_ai.request.*.
AI_REQUEST_PARAM_MAP = (
    ("ai.request.temperature", "temperature"),
    ("ai.request.topP", "top_p"),
    ("ai.request.topK", "top_k"),
    ("ai.request.maxTokens", "max_tokens"),
    ("ai.request.frequencyPenalty", "frequency_penalty"),
    ("ai.request.presencePenalty", "presence_penalty"),
    ("ai.request.seed", "seed"),
    ("ai.request.stopSequences", "stop_sequences"),
)

# Kept empty — ``gen_ai.request.*`` flat slicing doesn't apply to ``ai.*``.
FLAT_PARAM_ATTRS: tuple[str, ...] = ()

_PROVIDER_PREFIX_MAP = (
    ("amazon-bedrock", "aws_bedrock"),
    ("google-vertex", "vertex_ai"),
    ("google", "vertex_ai"),
    ("openai", "openai"),
    ("anthropic", "anthropic"),
    ("mistral", "mistral_ai"),
    ("cohere", "cohere"),
)


def normalise_provider(raw: Any) -> Optional[str]:
    """Normalise a raw ``ai.model.provider`` string to an OTel system id.

    Vercel emits values like ``openai.chat``, ``amazon-bedrock.claude-3-5``.
    We take the portion before the first ``.`` and map it to the OTel
    ``gen_ai.system`` convention. Unknown prefixes pass through verbatim.
    """
    if not isinstance(raw, str) or not raw:
        return None
    head = raw.split(".", 1)[0].strip().lower()
    for prefix, target in _PROVIDER_PREFIX_MAP:
        if head == prefix:
            return target
    return head or None


def build_params(span_attrs: dict, merged: dict[str, Any]) -> None:
    """Map ``ai.request.<camelCase>`` attributes into ``merged`` using snake_case keys."""
    for src_attr, canonical_key in AI_REQUEST_PARAM_MAP:
        val = span_attrs.get(src_attr)
        if val is None:
            continue
        if canonical_key not in merged:
            merged[canonical_key] = val
