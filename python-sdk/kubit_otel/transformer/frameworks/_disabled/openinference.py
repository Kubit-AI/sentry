"""OpenInference (Arize / Phoenix) attribute mappings.

Uses the ``llm.*`` namespace rather than ``gen_ai.*``. ``openinference.span.kind``
is the authoritative span-kind discriminator. Embedding spans carry the model
under ``embedding.model_name`` rather than ``llm.model_name``.

Also handles indexed message flattening: ``llm.input_messages.<n>.message.role``
and ``llm.input_messages.<n>.message.content`` (and the output equivalents),
reconstructing them into a JSON messages array.
"""

from __future__ import annotations

import json
from typing import Any, Optional

from ...helpers import clean_discriminator, merge_json_blob

NAME = "openinference"

MODEL_ATTRS = (
    "llm.model_name",
    "llm.response.model",
    "embedding.model_name",
)
PROVIDED_MODEL_ATTRS = ("llm.request.model",)

INPUT_ATTRS = (
    # Non-indexed forms. Indexed `llm.input_messages.<n>.*` unpacked separately.
    "llm.input_messages",
    "llm.prompts",
    # OpenInference flat raw value when `input.mime_type` is set.
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
# OpenInference tag attribute (comma-separated string or JSON array).
TAGS_ATTRS = ("tag.tags",)

TIME_TO_FIRST_TOKEN_ATTRS = ("llm.time_to_first_token",)
TOOL_CALLS_ATTRS: tuple[str, ...] = ()
TOOL_CALL_NAMES_ATTRS: tuple[str, ...] = ()
TOOL_DEFINITIONS_ATTRS: tuple[str, ...] = ()

# Provider identification — OpenInference splits system vs provider but both
# carry the same conceptual value ("openai", "anthropic", ...).
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
    """Reconstruct a document array from ``retrieval.documents.<n>.document.<field>``.

    Strips the constant ``document.`` segment and emits
    ``{content, id, score, metadata}`` objects ordered by index.
    """
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
        # Expected suffix forms: "<idx>.message.role", "<idx>.message.content",
        # "<idx>.message.tool_calls.<tidx>.<field>" (latter flattened further).
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
        msg = messages.setdefault(idx, {})
        msg[field] = value
    if not messages:
        return None
    ordered = [messages[i] for i in sorted(messages)]
    return json.dumps(ordered)
