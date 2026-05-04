"""Mastra (``mastra.*`` namespace) attribute mappings.

Mastra emits its own ``mastra.*`` telemetry alongside standard ``gen_ai.*``
keys. The same attribute shape ships under any Mastra-owned tracer (the
published ``@mastra/otel-exporter``, the Sentry/Datadog/Langfuse/etc.
exporters, or an in-tree emitter — apps wiring Mastra into Kubit have been
observed using resource/scope name ``@mastra/kubit``).

``MODEL_GENERATION`` spans carry the full GenAI semconv set (model, tokens,
``gen_ai.input.messages`` / ``gen_ai.output.messages``) which the
``otel_genai`` adapter handles unchanged. This adapter covers the additional
Mastra span types that store their payload under per-span-type keys:

- ``mastra.span.type=agent_run``     → ``mastra.agent_run.input/output``
- ``mastra.span.type=workflow_run``  → ``mastra.workflow_run.input/output``
  (and the ``workflow_step``, ``workflow_conditional[_eval]``,
  ``workflow_parallel``, ``workflow_loop``, ``workflow_sleep``,
  ``workflow_wait_event`` siblings)
- ``mastra.span.type=processor_run`` → ``mastra.processor_run.input/output``
- ``mastra.span.type=model_step``    → ``mastra.model_step.input/output``
  plus the raw HTTP ``mastra.metadata.body/headers/modelMetadata`` blob
- ``mastra.span.type=tool_call`` /
  ``mastra.span.type=mcp_tool_call``  → ``mastra.<...>.input/output``
- ``mastra.span.type=generic``       → ``mastra.generic.input/output``

``mastra.span.type=model_chunk`` spans are stream-coordination noise (payload
is always ``"{}"``). They are dropped at the span-filter layer
(``is_mastra_internal_span`` in ``span_filter.py``) before they reach the
transformer; matches Mastra's own Sentry exporter behaviour.

``mastra.completion_start_time`` (ISO ms) is exported as
:data:`COMPLETION_START_ATTRS` so ``core.py`` can merge it with Langfuse's
equivalent and derive ``time_to_first_token``.

See ``docs/otel-mapping/mastra.md`` for the per-span-type attribute schemas
and the OTel GenAI overlap.
"""

from __future__ import annotations

import json as _json
from typing import Any, Optional

from ..messages import (
    coerce_to_messages,
    message_with_parts,
    safe_json_parse,
    text_message,
    text_part,
    tool_call_part,
    tool_call_response_part,
)

NAME = "mastra"

_SPAN_TYPE_ATTR = "mastra.span.type"
_MODEL_METADATA_ATTR = "mastra.metadata.modelMetadata"


# MODEL / PROVIDED_MODEL: GENERATION spans carry ``gen_ai.request.model`` /
# ``gen_ai.response.model`` and route through ``otel_genai``. MODEL_STEP spans
# have no canonical model alias — ``resolve_provided_model`` below pulls the
# value out of the ``mastra.metadata.modelMetadata`` JSON blob.
MODEL_ATTRS: tuple[str, ...] = ()
PROVIDED_MODEL_ATTRS: tuple[str, ...] = ()

INPUT_ATTRS = (
    "mastra.agent_run.input",
    "mastra.workflow_run.input",
    "mastra.workflow_step.input",
    "mastra.workflow_conditional.input",
    "mastra.workflow_conditional_eval.input",
    "mastra.workflow_parallel.input",
    "mastra.workflow_loop.input",
    "mastra.workflow_sleep.input",
    "mastra.workflow_wait_event.input",
    "mastra.processor_run.input",
    "mastra.model_step.input",
    "mastra.tool_call.input",
    "mastra.mcp_tool_call.input",
    "mastra.generic.input",
)
OUTPUT_ATTRS = (
    "mastra.agent_run.output",
    "mastra.workflow_run.output",
    "mastra.workflow_step.output",
    "mastra.workflow_conditional.output",
    "mastra.workflow_conditional_eval.output",
    "mastra.workflow_parallel.output",
    "mastra.workflow_loop.output",
    "mastra.workflow_sleep.output",
    "mastra.workflow_wait_event.output",
    "mastra.processor_run.output",
    "mastra.model_step.output",
    "mastra.tool_call.output",
    "mastra.mcp_tool_call.output",
    "mastra.generic.output",
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
TIME_TO_FIRST_TOKEN_SECONDS_ATTRS: tuple[str, ...] = ()
TOOL_CALLS_ATTRS: tuple[str, ...] = ()
TOOL_CALL_NAMES_ATTRS: tuple[str, ...] = ()
TOOL_DEFINITIONS_ATTRS: tuple[str, ...] = ()

PROVIDER_ATTRS: tuple[str, ...] = ()
AGENT_NAME_ATTRS: tuple[str, ...] = ()
AGENT_ID_ATTRS: tuple[str, ...] = ()
AGENT_VERSION_ATTRS: tuple[str, ...] = ()
# Mastra's ``ToolCallAttributes`` interface exposes ``toolId`` as the
# canonical name. Both ``tool_call`` and ``mcp_tool_call`` span types share
# the schema.
TOOL_NAME_ATTRS = ("mastra.tool_call.toolId", "mastra.mcp_tool_call.toolId")
SYSTEM_INSTRUCTIONS_ATTRS: tuple[str, ...] = ()

CACHE_TOKEN_MAP: tuple[tuple[str, str], ...] = ()
PARAMS_BLOB_ATTRS: tuple[str, ...] = ()
FLAT_PARAM_ATTRS: tuple[str, ...] = ()
ENVIRONMENT_ATTRS: tuple[str, ...] = ()
RELEASE_ATTRS: tuple[str, ...] = ()


# ``mastra.completion_start_time`` aliases. Re-exported (parallel to
# ``frameworks/langfuse.py:COMPLETION_START_ATTRS``) so ``core.py`` can merge
# them into the single chain it consults when deriving
# ``time_to_first_token`` from a first-chunk timestamp. Keep the export name
# stable — it's imported by name in ``core.py``.
COMPLETION_START_ATTRS = ("mastra.completion_start_time",)


# ── Hooks ────────────────────────────────────────────────────────────────────


def resolve_provider(span_attrs: dict) -> Optional[str]:
    meta = _parse_model_metadata(span_attrs.get(_MODEL_METADATA_ATTR))
    if meta is None:
        return None
    provider = meta.get("modelProvider")
    return provider if isinstance(provider, str) and provider else None


def resolve_provided_model(span_attrs: dict) -> Optional[str]:
    """Recover ``provided_model_name`` for MODEL_STEP spans.

    Fires only after the canonical PROVIDED_MODEL_ATTRS chain misses, so
    ``gen_ai.request.model`` (set on MODEL_GENERATION) wins. MODEL_STEP spans
    have no ``gen_ai.*`` model alias — recover it from ``modelMetadata``.
    """
    meta = _parse_model_metadata(span_attrs.get(_MODEL_METADATA_ATTR))
    if meta is None:
        return None
    model_id = meta.get("modelId")
    return model_id if isinstance(model_id, str) and model_id else None


def enrich_metadata(span_attrs: dict, metadata: dict) -> None:
    """Hoist Mastra's run-context identifiers and parsed modelMetadata.

    Leaves ``mastra.metadata.body`` and ``mastra.metadata.headers`` untouched
    in raw ``attributes.span``. ``body`` is a multi-KB provider response
    payload that consumers may not want surfaced as first-class metadata.
    """
    run_id = span_attrs.get("mastra.metadata.runId")
    org_id = span_attrs.get("mastra.metadata.orgId")
    workspace_id = span_attrs.get("mastra.metadata.workspaceId")
    if run_id is not None:
        metadata["runId"] = run_id
    if org_id is not None:
        metadata["orgId"] = org_id
    if workspace_id is not None:
        metadata["workspaceId"] = workspace_id
    meta = _parse_model_metadata(span_attrs.get(_MODEL_METADATA_ATTR))
    if meta is not None:
        metadata["mastra_modelMetadata"] = meta


def normalize_messages(span_attrs: dict) -> Optional[dict]:
    span_type = span_attrs.get(_SPAN_TYPE_ATTR)
    if not isinstance(span_type, str):
        return None
    if span_type == "agent_run":
        return _normalize_agent_run(span_attrs)
    if span_type == "processor_run":
        return _normalize_processor_run(span_attrs)
    if span_type == "model_step":
        return _normalize_model_step(span_attrs)
    if span_type in ("tool_call", "mcp_tool_call"):
        return _normalize_tool_call(span_attrs, span_type)
    if span_type in (
        "workflow_run",
        "workflow_step",
        "workflow_conditional",
        "workflow_conditional_eval",
        "workflow_parallel",
        "workflow_loop",
        "workflow_sleep",
        "workflow_wait_event",
    ):
        return _normalize_workflow(span_attrs, span_type)
    if span_type == "generic":
        return _normalize_generic(span_attrs)
    # model_generation routes through otel_genai (gen_ai.input.messages /
    # gen_ai.output.messages); model_chunk is dropped at the span filter.
    return None


# ── Per-span-type normalizers ───────────────────────────────────────────────


def _normalize_agent_run(span_attrs: dict) -> dict:
    # ``mastra.agent_run.input`` is the raw user prompt (plain string). The
    # system instructions piece is already injected via core's
    # ``gen_ai.system_instructions`` pass, so we only emit the user-role
    # message here.
    input_msgs: Optional[list] = None
    raw_in = span_attrs.get("mastra.agent_run.input")
    if isinstance(raw_in, str) and raw_in:
        input_msgs = [text_message("user", raw_in)]

    # ``mastra.agent_run.output`` shape: ``{text, object?, files?}``.
    # ``object`` is a parsed view of ``text`` for structured-response agents
    # — preferring ``text`` keeps the canonical view byte-aligned with what
    # the model emitted.
    output_msgs: Optional[list] = None
    raw_out = span_attrs.get("mastra.agent_run.output")
    parsed_out = _parse_object(raw_out)
    if parsed_out is not None:
        text = parsed_out.get("text")
        if isinstance(text, str) and text:
            output_msgs = [text_message("assistant", text)]
        else:
            obj = parsed_out.get("object")
            if obj is not None:
                output_msgs = [text_message("assistant", _stringify(obj))]
    elif isinstance(raw_out, str) and raw_out:
        output_msgs = [text_message("assistant", raw_out)]

    return {"input": input_msgs, "output": output_msgs}


def _normalize_processor_run(span_attrs: dict) -> dict:
    # ``mastra.processor_run.input`` shape (input phase): ``{phase, ...}``.
    # ``mastra.processor_run.output`` shape (output phase):
    # ``{phase, messageList: {messages, systemMessages?}}``. The richer
    # structure is on the output side.
    input_msgs: Optional[list] = None
    in_obj = _parse_object(span_attrs.get("mastra.processor_run.input"))
    if in_obj is not None:
        from_list = _unpack_message_list(in_obj.get("messageList"))
        if from_list is not None:
            input_msgs = from_list

    output_msgs: Optional[list] = None
    out_obj = _parse_object(span_attrs.get("mastra.processor_run.output"))
    if out_obj is not None:
        from_list = _unpack_message_list(out_obj.get("messageList"))
        if from_list is not None:
            output_msgs = from_list

    return {"input": input_msgs, "output": output_msgs}


def _normalize_model_step(span_attrs: dict) -> dict:
    # ``mastra.model_step.input`` is a JSON-encoded message array
    # ``[{role, parts:[{text}]}]`` — Gemini-shape parts (bare ``{text}``, no
    # ``type``). ``coerce_to_messages`` would pass those through verbatim
    # assuming canonical shape; project to ``{type: "text", content}`` here.
    input_msgs: Optional[list] = None
    raw_in = span_attrs.get("mastra.model_step.input")
    parsed_in = safe_json_parse(raw_in) if isinstance(raw_in, str) else raw_in
    if isinstance(parsed_in, list):
        projected = [
            m for m in (_gemini_to_canonical_message(it) for it in parsed_in)
            if m is not None
        ]
        if projected:
            input_msgs = projected

    # ``mastra.model_step.output`` shape: ``{text, toolCalls?, object?}``.
    # Mirror otel_genai's ``mergeToolCallsIntoOutput``: assistant message
    # with text part + tool_call parts.
    output_msgs: Optional[list] = None
    out_obj = _parse_object(span_attrs.get("mastra.model_step.output"))
    if out_obj is not None:
        parts: list = []
        text = out_obj.get("text")
        if isinstance(text, str) and text:
            parts.append(text_part(text))
        tool_calls = out_obj.get("toolCalls")
        if isinstance(tool_calls, list):
            for tc in tool_calls:
                if not isinstance(tc, dict):
                    continue
                name = (
                    tc.get("toolName") if isinstance(tc.get("toolName"), str)
                    else (tc.get("name") if isinstance(tc.get("name"), str) else None)
                )
                if not name:
                    continue
                call_id = (
                    tc.get("toolCallId") if isinstance(tc.get("toolCallId"), str)
                    else (tc.get("id") if isinstance(tc.get("id"), str) else None)
                )
                # Match TS: ``tc.args ?? tc.arguments ?? tc.input``.
                raw_args = tc.get("args")
                if raw_args is None:
                    raw_args = tc.get("arguments")
                if raw_args is None:
                    raw_args = tc.get("input")
                args = (
                    safe_json_parse(raw_args) if isinstance(raw_args, str) else raw_args
                )
                if args is None and isinstance(raw_args, str):
                    args = raw_args
                parts.append(tool_call_part(name, args, call_id))
        if parts:
            output_msgs = [message_with_parts("assistant", parts)]

    return {"input": input_msgs, "output": output_msgs}


def _normalize_tool_call(span_attrs: dict, span_type: str) -> dict:
    input_attr = f"mastra.{span_type}.input"
    output_attr = f"mastra.{span_type}.output"
    id_attr = f"mastra.{span_type}.toolCallId"
    name_attr = f"mastra.{span_type}.toolId"

    tool_name = span_attrs.get(name_attr)
    if not isinstance(tool_name, str):
        return {"input": None, "output": None}

    call_id_val = span_attrs.get(id_attr)
    call_id = call_id_val if isinstance(call_id_val, str) else None

    input_msgs: Optional[list] = None
    raw_in = span_attrs.get(input_attr)
    if raw_in is not None:
        parsed_in = safe_json_parse(raw_in) if isinstance(raw_in, str) else raw_in
        if parsed_in is None and isinstance(raw_in, str):
            parsed_in = raw_in
        input_msgs = [
            message_with_parts(
                "assistant", [tool_call_part(tool_name, parsed_in, call_id)]
            )
        ]

    output_msgs: Optional[list] = None
    raw_out = span_attrs.get(output_attr)
    if raw_out is not None:
        parsed_out = safe_json_parse(raw_out) if isinstance(raw_out, str) else raw_out
        if parsed_out is None and isinstance(raw_out, str):
            parsed_out = raw_out
        output_msgs = [
            message_with_parts(
                "tool", [tool_call_response_part(parsed_out, call_id)]
            )
        ]

    return {"input": input_msgs, "output": output_msgs}


def _normalize_workflow(span_attrs: dict, span_type: str) -> dict:
    # Workflow span input/output are arbitrary user-shaped JSON. Best effort:
    # coerce to canonical messages if the blob already matches a known
    # message shape; otherwise wrap the stringified value in a single text
    # message.
    in_attr = f"mastra.{span_type}.input"
    out_attr = f"mastra.{span_type}.output"
    return {
        "input": _coerce_or_wrap(span_attrs.get(in_attr), "user"),
        "output": _coerce_or_wrap(span_attrs.get(out_attr), "assistant"),
    }


def _normalize_generic(span_attrs: dict) -> dict:
    return {
        "input": _coerce_or_wrap(span_attrs.get("mastra.generic.input"), "user"),
        "output": _coerce_or_wrap(span_attrs.get("mastra.generic.output"), "assistant"),
    }


# ── Helpers ─────────────────────────────────────────────────────────────────


def _parse_model_metadata(raw: Any) -> Optional[dict]:
    """Parse ``mastra.metadata.modelMetadata`` JSON to its
    ``{modelId, modelVersion, modelProvider}`` shape, or return ``None``.
    """
    if raw is None:
        return None
    parsed = safe_json_parse(raw) if isinstance(raw, str) else raw
    if not isinstance(parsed, dict):
        return None
    return parsed


def _parse_object(raw: Any) -> Optional[dict]:
    """Decode a JSON-string-or-object attribute to its dict form, returning
    ``None`` for anything that doesn't end up a dict literal.
    """
    if raw is None:
        return None
    parsed = safe_json_parse(raw) if isinstance(raw, str) else raw
    if not isinstance(parsed, dict):
        return None
    return parsed


def _unpack_message_list(raw: Any) -> Optional[list]:
    """Project Mastra's processor ``messageList: {messages, systemMessages?}``
    shape into canonical messages. ``systemMessages`` (if present) is
    prepended as a leading system message; the main ``messages`` array is
    run through the OpenAI coercer (already understands
    ``[{role, content:[{type,text}]}]``).
    """
    if not isinstance(raw, dict):
        return None
    out: list = []
    sys = raw.get("systemMessages")
    if isinstance(sys, list):
        for entry in sys:
            if not isinstance(entry, dict):
                continue
            content = entry.get("content")
            if isinstance(content, str) and content:
                out.append(text_message("system", content))
            elif isinstance(content, list):
                coerced = coerce_to_messages([{"role": "system", "content": content}])
                if coerced:
                    out.extend(coerced)
    messages = raw.get("messages")
    if isinstance(messages, list):
        coerced = coerce_to_messages(messages)
        if coerced:
            out.extend(coerced)
    return out or None


def _coerce_or_wrap(raw: Any, role: str) -> Optional[list]:
    if raw is None:
        return None
    parsed = safe_json_parse(raw) if isinstance(raw, str) else raw
    if isinstance(parsed, list):
        coerced = coerce_to_messages(parsed)
        if coerced:
            return coerced
    text = raw if isinstance(raw, str) else _stringify(raw)
    if not text:
        return None
    return [text_message(role, text)]


def _gemini_to_canonical_message(item: Any) -> Optional[dict]:
    """Project a Gemini-shape message ``{role, parts:[{text}]}`` into canonical
    ``Message``. Mastra's ``model_step`` input is the array Mastra hands to
    the Google client verbatim, so the parts use Gemini's bare ``{text}``
    form rather than canonical ``{type:"text", content}``. Returns ``None``
    for unrecognised entries.
    """
    if not isinstance(item, dict):
        return None
    role = item.get("role")
    if not isinstance(role, str):
        return None
    parts_in = item.get("parts")
    if not isinstance(parts_in, list):
        coerced = coerce_to_messages([item])
        return coerced[0] if coerced else None
    parts_out: list = []
    for part in parts_in:
        if not isinstance(part, dict):
            continue
        if isinstance(part.get("type"), str):
            # Already canonical / typed — pass through.
            parts_out.append(part)
            continue
        text = part.get("text")
        if isinstance(text, str):
            parts_out.append(text_part(text))
            continue
        # Unknown shape — keep verbatim under a generic part so we don't drop data.
        unknown = {"type": "unknown"}
        unknown.update(part)
        parts_out.append(unknown)
    if not parts_out:
        return None
    return {"role": role, "parts": parts_out}


def _stringify(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, str):
        return v
    try:
        return _json.dumps(v)
    except Exception:
        return str(v)
