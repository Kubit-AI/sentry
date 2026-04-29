"""Generic short-name aliases commonly emitted across vendors.

Kept at its own priority tier so the ordering of ``model`` / ``input`` /
``output`` relative to vendor-specific keys is preserved verbatim from the
pre-refactor transformer.
"""

from __future__ import annotations

from typing import Any

from ..messages import coerce_to_messages, stringify_for_text, text_message

NAME = "generic"

MODEL_ATTRS = ("model",)
PROVIDED_MODEL_ATTRS = ("model",)
INPUT_ATTRS = ("input",)
OUTPUT_ATTRS = ("output",)

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


def normalize_messages(span_attrs: dict) -> dict | None:
    """Last-resort wrap. ``coerce_to_messages`` first so a JSON-string with an
    OpenAI-shape array still surfaces as structured messages even on this
    generic path.
    """
    input_msgs = _wrap(span_attrs.get("input"), "user")
    output_msgs = _wrap(span_attrs.get("output"), "assistant")
    if input_msgs is None and output_msgs is None:
        return None
    return {"input": input_msgs, "output": output_msgs}


def _wrap(val: Any, role: str) -> list | None:
    if val is None:
        return None
    coerced = coerce_to_messages(val)
    if coerced:
        return coerced
    text = stringify_for_text(val)
    if not text:
        return None
    return [text_message(role, text)]
