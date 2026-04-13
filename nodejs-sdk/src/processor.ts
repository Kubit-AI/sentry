/**
 * KubitSpanProcessor — drop-in OTel SpanProcessor for Kubit analytics.
 *
 *     import { KubitSpanProcessor } from "@kubit/otel";
 *
 *     provider.addSpanProcessor(
 *       new KubitSpanProcessor({ apiKey: "rg.v1.xxx" })
 *     );
 */

import {
  BatchSpanProcessor,
  type BufferConfig,
} from "@opentelemetry/sdk-trace-base";
import { KubitExporter, type KubitExporterConfig } from "./exporter.js";

export interface KubitSpanProcessorConfig extends KubitExporterConfig {
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
  constructor(config: KubitSpanProcessorConfig) {
    const exporter = new KubitExporter({
      apiKey: config.apiKey,
      tokenEndpoint: config.tokenEndpoint,
    });

    const bufferConfig: BufferConfig = {
      maxQueueSize: config.maxQueueSize ?? 2048,
      scheduledDelayMillis: config.scheduledDelayMillis ?? 5000,
      maxExportBatchSize: config.maxExportBatchSize ?? 512,
      exportTimeoutMillis: config.exportTimeoutMillis ?? 30000,
    };

    super(exporter, bufferConfig);
  }
}
