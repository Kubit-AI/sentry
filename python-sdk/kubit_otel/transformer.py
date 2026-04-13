"""
OTel ReadableSpan → Kubit JSON record transformer.

Converts OpenTelemetry SDK ReadableSpan objects into flat JSON-serialisable
dicts matching the Kubit analytics schema.

Two entity types are produced:
  - ``trace``                 one per unique trace_id (from root spans)
  - ``enriched_observation``  one per span (including root spans)
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional, Sequence

from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.trace import SpanKind, StatusCode

# ── OTel SpanKind → Kubit observation type ──────────────────────────────────

_SPAN_KIND_MAP = {
    SpanKind.INTERNAL: "SPAN",
    SpanKind.SERVER: "SPAN",
    SpanKind.CONSUMER: "SPAN",
    SpanKind.CLIENT: "GENERATION",
    SpanKind.PRODUCER: "GENERATION",
}

# ── OTel StatusCode → Kubit level ───────────────────────────────────────────

_STATUS_CODE_MAP = {
    StatusCode.UNSET: "DEFAULT",
    StatusCode.OK: "DEFAULT",
    StatusCode.ERROR: "ERROR",
}

# ── GenAI semantic convention attribute names ─────────────────────────────────

_GENAI_MODEL_ATTRS = ("gen_ai.response.model", "gen_ai.request.model")
_GENAI_INPUT_ATTRS = ("gen_ai.prompt", "gen_ai.content.prompt")
_GENAI_OUTPUT_ATTRS = ("gen_ai.completion", "gen_ai.content.completion")
_GENAI_INPUT_TOKENS = "gen_ai.usage.input_tokens"
_GENAI_OUTPUT_TOKENS = "gen_ai.usage.output_tokens"
_GENAI_COST = "gen_ai.usage.cost"

_GENAI_ALL_KEYS = (
    set(_GENAI_MODEL_ATTRS)
    | set(_GENAI_INPUT_ATTRS)
    | set(_GENAI_OUTPUT_ATTRS)
    | {_GENAI_INPUT_TOKENS, _GENAI_OUTPUT_TOKENS, _GENAI_COST}
)

# Resource attribute names
_RESOURCE_SESSION_ID = "session.id"
_RESOURCE_USER_ID = "enduser.id"
_RESOURCE_SERVICE_VERSION = "service.version"
_RESOURCE_DEPLOYMENT_ENV = "deployment.environment"


def transform_spans(spans: Sequence[ReadableSpan], wid: str) -> list[dict[str, Any]]:
    """
    Transform a batch of ReadableSpan objects into Kubit JSON records.

    Returns a list of dicts ready for serialisation and export.
    """
    records: list[dict[str, Any]] = []
    now_iso = _now_iso()
    emitted_traces: set[str] = set()

    for span in spans:
        resource_attrs = dict(span.resource.attributes) if span.resource else {}
        span_attrs = dict(span.attributes) if span.attributes else {}

        trace_id = format(span.context.trace_id, "032x")
        span_id = format(span.context.span_id, "016x")
        parent_id = (
            format(span.parent.span_id, "016x")
            if span.parent and span.parent.span_id
            else None
        )
        is_root = parent_id is None

        start_iso = _nanos_to_iso(span.start_time)
        end_iso = _nanos_to_iso(span.end_time)
        latency_ms = (
            (span.end_time - span.start_time) / 1_000_000
            if span.end_time and span.start_time
            else None
        )

        # Span attrs take priority over resource attrs for per-request values
        session_id = span_attrs.get(_RESOURCE_SESSION_ID) or resource_attrs.get(_RESOURCE_SESSION_ID)
        user_id = span_attrs.get(_RESOURCE_USER_ID) or resource_attrs.get(_RESOURCE_USER_ID)
        service_version = resource_attrs.get(_RESOURCE_SERVICE_VERSION)
        deployment_env = resource_attrs.get(_RESOURCE_DEPLOYMENT_ENV)

        # ── Trace record (once per trace_id, from root span) ─────────────
        if is_root and trace_id not in emitted_traces:
            emitted_traces.add(trace_id)
            metadata = dict(resource_attrs)
            records.append({
                "entity_type": "trace",
                "id": trace_id,
                "name": span.name,
                "project_id": wid,
                "wid": wid,
                "session_id": session_id,
                "user_id": user_id,
                "release": service_version,
                "version": service_version,
                "environment": deployment_env,
                "metadata": metadata if metadata else {},
                "tags": [],
                "input": None,
                "output": None,
                "public": False,
                "bookmarked": False,
                "timestamp": start_iso,
                "event_ts": start_iso,
                "created_at": now_iso,
                "updated_at": now_iso,
                "is_deleted": 0,
            })

        # ── Enriched observation record (every span) ─────────────────────
        model = _first_attr(span_attrs, _GENAI_MODEL_ATTRS)
        input_text = _first_attr(span_attrs, _GENAI_INPUT_ATTRS)
        output_text = _first_attr(span_attrs, _GENAI_OUTPUT_ATTRS)
        input_tokens = _safe_int(span_attrs.get(_GENAI_INPUT_TOKENS))
        output_tokens = _safe_int(span_attrs.get(_GENAI_OUTPUT_TOKENS))
        cost = _safe_float(span_attrs.get(_GENAI_COST))

        usage_details: dict[str, Any] = {}
        if input_tokens is not None:
            usage_details["input"] = input_tokens
        if output_tokens is not None:
            usage_details["output"] = output_tokens
        total_tokens = (
            (input_tokens or 0) + (output_tokens or 0)
            if (input_tokens or output_tokens)
            else None
        )
        if total_tokens is not None:
            usage_details["total"] = total_tokens

        obs_type = _SPAN_KIND_MAP.get(span.kind, "SPAN")
        if model:
            obs_type = "GENERATION"

        metadata = {k: v for k, v in span_attrs.items() if k not in _GENAI_ALL_KEYS}

        records.append({
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
            "trace_name": span.name if is_root else None,
            "release": service_version,
            "start_time": start_iso,
            "end_time": end_iso,
            "completion_start_time": None,
            "latency": latency_ms,
            "time_to_first_token": None,
            "model": model,
            "provided_model_name": span_attrs.get("gen_ai.request.model"),
            "internal_model_id": None,
            "model_parameters": None,
            "input": input_text,
            "output": output_text,
            "metadata": metadata if metadata else {},
            "provided_usage_details": usage_details if usage_details else {},
            "usage_details": usage_details if usage_details else {},
            "provided_cost_details": {},
            "cost_details": {},
            "total_cost": cost,
            "prompt_id": None,
            "prompt_name": None,
            "prompt_version": None,
            "tool_definitions": None,
            "tool_calls": None,
            "tool_call_names": None,
            "event_ts": start_iso,
            "created_at": now_iso,
            "updated_at": now_iso,
            "is_deleted": 0,
        })

    return records


# ── Helpers ──────────────────────────────────────────────────────────────────


def _nanos_to_iso(nanos: Optional[int]) -> str:
    if not nanos:
        return _now_iso()
    dt = datetime.fromtimestamp(nanos / 1e9, tz=timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def _now_iso() -> str:
    dt = datetime.now(tz=timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def _first_attr(attrs: dict, keys: tuple[str, ...]) -> Any:
    for key in keys:
        val = attrs.get(key)
        if val is not None:
            return val
    return None


def _safe_int(val: Any) -> Optional[int]:
    if val is None:
        return None
    try:
        return int(val)
    except (ValueError, TypeError):
        return None


def _safe_float(val: Any) -> Optional[float]:
    if val is None:
        return None
    try:
        return float(val)
    except (ValueError, TypeError):
        return None
