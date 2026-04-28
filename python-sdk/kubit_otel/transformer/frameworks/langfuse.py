"""Langfuse SDK v3/v4 attribute mappings.

Langfuse serialises ``usage_details`` and ``cost_details`` as single JSON
strings. Model parameters likewise arrive as a JSON blob under either
``langfuse.observation.model.parameters`` (v4) or ``langfuse.observation.model_parameters``
(v3). Trace- and observation-level metadata are exposed via dotted prefixes
and can be promoted to first-level metadata keys.
"""

from __future__ import annotations

import ast
from typing import Any

from typing import Optional

from ..helpers import clean_discriminator, merge_json_blob
from ..messages import (
    coerce_to_messages,
    langchain_envelope_to_canonical,
    safe_json_parse,
    stringify_for_text,
    text_message,
    tool_call_part,
    tool_call_response_part,
)

NAME = "langfuse"

# LangChain integrations expose richer metadata than Langfuse's first-class
# fields — they tag spans with the model provider and the resolved model
# name under ``langfuse.observation.metadata.ls_*``. Surface them as
# first-class ``provider`` / ``provided_model_name`` aliases so consumers
# don't have to dig through the metadata bag.
_LS_PROVIDER_ATTR = "langfuse.observation.metadata.ls_provider"
_LS_MODEL_NAME_ATTR = "langfuse.observation.metadata.ls_model_name"
_LS_INTEGRATION_ATTR = "langfuse.observation.metadata.ls_integration"

MODEL_ATTRS = (
    "langfuse.observation.model.name",  # v4
    "langfuse.observation.model",       # v3
)
PROVIDED_MODEL_ATTRS = (
    "langfuse.observation.provided_model_name",
    _LS_MODEL_NAME_ATTR,
)

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

PROVIDER_ATTRS = (_LS_PROVIDER_ATTR,)
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
    # Langfuse JS SDK emits ``span`` for LangChain wrapper observations
    # (LangGraph root, ``tools``, ``model_request``, ``RunnableLambda``,
    # ``__start__``), while the Python SDK emits ``chain`` for the same
    # logical spans. Fold back to CHAIN whenever the integration metadata
    # says we're inside a LangChain run, so cross-SDK observation types
    # stay aligned.
    if lf == "span":
        integ = span_attrs.get(_LS_INTEGRATION_ATTR)
        if isinstance(integ, str) and integ.startswith("langchain"):
            return "CHAIN"
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


def aggregate_tool_definitions(span_attrs: dict) -> Optional[list]:
    """Surface phantom ``{role:"tool", content:{name, input_schema, description}}``
    entries as top-level ``tool_definitions``.

    Langfuse-LangChain (Python) injects each tool definition as a phantom
    ``tool``-role message inside ``langfuse.observation.input``. They aren't
    chat turns — return them here so the normalizer can drop them from
    ``input_messages`` without losing the schema.
    """
    raw = span_attrs.get("langfuse.observation.input")
    if raw is None:
        return None
    parsed = safe_json_parse(raw) if isinstance(raw, str) else raw
    if not isinstance(parsed, list):
        return None
    defs: list = []
    for m in parsed:
        if _is_tool_definition_message(m):
            defs.append(m["content"])
    return defs if defs else None


def normalize_messages(span_attrs: dict) -> Optional[dict]:
    input_msgs: Optional[list] = None
    output_msgs: Optional[list] = None

    # For TOOL spans, synthesize canonical request/response from raw args
    # + envelope-normalized output. Falls through to blob_to_messages when
    # synthesis can't produce a result (e.g. no recoverable tool name).
    if clean_discriminator(span_attrs.get(_OBSERVATION_TYPE_ATTR)) == "tool":
        synth = _synthesize_tool_span_messages(span_attrs)
        input_msgs = synth["input"]
        output_msgs = synth["output"]

    if input_msgs is None:
        input_msgs = _blob_to_messages(span_attrs.get("langfuse.observation.input"), "user")
    if output_msgs is None:
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

    input_msgs = _rewrite_tool_name_roles(input_msgs)
    output_msgs = _rewrite_tool_name_roles(output_msgs)

    if input_msgs is None and output_msgs is None:
        return None
    return {"input": input_msgs, "output": output_msgs}


def _blob_to_messages(raw: Any, role: str) -> Optional[list]:
    if raw is None:
        return None

    # Parse strings up front so the same pipeline handles stringified and
    # already-parsed blobs identically.
    parsed: Any = raw
    if isinstance(raw, str):
        parsed = safe_json_parse(raw)
        if parsed is None:
            return [text_message(role, raw)] if raw else None

    # Strip phantom tool-definition entries before normalization — they're
    # surfaced via ``aggregate_tool_definitions`` instead.
    if isinstance(parsed, list):
        parsed = [m for m in parsed if not _is_tool_definition_message(m)]

    # LangChain envelope translator handles ``{messages:[...]}``, AIMessage
    # with ``content:[{type:"tool_use",...}]`` arrays, ToolMessage with
    # ``tool_call_id``, and the OpenAI-shape fallback for non-Serializable
    # arrays.
    lc = langchain_envelope_to_canonical(parsed)
    if lc:
        return lc

    coerced = coerce_to_messages(parsed)
    if coerced:
        return coerced

    # Single OpenAI-shape object: Langfuse Python serializes the trailing
    # AIMessage of a tool-use turn as a bare object, not in an array. Wrap
    # and retry so canonical message extraction still runs.
    if (
        isinstance(parsed, dict)
        and isinstance(parsed.get("role"), str)
    ):
        wrapped = coerce_to_messages([parsed])
        if wrapped:
            return wrapped

    text = stringify_for_text(raw)
    return [text_message(role, text)] if text else None


def _is_tool_definition_message(m: Any) -> bool:
    """Detect ``{role:"tool", content:{name, input_schema, ...}}`` phantoms."""
    if not isinstance(m, dict):
        return False
    if m.get("role") != "tool":
        return False
    c = m.get("content")
    if not isinstance(c, dict):
        return False
    return isinstance(c.get("name"), str) and isinstance(c.get("input_schema"), dict)


def _synthesize_tool_span_messages(attrs: dict) -> dict:
    """Synthesize canonical request/response messages for a TOOL-typed
    Langfuse observation.

    Strategy mirrors ``synthesizeToolSpanMessages`` in the JS adapter and
    the openinference adapter helper of the same name:

    1. Parse the output blob and run ``langchain_envelope_to_canonical`` on
       it. Both the JS Serializable ToolMessage envelope and the PY
       plain-dict ``{type:"tool",...}`` shape are recognized by the
       envelope translator (post-Fix #1), producing
       ``[{role:"tool", name, parts:[{type:"tool_call_response", id, ...}]}]``.
    2. Lift ``name`` and the ``tool_call_response.id`` from the normalized
       output. These become the synthesized assistant tool_call's name +
       id, keeping input/output linked via the same id that the parent
       generation emitted.
    3. Parse args from the input blob: ``safe_json_parse`` first; on
       failure, ``ast.literal_eval`` (catches the PY-callback ``repr(dict)``
       quirk -- single-quoted dict literals that aren't valid JSON);
       fall back to the raw string.
    4. Synthesize input only when a tool name was recoverable; otherwise
       return ``None`` so the caller falls through to ``blob_to_messages``.
    5. Output fallback: when the envelope didn't yield a tool message, wrap
       the raw output as ``[{role:"tool", parts:[tool_call_response(
       raw_output, None)]}]``.
    """
    raw_out = attrs.get("langfuse.observation.output")
    if raw_out is None:
        return {"input": None, "output": None}
    if isinstance(raw_out, str):
        parsed_out: Any = safe_json_parse(raw_out)
        if parsed_out is None:
            parsed_out = raw_out
    else:
        parsed_out = raw_out

    tool_name: Optional[str] = None
    tool_call_id: Optional[str] = None
    output: Optional[list] = None

    lc_out = langchain_envelope_to_canonical(parsed_out)
    if lc_out:
        output = lc_out
        first = lc_out[0]
        if first.get("role") == "tool":
            name = first.get("name")
            if isinstance(name, str):
                tool_name = name
            parts = first.get("parts", [])
            if (
                parts
                and isinstance(parts[0], dict)
                and parts[0].get("type") == "tool_call_response"
            ):
                pid = parts[0].get("id")
                if isinstance(pid, str):
                    tool_call_id = pid

    # Output fallback: when envelope didn't produce a tool message but raw
    # output exists, wrap it as a tool message so consumers still get a
    # canonical response part (without an id linkage).
    if output is None and parsed_out is not None:
        output = [{
            "role": "tool",
            "parts": [tool_call_response_part(parsed_out, None)],
        }]

    # Input synthesis only fires when we can name the tool.
    input_msgs: Optional[list] = None
    if tool_name is not None:
        raw_in = attrs.get("langfuse.observation.input")
        if raw_in is None:
            args_parsed: Any = None
        elif isinstance(raw_in, str):
            args_parsed = safe_json_parse(raw_in)
            if args_parsed is None:
                try:
                    args_parsed = ast.literal_eval(raw_in)
                except (SyntaxError, ValueError):
                    args_parsed = raw_in
        else:
            args_parsed = raw_in
        input_msgs = [{
            "role": "assistant",
            "parts": [tool_call_part(tool_name, args_parsed, tool_call_id)],
        }]

    return {"input": input_msgs, "output": output}


def _rewrite_tool_name_roles(messages: Optional[list]) -> Optional[list]:
    """Recover ``role:"tool"`` + ``tool_call_response`` linkage when Langfuse
    JS LangChain integration projects ToolMessage as
    ``{role: <tool_name>, content: <result>}``. Rewrites any non-canonical
    string role to ``"tool"`` and lifts the ``tool_call_id`` from a
    same-array assistant ``tool_call`` part with the matching name when one
    is present. Standalone tool-result spans (e.g. the JS ``tools`` CHAIN
    observation, which only carries the result message) get the rewrite
    without the linkage.
    """
    if not messages:
        return messages
    canonical = {"system", "user", "assistant", "tool"}
    name_to_id: dict = {}
    out: list = []
    for m in messages:
        if m.get("role") == "assistant":
            for p in m.get("parts", []):
                if isinstance(p, dict) and p.get("type") == "tool_call":
                    name = p.get("name")
                    if isinstance(name, str):
                        pid = p.get("id")
                        name_to_id[name] = pid if isinstance(pid, str) else None
            out.append(m)
            continue
        role = m.get("role")
        if isinstance(role, str) and role not in canonical:
            call_id = name_to_id.get(role)
            parts = m.get("parts", [])
            if (
                len(parts) == 1
                and isinstance(parts[0], dict)
                and parts[0].get("type") == "text"
            ):
                response: Any = parts[0].get("content")
            else:
                response = parts
            out.append({
                "role": "tool",
                "name": role,
                "parts": [tool_call_response_part(response, call_id)],
            })
            continue
        out.append(m)
    return out


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
