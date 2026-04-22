"""LangSmith attribute mappings.

LangSmith mixes modern ``gen_ai.*`` keys with its own ``langsmith.*``
namespace. Token-detail JSON blobs (`gen_ai.usage.input_token_details`,
`gen_ai.usage.output_token_details`) are parsed into ``usage_details`` so
cache/audio/reasoning counts land alongside input/output.
"""

from __future__ import annotations

from typing import Any

from ..helpers import clean_discriminator, merge_json_blob

NAME = "langsmith"

MODEL_ATTRS: tuple[str, ...] = ()
PROVIDED_MODEL_ATTRS: tuple[str, ...] = ()
INPUT_ATTRS: tuple[str, ...] = ()
OUTPUT_ATTRS: tuple[str, ...] = ()
INPUT_TOKENS_ATTRS: tuple[str, ...] = ()
OUTPUT_TOKENS_ATTRS: tuple[str, ...] = ()
TOTAL_TOKENS_ATTRS: tuple[str, ...] = ()
INPUT_COST_ATTRS: tuple[str, ...] = ()
OUTPUT_COST_ATTRS: tuple[str, ...] = ()
TOTAL_COST_ATTRS: tuple[str, ...] = ()

SESSION_ID_ATTRS = ("langsmith.trace.session_id",)
USER_ID_ATTRS: tuple[str, ...] = ()
TAGS_ATTRS = ("langsmith.span.tags",)

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

# Per-direction token detail blobs, stringified dicts — merged into
# usage_details so nested detail keys (cache_read, reasoning, audio, …) land
# alongside input/output.
_USAGE_DETAIL_BLOB_ATTRS = (
    "gen_ai.usage.input_token_details",
    "gen_ai.usage.output_token_details",
)

_SPAN_KIND_ATTR = "langsmith.span.kind"


def resolve_observation_type(span_attrs: dict) -> str | None:
    ls = clean_discriminator(span_attrs.get(_SPAN_KIND_ATTR))
    if not ls:
        return None
    if ls == "llm":
        return "GENERATION"
    return ls.upper()


def parse_usage_blobs(span_attrs: dict, usage_details: dict[str, Any]) -> None:
    for attr in _USAGE_DETAIL_BLOB_ATTRS:
        merge_json_blob(span_attrs.get(attr), usage_details)
