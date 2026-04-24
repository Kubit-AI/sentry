"""Braintrust OTel-compat attribute mappings.

Braintrust serialises nested payloads as JSON strings (``braintrust.input_json``,
``braintrust.output_json``) to bypass OTel array-flattening limits, and exposes
custom metrics under ``braintrust.metrics.<key>``. The span-kind discriminator
is ``span_attributes.type``.
"""

from __future__ import annotations

import json
from typing import Any, Optional

from ...helpers import clean_discriminator, safe_float

NAME = "braintrust"

MODEL_ATTRS: tuple[str, ...] = ()
PROVIDED_MODEL_ATTRS: tuple[str, ...] = ()

# JSON-serialised payloads — Braintrust-native and the translation-target keys
# described in the Braintrust→OTel mapping table.
INPUT_ATTRS = (
    "braintrust.input_json",
    "gen_ai.prompt_json",
)
OUTPUT_ATTRS = (
    "braintrust.output_json",
    "gen_ai.completion_json",
)

INPUT_TOKENS_ATTRS: tuple[str, ...] = ()
OUTPUT_TOKENS_ATTRS: tuple[str, ...] = ()
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
PROVIDER_ATTRS: tuple[str, ...] = ()
AGENT_NAME_ATTRS: tuple[str, ...] = ()
AGENT_ID_ATTRS: tuple[str, ...] = ()
AGENT_VERSION_ATTRS: tuple[str, ...] = ()
TOOL_NAME_ATTRS: tuple[str, ...] = ()
SYSTEM_INSTRUCTIONS_ATTRS: tuple[str, ...] = ()

CACHE_TOKEN_MAP: tuple[tuple[str, str], ...] = ()
PARAMS_BLOB_ATTRS: tuple[str, ...] = ()
FLAT_PARAM_ATTRS: tuple[str, ...] = ()

_SPAN_TYPE_ATTR = "span_attributes.type"
_METRICS_PREFIX = "braintrust.metrics."
_INPUT_INDEX_PREFIX = "braintrust.input."
_OUTPUT_INDEX_PREFIX = "braintrust.output."
_METADATA_PREFIX = "braintrust.metadata."
_SCORES_ATTR = "braintrust.scores"


def resolve_observation_type(span_attrs: dict) -> str | None:
    bt = clean_discriminator(span_attrs.get(_SPAN_TYPE_ATTR))
    if not bt:
        return None
    if bt == "llm":
        return "GENERATION"
    return bt.upper()


def unpack_messages(span_attrs: dict) -> tuple[Optional[str], Optional[str]]:
    """Reconstruct JSON message arrays from indexed ``braintrust.input/output.<n>.*`` attrs."""
    return (
        _unpack_indexed(span_attrs, _INPUT_INDEX_PREFIX),
        _unpack_indexed(span_attrs, _OUTPUT_INDEX_PREFIX),
    )


def _unpack_indexed(span_attrs: dict, prefix: str) -> Optional[str]:
    messages: dict[int, dict[str, Any]] = {}
    prefix_len = len(prefix)
    for key, value in span_attrs.items():
        if not isinstance(key, str) or not key.startswith(prefix):
            continue
        rest = key[prefix_len:]
        head, sep, field = rest.partition(".")
        if not sep:
            continue
        try:
            idx = int(head)
        except ValueError:
            continue
        messages.setdefault(idx, {})[field] = value
    if not messages:
        return None
    return json.dumps([messages[i] for i in sorted(messages)])


def parse_usage_blobs(span_attrs: dict, usage_details: dict[str, Any]) -> None:
    """Promote ``braintrust.metrics.<key>`` values into ``usage_details``.

    Numeric-only; non-numeric values are skipped. Existing keys win.
    """
    for key, value in span_attrs.items():
        if not isinstance(key, str) or not key.startswith(_METRICS_PREFIX):
            continue
        metric_key = key[len(_METRICS_PREFIX):]
        if metric_key in usage_details:
            continue
        parsed = safe_float(value)
        if parsed is None:
            continue
        # Preserve integer-ness when the source was integer.
        if isinstance(value, int) and not isinstance(value, bool):
            usage_details[metric_key] = value
        else:
            usage_details[metric_key] = parsed


def enrich_metadata(span_attrs: dict, metadata: dict[str, Any]) -> None:
    """Promote ``braintrust.metadata.<key>`` to first-level metadata keys and
    parse ``braintrust.scores`` (JSON string or dict) under ``metadata.scores``.
    """
    for key, value in span_attrs.items():
        if not isinstance(key, str):
            continue
        if key.startswith(_METADATA_PREFIX):
            metadata.setdefault(key[len(_METADATA_PREFIX):], value)
    scores_raw = span_attrs.get(_SCORES_ATTR)
    if scores_raw is None or "scores" in metadata:
        return
    if isinstance(scores_raw, str):
        try:
            metadata["scores"] = json.loads(scores_raw)
        except (ValueError, TypeError):
            metadata["scores"] = scores_raw
    else:
        metadata["scores"] = scores_raw
