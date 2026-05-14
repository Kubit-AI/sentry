/**
 * Convenience setup — one-liner to configure OTel with the Kubit exporter.
 */

import type { TracerProvider } from "@opentelemetry/api";
import { resourceFromAttributes, type Resource } from "@opentelemetry/resources";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { logger, redactEndpoint } from "./logger";
import type { MaskSpan } from "./mask";
import { KubitSpanProcessor } from "./processor";
import type { ShouldExportSpan } from "./spanFilter";
import { SDK_NAME, VERSION as SDK_VERSION } from "./version";

export interface ConfigureOptions {
  /** Kubit API key (`rg.v1.<payload>.<sig>`). */
  apiKey: string;
  /** Name of the service (maps to `service.name` resource attribute). */
  serviceName?: string;
  /** Version of the service. */
  serviceVersion?: string;
  /**
   * Trace endpoint URL. See {@link KubitExporter} for resolution precedence
   * (explicit arg → `KUBIT_OTEL_ENDPOINT` env →
   * `https://otel.kubit.ai/v1/traces`).
   */
  endpoint?: string;
  /** Additional OTel resource attributes to include. */
  resourceAttributes?: Record<string, string>;
  /**
   * Predicate deciding which spans are forwarded to Kubit. See
   * {@link isDefaultExportSpan}. Defaults to LLM-only filtering.
   */
  shouldExportSpan?: ShouldExportSpan;
  /**
   * Sync transform that redacts sensitive content from each span before
   * export. See the `@kubit-ai/otel/mask` module for helpers and the full
   * contract.
   */
  mask?: MaskSpan;
}

function buildResource(
  serviceName: string,
  serviceVersion: string | undefined,
  extra: Record<string, string> | undefined,
): Resource {
  const attrs: Record<string, string> = { "service.name": serviceName };
  if (serviceVersion) attrs["service.version"] = serviceVersion;
  if (extra) Object.assign(attrs, extra);
  // SDK identity is set last so user-supplied attrs cannot clobber it.
  attrs["kubit.sdk.name"] = SDK_NAME;
  attrs["kubit.sdk.version"] = SDK_VERSION;
  return resourceFromAttributes(attrs);
}

/**
 * Configure OpenTelemetry with the Kubit exporter.
 *
 * ```ts
 * import { configure } from "@kubit-ai/otel";
 * const provider = configure({ apiKey: "rg.v1.xxx", serviceName: "my-app" });
 * ```
 *
 * Always creates a fresh `NodeTracerProvider` and registers it as the global
 * provider. OTel JS SDK v2 requires processors to be supplied at provider
 * construction time — there is no public API to attach a processor to an
 * already-running provider — so apps that need Kubit alongside another OTel
 * SDK must construct one `NodeTracerProvider` themselves and pass both
 * processors via `spanProcessors: [...]`. Use `KubitSpanProcessor` for that
 * direct path.
 *
 * @returns The freshly-registered provider.
 */
export function configure(options: ConfigureOptions): TracerProvider {
  const serviceName = options.serviceName ?? "default";
  const resource = buildResource(
    serviceName,
    options.serviceVersion,
    options.resourceAttributes,
  );
  const processor = new KubitSpanProcessor({
    apiKey: options.apiKey,
    endpoint: options.endpoint,
    shouldExportSpan: options.shouldExportSpan,
    mask: options.mask,
  });

  const provider = new NodeTracerProvider({
    resource,
    spanProcessors: [processor],
  });
  provider.register();

  logger.info(
    `kubit_otel configured  service_name=${serviceName} ` +
      `service_version=${options.serviceVersion ?? "-"} ` +
      `endpoint=${redactEndpoint(options.endpoint ?? "<from KUBIT_OTEL_ENDPOINT or default>")}`,
  );

  return provider;
}
