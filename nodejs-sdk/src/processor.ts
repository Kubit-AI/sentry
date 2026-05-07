/**
 * KubitSpanProcessor — drop-in OTel SpanProcessor for Kubit analytics.
 *
 *     import { KubitSpanProcessor } from "@kubit-ai/otel";
 *
 *     provider.addSpanProcessor(
 *       new KubitSpanProcessor({ apiKey: "rg.v1.xxx" })
 *     );
 *
 * By default only LLM-relevant spans are forwarded; override via
 * `shouldExportSpan`.
 */

import type { Context } from "@opentelemetry/api";
import {
  BatchSpanProcessor,
  type BufferConfig,
  type ReadableSpan,
  type Span,
} from "@opentelemetry/sdk-trace-base";
import { KubitExporter, type KubitExporterConfig } from "./exporter";
import { logger } from "./logger";
import {
  getInstrumentationScopeName,
  isDefaultExportSpan,
  type ShouldExportSpan,
} from "./spanFilter";

export interface KubitSpanProcessorConfig extends KubitExporterConfig {
  /**
   * Predicate that decides whether a span is forwarded to Kubit. Spans for
   * which it returns `false` are dropped before they reach the batch queue.
   * Defaults to {@link isDefaultExportSpan}. Pass `() => true` to disable
   * filtering entirely.
   */
  shouldExportSpan?: ShouldExportSpan;
  /** Maximum queue size (default: 2048). */
  maxQueueSize?: number;
  /** Delay between export batches in ms (default: 5000). */
  scheduledDelayMillis?: number;
  /** Maximum batch size per export (default: 512). */
  maxExportBatchSize?: number;
  /** Timeout for each export call in ms (default: 30000). */
  exportTimeoutMillis?: number;
}

export class KubitSpanProcessor extends BatchSpanProcessor {
  private readonly shouldExportSpan: ShouldExportSpan;

  constructor(config: KubitSpanProcessorConfig) {
    const exporter = new KubitExporter({
      apiKey: config.apiKey,
      endpoint: config.endpoint,
    });

    const bufferConfig: BufferConfig = {
      maxQueueSize: config.maxQueueSize ?? 2048,
      scheduledDelayMillis: config.scheduledDelayMillis ?? 5000,
      maxExportBatchSize: config.maxExportBatchSize ?? 512,
      exportTimeoutMillis: config.exportTimeoutMillis ?? 30000,
    };

    super(exporter, bufferConfig);

    this.shouldExportSpan =
      config.shouldExportSpan ??
      (({ otelSpan }) => isDefaultExportSpan(otelSpan));

    logger.debug(
      `KubitSpanProcessor initialised  maxQueueSize=${bufferConfig.maxQueueSize} ` +
        `scheduledDelayMillis=${bufferConfig.scheduledDelayMillis} ` +
        `maxExportBatchSize=${bufferConfig.maxExportBatchSize} ` +
        `exportTimeoutMillis=${bufferConfig.exportTimeoutMillis} ` +
        `shouldExportSpan=${config.shouldExportSpan ? "custom" : "default"}`
    );
  }

  onStart(span: Span, parentContext: Context): void {
    super.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    let keep: boolean;
    try {
      keep = this.shouldExportSpan({ otelSpan: span }) === true;
    } catch (err) {
      logger.debug(
        `shouldExportSpan raised; dropping span  span_name=${span.name} ` +
          `scope=${getInstrumentationScopeName(span) ?? "null"} ` +
          `err=${(err as Error)?.message ?? String(err)}`
      );
      return;
    }
    if (!keep) {
      logger.debug(
        `Dropped span due to shouldExportSpan filter  span_name=${span.name} ` +
          `scope=${getInstrumentationScopeName(span) ?? "null"}`
      );
      return;
    }
    super.onEnd(span);
  }

  async shutdown(): Promise<void> {
    logger.debug("KubitSpanProcessor shutdown");
    return super.shutdown();
  }

  async forceFlush(): Promise<void> {
    logger.debug("KubitSpanProcessor forceFlush");
    return super.forceFlush();
  }
}
