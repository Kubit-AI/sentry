/**
 * OTel ReadableSpan → Kubit JSON record transformer.
 *
 * Converts OpenTelemetry SDK ReadableSpan objects into flat JSON-serialisable
 * objects matching the Kubit analytics schema.
 *
 * Two entity types are produced:
 *   - `trace`                 one per unique trace_id (from root spans)
 *   - `enriched_observation`  one per span (including root spans)
 *
 * Every span received is transformed — there is no scope/attribute based filter.
 * Consumers who only want a subset can filter at the OTel SpanProcessor level.
 *
 * The transformer populates the canonical Kubit schema fields (model, input,
 * output, usage_details, cost_details, ...) from multiple source-attribute
 * aliases so spans from OpenAI, LangChain, LiteLLM, Anthropic, Langfuse-SDK,
 * OpenInference, Vercel AI SDK, etc. all land correctly without per-vendor code.
 * The full span + resource attribute maps are also embedded under `attributes`
 * so nothing is lost for attributes we haven't aliased yet.
 */

import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

import { logger } from "./logger";

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

// ── Canonical attribute alias lists ─────────────────────────────────────────
//
// First non-null wins. Order is priority: OTel GenAI semantic conventions
// first (most "standard"), then well-known vendor schemas.

const MODEL_ATTRS = [
  "gen_ai.response.model",
  "gen_ai.request.model",
  "llm.model_name",
  "llm.response.model",
  "model",
  "langfuse.observation.model",
  "ai.model",
] as const;

const PROVIDED_MODEL_ATTRS = [
  "gen_ai.request.model",
  "llm.request.model",
  "langfuse.observation.provided_model_name",
  "model",
] as const;

const INPUT_ATTRS = [
  "gen_ai.prompt",
  "gen_ai.content.prompt",
  "llm.input_messages",
  "llm.prompts",
  "input",
  "langfuse.observation.input",
  "ai.prompt",
] as const;

const OUTPUT_ATTRS = [
  "gen_ai.completion",
  "gen_ai.content.completion",
  "llm.output_messages",
  "llm.completions",
  "output",
  "langfuse.observation.output",
  "ai.response",
] as const;

const INPUT_TOKENS_ATTRS = [
  "gen_ai.usage.input_tokens",
  "gen_ai.usage.prompt_tokens",
  "llm.token_count.prompt",
  "llm.usage.prompt_tokens",
  "langfuse.observation.usage_details.input",
] as const;

const OUTPUT_TOKENS_ATTRS = [
  "gen_ai.usage.output_tokens",
  "gen_ai.usage.completion_tokens",
  "llm.token_count.completion",
  "llm.usage.completion_tokens",
  "langfuse.observation.usage_details.output",
] as const;

const TOTAL_TOKENS_ATTRS = [
  "gen_ai.usage.total_tokens",
  "llm.token_count.total",
  "llm.usage.total_tokens",
  "langfuse.observation.usage_details.total",
] as const;

const INPUT_COST_ATTRS = [
  "gen_ai.usage.input_cost",
  "langfuse.observation.cost_details.input",
] as const;

const OUTPUT_COST_ATTRS = [
  "gen_ai.usage.output_cost",
  "langfuse.observation.cost_details.output",
] as const;

const TOTAL_COST_ATTRS = [
  "gen_ai.usage.cost",
  "gen_ai.usage.total_cost",
  "langfuse.observation.cost_details.total",
  "langfuse.observation.total_cost",
] as const;

const SESSION_ID_ATTRS = ["session.id", "langfuse.session.id", "kubit.session.id"] as const;
const USER_ID_ATTRS = ["enduser.id", "user.id", "langfuse.user.id"] as const;
const TAGS_ATTRS = ["langfuse.trace.tags", "kubit.tags"] as const;
const COMPLETION_START_ATTRS = ["langfuse.observation.completion_start_time"] as const;
const TIME_TO_FIRST_TOKEN_ATTRS = [
  "llm.time_to_first_token",
  "gen_ai.usage.time_to_first_token",
] as const;
const PROMPT_ID_ATTRS = ["langfuse.observation.prompt_id"] as const;
const PROMPT_NAME_ATTRS = ["langfuse.observation.prompt_name", "langfuse.prompt.name"] as const;
const PROMPT_VERSION_ATTRS = [
  "langfuse.observation.prompt_version",
  "langfuse.prompt.version",
] as const;
const TOOL_CALLS_ATTRS = ["gen_ai.tool.calls", "langfuse.observation.tool_calls"] as const;
const TOOL_CALL_NAMES_ATTRS = [
  "gen_ai.tool.call_names",
  "langfuse.observation.tool_call_names",
] as const;
const TOOL_DEFINITIONS_ATTRS = [
  "gen_ai.tool.definitions",
  "langfuse.observation.tool_definitions",
] as const;
const MODEL_PARAMS_ATTRS = [
  "gen_ai.request.model_parameters",
  "langfuse.observation.model_parameters",
] as const;

// Resource attribute names (fall-back when span-level isn't set)
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
 * Returns a list of objects ready for serialisation and export. Every span
 * is transformed — no filtering by scope or attributes happens here.
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

    // OTel JS v1 names this `instrumentationLibrary`; v2 renames to
    // `instrumentationScope`. Support both without bumping the peer dep.
    const anySpan = span as unknown as {
      instrumentationLibrary?: { name?: string; version?: string };
      instrumentationScope?: { name?: string; version?: string };
    };
    const scopeName =
      anySpan.instrumentationScope?.name ??
      anySpan.instrumentationLibrary?.name ??
      null;
    const scopeVersion =
      anySpan.instrumentationScope?.version ??
      anySpan.instrumentationLibrary?.version ??
      null;

    const traceId = span.spanContext().traceId;
    const spanId = span.spanContext().spanId;
    const parentId = span.parentSpanId || null;
    const isRoot = parentId === null || parentId === "";

    const startIso = hrTimeToIso(span.startTime);
    const endIso = hrTimeToIso(span.endTime);
    const latencyMs = hrDurationMs(span.startTime, span.endTime);

    const sessionId =
      firstAttr(spanAttrs, SESSION_ID_ATTRS) ??
      firstAttr(resourceAttrs, SESSION_ID_ATTRS) ??
      null;
    const userId =
      firstAttr(spanAttrs, USER_ID_ATTRS) ??
      firstAttr(resourceAttrs, USER_ID_ATTRS) ??
      null;
    const serviceVersion = resourceAttrs[RESOURCE_SERVICE_VERSION] ?? null;
    const deploymentEnv = resourceAttrs[RESOURCE_DEPLOYMENT_ENV] ?? null;
    const tags = firstAttr(spanAttrs, TAGS_ATTRS) ?? [];

    const fullAttributes = {
      span: spanAttrs,
      resource: resourceAttrs,
      scope: { name: scopeName, version: scopeVersion },
    };

    // ── Trace record (once per trace_id, from root span) ─────────────
    if (isRoot && !emittedTraces.has(traceId)) {
      emittedTraces.add(traceId);
      records.push(
        withClaim({
          entity_type: "trace",
          id: traceId,
          name: span.name,
          project_id: wid,
          wid,
          session_id: sessionId,
          user_id: userId,
          release: serviceVersion,
          version: serviceVersion,
          environment: deploymentEnv,
          metadata: { ...resourceAttrs },
          tags,
          input: firstAttr(spanAttrs, INPUT_ATTRS) ?? null,
          output: firstAttr(spanAttrs, OUTPUT_ATTRS) ?? null,
          public: false,
          bookmarked: false,
          timestamp: startIso,
          event_ts: startIso,
          created_at: nowIso,
          updated_at: nowIso,
          is_deleted: 0,
          attributes: fullAttributes,
        } as KubitRecord)
      );
    }

    // ── Enriched observation record (every span) ─────────────────────
    const model = firstAttr(spanAttrs, MODEL_ATTRS) ?? null;
    const providedModelName = firstAttr(spanAttrs, PROVIDED_MODEL_ATTRS) ?? null;
    const inputText = firstAttr(spanAttrs, INPUT_ATTRS) ?? null;
    const outputText = firstAttr(spanAttrs, OUTPUT_ATTRS) ?? null;
    const inputTokens = safeInt(firstAttr(spanAttrs, INPUT_TOKENS_ATTRS));
    const outputTokens = safeInt(firstAttr(spanAttrs, OUTPUT_TOKENS_ATTRS));
    let totalTokens = safeInt(firstAttr(spanAttrs, TOTAL_TOKENS_ATTRS));
    if (totalTokens === null && (inputTokens !== null || outputTokens !== null)) {
      totalTokens = (inputTokens ?? 0) + (outputTokens ?? 0);
    }
    const inputCost = safeFloat(firstAttr(spanAttrs, INPUT_COST_ATTRS));
    const outputCost = safeFloat(firstAttr(spanAttrs, OUTPUT_COST_ATTRS));
    const totalCost = safeFloat(firstAttr(spanAttrs, TOTAL_COST_ATTRS));

    const usageDetails: Record<string, unknown> = {};
    if (inputTokens !== null) usageDetails.input = inputTokens;
    if (outputTokens !== null) usageDetails.output = outputTokens;
    if (totalTokens !== null) usageDetails.total = totalTokens;

    const costDetails: Record<string, unknown> = {};
    if (inputCost !== null) costDetails.input = inputCost;
    if (outputCost !== null) costDetails.output = outputCost;
    if (totalCost !== null) costDetails.total = totalCost;

    let obsType: string = SPAN_KIND_MAP[span.kind] ?? "SPAN";
    if (model) obsType = "GENERATION";

    records.push(
      withClaim({
        entity_type: "enriched_observation",
        id: spanId,
        trace_id: traceId,
        parent_observation_id: parentId,
        name: span.name,
        type: obsType,
        project_id: wid,
        wid,
        level: STATUS_CODE_MAP[span.status.code] ?? "DEFAULT",
        status_message: span.status.message || null,
        version: serviceVersion,
        environment: deploymentEnv,
        session_id: sessionId,
        user_id: userId,
        trace_name: isRoot ? span.name : null,
        release: serviceVersion,
        start_time: startIso,
        end_time: endIso,
        completion_start_time: firstAttr(spanAttrs, COMPLETION_START_ATTRS) ?? null,
        latency: latencyMs,
        time_to_first_token: safeInt(firstAttr(spanAttrs, TIME_TO_FIRST_TOKEN_ATTRS)),
        model,
        provided_model_name: providedModelName,
        internal_model_id: null,
        model_parameters: firstAttr(spanAttrs, MODEL_PARAMS_ATTRS) ?? null,
        input: inputText,
        output: outputText,
        metadata: { ...resourceAttrs },
        provided_usage_details: usageDetails,
        usage_details: usageDetails,
        provided_cost_details: costDetails,
        cost_details: costDetails,
        total_cost: totalCost,
        prompt_id: firstAttr(spanAttrs, PROMPT_ID_ATTRS) ?? null,
        prompt_name: firstAttr(spanAttrs, PROMPT_NAME_ATTRS) ?? null,
        prompt_version: safeInt(firstAttr(spanAttrs, PROMPT_VERSION_ATTRS)),
        tool_definitions: firstAttr(spanAttrs, TOOL_DEFINITIONS_ATTRS) ?? null,
        tool_calls: firstAttr(spanAttrs, TOOL_CALLS_ATTRS) ?? null,
        tool_call_names: firstAttr(spanAttrs, TOOL_CALL_NAMES_ATTRS) ?? null,
        tags,
        event_ts: startIso,
        created_at: nowIso,
        updated_at: nowIso,
        is_deleted: 0,
        attributes: fullAttributes,
      } as KubitRecord)
    );
  }

  logger.debug(
    `transformer spans_in=${spans.length} records_out=${records.length} traces_emitted=${emittedTraces.size}`
  );
  return records;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function hrTimeToIso(hr: [number, number] | undefined): string {
  if (!hr) return nowIsoString();
  const ms = hr[0] * 1000 + Math.floor(hr[1] / 1_000_000);
  return new Date(ms).toISOString();
}

function hrDurationMs(
  start: [number, number] | undefined,
  end: [number, number] | undefined
): number | null {
  if (!start || !end) return null;
  const startMs = start[0] * 1000 + start[1] / 1_000_000;
  const endMs = end[0] * 1000 + end[1] / 1_000_000;
  return Math.round(endMs - startMs);
}

function nowIsoString(): string {
  return new Date().toISOString();
}

function firstAttr(
  attrs: Record<string, unknown>,
  keys: readonly string[]
): unknown {
  for (const key of keys) {
    const val = attrs[key];
    if (val !== undefined && val !== null) return val;
  }
  return undefined;
}

function safeInt(val: unknown): number | null {
  if (val === null || val === undefined) return null;
  const n = typeof val === "number" ? val : Number(val);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function safeFloat(val: unknown): number | null {
  if (val === null || val === undefined) return null;
  const n = typeof val === "number" ? val : Number(val);
  if (!Number.isFinite(n)) return null;
  return n;
}
