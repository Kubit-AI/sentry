/**
 * OTel ReadableSpan → Kubit JSON record transformer.
 *
 * Converts OpenTelemetry SDK ReadableSpan objects into flat JSON-serialisable
 * objects matching the Kubit analytics schema.
 *
 * Two entity types are produced:
 *   - `trace`                 one per unique trace_id (from root spans)
 *   - `enriched_observation`  one per span (including root spans)
 */

import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

// ── OTel SpanKind → Kubit observation type ──────────────────────────────────

const SPAN_KIND_MAP: Record<number, string> = {
  [SpanKind.INTERNAL]: "SPAN",
  [SpanKind.SERVER]: "SPAN",
  [SpanKind.CONSUMER]: "SPAN",
  [SpanKind.CLIENT]: "GENERATION",
  [SpanKind.PRODUCER]: "GENERATION",
};

// ── OTel StatusCode → Kubit level ───────────────────────────────────────────

const STATUS_CODE_MAP: Record<number, string> = {
  [SpanStatusCode.UNSET]: "DEFAULT",
  [SpanStatusCode.OK]: "DEFAULT",
  [SpanStatusCode.ERROR]: "ERROR",
};

// ── GenAI semantic convention attribute names ───────────────────────────────

const GENAI_MODEL_ATTRS = ["gen_ai.response.model", "gen_ai.request.model"];
const GENAI_INPUT_ATTRS = ["gen_ai.prompt", "gen_ai.content.prompt"];
const GENAI_OUTPUT_ATTRS = ["gen_ai.completion", "gen_ai.content.completion"];
const GENAI_INPUT_TOKENS = "gen_ai.usage.input_tokens";
const GENAI_OUTPUT_TOKENS = "gen_ai.usage.output_tokens";
const GENAI_COST = "gen_ai.usage.cost";

const GENAI_ALL_KEYS = new Set([
  ...GENAI_MODEL_ATTRS,
  ...GENAI_INPUT_ATTRS,
  ...GENAI_OUTPUT_ATTRS,
  GENAI_INPUT_TOKENS,
  GENAI_OUTPUT_TOKENS,
  GENAI_COST,
]);

// Resource attribute names
const RESOURCE_SESSION_ID = "session.id";
const RESOURCE_USER_ID = "enduser.id";
const RESOURCE_SERVICE_VERSION = "service.version";
const RESOURCE_DEPLOYMENT_ENV = "deployment.environment";

export interface KubitRecord {
  entity_type: string;
  id: string;
  wid: string;
  [key: string]: unknown;
}

/**
 * Transform a batch of ReadableSpan objects into Kubit JSON records.
 *
 * Returns a list of objects ready for serialisation and export.
 */
export function transformSpans(
  spans: ReadableSpan[],
  wid: string,
  widClaim: string
): KubitRecord[] {
  const records: KubitRecord[] = [];
  const nowIso = nowIsoString();
  const emittedTraces = new Set<string>();

  const withClaim = (rec: KubitRecord): KubitRecord => {
    (rec as Record<string, unknown>)._wid_claim = widClaim;
    return rec;
  };

  for (const span of spans) {
    const resourceAttrs: Record<string, unknown> =
      span.resource?.attributes ?? {};
    const spanAttrs: Record<string, unknown> = span.attributes ?? {};

    const traceId = span.spanContext().traceId;
    const spanId = span.spanContext().spanId;
    const parentId = span.parentSpanId || null;
    const isRoot = !parentId;

    const startIso = hrtimeToIso(span.startTime);
    const endIso = hrtimeToIso(span.endTime);
    const latencyMs =
      span.endTime && span.startTime
        ? hrtimeDiffMs(span.startTime, span.endTime)
        : null;

    // Span attrs take priority over resource attrs for per-request values
    const sessionId = (spanAttrs[RESOURCE_SESSION_ID] ?? resourceAttrs[RESOURCE_SESSION_ID]) as string | undefined;
    const userId = (spanAttrs[RESOURCE_USER_ID] ?? resourceAttrs[RESOURCE_USER_ID]) as string | undefined;
    const serviceVersion = resourceAttrs[RESOURCE_SERVICE_VERSION] as
      | string
      | undefined;
    const deploymentEnv = resourceAttrs[RESOURCE_DEPLOYMENT_ENV] as
      | string
      | undefined;

    // ── Trace record (once per trace_id, from root span) ────────────────
    if (isRoot && !emittedTraces.has(traceId)) {
      emittedTraces.add(traceId);
      const metadata: Record<string, unknown> = { ...resourceAttrs };

      records.push(withClaim({
        entity_type: "trace",
        id: traceId,
        name: span.name,
        project_id: wid,
        wid,
        session_id: sessionId ?? null,
        user_id: userId ?? null,
        release: serviceVersion ?? null,
        version: serviceVersion ?? null,
        environment: deploymentEnv ?? null,
        metadata,
        tags: [],
        input: null,
        output: null,
        public: false,
        bookmarked: false,
        timestamp: startIso,
        event_ts: startIso,
        created_at: nowIso,
        updated_at: nowIso,
        is_deleted: 0,
      }));
    }

    // ── Enriched observation record (every span) ────────────────────────
    const model = firstAttr(spanAttrs, GENAI_MODEL_ATTRS);
    const inputText = firstAttr(spanAttrs, GENAI_INPUT_ATTRS);
    const outputText = firstAttr(spanAttrs, GENAI_OUTPUT_ATTRS);
    const inputTokens = safeInt(spanAttrs[GENAI_INPUT_TOKENS]);
    const outputTokens = safeInt(spanAttrs[GENAI_OUTPUT_TOKENS]);
    const cost = safeFloat(spanAttrs[GENAI_COST]);

    const usageDetails: Record<string, number> = {};
    if (inputTokens != null) usageDetails.input = inputTokens;
    if (outputTokens != null) usageDetails.output = outputTokens;
    const totalTokens =
      inputTokens != null || outputTokens != null
        ? (inputTokens ?? 0) + (outputTokens ?? 0)
        : null;
    if (totalTokens != null) usageDetails.total = totalTokens;

    let obsType = SPAN_KIND_MAP[span.kind] ?? "SPAN";
    if (model) obsType = "GENERATION";

    const metadata: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(spanAttrs)) {
      if (!GENAI_ALL_KEYS.has(k)) metadata[k] = v;
    }

    records.push(withClaim({
      entity_type: "enriched_observation",
      id: spanId,
      trace_id: traceId,
      parent_observation_id: parentId,
      name: span.name,
      type: obsType,
      project_id: wid,
      wid,
      level: STATUS_CODE_MAP[span.status.code] ?? "DEFAULT",
      status_message: span.status.message ?? null,
      version: serviceVersion ?? null,
      environment: deploymentEnv ?? null,
      session_id: sessionId ?? null,
      user_id: userId ?? null,
      trace_name: isRoot ? span.name : null,
      release: serviceVersion ?? null,
      start_time: startIso,
      end_time: endIso,
      completion_start_time: null,
      latency: latencyMs,
      time_to_first_token: null,
      model: model ?? null,
      provided_model_name:
        (spanAttrs["gen_ai.request.model"] as string) ?? null,
      internal_model_id: null,
      model_parameters: null,
      input: inputText ?? null,
      output: outputText ?? null,
      metadata,
      provided_usage_details:
        Object.keys(usageDetails).length > 0 ? usageDetails : {},
      usage_details: Object.keys(usageDetails).length > 0 ? usageDetails : {},
      provided_cost_details: {},
      cost_details: {},
      total_cost: cost ?? null,
      prompt_id: null,
      prompt_name: null,
      prompt_version: null,
      tool_definitions: null,
      tool_calls: null,
      tool_call_names: null,
      event_ts: startIso,
      created_at: nowIso,
      updated_at: nowIso,
      is_deleted: 0,
    }));
  }

  return records;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Convert OTel HrTime [seconds, nanos] to ISO string with ms precision. */
function hrtimeToIso(hrtime: [number, number]): string {
  const ms = hrtime[0] * 1000 + hrtime[1] / 1_000_000;
  return new Date(ms).toISOString();
}

function hrtimeDiffMs(
  start: [number, number],
  end: [number, number]
): number {
  const startMs = start[0] * 1000 + start[1] / 1_000_000;
  const endMs = end[0] * 1000 + end[1] / 1_000_000;
  return endMs - startMs;
}

function nowIsoString(): string {
  return new Date().toISOString();
}

function firstAttr(
  attrs: Record<string, unknown>,
  keys: string[]
): unknown | null {
  for (const key of keys) {
    if (attrs[key] != null) return attrs[key];
  }
  return null;
}

function safeInt(val: unknown): number | null {
  if (val == null) return null;
  const n = Number(val);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function safeFloat(val: unknown): number | null {
  if (val == null) return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}
