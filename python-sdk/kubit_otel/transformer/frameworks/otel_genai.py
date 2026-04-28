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
from ..messages import (
    coerce_to_messages,
    safe_json_parse,
    text_message,
    tool_call_part,
)

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


def normalize_messages(span_attrs: dict) -> dict | None:
    input_msgs = _canonicalize_side(
        span_attrs.get("gen_ai.input.messages"),
        span_attrs.get("gen_ai.prompt") or span_attrs.get("gen_ai.content.prompt"),
        "user",
    )
    output_msgs = _canonicalize_side(
        span_attrs.get("gen_ai.output.messages"),
        span_attrs.get("gen_ai.completion") or span_attrs.get("gen_ai.content.completion"),
        "assistant",
    )
    output_msgs = _merge_tool_calls_into_output(
        output_msgs, span_attrs.get("gen_ai.tool.calls")
    )
    if input_msgs is None and output_msgs is None:
        return None
    return {"input": input_msgs, "output": output_msgs}


def _canonicalize_side(messages_attr: Any, text_attr: Any, text_role: str) -> list | None:
    if messages_attr is not None:
        coerced = coerce_to_messages(messages_attr)
        if coerced:
            return coerced
    if isinstance(text_attr, str) and text_attr:
        return [text_message(text_role, text_attr)]
    return None


def _merge_tool_calls_into_output(output: list | None, raw_tool_calls: Any) -> list | None:
    """If ``gen_ai.tool.calls`` is present, append ``ToolCallRequestPart``s
    onto the trailing assistant message. Synthesizes an assistant message if
    none exists yet.
    """
    if raw_tool_calls is None:
        return output
    parsed = safe_json_parse(raw_tool_calls) if isinstance(raw_tool_calls, str) else raw_tool_calls
    if not isinstance(parsed, list) or not parsed:
        return output

    parts: list = []
    for tc in parsed:
        if not isinstance(tc, dict):
            continue
        fn = tc.get("function") if isinstance(tc.get("function"), dict) else None
        name = tc.get("name") or (fn.get("name") if fn else None)
        if not isinstance(name, str):
            continue
        raw_args = tc.get("arguments") if "arguments" in tc else (fn.get("arguments") if fn else None)
        args = safe_json_parse(raw_args) if isinstance(raw_args, str) else raw_args
        if args is None and isinstance(raw_args, str):
            args = raw_args
        call_id = tc.get("id") if isinstance(tc.get("id"), str) else None
        parts.append(tool_call_part(name, args, call_id))
    if not parts:
        return output

    if output:
        last = output[-1]
        if last.get("role") == "assistant":
            last["parts"] = list(last.get("parts", [])) + parts
            return output
    synthesized = {"role": "assistant", "parts": parts}
    if output:
        return list(output) + [synthesized]
    return [synthesized]
