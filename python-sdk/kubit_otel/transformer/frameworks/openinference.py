"""OpenInference (Arize / Phoenix) attribute mappings.

Uses the ``llm.*`` namespace rather than ``gen_ai.*``. ``openinference.span.kind``
is the authoritative span-kind discriminator. Embedding spans carry the model
under ``embedding.model_name`` rather than ``llm.model_name``.

Handles indexed message flattening: ``llm.input_messages.<n>.message.role``,
``llm.input_messages.<n>.message.content`` (and output equivalents),
reconstructing them into a JSON messages array. Retriever spans encode RAG hits
as ``retrieval.documents.<n>.document.<field>`` which are unpacked into the
output slot when no ``llm.output_messages`` are present.
"""

from __future__ import annotations

import json
from typing import Any, Optional

from ..helpers import clean_discriminator
from ..messages import (
    coerce_to_messages,
    generic_part,
    stringify_for_text,
    text_message,
    unpack_indexed_messages,
)

NAME = "openinference"

MODEL_ATTRS = (
    "llm.model_name",
    "llm.response.model",
    "embedding.model_name",
)
PROVIDED_MODEL_ATTRS = ("llm.request.model",)

INPUT_ATTRS = (
    "llm.input_messages",
    "llm.prompts",
    "input.value",
)
OUTPUT_ATTRS = (
    "llm.output_messages",
    "llm.completions",
    "output.value",
)

INPUT_TOKENS_ATTRS = (
    "llm.token_count.prompt",
    "llm.usage.prompt_tokens",
)
OUTPUT_TOKENS_ATTRS = (
    "llm.token_count.completion",
    "llm.usage.completion_tokens",
)
TOTAL_TOKENS_ATTRS = (
    "llm.token_count.total",
    "llm.usage.total_tokens",
)

INPUT_COST_ATTRS = ("llm.cost.prompt",)
OUTPUT_COST_ATTRS = ("llm.cost.completion",)
TOTAL_COST_ATTRS = ("llm.cost.total",)

SESSION_ID_ATTRS: tuple[str, ...] = ()
USER_ID_ATTRS: tuple[str, ...] = ()
TAGS_ATTRS = ("tag.tags",)

TIME_TO_FIRST_TOKEN_ATTRS = ("llm.time_to_first_token",)
TOOL_CALLS_ATTRS: tuple[str, ...] = ()
TOOL_CALL_NAMES_ATTRS: tuple[str, ...] = ()
TOOL_DEFINITIONS_ATTRS: tuple[str, ...] = ()

PROVIDER_ATTRS = (
    "llm.system",
    "llm.provider",
)

AGENT_NAME_ATTRS: tuple[str, ...] = ()
AGENT_ID_ATTRS: tuple[str, ...] = ()
AGENT_VERSION_ATTRS: tuple[str, ...] = ()
TOOL_NAME_ATTRS: tuple[str, ...] = ()
SYSTEM_INSTRUCTIONS_ATTRS: tuple[str, ...] = ()

CACHE_TOKEN_MAP = (
    ("llm.token_count.prompt_details.cache_read", "cache_read_input"),
    ("llm.token_count.prompt_details.cache_write", "cache_creation_input"),
    ("llm.token_count.completion_details.reasoning", "completion_reasoning"),
)

# OpenInference emits invocation parameters as a single JSON-serialised dict.
PARAMS_BLOB_ATTRS = ("llm.invocation_parameters",)
FLAT_PARAM_ATTRS: tuple[str, ...] = ()

_SPAN_KIND_ATTR = "openinference.span.kind"
_INPUT_INDEX_PREFIX = "llm.input_messages."
_OUTPUT_INDEX_PREFIX = "llm.output_messages."
_RETRIEVAL_DOCS_PREFIX = "retrieval.documents."


def resolve_observation_type(span_attrs: dict) -> str | None:
    oi = clean_discriminator(span_attrs.get(_SPAN_KIND_ATTR))
    if not oi or oi == "unknown":
        return None
    if oi == "llm":
        return "GENERATION"
    return oi.upper()


def unpack_messages(span_attrs: dict) -> tuple[Optional[str], Optional[str]]:
    """Reconstruct JSON message arrays from indexed ``llm.*_messages`` attrs.

    Returns ``(input_json, output_json)`` where each is a JSON string suitable
    for assignment to the canonical ``input``/``output`` fields — or ``None``
    when no indexed attributes are present. When ``llm.output_messages`` is
    absent, falls back to ``retrieval.documents.<n>.document.*`` for
    retriever-kind spans.
    """
    return (
        _unpack_indexed(span_attrs, _INPUT_INDEX_PREFIX),
        _unpack_indexed(span_attrs, _OUTPUT_INDEX_PREFIX)
            or _unpack_retrieval_docs(span_attrs),
    )


def _unpack_retrieval_docs(span_attrs: dict) -> Optional[str]:
    docs: dict[int, dict[str, Any]] = {}
    prefix_len = len(_RETRIEVAL_DOCS_PREFIX)
    for key, value in span_attrs.items():
        if not isinstance(key, str) or not key.startswith(_RETRIEVAL_DOCS_PREFIX):
            continue
        rest = key[prefix_len:]
        head, sep, inner = rest.partition(".")
        if not sep:
            continue
        try:
            idx = int(head)
        except ValueError:
            continue
        if inner.startswith("document."):
            inner = inner[len("document."):]
        docs.setdefault(idx, {})[inner] = value
    if not docs:
        return None
    return json.dumps([docs[i] for i in sorted(docs)])


def _unpack_indexed(span_attrs: dict, prefix: str) -> Optional[str]:
    messages: dict[int, dict[str, Any]] = {}
    prefix_len = len(prefix)
    for key, value in span_attrs.items():
        if not isinstance(key, str) or not key.startswith(prefix):
            continue
        rest = key[prefix_len:]
        parts = rest.split(".", 1)
        if len(parts) < 2:
            continue
        try:
            idx = int(parts[0])
        except ValueError:
            continue
        inner = parts[1]
        if not inner.startswith("message."):
            continue
        field = inner[len("message."):]
        messages.setdefault(idx, {})[field] = value
    if not messages:
        return None
    ordered = [messages[i] for i in sorted(messages)]
    return json.dumps(ordered)


def normalize_messages(span_attrs: dict) -> dict | None:
    indexed_in = unpack_indexed_messages(span_attrs, _INPUT_INDEX_PREFIX, "message.")
    indexed_out = unpack_indexed_messages(span_attrs, _OUTPUT_INDEX_PREFIX, "message.")

    input_msgs = (
        indexed_in
        or _blob_to_messages(span_attrs.get("llm.input_messages"), "user")
        or _blob_to_messages(span_attrs.get("llm.prompts"), "user")
        or _blob_to_messages(span_attrs.get("input.value"), "user")
    )
    output_msgs = (
        indexed_out
        or _blob_to_messages(span_attrs.get("llm.output_messages"), "assistant")
        or _blob_to_messages(span_attrs.get("llm.completions"), "assistant")
        or _blob_to_messages(span_attrs.get("output.value"), "assistant")
    )

    # Retriever-span fallback: only on output, only when nothing else produced
    # output messages. Encodes ``retrieval.documents.<i>.document.*`` as a
    # single tool-role message holding one GenericPart per document.
    if output_msgs is None:
        doc_msg = _retrieval_docs_to_message(span_attrs)
        if doc_msg is not None:
            output_msgs = [doc_msg]

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


def _retrieval_docs_to_message(span_attrs: dict) -> Optional[dict]:
    buckets: dict[int, dict[str, Any]] = {}
    prefix_len = len(_RETRIEVAL_DOCS_PREFIX)
    for key, value in span_attrs.items():
        if not isinstance(key, str) or not key.startswith(_RETRIEVAL_DOCS_PREFIX):
            continue
        rest = key[prefix_len:]
        head, sep, inner = rest.partition(".")
        if not sep:
            continue
        try:
            idx = int(head)
        except ValueError:
            continue
        if inner.startswith("document."):
            inner = inner[len("document."):]
        buckets.setdefault(idx, {})[inner] = value
    if not buckets:
        return None
    parts = [generic_part("retrieval_document", buckets[i]) for i in sorted(buckets)]
    return {"role": "tool", "parts": parts}
