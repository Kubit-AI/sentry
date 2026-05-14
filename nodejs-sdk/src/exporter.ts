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
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { logger, redactEndpoint } from "./logger";

export const DEFAULT_ENDPOINT = "https://otel.kubit.ai/v1/traces";
export const KUBIT_OTEL_ENDPOINT_ENV = "KUBIT_OTEL_ENDPOINT";

export interface KubitExporterConfig {
  /** Kubit API key (`rg.v1.<payload>.<sig>`). Sent as `x-api-key`. */
  apiKey: string;
  /**
   * Full trace endpoint URL. Resolution precedence: explicit arg →
   * `KUBIT_OTEL_ENDPOINT` env → built-in default
   * `https://otel.kubit.ai/v1/traces`. The standard `OTEL_EXPORTER_OTLP_*`
   * env vars are not consulted.
   */
  endpoint?: string;
}

function resolveEndpoint(explicit: string | undefined): string {
  if (explicit) return explicit;
  const env =
    typeof process !== "undefined"
      ? process.env?.[KUBIT_OTEL_ENDPOINT_ENV]
      : undefined;
  if (env) return env;
  return DEFAULT_ENDPOINT;
}

/**
 * OTel SpanExporter that ships spans to Kubit via OTLP/HTTP.
 *
 * **Note:** the default span filter (`isDefaultExportSpan`) and the
 * user-supplied `mask` hook both live in {@link KubitSpanProcessor}, not
 * here. Consumers who wrap this exporter in their own `SpanProcessor` must
 * compose the filter and mask themselves; otherwise un-filtered, un-masked
 * spans will ship.
 */
export class KubitExporter implements SpanExporter {
  private readonly inner: OTLPTraceExporter;

  constructor(config: KubitExporterConfig) {
    const url = resolveEndpoint(config.endpoint);
    this.inner = new OTLPTraceExporter({
      url,
      headers: { "x-api-key": config.apiKey },
    });
    logger.debug(
      `KubitExporter initialised  endpoint=${redactEndpoint(url)}`,
    );
  }

  export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    const spanCount = spans.length;
    this.inner.export(spans, (result) => {
      if (result.code === ExportResultCode.SUCCESS) {
        logger.debug(`Exported batch to kubit  span_count=${spanCount}`);
      } else {
        logger.warn(`KubitExporter export failed  span_count=${spanCount}`);
      }
      resultCallback(result);
    });
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
