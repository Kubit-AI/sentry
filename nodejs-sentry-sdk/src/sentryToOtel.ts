/**
 * Sentry `Event` -> OTLP/HTTP+JSON (`ExportTraceServiceRequest`).
 *
 * Two entry points behind one dispatcher (`sentryEventToOtlp`):
 *   - transactions (`event.type === 'transaction'`) -> spans (root from
 *     `contexts.trace`, one child per `event.spans[]`).
 *   - errors (everything else) -> a single span carrying an `exception` span
 *     event per `exception.values[]`, with `status.code = ERROR`.
 *
 * Pure functions — no Sentry SDK calls, no I/O, no randomness. Error events
 * without a trace context are anchored on the Sentry `event_id` (a 32-hex
 * string, valid as an OTLP trace id) so the transform stays deterministic.
 */

import type { Event, TransactionEvent } from "@sentry/core";
import type {
  OtlpAnyValue,
  OtlpExportRequest,
  OtlpKeyValue,
  OtlpSpan,
  OtlpSpanEvent,
} from "./types";
import type { KubitSentryConfig } from "./config";

const SCOPE_NAME = "kubit.sentry";
const SCOPE_VERSION = "0.1.0";
const SPAN_KIND_INTERNAL = 1;

// OTel Status enum
const STATUS_UNSET = 0;
const STATUS_OK = 1;
const STATUS_ERROR = 2;

const STATUS_ERROR_VALUES = new Set([
  "cancelled",
  "unknown",
  "unknown_error",
  "invalid_argument",
  "deadline_exceeded",
  "not_found",
  "already_exists",
  "permission_denied",
  "resource_exhausted",
  "failed_precondition",
  "aborted",
  "out_of_range",
  "unimplemented",
  "internal_error",
  "unavailable",
  "data_loss",
  "unauthenticated",
]);

const mapStatus = (status: string | undefined): number => {
  if (status === "ok") {
    return STATUS_OK;
  }
  if (status !== undefined && STATUS_ERROR_VALUES.has(status)) {
    return STATUS_ERROR;
  }
  return STATUS_UNSET;
};

/**
 * Seconds-float -> integer-nanosecond string. Computed as whole seconds plus
 * padded fractional nanos rather than `seconds * 1e9`: the product (~1.7e18)
 * exceeds Number.MAX_SAFE_INTEGER and would quantize timestamps to ~256 ns,
 * distorting sub-microsecond span durations.
 */
const toUnixNano = (secondsFloat: number | undefined): string => {
  if (
    typeof secondsFloat !== "number" ||
    !Number.isFinite(secondsFloat) ||
    secondsFloat < 0
  ) {
    return "0";
  }
  let seconds = Math.floor(secondsFloat);
  let nanos = Math.round((secondsFloat - seconds) * 1e9);
  if (nanos >= 1e9) {
    seconds += 1;
    nanos = 0;
  }
  return seconds === 0
    ? nanos.toString()
    : `${seconds}${nanos.toString().padStart(9, "0")}`;
};

const toAnyValue = (value: unknown): OtlpAnyValue | null => {
  if (typeof value === "string") {
    return { stringValue: value };
  }
  if (typeof value === "boolean") {
    return { boolValue: value };
  }
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { intValue: Math.trunc(value).toString() }
      : { doubleValue: value };
  }
  if (Array.isArray(value)) {
    const values = value
      .map(toAnyValue)
      .filter((v): v is OtlpAnyValue => v !== null);
    return { arrayValue: { values } };
  }
  if (value === null || value === undefined) {
    return null;
  }
  // Plain objects -> OTLP kvlistValue (recursively), so nested structure reaches
  // the collector as real key/values instead of a JSON string. This is what lets
  // e.g. each item in a `product_items` array arrive as an object, not a string.
  // Arrays and scalars are already handled above.
  if (typeof value === "object") {
    const values: OtlpKeyValue[] = [];
    for (const [key, child] of Object.entries(value)) {
      const childValue = toAnyValue(child);
      if (childValue !== null) {
        values.push({ key, value: childValue });
      }
    }
    return { kvlistValue: { values } };
  }
  // Non-object, non-scalar leftovers (bigint, symbol, function) -> string.
  try {
    return { stringValue: JSON.stringify(value) };
  } catch {
    return { stringValue: "[uncoercible]" };
  }
};

const toAttributes = (
  data: Record<string, unknown> | undefined,
): OtlpKeyValue[] => {
  if (!data) {
    return [];
  }
  const out: OtlpKeyValue[] = [];
  for (const [key, raw] of Object.entries(data)) {
    const value = toAnyValue(raw);
    if (value !== null) {
      out.push({ key, value });
    }
  }
  return out;
};

/** Conditional single string attribute — empty array when absent/blank. */
const strAttr = (key: string, value: unknown): OtlpKeyValue[] =>
  typeof value === "string" && value.length > 0
    ? [{ key, value: { stringValue: value } }]
    : [];

/**
 * Build the OTLP `resource.attributes` array.
 *
 * `service.name` / `service.version` come from config first (so a customer's
 * own app identity flows through), then fall back to the Sentry event's
 * `release`. Browser / OS / device contexts map to OTel resource semconv.
 */
const buildResourceAttributes = (
  event: Event,
  config: KubitSentryConfig,
): OtlpKeyValue[] => {
  const browser = event.contexts?.browser;
  const os = event.contexts?.os;
  const device = event.contexts?.device;
  return [
    ...strAttr("service.name", config.serviceName ?? "sentry-app"),
    ...strAttr("service.version", config.serviceVersion ?? event.release),
    ...strAttr("deployment.environment", event.environment),
    // SDK identity
    ...strAttr("telemetry.sdk.name", event.sdk?.name),
    ...strAttr("telemetry.sdk.version", event.sdk?.version),
    ...strAttr("telemetry.sdk.language", event.platform),
    // Browser / OS / device context (typed `unknown` via the index signature)
    ...strAttr("browser.name", browser?.name),
    ...strAttr("browser.version", browser?.version),
    ...strAttr("os.name", os?.name),
    ...strAttr("os.version", os?.version),
    ...strAttr("device.model.name", device?.model),
    ...strAttr("device.manufacturer", device?.brand),
    ...strAttr("device.model.identifier", device?.family),
  ];
};

/** String form of the Sentry user id (`string | number`). */
const userIdToString = (id: unknown): string | undefined => {
  if (typeof id === "string") {
    return id.length > 0 ? id : undefined;
  }
  if (typeof id === "number" || typeof id === "bigint") {
    return String(id);
  }
  return undefined;
};

/**
 * Event-scoped attributes stamped onto every span: the injected `session.id`
 * plus the Sentry user identity (`Sentry.setUser`). `user.id` is the join key
 * for per-user behavior analytics — without it, events can't be grouped by user.
 */
const eventScopedAttrs = (event: Event, sessionId?: string): OtlpKeyValue[] => [
  ...strAttr("session.id", sessionId),
  ...strAttr("user.id", userIdToString(event.user?.id)),
  ...strAttr("user.name", event.user?.username),
  ...strAttr("user.email", event.user?.email),
];

/**
 * Append the given attributes to every span. Single choke point so all span
 * families (transaction root, children, error) get them uniformly. The transform
 * stays pure — the values are explicit inputs resolved by the impure tee
 * boundary, not read here.
 */
const withScopedAttrs = (
  spans: OtlpSpan[],
  attrs: OtlpKeyValue[],
): OtlpSpan[] =>
  attrs.length === 0
    ? spans
    : spans.map((span) => ({
        ...span,
        attributes: [...span.attributes, ...attrs],
      }));

const buildExportRequest = (
  spans: OtlpSpan[],
  resourceEvent: Event,
  config: KubitSentryConfig,
  sessionId?: string,
): OtlpExportRequest => ({
  resourceSpans: [
    {
      resource: { attributes: buildResourceAttributes(resourceEvent, config) },
      scopeSpans: [
        {
          scope: { name: SCOPE_NAME, version: SCOPE_VERSION },
          spans: withScopedAttrs(
            spans,
            eventScopedAttrs(resourceEvent, sessionId),
          ),
        },
      ],
    },
  ],
});

export const sentryTransactionToOtlp = (
  event: TransactionEvent,
  config: KubitSentryConfig,
  sessionId?: string,
): OtlpExportRequest => {
  const trace = event.contexts?.trace;
  const spans: OtlpSpan[] = [];

  if (trace?.trace_id && trace.span_id) {
    spans.push({
      traceId: trace.trace_id,
      spanId: trace.span_id,
      parentSpanId: trace.parent_span_id,
      name: event.transaction ?? trace.op ?? "transaction",
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: toUnixNano(event.start_timestamp),
      endTimeUnixNano: toUnixNano(event.timestamp),
      attributes: [
        ...toAttributes(trace.data),
        ...strAttr("sentry.op", trace.op),
        ...strAttr("sentry.source", event.transaction_info?.source),
      ],
      status: { code: mapStatus(trace.status) },
    });
  }

  for (const child of event.spans ?? []) {
    spans.push({
      traceId: child.trace_id,
      spanId: child.span_id,
      parentSpanId: child.parent_span_id,
      name: child.description ?? child.op ?? "span",
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: toUnixNano(child.start_timestamp),
      endTimeUnixNano: toUnixNano(child.timestamp),
      attributes: [...toAttributes(child.data), ...strAttr("sentry.op", child.op)],
      status: { code: mapStatus(child.status) },
    });
  }

  return buildExportRequest(spans, event, config, sessionId);
};

const renderStackFrames = (
  frames: ReadonlyArray<{
    function?: string;
    filename?: string;
    lineno?: number;
    colno?: number;
  }>,
): string =>
  frames
    .map(
      (f) =>
        `  at ${f.function ?? "<anonymous>"} (${f.filename ?? "?"}:${
          f.lineno ?? 0
        }:${f.colno ?? 0})`,
    )
    .join("\n");

export const sentryErrorToOtlp = (
  event: Event,
  config: KubitSentryConfig,
  sessionId?: string,
): OtlpExportRequest => {
  const trace = event.contexts?.trace;
  // Anchor on the Sentry event_id (32-hex) when there's no trace context,
  // so the transform stays pure (no randomness).
  const traceId = trace?.trace_id ?? event.event_id;
  if (!traceId) {
    return buildExportRequest([], event, config, sessionId);
  }
  // The error span gets its own id derived from the (unique) event_id and is
  // parented under the active span. Reusing `trace.span_id` as the span id
  // would collide with the live span the transaction export also ships.
  const spanId = event.event_id?.slice(0, 16) ?? traceId.slice(0, 16);
  const parentSpanId = trace?.span_id;
  const ts = toUnixNano(event.timestamp);

  const values = event.exception?.values ?? [];
  // Sentry orders exceptions outermost-first; the last entry is the innermost
  // (most specific) error — use it for the span name.
  const primary = values.length > 0 ? values[values.length - 1] : undefined;

  const events: OtlpSpanEvent[] = values.map((ex) => {
    const attributes: OtlpKeyValue[] = [
      ...strAttr("exception.type", ex.type),
      ...strAttr("exception.message", ex.value),
    ];
    const frames = ex.stacktrace?.frames;
    if (frames && frames.length > 0) {
      attributes.push({
        key: "exception.stacktrace",
        value: { stringValue: renderStackFrames(frames) },
      });
    }
    if (ex.mechanism?.handled !== undefined) {
      attributes.push({
        key: "exception.escaped",
        value: { boolValue: !ex.mechanism?.handled },
      });
    }
    return { timeUnixNano: ts, name: "exception", attributes };
  });

  const span: OtlpSpan = {
    traceId,
    spanId,
    parentSpanId,
    name: event.transaction ?? primary?.type ?? "error",
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: ts,
    endTimeUnixNano: ts,
    attributes: [
      ...toAttributes(event.tags),
      ...toAttributes(event.extra),
      ...strAttr("sentry.level", event.level),
      ...strAttr("exception.type", primary?.type),
      ...strAttr("exception.message", primary?.value),
    ],
    events,
    status: { code: STATUS_ERROR, message: primary?.value },
  };

  return buildExportRequest([span], event, config, sessionId);
};

const isTransactionEvent = (event: Event): event is TransactionEvent =>
  event.type === "transaction";

/**
 * Dispatcher: route a Sentry event to the right transform by `event.type`.
 * Transactions carry `type: 'transaction'`; error events leave it undefined.
 */
export const sentryEventToOtlp = (
  event: Event,
  config: KubitSentryConfig,
  sessionId?: string,
): OtlpExportRequest =>
  isTransactionEvent(event)
    ? sentryTransactionToOtlp(event, config, sessionId)
    : sentryErrorToOtlp(event, config, sessionId);
