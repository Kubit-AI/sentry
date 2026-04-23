/**
 * Core `transformSpans` implementation.
 *
 * Iterates framework adapters from the registry to build canonical alias lists
 * at module load, then runs per-span record assembly in a single pass.
 * Adding support for a new emitter is a matter of dropping a new module into
 * `frameworks/` and appending it to `FRAMEWORKS` — no changes here.
 */

import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

import { logger } from "../logger";
import {
  COMPLETION_START_ATTRS,
  PROMPT_ID_ATTRS,
  PROMPT_NAME_ATTRS,
  PROMPT_VERSION_ATTRS,
} from "./frameworks/langfuse";
import type { FrameworkAdapter } from "./frameworks/types";
import { normaliseProvider } from "./frameworks/vercelAi";
import {
  firstAttr,
  hrDurationMs,
  hrTimeToIso,
  mergeJsonBlob,
  nowIsoString,
  safeFloat,
  safeInt,
} from "./helpers";
import { DISCRIMINATOR_ORDER, FRAMEWORKS } from "./registry";

const SPAN_KIND_MAP: Record<number, string> = {
  [SpanKind.INTERNAL]: "SPAN",
  [SpanKind.SERVER]: "SPAN",
  [SpanKind.CONSUMER]: "SPAN",
  [SpanKind.CLIENT]: "GENERATION",
  [SpanKind.PRODUCER]: "GENERATION",
};

// OTel GenAI semconv event names. Conversation payloads shifted from
// flattened `gen_ai.prompt.<i>.*` attributes to per-message span events to
// dodge attribute-size limits and AnyValue nesting issues. Each input event
// implies a role via its name; `gen_ai.choice` carries the generated output.
const GEN_AI_INPUT_EVENT_ROLES: Record<string, string> = {
  "gen_ai.system.message": "system",
  "gen_ai.user.message": "user",
  "gen_ai.assistant.message": "assistant",
  "gen_ai.tool.message": "tool",
};
const GEN_AI_OUTPUT_EVENT_NAME = "gen_ai.choice";

const STATUS_CODE_MAP: Record<number, string> = {
  [SpanStatusCode.UNSET]: "DEFAULT",
  [SpanStatusCode.OK]: "DEFAULT",
  [SpanStatusCode.ERROR]: "ERROR",
};

type AttrKey =
  | "MODEL_ATTRS"
  | "PROVIDED_MODEL_ATTRS"
  | "INPUT_ATTRS"
  | "OUTPUT_ATTRS"
  | "INPUT_TOKENS_ATTRS"
  | "OUTPUT_TOKENS_ATTRS"
  | "TOTAL_TOKENS_ATTRS"
  | "INPUT_COST_ATTRS"
  | "OUTPUT_COST_ATTRS"
  | "TOTAL_COST_ATTRS"
  | "SESSION_ID_ATTRS"
  | "USER_ID_ATTRS"
  | "TAGS_ATTRS"
  | "TIME_TO_FIRST_TOKEN_ATTRS"
  | "TOOL_CALLS_ATTRS"
  | "TOOL_CALL_NAMES_ATTRS"
  | "TOOL_DEFINITIONS_ATTRS"
  | "PROVIDER_ATTRS"
  | "AGENT_NAME_ATTRS"
  | "AGENT_ID_ATTRS"
  | "AGENT_VERSION_ATTRS"
  | "TOOL_NAME_ATTRS"
  | "SYSTEM_INSTRUCTIONS_ATTRS"
  | "PARAMS_BLOB_ATTRS"
  | "ENVIRONMENT_ATTRS"
  | "RELEASE_ATTRS";

function concat(key: AttrKey): readonly string[] {
  const parts: string[] = [];
  for (const fw of FRAMEWORKS) parts.push(...fw[key]);
  return parts;
}

function concatPairs(): ReadonlyArray<readonly [string, string]> {
  const parts: [string, string][] = [];
  for (const fw of FRAMEWORKS) parts.push(...(fw.CACHE_TOKEN_MAP as [string, string][]));
  return parts;
}

export const MODEL_ATTRS = concat("MODEL_ATTRS");
export const PROVIDED_MODEL_ATTRS = concat("PROVIDED_MODEL_ATTRS");
export const INPUT_ATTRS = concat("INPUT_ATTRS");
export const OUTPUT_ATTRS = concat("OUTPUT_ATTRS");
export const INPUT_TOKENS_ATTRS = concat("INPUT_TOKENS_ATTRS");
export const OUTPUT_TOKENS_ATTRS = concat("OUTPUT_TOKENS_ATTRS");
export const TOTAL_TOKENS_ATTRS = concat("TOTAL_TOKENS_ATTRS");
export const INPUT_COST_ATTRS = concat("INPUT_COST_ATTRS");
export const OUTPUT_COST_ATTRS = concat("OUTPUT_COST_ATTRS");
export const TOTAL_COST_ATTRS = concat("TOTAL_COST_ATTRS");
export const SESSION_ID_ATTRS = concat("SESSION_ID_ATTRS");
export const USER_ID_ATTRS = concat("USER_ID_ATTRS");
export const TAGS_ATTRS = concat("TAGS_ATTRS");
export const TIME_TO_FIRST_TOKEN_ATTRS = concat("TIME_TO_FIRST_TOKEN_ATTRS");
export const TOOL_CALLS_ATTRS = concat("TOOL_CALLS_ATTRS");
export const TOOL_CALL_NAMES_ATTRS = concat("TOOL_CALL_NAMES_ATTRS");
export const TOOL_DEFINITIONS_ATTRS = concat("TOOL_DEFINITIONS_ATTRS");
export const PROVIDER_ATTRS = concat("PROVIDER_ATTRS");
export const AGENT_NAME_ATTRS = concat("AGENT_NAME_ATTRS");
export const AGENT_ID_ATTRS = concat("AGENT_ID_ATTRS");
export const AGENT_VERSION_ATTRS = concat("AGENT_VERSION_ATTRS");
export const TOOL_NAME_ATTRS = concat("TOOL_NAME_ATTRS");
export const SYSTEM_INSTRUCTIONS_ATTRS = concat("SYSTEM_INSTRUCTIONS_ATTRS");
export const PARAMS_BLOB_ATTRS = concat("PARAMS_BLOB_ATTRS");
export const ENVIRONMENT_ATTRS = concat("ENVIRONMENT_ATTRS");
export const RELEASE_ATTRS = concat("RELEASE_ATTRS");
export const CACHE_TOKEN_MAP = concatPairs();

// Langfuse lets apps set an explicit trace title that overrides whatever
// generic span name auto-instrumentation chose (e.g. `POST /chat`). Used for
// both the trace record's `name` and the observation record's `trace_name`.
const LANGFUSE_TRACE_NAME_ATTRS = ["langfuse.trace.name"] as const;

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
  widClaim: string,
): KubitRecord[] {
  const records: KubitRecord[] = [];
  const now = nowIsoString();
  const emittedTraces = new Set<string>();

  const withClaim = (rec: KubitRecord): KubitRecord => {
    (rec as Record<string, unknown>)._wid_claim = widClaim;
    return rec;
  };

  for (const span of spans) {
    const resourceAttrs: Record<string, unknown> =
      span.resource?.attributes ?? {};
    const spanAttrs: Record<string, unknown> = span.attributes ?? {};

    const scopeName = span.instrumentationScope?.name ?? null;
    const scopeVersion = span.instrumentationScope?.version ?? null;

    const traceId = span.spanContext().traceId;
    const spanId = span.spanContext().spanId;
    const parentId = span.parentSpanContext?.spanId || null;
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
    const serviceVersion =
      firstAttr(spanAttrs, RELEASE_ATTRS) ??
      resourceAttrs[RESOURCE_SERVICE_VERSION] ??
      null;
    const deploymentEnv =
      firstAttr(spanAttrs, ENVIRONMENT_ATTRS) ??
      resourceAttrs[RESOURCE_DEPLOYMENT_ENV] ??
      null;
    const tags = firstAttr(spanAttrs, TAGS_ATTRS) ?? [];

    const fullAttributes = {
      span: spanAttrs,
      resource: resourceAttrs,
      scope: { name: scopeName, version: scopeVersion },
    };

    const metadata: Record<string, unknown> = { ...resourceAttrs };
    for (const fw of FRAMEWORKS) {
      fw.enrichMetadata?.(spanAttrs, metadata);
    }

    const traceEventIO = isRoot ? unpackGenAiEvents(span) : null;

    if (isRoot && !emittedTraces.has(traceId)) {
      emittedTraces.add(traceId);
      records.push(
        withClaim({
          entity_type: "trace",
          id: traceId,
          name: firstAttr(spanAttrs, LANGFUSE_TRACE_NAME_ATTRS) ?? span.name,
          project_id: wid,
          wid,
          session_id: sessionId,
          user_id: userId,
          release: serviceVersion,
          version: serviceVersion,
          environment: deploymentEnv,
          metadata: { ...metadata },
          tags,
          input: resolveInput(spanAttrs) ?? traceEventIO?.[0] ?? null,
          output: resolveOutput(spanAttrs) ?? traceEventIO?.[1] ?? null,
          public: false,
          bookmarked: false,
          timestamp: startIso,
          event_ts: startIso,
          created_at: now,
          updated_at: now,
          is_deleted: 0,
          attributes: fullAttributes,
        } as KubitRecord),
      );
    }

    const model = firstAttr(spanAttrs, MODEL_ATTRS) ?? null;
    const providedModelName = firstAttr(spanAttrs, PROVIDED_MODEL_ATTRS) ?? null;
    const [eventInput, eventOutput] = unpackGenAiEvents(span);
    const inputText = resolveInput(spanAttrs) ?? eventInput ?? null;
    const outputText = resolveOutput(spanAttrs) ?? eventOutput ?? null;
    const inputTokens = safeInt(firstAttr(spanAttrs, INPUT_TOKENS_ATTRS));
    const outputTokens = safeInt(firstAttr(spanAttrs, OUTPUT_TOKENS_ATTRS));
    const totalTokens = safeInt(firstAttr(spanAttrs, TOTAL_TOKENS_ATTRS));

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

    for (const fw of FRAMEWORKS) {
      fw.parseUsageBlobs?.(spanAttrs, usageDetails);
      fw.parseCostBlobs?.(spanAttrs, costDetails);
    }

    for (const [srcAttr, canonicalKey] of CACHE_TOKEN_MAP) {
      if (canonicalKey in usageDetails) continue;
      const val = safeInt(spanAttrs[srcAttr]);
      if (val !== null) usageDetails[canonicalKey] = val;
    }

    if (
      usageDetails.total === undefined &&
      (usageDetails.input !== undefined || usageDetails.output !== undefined)
    ) {
      usageDetails.total =
        (safeInt(usageDetails.input) ?? 0) + (safeInt(usageDetails.output) ?? 0);
    }

    let effectiveTotalCost = totalCost;
    if (effectiveTotalCost === null && costDetails.total != null) {
      effectiveTotalCost = safeFloat(costDetails.total);
    }

    const modelParameters = buildModelParameters(spanAttrs);
    const obsType = resolveObservationType(span, spanAttrs, model);
    const provider = resolveProvider(spanAttrs);

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
        trace_name: isRoot
          ? (firstAttr(spanAttrs, LANGFUSE_TRACE_NAME_ATTRS) ?? span.name)
          : null,
        release: serviceVersion,
        start_time: startIso,
        end_time: endIso,
        completion_start_time: firstAttr(spanAttrs, COMPLETION_START_ATTRS) ?? null,
        latency: latencyMs,
        time_to_first_token: safeInt(firstAttr(spanAttrs, TIME_TO_FIRST_TOKEN_ATTRS)),
        model,
        provided_model_name: providedModelName,
        internal_model_id: null,
        model_parameters: modelParameters,
        provider,
        agent_name: firstAttr(spanAttrs, AGENT_NAME_ATTRS) ?? null,
        agent_id: firstAttr(spanAttrs, AGENT_ID_ATTRS) ?? null,
        agent_version: firstAttr(spanAttrs, AGENT_VERSION_ATTRS) ?? null,
        tool_name: firstAttr(spanAttrs, TOOL_NAME_ATTRS) ?? null,
        system_instructions: firstAttr(spanAttrs, SYSTEM_INSTRUCTIONS_ATTRS) ?? null,
        input: inputText,
        output: outputText,
        metadata: { ...metadata },
        provided_usage_details: usageDetails,
        usage_details: usageDetails,
        provided_cost_details: costDetails,
        cost_details: costDetails,
        total_cost: effectiveTotalCost,
        prompt_id: firstAttr(spanAttrs, PROMPT_ID_ATTRS) ?? null,
        prompt_name: firstAttr(spanAttrs, PROMPT_NAME_ATTRS) ?? null,
        prompt_version: safeInt(firstAttr(spanAttrs, PROMPT_VERSION_ATTRS)),
        tool_definitions: firstAttr(spanAttrs, TOOL_DEFINITIONS_ATTRS) ?? null,
        tool_calls: firstAttr(spanAttrs, TOOL_CALLS_ATTRS) ?? null,
        tool_call_names: firstAttr(spanAttrs, TOOL_CALL_NAMES_ATTRS) ?? null,
        tags,
        event_ts: startIso,
        created_at: now,
        updated_at: now,
        is_deleted: 0,
        attributes: fullAttributes,
      } as KubitRecord),
    );
  }

  logger.debug(
    `transformer spans_in=${spans.length} records_out=${records.length} traces_emitted=${emittedTraces.size}`,
  );
  return records;
}

function resolveInput(spanAttrs: Record<string, unknown>): unknown {
  const val = firstAttr(spanAttrs, INPUT_ATTRS);
  if (val !== undefined && val !== null) return val;
  for (const fw of FRAMEWORKS) {
    if (!fw.unpackMessages) continue;
    const [unpackedIn] = fw.unpackMessages(spanAttrs);
    if (unpackedIn !== null) return unpackedIn;
  }
  return undefined;
}

function resolveOutput(spanAttrs: Record<string, unknown>): unknown {
  const val = firstAttr(spanAttrs, OUTPUT_ATTRS);
  if (val !== undefined && val !== null) return val;
  for (const fw of FRAMEWORKS) {
    if (!fw.unpackMessages) continue;
    const [, unpackedOut] = fw.unpackMessages(spanAttrs);
    if (unpackedOut !== null) return unpackedOut;
  }
  return undefined;
}

function resolveObservationType(
  span: ReadableSpan,
  spanAttrs: Record<string, unknown>,
  model: unknown,
): string {
  for (const fw of DISCRIMINATOR_ORDER) {
    if (!fw.resolveObservationType) continue;
    const result = fw.resolveObservationType(spanAttrs);
    if (result) return result;
  }
  // Fallback chain: last-resort discriminators (e.g. Traceloop's
  // `llm.request.type`) that must lose to standard `gen_ai.operation.name`.
  for (const fw of DISCRIMINATOR_ORDER) {
    if (!fw.resolveObservationTypeFallback) continue;
    const result = fw.resolveObservationTypeFallback(spanAttrs);
    if (result) return result;
  }
  if (model) return "GENERATION";
  return SPAN_KIND_MAP[span.kind] ?? "SPAN";
}

function resolveProvider(spanAttrs: Record<string, unknown>): string | null {
  for (const attr of PROVIDER_ATTRS) {
    const val = spanAttrs[attr];
    if (val === undefined || val === null) continue;
    if (attr === "ai.model.provider") return normaliseProvider(val);
    return typeof val === "string" ? val : String(val);
  }
  return null;
}

type SpanEvent = {
  name: string;
  attributes?: Record<string, unknown>;
  time?: [number, number];
};

function unpackGenAiEvents(
  span: ReadableSpan,
): [string | null, string | null] {
  const events = (span as unknown as { events?: SpanEvent[] }).events;
  if (!events || events.length === 0) return [null, null];

  const inputs: Array<{ __t: number; msg: Record<string, unknown> }> = [];
  const outputs: Array<{ __t: number; msg: Record<string, unknown> }> = [];

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const name = ev.name;
    const t = ev.time ? ev.time[0] * 1e9 + ev.time[1] : i;
    const attrs = ev.attributes ?? {};
    const role = GEN_AI_INPUT_EVENT_ROLES[name];
    if (role !== undefined) {
      const msg: Record<string, unknown> = { ...attrs };
      if (msg.role === undefined) msg.role = role;
      inputs.push({ __t: t, msg });
      continue;
    }
    if (name === GEN_AI_OUTPUT_EVENT_NAME) {
      outputs.push({ __t: t, msg: { ...attrs } });
    }
  }

  const sortByTime = (a: { __t: number }, b: { __t: number }) => a.__t - b.__t;
  const inputStr = inputs.length
    ? JSON.stringify(inputs.sort(sortByTime).map((e) => e.msg))
    : null;
  const outputStr = outputs.length
    ? JSON.stringify(outputs.sort(sortByTime).map((e) => e.msg))
    : null;
  return [inputStr, outputStr];
}

function buildModelParameters(spanAttrs: Record<string, unknown>): unknown {
  const merged: Record<string, unknown> = {};
  for (const attr of PARAMS_BLOB_ATTRS) {
    mergeJsonBlob(spanAttrs[attr], merged);
  }
  for (const fw of FRAMEWORKS) {
    fw.buildParams?.(spanAttrs, merged);
  }
  if (Object.keys(merged).length > 0) return merged;
  return firstAttr(spanAttrs, PARAMS_BLOB_ATTRS) ?? null;
}
