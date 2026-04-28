"""Langfuse SDK v3/v4 attribute mappings.

Langfuse serialises ``usage_details`` and ``cost_details`` as single JSON
strings. Model parameters likewise arrive as a JSON blob under either
``langfuse.observation.model.parameters`` (v4) or ``langfuse.observation.model_parameters``
(v3). Trace- and observation-level metadata are exposed via dotted prefixes
and can be promoted to first-level metadata keys.
"""

from __future__ import annotations

from typing import Any

from typing import Optional

from ..helpers import clean_discriminator, merge_json_blob
from ..messages import (
    coerce_to_messages,
    safe_json_parse,
    stringify_for_text,
    text_message,
    tool_call_part,
)

NAME = "langfuse"

MODEL_ATTRS = (
    "langfuse.observation.model.name",  # v4
    "langfuse.observation.model",       # v3
)
PROVIDED_MODEL_ATTRS = ("langfuse.observation.provided_model_name",)

INPUT_ATTRS = ("langfuse.observation.input",)
OUTPUT_ATTRS = ("langfuse.observation.output",)

INPUT_TOKENS_ATTRS = ("langfuse.observation.usage_details.input",)
OUTPUT_TOKENS_ATTRS = ("langfuse.observation.usage_details.output",)
TOTAL_TOKENS_ATTRS = ("langfuse.observation.usage_details.total",)

INPUT_COST_ATTRS = ("langfuse.observation.cost_details.input",)
OUTPUT_COST_ATTRS = ("langfuse.observation.cost_details.output",)
TOTAL_COST_ATTRS = (
    "langfuse.observation.cost_details.total",
    "langfuse.observation.total_cost",
)

SESSION_ID_ATTRS = ("langfuse.session.id",)
USER_ID_ATTRS = ("langfuse.user.id",)
TAGS_ATTRS = ("langfuse.trace.tags",)

TIME_TO_FIRST_TOKEN_ATTRS: tuple[str, ...] = ()
TOOL_CALLS_ATTRS = ("langfuse.observation.tool_calls",)
TOOL_CALL_NAMES_ATTRS = ("langfuse.observation.tool_call_names",)
TOOL_DEFINITIONS_ATTRS = ("langfuse.observation.tool_definitions",)

# Langfuse lets apps set environment/release as span attrs (not resource attrs);
# core consults these before falling back to ``deployment.environment`` /
# ``service.version``.
ENVIRONMENT_ATTRS = ("langfuse.environment",)
RELEASE_ATTRS = ("langfuse.release",)

PROVIDER_ATTRS: tuple[str, ...] = ()
AGENT_NAME_ATTRS: tuple[str, ...] = ()
AGENT_ID_ATTRS: tuple[str, ...] = ()
AGENT_VERSION_ATTRS: tuple[str, ...] = ()
TOOL_NAME_ATTRS: tuple[str, ...] = ()
SYSTEM_INSTRUCTIONS_ATTRS: tuple[str, ...] = ()

# Langfuse-specific extras (first-match string fallbacks).
# Both underscore (``prompt_id``, ``prompt_name``, ``prompt_version``) and
# dotted (``prompt.id``, ``prompt.name``, ``prompt.version``) forms have
# appeared across Langfuse SDK versions and docs; accept both.
COMPLETION_START_ATTRS = ("langfuse.observation.completion_start_time",)
PROMPT_ID_ATTRS = (
    "langfuse.observation.prompt_id",
    "langfuse.observation.prompt.id",
)
PROMPT_NAME_ATTRS = (
    "langfuse.observation.prompt_name",
    "langfuse.observation.prompt.name",
    "langfuse.prompt.name",
)
PROMPT_VERSION_ATTRS = (
    "langfuse.observation.prompt_version",
    "langfuse.observation.prompt.version",
    "langfuse.prompt.version",
)

CACHE_TOKEN_MAP: tuple[tuple[str, str], ...] = ()

# Params arrive as JSON blobs. v4 preferred, v3 legacy.
PARAMS_BLOB_ATTRS = (
    "langfuse.observation.model.parameters",
    "langfuse.observation.model_parameters",
)
FLAT_PARAM_ATTRS: tuple[str, ...] = ()

_USAGE_BLOB_ATTR = "langfuse.observation.usage_details"
_COST_BLOB_ATTR = "langfuse.observation.cost_details"
_OBSERVATION_TYPE_ATTR = "langfuse.observation.type"

_METADATA_PREFIXES = (
    "langfuse.trace.metadata.",
    "langfuse.observation.metadata.",
)


def resolve_observation_type(span_attrs: dict) -> str | None:
    lf = clean_discriminator(span_attrs.get(_OBSERVATION_TYPE_ATTR))
    if not lf:
        return None
    if lf == "generation":
        return "GENERATION"
    return lf.upper()


def parse_usage_blobs(span_attrs: dict, usage_details: dict[str, Any]) -> None:
    merge_json_blob(span_attrs.get(_USAGE_BLOB_ATTR), usage_details)


def parse_cost_blobs(span_attrs: dict, cost_details: dict[str, Any]) -> None:
    merge_json_blob(span_attrs.get(_COST_BLOB_ATTR), cost_details)


def enrich_metadata(span_attrs: dict, metadata: dict[str, Any]) -> None:
    """Promote ``langfuse.{trace,observation}.metadata.*`` to first-level keys."""
    for key, value in span_attrs.items():
        if not isinstance(key, str):
            continue
        for prefix in _METADATA_PREFIXES:
            if key.startswith(prefix):
                metadata.setdefault(key[len(prefix):], value)
                break


def normalize_messages(span_attrs: dict) -> Optional[dict]:
    input_msgs = _blob_to_messages(span_attrs.get("langfuse.observation.input"), "user")
    output_msgs = _blob_to_messages(span_attrs.get("langfuse.observation.output"), "assistant")

    raw_calls = span_attrs.get("langfuse.observation.tool_calls")
    if raw_calls is not None:
        parts = _parse_langfuse_tool_calls(raw_calls)
        if parts:
            if output_msgs and output_msgs[-1].get("role") == "assistant":
                output_msgs[-1]["parts"] = list(output_msgs[-1].get("parts", [])) + parts
            else:
                synthesized = {"role": "assistant", "parts": parts}
                output_msgs = (output_msgs or []) + [synthesized]

    if input_msgs is None and output_msgs is None:
        return None
    return {"input": input_msgs, "output": output_msgs}


def _blob_to_messages(raw: Any, role: str) -> Optional[list]:
    if raw is None:
        return None
    coerced = coerce_to_messages(raw)
    if coerced:
        return coerced
    text = stringify_for_text(raw)
    if not text:
        return None
    return [text_message(role, text)]


def _parse_langfuse_tool_calls(raw: Any) -> list:
    parsed = safe_json_parse(raw) if isinstance(raw, str) else raw
    if not isinstance(parsed, list):
        return []
    out: list = []
    for tc in parsed:
        if not isinstance(tc, dict):
            continue
        fn = tc.get("function") if isinstance(tc.get("function"), dict) else None
        # Match TS nullish-coalescing parity: only fall through to fn fields
        # when tc.name / tc.arguments are None/missing, not when truthy-falsy.
        name = tc.get("name") if isinstance(tc.get("name"), str) else None
        if name is None and fn is not None:
            name = fn.get("name") if isinstance(fn.get("name"), str) else None
        if not isinstance(name, str):
            continue
        call_id = tc.get("id") if isinstance(tc.get("id"), str) else None
        raw_args = tc.get("arguments")
        if raw_args is None and fn is not None:
            raw_args = fn.get("arguments")
        args = safe_json_parse(raw_args) if isinstance(raw_args, str) else raw_args
        if args is None and isinstance(raw_args, str):
            args = raw_args
        out.append(tool_call_part(name, args, call_id))
    return out
