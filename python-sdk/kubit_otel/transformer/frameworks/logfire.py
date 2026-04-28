"""Logfire / Pydantic AI attribute mappings.

Logfire is built natively on OTel GenAI semconv, so the bulk of its spans
land through ``otel_genai``. This module adds ``logfire.tags`` plus
``pydantic_ai.all_messages`` for multi-agent conversation-state capture.
"""

from __future__ import annotations

from typing import Optional

from ..messages import pydantic_ai_envelope_to_canonical

NAME = "logfire"

MODEL_ATTRS: tuple[str, ...] = ()
PROVIDED_MODEL_ATTRS: tuple[str, ...] = ()

# pydantic_ai.all_messages carries the full multi-agent conversation state.
# Lowest priority — only used when no other input/output is present.
INPUT_ATTRS = ("pydantic_ai.all_messages",)
OUTPUT_ATTRS: tuple[str, ...] = ()

INPUT_TOKENS_ATTRS: tuple[str, ...] = ()
OUTPUT_TOKENS_ATTRS: tuple[str, ...] = ()
TOTAL_TOKENS_ATTRS: tuple[str, ...] = ()
INPUT_COST_ATTRS: tuple[str, ...] = ()
OUTPUT_COST_ATTRS: tuple[str, ...] = ()
TOTAL_COST_ATTRS: tuple[str, ...] = ()

SESSION_ID_ATTRS: tuple[str, ...] = ()
USER_ID_ATTRS: tuple[str, ...] = ()
TAGS_ATTRS = ("logfire.tags",)
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


def normalize_messages(span_attrs: dict) -> Optional[dict]:
    raw = span_attrs.get("pydantic_ai.all_messages")
    if raw is None:
        return None
    result = pydantic_ai_envelope_to_canonical(raw)
    if result["input"] is None and result["output"] is None:
        return None
    return result
