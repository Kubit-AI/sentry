"""OpenLLMetry / Traceloop attribute mappings.

Traceloop emits the underscore cache-token variant (distinct from the
dot-separated OTel semconv variant), exposes trace-wide metadata under the
``traceloop.association.properties.*`` namespace, and uses ``traceloop.span.kind``
as its span-kind discriminator. Also provides the ``llm.request.type``
fallback for operation-name resolution, and unpacks indexed
``gen_ai.prompt.<n>.*`` / ``gen_ai.completion.<n>.*`` conversational attrs.
"""

from __future__ import annotations

import json
from typing import Any, Optional

from ..helpers import clean_discriminator
from ..messages import (
    coerce_to_messages,
    stringify_for_text,
    text_message,
    unpack_indexed_messages,
)

NAME = "traceloop"

MODEL_ATTRS: tuple[str, ...] = ()
PROVIDED_MODEL_ATTRS: tuple[str, ...] = ()
# OpenLLMetry's @workflow / @task decorators emit raw JSON payloads here.
INPUT_ATTRS = ("traceloop.entity.input",)
OUTPUT_ATTRS = ("traceloop.entity.output",)
INPUT_TOKENS_ATTRS: tuple[str, ...] = ()
OUTPUT_TOKENS_ATTRS: tuple[str, ...] = ()
TOTAL_TOKENS_ATTRS: tuple[str, ...] = ()
INPUT_COST_ATTRS: tuple[str, ...] = ()
OUTPUT_COST_ATTRS: tuple[str, ...] = ()
TOTAL_COST_ATTRS: tuple[str, ...] = ()

SESSION_ID_ATTRS = ("traceloop.association.properties.session_id",)
USER_ID_ATTRS = ("traceloop.association.properties.user_id",)
TAGS_ATTRS = ("traceloop.association.properties.tags",)

TIME_TO_FIRST_TOKEN_ATTRS: tuple[str, ...] = ()
TOOL_CALLS_ATTRS: tuple[str, ...] = ()
TOOL_CALL_NAMES_ATTRS: tuple[str, ...] = ()
TOOL_DEFINITIONS_ATTRS: tuple[str, ...] = ()
PROVIDER_ATTRS: tuple[str, ...] = ()
AGENT_NAME_ATTRS: tuple[str, ...] = ()
AGENT_ID_ATTRS: tuple[str, ...] = ()
AGENT_VERSION_ATTRS: tuple[str, ...] = ()
TOOL_NAME_ATTRS: tuple[str, ...] = ()
SYSTEM_INSTRUCTIONS_ATTRS: tuple[str, ...] = ()

# Traceloop variant: underscored, distinct from OTel semconv dot-separated.
CACHE_TOKEN_MAP = (
    ("gen_ai.usage.cache_read_input_tokens", "cache_read_input"),
    ("gen_ai.usage.cache_creation_input_tokens", "cache_creation_input"),
)

PARAMS_BLOB_ATTRS: tuple[str, ...] = ()
FLAT_PARAM_ATTRS: tuple[str, ...] = ()

_SPAN_KIND_ATTR = "traceloop.span.kind"
_LLM_REQUEST_TYPE_ATTR = "llm.request.type"

_PROMPT_INDEX_PREFIX = "gen_ai.prompt."
_COMPLETION_INDEX_PREFIX = "gen_ai.completion."

_LLM_REQUEST_TYPE_MAP = {
    "chat": "GENERATION",
    "completion": "GENERATION",
    "embedding": "EMBEDDING",
    "rerank": "WORKFLOW",
}


def resolve_observation_type(span_attrs: dict) -> str | None:
    tl = clean_discriminator(span_attrs.get(_SPAN_KIND_ATTR))
    if tl:
        return tl.upper()
    return None


def resolve_observation_type_fallback(span_attrs: dict) -> str | None:
    """Last-resort ``llm.request.type`` lookup.

    Separate from :func:`resolve_observation_type` so that standard
    ``gen_ai.operation.name`` wins on collision; Traceloop's primary
    ``traceloop.span.kind`` still fires in the main chain.
    """
    req_type = clean_discriminator(span_attrs.get(_LLM_REQUEST_TYPE_ATTR))
    if not req_type:
        return None
    return _LLM_REQUEST_TYPE_MAP.get(req_type, req_type.upper())


def unpack_messages(span_attrs: dict) -> tuple[Optional[str], Optional[str]]:
    """Reconstruct JSON message arrays from indexed ``gen_ai.prompt.<n>.*``.

    Only triggers when the indexed form is present; non-indexed plain-string
    ``gen_ai.prompt`` / ``gen_ai.completion`` are picked up through the
    canonical alias lists (``otel_genai``) instead.
    """
    return (
        _unpack_indexed(span_attrs, _PROMPT_INDEX_PREFIX),
        _unpack_indexed(span_attrs, _COMPLETION_INDEX_PREFIX),
    )


def _unpack_indexed(span_attrs: dict, prefix: str) -> Optional[str]:
    messages: dict[int, dict[str, Any]] = {}
    prefix_len = len(prefix)
    for key, value in span_attrs.items():
        if not isinstance(key, str) or not key.startswith(prefix):
            continue
        rest = key[prefix_len:]
        # Valid forms: "<idx>.role", "<idx>.content", "<idx>.tool_call_id",
        # "<idx>.tool_calls.<tidx>.<field>". Ignore the non-indexed bare
        # "gen_ai.prompt" case which is handled by otel_genai.INPUT_ATTRS.
        head, sep, tail = rest.partition(".")
        if not sep:
            continue
        try:
            idx = int(head)
        except ValueError:
            continue
        msg = messages.setdefault(idx, {})
        msg[tail] = value
    if not messages:
        return None
    ordered = [messages[i] for i in sorted(messages)]
    return json.dumps(ordered)


def normalize_messages(span_attrs: dict) -> dict | None:
    indexed_in = unpack_indexed_messages(span_attrs, _PROMPT_INDEX_PREFIX, "")
    indexed_out = unpack_indexed_messages(span_attrs, _COMPLETION_INDEX_PREFIX, "")

    input_msgs = indexed_in or _entity_to_messages(
        span_attrs.get("traceloop.entity.input"), "user"
    )
    output_msgs = indexed_out or _entity_to_messages(
        span_attrs.get("traceloop.entity.output"), "assistant"
    )

    if input_msgs is None and output_msgs is None:
        return None
    return {"input": input_msgs, "output": output_msgs}


def _entity_to_messages(raw: Any, role: str) -> Optional[list]:
    if raw is None:
        return None
    coerced = coerce_to_messages(raw)
    if coerced:
        return coerced
    text = stringify_for_text(raw)
    if not text:
        return None
    return [text_message(role, text)]
