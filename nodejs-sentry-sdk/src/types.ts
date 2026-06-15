/**
 * OTLP/HTTP+JSON encoding types (trace signal only).
 *
 * Reference: OpenTelemetry OTLP/HTTP JSON encoding spec
 *   https://opentelemetry.io/docs/specs/otlp/#otlphttp-with-json-encoding
 *
 * These mirror the subset of the OTLP `ExportTraceServiceRequest` shape we
 * emit. The Kubit collector accepts both protobuf and JSON; this SDK sends
 * JSON to keep the browser build free of a protobuf dependency.
 */

export type OtlpAnyValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean }
  | { arrayValue: { values: OtlpAnyValue[] } };

export interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

/** A span event (e.g. a recorded exception). */
export interface OtlpSpanEvent {
  timeUnixNano: string;
  name: string;
  attributes: OtlpKeyValue[];
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  /** SpanKind enum. 1 = INTERNAL (default for browser-side spans). */
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  events?: OtlpSpanEvent[];
  status: { code: number; message?: string };
}

export interface OtlpExportRequest {
  resourceSpans: Array<{
    resource: { attributes: OtlpKeyValue[] };
    scopeSpans: Array<{
      scope: { name: string; version: string };
      spans: OtlpSpan[];
    }>;
  }>;
}
