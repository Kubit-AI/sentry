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

import { SpanStatusCode, type Context } from "@opentelemetry/api";
import {
  BatchSpanProcessor,
  type BufferConfig,
  type ReadableSpan,
  type Span,
} from "@opentelemetry/sdk-trace-base";
import { KubitExporter, type KubitExporterConfig } from "./exporter";
import { logger } from "./logger";
import type { MaskSpan } from "./mask";
import {
  getInstrumentationScopeName,
  isDefaultExportSpan,
  type ShouldExportSpan,
} from "./spanFilter";
import { SDK_NAME, VERSION as SDK_VERSION } from "./version";

const TOMBSTONE_STATUS_DESCRIPTION = "kubit-otel mask failed";
const TOMBSTONE_MARKER_KEY = "kubit.sdk.mask_error";

/**
 * Build a payload-free skeleton of `original` for the mask-failure path.
 *
 * Trace structure is preserved (trace/span IDs, parent, timing, kind,
 * resource); every field that could carry PII is wiped (attributes, events,
 * link attrs, status.description). Status is forced to ERROR so failures show
 * up in OTel-native error dashboards. A single marker attribute names the
 * cause (exception class name, or the literal `"returned_null"`).
 *
 * This is the last line of defense against a buggy customer mask. It must
 * not throw — defensive reads everywhere, and a final try/catch wraps the
 * construction with a degenerate fallback if anything in the original is
 * structurally surprising.
 */
function buildTombstone(original: ReadableSpan, cause: string): ReadableSpan {
  // Defensive readers — every field access on `original` is wrapped so a
  // pathological input (getter that throws, missing property) can never crash
  // the tombstone path. This is the last line of defense.
  const safeRead = <T>(fn: () => T, fallback: T): T => {
    try {
      const v = fn();
      return v == null ? fallback : v;
    } catch {
      return fallback;
    }
  };

  const name = safeRead(
    () => (typeof original.name === "string" ? original.name : "[unknown]"),
    "[unknown]"
  );
  const ctx = safeRead(() => original.spanContext(), {
    traceId: "0".repeat(32),
    spanId: "0".repeat(16),
    traceFlags: 0,
  } as unknown as ReturnType<ReadableSpan["spanContext"]>);

  const tombstone = {
    name,
    kind: safeRead(() => original.kind, 0 /* INTERNAL */ as unknown as ReadableSpan["kind"]),
    spanContext: () => ctx,
    parentSpanContext: safeRead(
      () => (original as { parentSpanContext?: unknown }).parentSpanContext,
      undefined
    ),
    startTime: safeRead(() => original.startTime, [0, 0] as [number, number]),
    endTime: safeRead(() => original.endTime, [0, 0] as [number, number]),
    status: {
      code: SpanStatusCode.ERROR,
      message: TOMBSTONE_STATUS_DESCRIPTION,
    },
    attributes: { [TOMBSTONE_MARKER_KEY]: cause } as Record<string, unknown>,
    links: [],
    events: [],
    duration: safeRead(() => original.duration, [0, 0] as [number, number]),
    ended: true,
    resource: safeRead(() => original.resource, undefined as unknown as ReadableSpan["resource"]),
    instrumentationScope: safeRead(
      () => original.instrumentationScope,
      undefined as unknown as ReadableSpan["instrumentationScope"]
    ),
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  } as unknown as ReadableSpan;
  return tombstone;
}

export interface KubitSpanProcessorConfig extends KubitExporterConfig {
  /**
   * Predicate that decides whether a span is forwarded to Kubit. Spans for
   * which it returns `false` are dropped before they reach the batch queue.
   * Defaults to {@link isDefaultExportSpan}. Pass `() => true` to disable
   * filtering entirely.
   */
  shouldExportSpan?: ShouldExportSpan;
  /**
   * Sync transform `(span: ReadableSpan) => ReadableSpan` that runs after
   * `shouldExportSpan` and before the batch queue. Use it together with the
   * helpers in `@kubit-ai/otel/mask` to redact sensitive content from span
   * attributes and events. If `mask` throws or returns `null`/`undefined`, the
   * SDK ships a tombstone (structural skeleton + `kubit.sdk.mask_error`
   * marker + `status=ERROR`) in place of the span — un-masked data is never
   * shipped (fail-closed). See the `mask` module for the full contract.
   */
  mask?: MaskSpan;
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
  private readonly mask: MaskSpan | undefined;

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
    this.mask = config.mask;

    logger.debug(
      `KubitSpanProcessor initialised  maxQueueSize=${bufferConfig.maxQueueSize} ` +
        `scheduledDelayMillis=${bufferConfig.scheduledDelayMillis} ` +
        `maxExportBatchSize=${bufferConfig.maxExportBatchSize} ` +
        `exportTimeoutMillis=${bufferConfig.exportTimeoutMillis} ` +
        `shouldExportSpan=${config.shouldExportSpan ? "custom" : "default"} ` +
        `mask=${config.mask ? "custom" : "none"}`
    );
  }

  onStart(span: Span, parentContext: Context): void {
    super.onStart(span, parentContext);
    // Stamp Kubit SDK identity on every span so it survives even when a
    // user constructs their TracerProvider's Resource without going through
    // `configure()` / `buildResource()`. Cylon lifts these two keys into the
    // observation `metadata`. `onEnd` below stamps the same attributes
    // defensively to cover bridge exporters that synthesize a ReadableSpan
    // and invoke `onEnd` directly without going through `onStart`.
    span.setAttribute("kubit.sdk.name", SDK_NAME);
    span.setAttribute("kubit.sdk.version", SDK_VERSION);
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
    let outSpan: ReadableSpan = span;
    if (this.mask) {
      try {
        const masked = this.mask(span);
        if (masked == null) {
          logger.error(
            `mask returned null; tombstoning span (use shouldExportSpan to filter)  ` +
              `span_name=${span.name} ` +
              `span_id=${span.spanContext?.().spanId ?? "-"}`
          );
          outSpan = buildTombstone(span, "returned_null");
        } else {
          outSpan = masked;
        }
      } catch (err) {
        // Fail-closed: a mask that throws must never leak un-masked data.
        // Tombstone the span so trace structure survives and the failure is
        // loudly visible via status=ERROR + marker attr.
        const errObj = err as Error;
        logger.error(
          `mask raised; tombstoning span  span_name=${span.name} ` +
            `span_id=${span.spanContext?.().spanId ?? "-"} ` +
            `err=${errObj?.message ?? String(err)} ` +
            `stack=${errObj?.stack ?? "-"}`
        );
        outSpan = buildTombstone(span, errObj?.name ?? "Error");
      }
    }
    // Re-stamp SDK identity. When a mask ran, force-overwrite so an
    // overzealous mask cannot strip Cylon's per-SDK identification. When no
    // mask is configured, fill-if-missing — covering bridge exporters that
    // synthesize a ReadableSpan and invoke onEnd directly without going
    // through onStart.
    this.stampKubitSdkIdentity(outSpan, this.mask !== undefined);
    super.onEnd(outSpan);
  }

  private stampKubitSdkIdentity(
    span: ReadableSpan,
    force: boolean,
  ): void {
    const attrs = span.attributes as Record<string, unknown> | undefined;
    if (!attrs) return;
    if (force || attrs["kubit.sdk.name"] === undefined) {
      attrs["kubit.sdk.name"] = SDK_NAME;
    }
    if (force || attrs["kubit.sdk.version"] === undefined) {
      attrs["kubit.sdk.version"] = SDK_VERSION;
    }
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
