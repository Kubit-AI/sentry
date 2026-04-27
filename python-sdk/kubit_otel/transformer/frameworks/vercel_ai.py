"""Vercel AI SDK (``ai.*`` namespace) attribute mappings.

Vercel emits its own ``ai.*`` telemetry alongside standard ``gen_ai.*``. The
``otel_genai`` adapter handles the ``gen_ai.*`` fields on ``ai.*.doGenerate`` /
``ai.*.doStream`` spans; this adapter covers the additional ``ai.*`` fields on
outer agent spans (``ai.generateText``, ``ai.streamText``, …) and tool spans
(``ai.toolCall``).

Includes provider normalisation (``amazon-bedrock.*`` → ``aws_bedrock``,
``anthropic.messages`` → ``anthropic``, …) via the ``resolve_provider`` hook.
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

INPUT_ATTRS = (
    "ai.prompt.messages",
    "ai.prompt",
    "ai.toolCall.args",
)
OUTPUT_ATTRS = (
    "ai.response.text",
    "ai.response.toolCalls",
    "ai.toolCall.result",
)

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
AGENT_NAME_ATTRS = ("ai.telemetry.functionId",)
AGENT_ID_ATTRS: tuple[str, ...] = ()
AGENT_VERSION_ATTRS: tuple[str, ...] = ()
TOOL_NAME_ATTRS = ("ai.toolCall.name",)
SYSTEM_INSTRUCTIONS_ATTRS: tuple[str, ...] = ()

CACHE_TOKEN_MAP: tuple[tuple[str, str], ...] = ()
PARAMS_BLOB_ATTRS: tuple[str, ...] = ()
FLAT_PARAM_ATTRS: tuple[str, ...] = ()

# Vercel has emitted both camelCase (``topP``, ``maxTokens``, …) and snake_case
# (``top_p``, ``max_tokens``, …) variants of ``ai.request.*`` across SDK versions.
# Accept both; first-non-null per canonical key wins.
_AI_REQUEST_PARAM_MAP = (
    ("ai.request.temperature", "temperature"),
    ("ai.request.topP", "top_p"),
    ("ai.request.top_p", "top_p"),
    ("ai.request.topK", "top_k"),
    ("ai.request.top_k", "top_k"),
    ("ai.request.maxTokens", "max_tokens"),
    ("ai.request.max_tokens", "max_tokens"),
    ("ai.request.frequencyPenalty", "frequency_penalty"),
    ("ai.request.frequency_penalty", "frequency_penalty"),
    ("ai.request.presencePenalty", "presence_penalty"),
    ("ai.request.presence_penalty", "presence_penalty"),
    ("ai.request.seed", "seed"),
    ("ai.request.stopSequences", "stop_sequences"),
    ("ai.request.stop_sequences", "stop_sequences"),
)

_PROVIDER_PREFIX_MAP = (
    ("amazon-bedrock", "aws_bedrock"),
    ("google-vertex", "vertex_ai"),
    ("google", "vertex_ai"),
    ("openai", "openai"),
    ("anthropic", "anthropic"),
    ("mistral", "mistral_ai"),
    ("cohere", "cohere"),
)


def _normalise_provider(raw: Any) -> Optional[str]:
    """Normalise a raw provider string to an OTel system id.

    Vercel emits values like ``openai.chat``, ``amazon-bedrock.claude-3-5``,
    ``anthropic.messages``. We take the portion before the first ``.`` and map
    it to the OTel ``gen_ai.system`` convention. Unknown prefixes pass through
    verbatim (lowercased).
    """
    if not isinstance(raw, str) or not raw:
        return None
    head = raw.split(".", 1)[0].strip().lower()
    for prefix, target in _PROVIDER_PREFIX_MAP:
        if head == prefix:
            return target
    return head or None


def resolve_observation_type(span_attrs: dict) -> str | None:
    op = span_attrs.get("ai.operationId")
    if not isinstance(op, str):
        return None
    if op == "ai.toolCall":
        return "TOOL"
    if op in ("ai.generateText", "ai.streamText"):
        return "AGENT"
    if op in ("ai.generateObject", "ai.streamObject"):
        return "AGENT"
    if op in ("ai.embed", "ai.embedMany"):
        return "EMBEDDING"
    # `.doGenerate` / `.doStream` fall through to otel_genai's `gen_ai.*` handling.
    return None


def resolve_provider(span_attrs: dict) -> Optional[str]:
    """Normalise Vercel-specific provider values.

    Only fires for Vercel-emitted spans (identified by ``ai.operationId``).
    Vercel puts dotted values like ``anthropic.messages`` into both
    ``ai.model.provider`` and ``gen_ai.system``; non-Vercel callers should fall
    through to the canonical PROVIDER_ATTRS chain undisturbed.
    """
    if not isinstance(span_attrs.get("ai.operationId"), str):
        return None
    return (
        _normalise_provider(span_attrs.get("ai.model.provider"))
        or _normalise_provider(span_attrs.get("gen_ai.system"))
    )


def build_params(span_attrs: dict, merged: dict[str, Any]) -> None:
    """Map ``ai.request.<camelCase|snake_case>`` attributes into ``merged`` using snake_case keys."""
    for src_attr, canonical_key in _AI_REQUEST_PARAM_MAP:
        val = span_attrs.get(src_attr)
        if val is None:
            continue
        if canonical_key not in merged:
            merged[canonical_key] = val
