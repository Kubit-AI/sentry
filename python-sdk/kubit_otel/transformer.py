"""
OTel ReadableSpan → Kubit JSON record transformer.

Converts OpenTelemetry SDK ReadableSpan objects into flat JSON-serialisable
dicts matching the Kubit analytics schema.

Two entity types are produced:
  - ``trace``                 one per unique trace_id (from root spans)
  - ``enriched_observation``  one per span (including root spans)

Every span received is transformed — there is no scope/attribute based filter.
Consumers who only want a subset can filter at the OTel SpanProcessor level.

The transformer populates the canonical Kubit schema fields (model, input,
output, usage_details, cost_details, ...) from multiple source-attribute
aliases so spans from OpenAI, LangChain, LiteLLM, Anthropic, Langfuse-SDK,
OpenInference, Vercel AI SDK, etc. all land correctly without per-vendor code.
The full span + resource attribute maps are also embedded under ``attributes``
so nothing is lost for attributes we haven't aliased yet.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Optional, Sequence

from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.trace import SpanKind, StatusCode

logger = logging.getLogger(__name__)

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

# ── Canonical attribute alias lists ─────────────────────────────────────────
#
# First non-null wins. Order is priority: OTel GenAI semantic conventions
# first (most "standard"), then well-known vendor schemas.

_MODEL_ATTRS = (
    "gen_ai.response.model",
    "gen_ai.request.model",
    "llm.model_name",
    "llm.response.model",
    "model",
    "langfuse.observation.model",
    "ai.model",
)

_PROVIDED_MODEL_ATTRS = (
    "gen_ai.request.model",
    "llm.request.model",
    "langfuse.observation.provided_model_name",
    "model",
)

_INPUT_ATTRS = (
    "gen_ai.prompt",
    "gen_ai.content.prompt",
    "llm.input_messages",
    "llm.prompts",
    "input",
    "langfuse.observation.input",
    "ai.prompt",
)

_OUTPUT_ATTRS = (
    "gen_ai.completion",
    "gen_ai.content.completion",
    "llm.output_messages",
    "llm.completions",
    "output",
    "langfuse.observation.output",
    "ai.response",
)

_INPUT_TOKENS_ATTRS = (
    "gen_ai.usage.input_tokens",
    "gen_ai.usage.prompt_tokens",
    "llm.token_count.prompt",
    "llm.usage.prompt_tokens",
    "langfuse.observation.usage_details.input",
)

_OUTPUT_TOKENS_ATTRS = (
    "gen_ai.usage.output_tokens",
    "gen_ai.usage.completion_tokens",
    "llm.token_count.completion",
    "llm.usage.completion_tokens",
    "langfuse.observation.usage_details.output",
)

_TOTAL_TOKENS_ATTRS = (
    "gen_ai.usage.total_tokens",
    "llm.token_count.total",
    "llm.usage.total_tokens",
    "langfuse.observation.usage_details.total",
)

_INPUT_COST_ATTRS = (
    "gen_ai.usage.input_cost",
    "langfuse.observation.cost_details.input",
)

_OUTPUT_COST_ATTRS = (
    "gen_ai.usage.output_cost",
    "langfuse.observation.cost_details.output",
)

_TOTAL_COST_ATTRS = (
    "gen_ai.usage.cost",
    "gen_ai.usage.total_cost",
    "langfuse.observation.cost_details.total",
    "langfuse.observation.total_cost",
)

_SESSION_ID_ATTRS = ("session.id", "langfuse.session.id", "kubit.session.id")
_USER_ID_ATTRS = ("enduser.id", "user.id", "langfuse.user.id")
_TAGS_ATTRS = ("langfuse.trace.tags", "kubit.tags")
_COMPLETION_START_ATTRS = ("langfuse.observation.completion_start_time",)
_TIME_TO_FIRST_TOKEN_ATTRS = ("llm.time_to_first_token", "gen_ai.usage.time_to_first_token")
_PROMPT_ID_ATTRS = ("langfuse.observation.prompt_id",)
_PROMPT_NAME_ATTRS = ("langfuse.observation.prompt_name", "langfuse.prompt.name")
_PROMPT_VERSION_ATTRS = ("langfuse.observation.prompt_version", "langfuse.prompt.version")
_TOOL_CALLS_ATTRS = ("gen_ai.tool.calls", "langfuse.observation.tool_calls")
_TOOL_CALL_NAMES_ATTRS = ("gen_ai.tool.call_names", "langfuse.observation.tool_call_names")
_TOOL_DEFINITIONS_ATTRS = ("gen_ai.tool.definitions", "langfuse.observation.tool_definitions")
_MODEL_PARAMS_ATTRS = ("gen_ai.request.model_parameters", "langfuse.observation.model_parameters")

# Resource attribute names (fall-back when span-level isn't set)
_RESOURCE_SESSION_ID = "session.id"
_RESOURCE_USER_ID = "enduser.id"
_RESOURCE_SERVICE_VERSION = "service.version"
_RESOURCE_DEPLOYMENT_ENV = "deployment.environment"


def transform_spans(
    spans: Sequence[ReadableSpan],
    wid: str,
    wid_claim: str,
) -> list[dict[str, Any]]:
    """
    Transform a batch of ReadableSpan objects into Kubit JSON records.

    Returns a list of dicts ready for serialisation and export. Every span
    is transformed — no filtering by scope or attributes happens here.
    """
    records: list[dict[str, Any]] = []
    now_iso = _now_iso()
    emitted_traces: set[str] = set()
    dropped_oversize = 0

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

        start_iso = _nanos_to_iso(span.start_time)
        end_iso = _nanos_to_iso(span.end_time)
        latency_ms = (
            (span.end_time - span.start_time) / 1_000_000
            if span.end_time and span.start_time
            else None
        )

        # Span attrs take priority over resource attrs for per-request values
        session_id = (
            _first_attr(span_attrs, _SESSION_ID_ATTRS)
            or _first_attr(resource_attrs, _SESSION_ID_ATTRS)
        )
        user_id = (
            _first_attr(span_attrs, _USER_ID_ATTRS)
            or _first_attr(resource_attrs, _USER_ID_ATTRS)
        )
        service_version = resource_attrs.get(_RESOURCE_SERVICE_VERSION)
        deployment_env = resource_attrs.get(_RESOURCE_DEPLOYMENT_ENV)
        tags = _first_attr(span_attrs, _TAGS_ATTRS) or []

        full_attributes = {
            "span": span_attrs,
            "resource": resource_attrs,
            "scope": {"name": scope_name, "version": scope_version},
        }

        # ── Trace record (once per trace_id, from root span) ─────────────
        if is_root and trace_id not in emitted_traces:
            emitted_traces.add(trace_id)
            records.append(_with_claim({
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
                "metadata": dict(resource_attrs),
                "tags": tags,
                "input": _first_attr(span_attrs, _INPUT_ATTRS),
                "output": _first_attr(span_attrs, _OUTPUT_ATTRS),
                "public": False,
                "bookmarked": False,
                "timestamp": start_iso,
                "event_ts": start_iso,
                "created_at": now_iso,
                "updated_at": now_iso,
                "is_deleted": 0,
                "attributes": full_attributes,
            }))

        # ── Enriched observation record (every span) ─────────────────────
        model = _first_attr(span_attrs, _MODEL_ATTRS)
        provided_model_name = _first_attr(span_attrs, _PROVIDED_MODEL_ATTRS)
        input_text = _first_attr(span_attrs, _INPUT_ATTRS)
        output_text = _first_attr(span_attrs, _OUTPUT_ATTRS)
        input_tokens = _safe_int(_first_attr(span_attrs, _INPUT_TOKENS_ATTRS))
        output_tokens = _safe_int(_first_attr(span_attrs, _OUTPUT_TOKENS_ATTRS))
        total_tokens = _safe_int(_first_attr(span_attrs, _TOTAL_TOKENS_ATTRS))
        if total_tokens is None and (input_tokens or output_tokens):
            total_tokens = (input_tokens or 0) + (output_tokens or 0)

        input_cost = _safe_float(_first_attr(span_attrs, _INPUT_COST_ATTRS))
        output_cost = _safe_float(_first_attr(span_attrs, _OUTPUT_COST_ATTRS))
        total_cost = _safe_float(_first_attr(span_attrs, _TOTAL_COST_ATTRS))

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

        obs_type = _SPAN_KIND_MAP.get(span.kind, "SPAN")
        if model:
            obs_type = "GENERATION"

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
            "trace_name": span.name if is_root else None,
            "release": service_version,
            "start_time": start_iso,
            "end_time": end_iso,
            "completion_start_time": _first_attr(span_attrs, _COMPLETION_START_ATTRS),
            "latency": latency_ms,
            "time_to_first_token": _safe_int(_first_attr(span_attrs, _TIME_TO_FIRST_TOKEN_ATTRS)),
            "model": model,
            "provided_model_name": provided_model_name,
            "internal_model_id": None,
            "model_parameters": _first_attr(span_attrs, _MODEL_PARAMS_ATTRS),
            "input": input_text,
            "output": output_text,
            "metadata": dict(resource_attrs),
            "provided_usage_details": usage_details,
            "usage_details": usage_details,
            "provided_cost_details": cost_details,
            "cost_details": cost_details,
            "total_cost": total_cost,
            "prompt_id": _first_attr(span_attrs, _PROMPT_ID_ATTRS),
            "prompt_name": _first_attr(span_attrs, _PROMPT_NAME_ATTRS),
            "prompt_version": _safe_int(_first_attr(span_attrs, _PROMPT_VERSION_ATTRS)),
            "tool_definitions": _first_attr(span_attrs, _TOOL_DEFINITIONS_ATTRS),
            "tool_calls": _first_attr(span_attrs, _TOOL_CALLS_ATTRS),
            "tool_call_names": _first_attr(span_attrs, _TOOL_CALL_NAMES_ATTRS),
            "tags": tags,
            "event_ts": start_iso,
            "created_at": now_iso,
            "updated_at": now_iso,
            "is_deleted": 0,
            "attributes": full_attributes,
        }))

    logger.debug(
        "transformer spans_in=%d records_out=%d traces_emitted=%d dropped_oversize=%d",
        len(spans), len(records), len(emitted_traces), dropped_oversize,
    )
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
