"""OpenTelemetry GenAI semantic-convention attribute mappings.

The authoritative standard. Covers both modern (2025+) `gen_ai.input.messages`
array form and the legacy `gen_ai.prompt`/`gen_ai.completion` indexed form
still emitted by several vendors.

Also hosts the `gen_ai.agent.*` and `gen_ai.tool.*` families used by
OpenAI-Agents instrumentation, and `gen_ai.system_instructions` emitted by
Logfire v2.
"""

from __future__ import annotations

from typing import Any

from ..helpers import clean_discriminator

NAME = "otel_genai"

MODEL_ATTRS = (
    "gen_ai.response.model",
    "gen_ai.request.model",
)
PROVIDED_MODEL_ATTRS = ("gen_ai.request.model",)

INPUT_ATTRS = (
    "gen_ai.input.messages",        # modern, preferred
    "gen_ai.prompt",                # legacy — LangSmith still emits this
    "gen_ai.content.prompt",
)
OUTPUT_ATTRS = (
    "gen_ai.output.messages",
    "gen_ai.completion",
    "gen_ai.content.completion",
)

INPUT_TOKENS_ATTRS = (
    "gen_ai.usage.input_tokens",
    "gen_ai.usage.prompt_tokens",
)
OUTPUT_TOKENS_ATTRS = (
    "gen_ai.usage.output_tokens",
    "gen_ai.usage.completion_tokens",
)
TOTAL_TOKENS_ATTRS = ("gen_ai.usage.total_tokens",)

INPUT_COST_ATTRS = (
    "gen_ai.usage.input_cost",
    # Braintrust CostEnrichmentSpanProcessor uses this shape.
    "gen_ai.usage.cost.prompt",
)
OUTPUT_COST_ATTRS = (
    "gen_ai.usage.output_cost",
    "gen_ai.usage.cost.completion",
)
TOTAL_COST_ATTRS = (
    "gen_ai.usage.cost",
    "gen_ai.usage.total_cost",
    "gen_ai.usage.cost.total",
)

SESSION_ID_ATTRS = (
    "session.id",
    # Modern GenAI semconv + OpenAI Agents v2.
    "gen_ai.conversation.id",
)
USER_ID_ATTRS = (
    "enduser.id",
    "user.id",
)
TAGS_ATTRS: tuple[str, ...] = ()

TIME_TO_FIRST_TOKEN_ATTRS = ("gen_ai.usage.time_to_first_token",)
TOOL_CALLS_ATTRS = ("gen_ai.tool.calls",)
TOOL_CALL_NAMES_ATTRS = ("gen_ai.tool.call_names",)
TOOL_DEFINITIONS_ATTRS = ("gen_ai.tool.definitions",)

# Provider / model system identification.
PROVIDER_ATTRS = (
    "gen_ai.provider.name",
    "gen_ai.system",
)

# Agent identity — emitted by opentelemetry-instrumentation-openai-agents-v2.
AGENT_NAME_ATTRS = ("gen_ai.agent.name",)
AGENT_ID_ATTRS = ("gen_ai.agent.id",)
AGENT_VERSION_ATTRS = ("gen_ai.agent.version",)
TOOL_NAME_ATTRS = ("gen_ai.tool.name",)

# High-level system prompt — Logfire v2.
SYSTEM_INSTRUCTIONS_ATTRS = ("gen_ai.system_instructions",)

# Cache-token → canonical key.
CACHE_TOKEN_MAP = (
    ("gen_ai.usage.cache_read.input_tokens", "cache_read_input"),
    ("gen_ai.usage.cache_creation.input_tokens", "cache_creation_input"),
)

# Hypothetical bundled form; kept as defensive fallback.
PARAMS_BLOB_ATTRS = ("gen_ai.request.model_parameters",)

# Flat per-parameter attributes — OTel semconv defines these as separate keys.
# Modern emitters (OpenAI Agents v2, Braintrust OTel-compat, Logfire latest,
# LangSmith, Traceloop v0.5+) use this shape.
FLAT_PARAM_ATTRS = (
    "gen_ai.request.temperature",
    "gen_ai.request.top_p",
    "gen_ai.request.top_k",
    "gen_ai.request.max_tokens",
    "gen_ai.request.frequency_penalty",
    "gen_ai.request.presence_penalty",
    "gen_ai.request.seed",
    "gen_ai.request.stop_sequences",
    "gen_ai.request.choice.count",
    # Traceloop Claude-style thinking budget.
    "gen_ai.request.thinking_budget_tokens",
    "gen_ai.request.thinking_type",
)

_OPERATION_NAME_ATTR = "gen_ai.operation.name"
_GENERATION_OPS = frozenset({"chat", "text_completion", "generate_content"})


def resolve_observation_type(span_attrs: dict) -> str | None:
    op = clean_discriminator(span_attrs.get(_OPERATION_NAME_ATTR))
    if not op:
        return None
    if op in _GENERATION_OPS:
        return "GENERATION"
    if op == "embedding":
        return "EMBEDDING"
    if op == "execute_tool":
        return "TOOL"
    return op.upper()


def build_params(span_attrs: dict, merged: dict[str, Any]) -> None:
    """Pack flat ``gen_ai.request.<param>`` attributes into ``merged``.

    Suffix after ``gen_ai.request.`` becomes the dict key. Existing keys on
    ``merged`` (e.g. from a JSON blob parsed earlier) win.
    """
    for attr in FLAT_PARAM_ATTRS:
        val = span_attrs.get(attr)
        if val is None:
            continue
        key = attr[len("gen_ai.request."):]
        if key not in merged:
            merged[key] = val
