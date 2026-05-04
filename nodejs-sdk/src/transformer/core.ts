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
  COMPLETION_START_ATTRS as LF_COMPLETION_START_ATTRS,
  PROMPT_ID_ATTRS,
  PROMPT_NAME_ATTRS,
  PROMPT_VERSION_ATTRS,
} from "./frameworks/langfuse";
import { COMPLETION_START_ATTRS as MASTRA_COMPLETION_START_ATTRS } from "./frameworks/mastra";

// `completion_start_time` is the first-chunk timestamp emitters (Langfuse,
// Mastra) record on streaming generations. Core uses it directly for the
// `completion_start_time` field and as the third-tier source for TTFT
// derivation. Langfuse priority is preserved by ordering it first.
const COMPLETION_START_ATTRS = [
  ...LF_COMPLETION_START_ATTRS,
  ...MASTRA_COMPLETION_START_ATTRS,
] as const;
import type {
  CanonicalMessages,
  FrameworkAdapter,
  Message,
  Part,
} from "./frameworks/types";
import {
  decodeJsonStringAttr,
  firstAttr,
  hrDurationMs,
  hrTimeToIso,
  mergeJsonBlob,
  nowIsoString,
  safeFloat,
  safeInt,
} from "./helpers";
import {
  canonicalizeGenAiEvents,
  safeJsonParse,
  stringifyForText,
  textPart,
  type SpanEventLike,
} from "./messages";
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
  | "TIME_TO_FIRST_TOKEN_SECONDS_ATTRS"
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
export const TIME_TO_FIRST_TOKEN_SECONDS_ATTRS = concat(
  "TIME_TO_FIRST_TOKEN_SECONDS_ATTRS",
);
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

/**
 * Resolve `time_to_first_token` in canonical milliseconds (int).
 *
 * Three-tier priority:
 *   1. ms-typed aliases (e.g. Vercel `ai.response.msToFirstChunk`)
 *   2. seconds-typed aliases (e.g. OTel GenAI `gen_ai.response.time_to_first_chunk`),
 *      converted to ms via float→round (`0.5` → `500`)
 *   3. derived from `completion_start_time − span.startTime` for emitters that
 *      record the first-chunk timestamp instead of a duration (Langfuse).
 *      Negative diffs (clock skew / instrumentation bug) clamp to 0.
 *
 * Direct measurements win over derivation because instrumentations typically
 * record the duration with higher precision than the round-tripped
 * timestamp.
 */
function resolveTtftMs(
  spanAttrs: Record<string, unknown>,
  startTime: [number, number],
  completionStartTimeIso: string | null,
): number | null {
  const ms = safeInt(firstAttr(spanAttrs, TIME_TO_FIRST_TOKEN_ATTRS));
  if (ms !== null) return ms;
  const seconds = safeFloat(firstAttr(spanAttrs, TIME_TO_FIRST_TOKEN_SECONDS_ATTRS));
  if (seconds !== null) return Math.round(seconds * 1000);
  if (completionStartTimeIso) {
    const completionMs = Date.parse(completionStartTimeIso);
    if (Number.isFinite(completionMs)) {
      const startMs = startTime[0] * 1000 + startTime[1] / 1_000_000;
      const diff = Math.round(completionMs - startMs);
      return diff < 0 ? 0 : diff;
    }
  }
  return null;
}

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

  // Root detection is purely OTel-local: a span is a root when its OTel
  // parent context is empty. Cross-batch flushing is the norm — short
  // children commonly end (and flush) before their long-running parent —
  // so a per-batch "parent not in this batch" check would misclassify
  // those as roots and emit duplicate `trace` rows. Surviving children of
  // a filtered HTTP/server parent will carry a dangling
  // `parent_observation_id` until ingestion-side reconciliation clears it.
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
    const isRoot = !parentId;

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
    const canonicalMessages = resolveCanonicalMessages(spanAttrs, span);

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
          input: canonicalMessages.input,
          output: canonicalMessages.output,
          input_messages_raw: resolveInput(spanAttrs) ?? traceEventIO?.[0] ?? null,
          output_messages_raw: resolveOutput(spanAttrs) ?? traceEventIO?.[1] ?? null,
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
    const providedModelName = resolveProvidedModel(spanAttrs);
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
    const completionStartTime =
      (decodeJsonStringAttr(firstAttr(spanAttrs, COMPLETION_START_ATTRS)) as
        | string
        | null
        | undefined) ?? null;

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
        completion_start_time: completionStartTime,
        latency: latencyMs,
        time_to_first_token: resolveTtftMs(
          spanAttrs,
          span.startTime,
          completionStartTime,
        ),
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
        input: canonicalMessages.input,
        output: canonicalMessages.output,
        input_messages_raw: inputText,
        output_messages_raw: outputText,
        metadata: { ...metadata },
        provided_usage_details: usageDetails,
        usage_details: usageDetails,
        provided_cost_details: costDetails,
        cost_details: costDetails,
        total_cost: effectiveTotalCost,
        prompt_id: firstAttr(spanAttrs, PROMPT_ID_ATTRS) ?? null,
        prompt_name: firstAttr(spanAttrs, PROMPT_NAME_ATTRS) ?? null,
        prompt_version: safeInt(firstAttr(spanAttrs, PROMPT_VERSION_ATTRS)),
        tool_definitions: aggregateToolDefinitions(spanAttrs)
                          ?? firstAttr(spanAttrs, TOOL_DEFINITIONS_ATTRS) ?? null,
        tool_calls: firstAttr(spanAttrs, TOOL_CALLS_ATTRS)
                    ?? deriveToolCallsFromMessages(canonicalMessages.output),
        tool_call_names: firstAttr(spanAttrs, TOOL_CALL_NAMES_ATTRS)
                         ?? deriveToolCallNamesFromMessages(canonicalMessages.output),
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
  for (const fw of FRAMEWORKS) {
    if (!fw.resolveProvider) continue;
    const resolved = fw.resolveProvider(spanAttrs);
    if (resolved) return resolved;
  }
  for (const attr of PROVIDER_ATTRS) {
    const val = spanAttrs[attr];
    if (val === undefined || val === null) continue;
    return typeof val === "string" ? val : String(val);
  }
  return null;
}

// Return the user-requested model name (OTel `gen_ai.request.model`).
// Explicit `PROVIDED_MODEL_ATTRS` aliases fire first — an explicitly-set
// request-model attribute wins over inferred extraction. If the alias chain
// misses, framework `resolveProvidedModel` hooks pull from blob-form sources
// (e.g. OpenInference's `llm.invocation_parameters`, where LangChain hides
// the requested model name).
function resolveProvidedModel(spanAttrs: Record<string, unknown>): string | null {
  const aliasHit = firstAttr(spanAttrs, PROVIDED_MODEL_ATTRS);
  if (aliasHit !== undefined && aliasHit !== null) {
    return typeof aliasHit === "string" ? aliasHit : String(aliasHit);
  }
  for (const fw of FRAMEWORKS) {
    if (!fw.resolveProvidedModel) continue;
    const resolved = fw.resolveProvidedModel(spanAttrs);
    if (resolved) return resolved;
  }
  return null;
}

function aggregateToolDefinitions(spanAttrs: Record<string, unknown>): unknown[] | null {
  for (const fw of FRAMEWORKS) {
    if (!fw.aggregateToolDefinitions) continue;
    const result = fw.aggregateToolDefinitions(spanAttrs);
    if (result && result.length > 0) return result;
  }
  return null;
}

/**
 * Derive `tool_calls` from canonical output messages when no adapter
 * exposed a dedicated attribute. Walks every assistant message's parts
 * and collects the discriminated `tool_call` parts as-is. Returns `null`
 * when nothing was found so the caller's `?? null` chain stays clean.
 */
function deriveToolCallsFromMessages(
  messages: Message[] | null,
): unknown[] | null {
  if (!messages) return null;
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const p of m.parts) {
      if ((p as { type?: unknown }).type === "tool_call") out.push(p);
    }
  }
  return out.length > 0 ? out : null;
}

function deriveToolCallNamesFromMessages(
  messages: Message[] | null,
): string[] | null {
  const calls = deriveToolCallsFromMessages(messages);
  if (!calls) return null;
  const names: string[] = [];
  for (const tc of calls) {
    const n = (tc as { name?: unknown }).name;
    if (typeof n === "string") names.push(n);
  }
  return names.length > 0 ? names : null;
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

/**
 * Build the canonical OTel GenAI v2 message arrays for both directions, in
 * priority order:
 *   1. Each adapter's `normalizeMessages` hook (registry order; per-side
 *      first-non-null wins so a Vercel input + Langfuse output combo works).
 *   2. Span-event fallback for emitters that put messages on
 *      `gen_ai.user.message` / `gen_ai.choice` / etc. events rather than
 *      attributes.
 *   3. `gen_ai.system_instructions` injection: prepended as the leading
 *      `role: "system"` message when not already present at the head of input.
 *
 * No fallback text-wraps the legacy raw `INPUT_ATTRS` / `OUTPUT_ATTRS` value:
 * those attrs may carry opaque entity blobs (e.g. `traceloop.entity.input`
 * with `{inputs, tags, metadata, kwargs}`), and synthesizing a single fake
 * `[{role:user, parts:[text:<blob>]}]` envelope misrepresents non-
 * conversational data as a chat turn. Adapters that want a text fallback
 * (e.g. legacy `gen_ai.prompt` strings) emit it from their own
 * `normalizeMessages` hook.
 */
function resolveCanonicalMessages(
  spanAttrs: Record<string, unknown>,
  span: ReadableSpan,
): CanonicalMessages {
  let input: Message[] | null = null;
  let output: Message[] | null = null;

  for (const fw of FRAMEWORKS) {
    if (input !== null && output !== null) break;
    const r = fw.normalizeMessages?.(spanAttrs);
    if (!r) continue;
    if (input === null && r.input !== null) input = r.input;
    if (output === null && r.output !== null) output = r.output;
  }

  if (input === null || output === null) {
    const events = (span as unknown as { events?: SpanEventLike[] }).events;
    const ev = canonicalizeGenAiEvents(events);
    if (input === null) input = ev.input;
    if (output === null) output = ev.output;
  }

  const sysMsg = parseSystemInstructions(spanAttrs["gen_ai.system_instructions"]);
  if (sysMsg) {
    if (input === null || input.length === 0 || input[0].role !== "system") {
      input = [sysMsg, ...(input ?? [])];
    }
  }

  return { input, output };
}

/**
 * Parse `gen_ai.system_instructions` (per OTel spec: an array of parts) into a
 * canonical `system`-role message. Tolerates plain-string emitters (wraps as
 * a single TextPart) and JSON-stringified arrays.
 */
function parseSystemInstructions(raw: unknown): Message | null {
  if (raw === undefined || raw === null) return null;
  let value: unknown = raw;
  if (typeof raw === "string") {
    const parsed = safeJsonParse(raw);
    value = parsed ?? raw;
  }
  if (Array.isArray(value)) {
    const parts: Part[] = [];
    for (const item of value) {
      if (typeof item === "string") {
        parts.push(textPart(item));
        continue;
      }
      if (item && typeof item === "object") {
        const obj = item as Record<string, unknown>;
        if (typeof obj.type === "string") {
          parts.push(obj as Part);
          continue;
        }
        // Fallback: stringify a structured value with no `type`.
        parts.push(textPart(stringifyForText(item)));
        continue;
      }
      // Non-string non-object items (numbers, booleans). Out-of-spec but
      // text-wrap them rather than drop, mirroring the Python adapter so
      // both SDKs produce the same number of parts.
      if (item !== null && item !== undefined) {
        parts.push(textPart(stringifyForText(item)));
      }
    }
    if (parts.length === 0) return null;
    return { role: "system", parts };
  }
  if (typeof value === "string" && value.length > 0) {
    return { role: "system", parts: [textPart(value)] };
  }
  return null;
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
