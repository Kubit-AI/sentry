/**
 * KubitExporter — OpenTelemetry SpanExporter for Kubit analytics.
 *
 * Thin wrapper around `@opentelemetry/exporter-trace-otlp-proto`,
 * preconfigured to point at the Kubit collector and inject the `x-api-key`
 * header. Cylon (the server-side collector) handles span normalization and
 * downstream fan-out.
 */

import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import {
  type ReadableSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import type { ExportResult } from "@opentelemetry/core";
import { logger, redactEndpoint } from "./logger";

export const DEFAULT_ENDPOINT = "https://otel.kubit.ai/v1/traces";
export const KUBIT_OTEL_ENDPOINT_ENV = "KUBIT_OTEL_ENDPOINT";

export interface KubitExporterConfig {
  /** Kubit API key (`rg.v1.<payload>.<sig>`). Sent as `x-api-key`. */
  apiKey: string;
  /**
   * Full trace endpoint URL. Resolution precedence: explicit arg →
   * `KUBIT_OTEL_ENDPOINT` env → `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` /
   * `OTEL_EXPORTER_OTLP_ENDPOINT` → built-in default
   * `https://otel.kubit.ai/v1/traces`.
   */
  endpoint?: string;
}

function resolveEndpoint(explicit: string | undefined): string | undefined {
  if (explicit) return explicit;
  const env =
    typeof process !== "undefined"
      ? process.env?.[KUBIT_OTEL_ENDPOINT_ENV]
      : undefined;
  if (env) return env;
  const otlpEnv =
    typeof process !== "undefined"
      ? process.env?.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
        process.env?.OTEL_EXPORTER_OTLP_ENDPOINT
      : undefined;
  if (otlpEnv) return undefined; // let the underlying exporter pick it up
  return DEFAULT_ENDPOINT;
}

export class KubitExporter implements SpanExporter {
  private readonly inner: OTLPTraceExporter;

  constructor(config: KubitExporterConfig) {
    const url = resolveEndpoint(config.endpoint);
    this.inner = new OTLPTraceExporter({
      url,
      headers: { "x-api-key": config.apiKey },
    });
    logger.debug(
      `KubitExporter initialised  endpoint=${redactEndpoint(url ?? "<from OTEL_EXPORTER_OTLP_*>")}`,
    );
  }

  export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    this.inner.export(spans, resultCallback);
  }

  async shutdown(): Promise<void> {
    logger.debug("KubitExporter shutdown");
    return this.inner.shutdown();
  }

  async forceFlush(): Promise<void> {
    logger.debug("forceFlush called");
    return this.inner.forceFlush();
  }
}
