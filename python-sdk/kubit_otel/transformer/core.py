"""Core ``transform_spans`` implementation.

Iterates framework adapters from the registry to build canonical alias lists
at import time, then runs the per-span record assembly in a single pass.
Adding support for a new emitter is a matter of dropping a new module into
``frameworks/`` and adding it to ``registry.FRAMEWORKS`` — no changes here.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Optional, Sequence

from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.trace import SpanKind, StatusCode

from .frameworks import (
    langfuse as _langfuse,
)
from .helpers import (
    first_attr,
    merge_json_blob,
    nanos_to_iso,
    now_iso,
    safe_float,
    safe_int,
)
from .messages import (
    canonicalize_gen_ai_events,
    safe_json_parse,
    stringify_for_text,
    text_part,
)
from .registry import DISCRIMINATOR_ORDER, FRAMEWORKS

logger = logging.getLogger(__name__)

# ── OTel SpanKind → Kubit observation type ──────────────────────────────────

_SPAN_KIND_MAP = {
    SpanKind.INTERNAL: "SPAN",
    SpanKind.SERVER: "SPAN",
    SpanKind.CONSUMER: "SPAN",
    SpanKind.CLIENT: "GENERATION",
    SpanKind.PRODUCER: "GENERATION",
}

_STATUS_CODE_MAP = {
    StatusCode.UNSET: "DEFAULT",
    StatusCode.OK: "DEFAULT",
    StatusCode.ERROR: "ERROR",
}

# OTel GenAI semconv event names. Conversation payloads shifted from
# flattened ``gen_ai.prompt.<i>.*`` attributes to per-message span events to
# dodge attribute-size limits and AnyValue nesting issues. Each input event
# implies a role via its name; ``gen_ai.choice`` carries the generated output.
_GEN_AI_INPUT_EVENT_ROLES = {
    "gen_ai.system.message": "system",
    "gen_ai.user.message": "user",
    "gen_ai.assistant.message": "assistant",
    "gen_ai.tool.message": "tool",
}
_GEN_AI_OUTPUT_EVENT_NAME = "gen_ai.choice"

# Langfuse lets apps set an explicit trace title that overrides whatever
# generic span name auto-instrumentation chose (e.g. ``POST /chat``). Used for
# both the trace record's ``name`` and the observation record's ``trace_name``.
_LANGFUSE_TRACE_NAME_ATTR = "langfuse.trace.name"


def _concat(attr_name: str) -> tuple[str, ...]:
    parts: list[str] = []
    for fw in FRAMEWORKS:
        parts.extend(getattr(fw, attr_name, ()))
    return tuple(parts)


def _concat_pairs(attr_name: str) -> tuple[tuple[str, str], ...]:
    parts: list[tuple[str, str]] = []
    for fw in FRAMEWORKS:
        parts.extend(getattr(fw, attr_name, ()))
    return tuple(parts)


# ── Canonical alias tuples (built at import time) ───────────────────────────

MODEL_ATTRS = _concat("MODEL_ATTRS")
PROVIDED_MODEL_ATTRS = _concat("PROVIDED_MODEL_ATTRS")
INPUT_ATTRS = _concat("INPUT_ATTRS")
OUTPUT_ATTRS = _concat("OUTPUT_ATTRS")
INPUT_TOKENS_ATTRS = _concat("INPUT_TOKENS_ATTRS")
OUTPUT_TOKENS_ATTRS = _concat("OUTPUT_TOKENS_ATTRS")
TOTAL_TOKENS_ATTRS = _concat("TOTAL_TOKENS_ATTRS")
INPUT_COST_ATTRS = _concat("INPUT_COST_ATTRS")
OUTPUT_COST_ATTRS = _concat("OUTPUT_COST_ATTRS")
TOTAL_COST_ATTRS = _concat("TOTAL_COST_ATTRS")
SESSION_ID_ATTRS = _concat("SESSION_ID_ATTRS")
USER_ID_ATTRS = _concat("USER_ID_ATTRS")
TAGS_ATTRS = _concat("TAGS_ATTRS")
TIME_TO_FIRST_TOKEN_ATTRS = _concat("TIME_TO_FIRST_TOKEN_ATTRS")
TOOL_CALLS_ATTRS = _concat("TOOL_CALLS_ATTRS")
TOOL_CALL_NAMES_ATTRS = _concat("TOOL_CALL_NAMES_ATTRS")
TOOL_DEFINITIONS_ATTRS = _concat("TOOL_DEFINITIONS_ATTRS")
PROVIDER_ATTRS = _concat("PROVIDER_ATTRS")
AGENT_NAME_ATTRS = _concat("AGENT_NAME_ATTRS")
AGENT_ID_ATTRS = _concat("AGENT_ID_ATTRS")
AGENT_VERSION_ATTRS = _concat("AGENT_VERSION_ATTRS")
TOOL_NAME_ATTRS = _concat("TOOL_NAME_ATTRS")
SYSTEM_INSTRUCTIONS_ATTRS = _concat("SYSTEM_INSTRUCTIONS_ATTRS")
PARAMS_BLOB_ATTRS = _concat("PARAMS_BLOB_ATTRS")
ENVIRONMENT_ATTRS = _concat("ENVIRONMENT_ATTRS")
RELEASE_ATTRS = _concat("RELEASE_ATTRS")
CACHE_TOKEN_MAP = _concat_pairs("CACHE_TOKEN_MAP")

# Resource attribute names (fall-back when span-level isn't set).
_RESOURCE_SERVICE_VERSION = "service.version"
_RESOURCE_DEPLOYMENT_ENV = "deployment.environment"


def transform_spans(
    spans: Sequence[ReadableSpan],
    wid: str,
    wid_claim: str,
) -> list[dict[str, Any]]:
    """Transform a batch of ReadableSpan objects into Kubit JSON records.

    Returns a list of dicts ready for serialisation and export. Every span
    is transformed — no filtering by scope or attributes happens here.
    """
    records: list[dict[str, Any]] = []
    now = now_iso()
    emitted_traces: set[str] = set()

    # Root detection is purely OTel-local: a span is a root when its OTel
    # parent context is empty. Cross-batch flushing is the norm — short
    # children commonly end (and flush) before their long-running parent —
    # so a per-batch "parent not in this batch" check would misclassify
    # those as roots and emit duplicate ``trace`` rows. Surviving children
    # of a filtered HTTP/server parent will carry a dangling
    # ``parent_observation_id`` until ingestion-side reconciliation clears it.

    def _with_claim(rec: dict[str, Any]) -> dict[str, Any]:
        rec["_wid_claim"] = wid_claim
        return rec

    for span in spans:
        resource_attrs = dict(span.resource.attributes) if span.resource else {}
        span_attrs = dict(span.attributes) if span.attributes else {}
        scope_name = (
            span.instrumentation_scope.name if span.instrumentation_scope else None
        )
        scope_version = (
            span.instrumentation_scope.version if span.instrumentation_scope else None
        )

        trace_id = format(span.context.trace_id, "032x")
        span_id = format(span.context.span_id, "016x")
        parent_id = (
            format(span.parent.span_id, "016x")
            if span.parent and span.parent.span_id
            else None
        )
        is_root = parent_id is None

        start_iso = nanos_to_iso(span.start_time)
        end_iso = nanos_to_iso(span.end_time)
        latency_ms = (
            (span.end_time - span.start_time) / 1_000_000
            if span.end_time and span.start_time
            else None
        )

        # Span attrs take priority over resource attrs for per-request values.
        session_id = (
            first_attr(span_attrs, SESSION_ID_ATTRS)
            or first_attr(resource_attrs, SESSION_ID_ATTRS)
        )
        user_id = (
            first_attr(span_attrs, USER_ID_ATTRS)
            or first_attr(resource_attrs, USER_ID_ATTRS)
        )
        service_version = (
            first_attr(span_attrs, RELEASE_ATTRS)
            or resource_attrs.get(_RESOURCE_SERVICE_VERSION)
        )
        deployment_env = (
            first_attr(span_attrs, ENVIRONMENT_ATTRS)
            or resource_attrs.get(_RESOURCE_DEPLOYMENT_ENV)
        )
        tags = first_attr(span_attrs, TAGS_ATTRS) or []

        full_attributes = {
            "span": span_attrs,
            "resource": resource_attrs,
            "scope": {"name": scope_name, "version": scope_version},
        }

        metadata: dict[str, Any] = dict(resource_attrs)
        for fw in FRAMEWORKS:
            enrich = getattr(fw, "enrich_metadata", None)
            if enrich is not None:
                enrich(span_attrs, metadata)

        event_input, event_output = _unpack_gen_ai_events(span)
        canonical_messages = _resolve_canonical_messages(span_attrs, span)
        trace_name_override = span_attrs.get(_LANGFUSE_TRACE_NAME_ATTR)

        if is_root and trace_id not in emitted_traces:
            emitted_traces.add(trace_id)
            records.append(_with_claim({
                "entity_type": "trace",
                "id": trace_id,
                "name": trace_name_override or span.name,
                "project_id": wid,
                "wid": wid,
                "session_id": session_id,
                "user_id": user_id,
                "release": service_version,
                "version": service_version,
                "environment": deployment_env,
                "metadata": dict(metadata),
                "tags": tags,
                "input": canonical_messages["input"],
                "output": canonical_messages["output"],
                "input_messages_raw": _resolve_input(span_attrs) or event_input,
                "output_messages_raw": _resolve_output(span_attrs) or event_output,
                "public": False,
                "bookmarked": False,
                "timestamp": start_iso,
                "event_ts": start_iso,
                "created_at": now,
                "updated_at": now,
                "is_deleted": 0,
                "attributes": full_attributes,
            }))

        # ── Enriched observation record (every span) ─────────────────────
        model = first_attr(span_attrs, MODEL_ATTRS)
        provided_model_name = first_attr(span_attrs, PROVIDED_MODEL_ATTRS)
        input_text = _resolve_input(span_attrs) or event_input
        output_text = _resolve_output(span_attrs) or event_output
        input_tokens = safe_int(first_attr(span_attrs, INPUT_TOKENS_ATTRS))
        output_tokens = safe_int(first_attr(span_attrs, OUTPUT_TOKENS_ATTRS))
        total_tokens = safe_int(first_attr(span_attrs, TOTAL_TOKENS_ATTRS))

        input_cost = safe_float(first_attr(span_attrs, INPUT_COST_ATTRS))
        output_cost = safe_float(first_attr(span_attrs, OUTPUT_COST_ATTRS))
        total_cost = safe_float(first_attr(span_attrs, TOTAL_COST_ATTRS))

        usage_details: dict[str, Any] = {}
        if input_tokens is not None:
            usage_details["input"] = input_tokens
        if output_tokens is not None:
            usage_details["output"] = output_tokens
        if total_tokens is not None:
            usage_details["total"] = total_tokens

        cost_details: dict[str, Any] = {}
        if input_cost is not None:
            cost_details["input"] = input_cost
        if output_cost is not None:
            cost_details["output"] = output_cost
        if total_cost is not None:
            cost_details["total"] = total_cost

        # Framework-specific usage/cost JSON blobs. Canonical per-key values
        # above win on collision; blob values fill remaining keys.
        for fw in FRAMEWORKS:
            parse_usage = getattr(fw, "parse_usage_blobs", None)
            if parse_usage is not None:
                parse_usage(span_attrs, usage_details)
            parse_cost = getattr(fw, "parse_cost_blobs", None)
            if parse_cost is not None:
                parse_cost(span_attrs, cost_details)

        # Cross-vendor cache / reasoning tokens mapped to canonical keys.
        for src_attr, canonical_key in CACHE_TOKEN_MAP:
            if canonical_key in usage_details:
                continue
            val = safe_int(span_attrs.get(src_attr))
            if val is not None:
                usage_details[canonical_key] = val

        if "total" not in usage_details and (
            "input" in usage_details or "output" in usage_details
        ):
            usage_details["total"] = (
                (usage_details.get("input") or 0)
                + (usage_details.get("output") or 0)
            )

        if total_cost is None and "total" in cost_details:
            total_cost = safe_float(cost_details["total"])

        model_parameters = _build_model_parameters(span_attrs)
        obs_type = _resolve_observation_type(span, span_attrs, model)
        provider = _resolve_provider(span_attrs)

        records.append(_with_claim({
            "entity_type": "enriched_observation",
            "id": span_id,
            "trace_id": trace_id,
            "parent_observation_id": parent_id,
            "name": span.name,
            "type": obs_type,
            "project_id": wid,
            "wid": wid,
            "level": _STATUS_CODE_MAP.get(span.status.status_code, "DEFAULT"),
            "status_message": span.status.description or None,
            "version": service_version,
            "environment": deployment_env,
            "session_id": session_id,
            "user_id": user_id,
            "trace_name": (trace_name_override or span.name) if is_root else None,
            "release": service_version,
            "start_time": start_iso,
            "end_time": end_iso,
            "completion_start_time": first_attr(span_attrs, _langfuse.COMPLETION_START_ATTRS),
            "latency": latency_ms,
            "time_to_first_token": safe_int(first_attr(span_attrs, TIME_TO_FIRST_TOKEN_ATTRS)),
            "model": model,
            "provided_model_name": provided_model_name,
            "internal_model_id": None,
            "model_parameters": model_parameters,
            "provider": provider,
            "agent_name": first_attr(span_attrs, AGENT_NAME_ATTRS),
            "agent_id": first_attr(span_attrs, AGENT_ID_ATTRS),
            "agent_version": first_attr(span_attrs, AGENT_VERSION_ATTRS),
            "tool_name": first_attr(span_attrs, TOOL_NAME_ATTRS),
            "system_instructions": first_attr(span_attrs, SYSTEM_INSTRUCTIONS_ATTRS),
            "input": canonical_messages["input"],
            "output": canonical_messages["output"],
            "input_messages_raw": input_text,
            "output_messages_raw": output_text,
            "metadata": dict(metadata),
            "provided_usage_details": usage_details,
            "usage_details": usage_details,
            "provided_cost_details": cost_details,
            "cost_details": cost_details,
            "total_cost": total_cost,
            "prompt_id": first_attr(span_attrs, _langfuse.PROMPT_ID_ATTRS),
            "prompt_name": first_attr(span_attrs, _langfuse.PROMPT_NAME_ATTRS),
            "prompt_version": safe_int(first_attr(span_attrs, _langfuse.PROMPT_VERSION_ATTRS)),
            "tool_definitions": _aggregate_tool_definitions(span_attrs)
                                or first_attr(span_attrs, TOOL_DEFINITIONS_ATTRS),
            "tool_calls": first_attr(span_attrs, TOOL_CALLS_ATTRS)
                          or _derive_tool_calls_from_messages(canonical_messages["output"]),
            "tool_call_names": first_attr(span_attrs, TOOL_CALL_NAMES_ATTRS)
                               or _derive_tool_call_names_from_messages(canonical_messages["output"]),
            "tags": tags,
            "event_ts": start_iso,
            "created_at": now,
            "updated_at": now,
            "is_deleted": 0,
            "attributes": full_attributes,
        }))

    logger.debug(
        "transformer spans_in=%d records_out=%d traces_emitted=%d",
        len(spans), len(records), len(emitted_traces),
    )
    return records


def _unpack_gen_ai_events(span: Any) -> tuple[Optional[str], Optional[str]]:
    """Reconstruct input/output arrays from OTel GenAI span events.

    Attribute-size limits and the shift to event-based payload logging mean
    some emitters (current OTel semconv, LangSmith, Logfire) put conversation
    messages on span events rather than as flattened ``gen_ai.prompt.<i>.*``
    attributes. Returns ``(input_json, output_json)`` where each is a JSON
    string suitable for the canonical ``input``/``output`` fields, or
    ``None`` when no matching events are present.
    """
    events = getattr(span, "events", None) or ()
    inputs: list[tuple[int, dict]] = []
    outputs: list[tuple[int, dict]] = []
    for i, ev in enumerate(events):
        name = getattr(ev, "name", None)
        ts = getattr(ev, "timestamp", None) or i
        attrs = dict(getattr(ev, "attributes", None) or {})
        role = _GEN_AI_INPUT_EVENT_ROLES.get(name)
        if role is not None:
            attrs.setdefault("role", role)
            inputs.append((ts, attrs))
            continue
        if name == _GEN_AI_OUTPUT_EVENT_NAME:
            outputs.append((ts, attrs))
    input_str = (
        json.dumps([m for _, m in sorted(inputs, key=lambda p: p[0])])
        if inputs else None
    )
    output_str = (
        json.dumps([m for _, m in sorted(outputs, key=lambda p: p[0])])
        if outputs else None
    )
    return input_str, output_str


def _resolve_input(span_attrs: dict) -> Any:
    val = first_attr(span_attrs, INPUT_ATTRS)
    if val is not None:
        return val
    # Fall back to framework-specific indexed-message reconstruction.
    for fw in FRAMEWORKS:
        unpack = getattr(fw, "unpack_messages", None)
        if unpack is None:
            continue
        unpacked_in, _ = unpack(span_attrs)
        if unpacked_in is not None:
            return unpacked_in
    return None


def _resolve_output(span_attrs: dict) -> Any:
    val = first_attr(span_attrs, OUTPUT_ATTRS)
    if val is not None:
        return val
    for fw in FRAMEWORKS:
        unpack = getattr(fw, "unpack_messages", None)
        if unpack is None:
            continue
        _, unpacked_out = unpack(span_attrs)
        if unpacked_out is not None:
            return unpacked_out
    return None


def _resolve_observation_type(span: Any, span_attrs: dict, model: Any) -> str:
    """Resolve Kubit observation type by consulting each adapter in discriminator order.

    First non-empty resolver wins. When none fires, a resolved ``model``
    forces ``GENERATION``; otherwise the OTel ``SpanKind`` map is consulted
    as the final fallback.
    """
    for fw in DISCRIMINATOR_ORDER:
        resolve = getattr(fw, "resolve_observation_type", None)
        if resolve is None:
            continue
        result = resolve(span_attrs)
        if result:
            return result
    # Fallback chain: last-resort discriminators (e.g. Traceloop's
    # ``llm.request.type``) that must lose to standard ``gen_ai.operation.name``.
    for fw in DISCRIMINATOR_ORDER:
        resolve = getattr(fw, "resolve_observation_type_fallback", None)
        if resolve is None:
            continue
        result = resolve(span_attrs)
        if result:
            return result
    if model:
        return "GENERATION"
    return _SPAN_KIND_MAP.get(span.kind, "SPAN")


def _resolve_provider(span_attrs: dict) -> Optional[str]:
    """Return the provider/system id.

    Adapter-specific ``resolve_provider`` hooks fire first (e.g. Vercel's
    dotted-value normalisation); otherwise falls through to the first
    PROVIDER_ATTRS hit.
    """
    for fw in FRAMEWORKS:
        resolve = getattr(fw, "resolve_provider", None)
        if resolve is None:
            continue
        resolved = resolve(span_attrs)
        if resolved:
            return resolved
    for attr in PROVIDER_ATTRS:
        val = span_attrs.get(attr)
        if val is None:
            continue
        return val if isinstance(val, str) else str(val)
    return None


def _aggregate_tool_definitions(span_attrs: dict) -> Optional[list]:
    """Aggregate ``tool_definitions`` from non-blob sources (e.g. indexed
    ``llm.tools.<n>.tool.json_schema``). First non-empty adapter result wins;
    falls back to ``first_attr(TOOL_DEFINITIONS_ATTRS)`` in the caller.
    """
    for fw in FRAMEWORKS:
        agg = getattr(fw, "aggregate_tool_definitions", None)
        if agg is None:
            continue
        result = agg(span_attrs)
        if result:
            return result
    return None


def _derive_tool_calls_from_messages(messages: Optional[list]) -> Optional[list]:
    """Derive ``tool_calls`` from canonical output messages when no adapter
    exposed a dedicated attribute. Walks every assistant message's parts and
    collects the discriminated ``tool_call`` parts as-is. Returns ``None``
    when nothing was found so the caller's fallback chain stays clean.
    """
    if not messages:
        return None
    out: list = []
    for m in messages:
        if m.get("role") != "assistant":
            continue
        for p in m.get("parts", []):
            if isinstance(p, dict) and p.get("type") == "tool_call":
                out.append(p)
    return out if out else None


def _derive_tool_call_names_from_messages(messages: Optional[list]) -> Optional[list]:
    calls = _derive_tool_calls_from_messages(messages)
    if not calls:
        return None
    names = [tc.get("name") for tc in calls if isinstance(tc.get("name"), str)]
    return names if names else None


def _resolve_canonical_messages(span_attrs: dict, span: Any) -> dict:
    """Build the canonical OTel GenAI v2 message arrays for both directions.

    Priority order:
      1. Each adapter's ``normalize_messages`` hook (registry order; per-side
         first-non-null wins so a Vercel input + Langfuse output combo works).
      2. Span-event fallback for emitters that put messages on
         ``gen_ai.user.message`` / ``gen_ai.choice`` / etc. events rather than
         attributes.
      3. ``gen_ai.system_instructions`` injection: prepended as the leading
         ``role: "system"`` message when not already present at head of input.

    No fallback text-wraps the legacy raw INPUT_ATTRS / OUTPUT_ATTRS value:
    those attrs may carry opaque entity blobs (e.g. ``traceloop.entity.input``
    with ``{inputs, tags, metadata, kwargs}``), and synthesizing a single fake
    ``[{role:"user", parts:[text:<blob>]}]`` envelope misrepresents non-
    conversational data as a chat turn. Adapters that want a text fallback
    (e.g. legacy ``gen_ai.prompt`` strings) emit it from their own
    ``normalize_messages`` hook.
    """
    input_msgs: Optional[list] = None
    output_msgs: Optional[list] = None

    for fw in FRAMEWORKS:
        if input_msgs is not None and output_msgs is not None:
            break
        normalize = getattr(fw, "normalize_messages", None)
        if normalize is None:
            continue
        result = normalize(span_attrs)
        if not result:
            continue
        if input_msgs is None and result.get("input") is not None:
            input_msgs = result["input"]
        if output_msgs is None and result.get("output") is not None:
            output_msgs = result["output"]

    if input_msgs is None or output_msgs is None:
        ev = canonicalize_gen_ai_events(getattr(span, "events", None))
        if input_msgs is None:
            input_msgs = ev["input"]
        if output_msgs is None:
            output_msgs = ev["output"]

    sys_msg = _parse_system_instructions(span_attrs.get("gen_ai.system_instructions"))
    if sys_msg is not None:
        if not input_msgs or input_msgs[0].get("role") != "system":
            input_msgs = [sys_msg] + (input_msgs or [])

    return {"input": input_msgs, "output": output_msgs}


def _parse_system_instructions(raw: Any) -> Optional[dict]:
    """Parse ``gen_ai.system_instructions`` into a canonical ``system`` message.

    Spec form is an array of parts (e.g. ``[{"type": "text", "content": "..."}]``);
    tolerates plain-string emitters (wraps as a single TextPart) and
    JSON-stringified arrays.
    """
    if raw is None:
        return None
    value: Any = raw
    if isinstance(raw, str):
        parsed = safe_json_parse(raw)
        value = parsed if parsed is not None else raw
    if isinstance(value, list):
        parts: list = []
        for item in value:
            if isinstance(item, str):
                parts.append(text_part(item))
            elif isinstance(item, dict) and isinstance(item.get("type"), str):
                parts.append(item)
            elif item is not None:
                parts.append(text_part(stringify_for_text(item)))
        if not parts:
            return None
        return {"role": "system", "parts": parts}
    if isinstance(value, str) and value:
        return {"role": "system", "parts": [text_part(value)]}
    return None


def _build_model_parameters(span_attrs: dict) -> Any:
    """Compose a merged ``model_parameters`` value.

    Blob sources (Langfuse v3/v4) parsed first; flat ``gen_ai.request.*``
    attrs (otel_genai) added for any key still missing; Vercel
    ``ai.request.*`` camelCase attrs remapped to snake_case similarly.
    Falls back to the legacy first-match string when nothing else resolved.
    """
    merged: dict[str, Any] = {}
    for attr in PARAMS_BLOB_ATTRS:
        merge_json_blob(span_attrs.get(attr), merged)

    for fw in FRAMEWORKS:
        builder = getattr(fw, "build_params", None)
        if builder is None:
            continue
        builder(span_attrs, merged)

    if merged:
        return merged
    return first_attr(span_attrs, PARAMS_BLOB_ATTRS)
