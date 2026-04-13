/**
 * Convenience setup — one-liner to configure OTel with Kubit exporter.
 */

import { trace } from "@opentelemetry/api";
import { Resource } from "@opentelemetry/resources";
import {
  NodeTracerProvider,
  BatchSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { KubitExporter } from "./exporter";
import { DEFAULT_TOKEN_ENDPOINT } from "./credentials";

export interface ConfigureOptions {
  /** Kubit API key (`rg.v1.<payload>.<sig>`). */
  apiKey: string;
  /** Name of the service (maps to `service.name` resource attribute). */
  serviceName?: string;
  /** Version of the service. */
  serviceVersion?: string;
  /** URL of the credential endpoint. */
  tokenEndpoint?: string;
  /** Additional OTel resource attributes to include. */
  resourceAttributes?: Record<string, string>;
}

/**
 * Configure OpenTelemetry with the Kubit exporter.
 *
 * This is the simplest way to get started:
 *
 * ```ts
 * import { configure } from "@kubit/otel";
 * const provider = configure({ apiKey: "rg.v1.xxx", serviceName: "my-app" });
 * ```
 *
 * All spans from any tracer now flow to Kubit.
 *
 * @returns The configured NodeTracerProvider (also registered as global provider).
 */
export function configure(options: ConfigureOptions): NodeTracerProvider {
  const attrs: Record<string, string> = {
    "service.name": options.serviceName ?? "default",
  };

  if (options.serviceVersion) {
    attrs["service.version"] = options.serviceVersion;
  }
  if (options.resourceAttributes) {
    Object.assign(attrs, options.resourceAttributes);
  }

  const resource = new Resource(attrs);
  const provider = new NodeTracerProvider({ resource });

  const exporter = new KubitExporter({
    apiKey: options.apiKey,
    tokenEndpoint: options.tokenEndpoint ?? DEFAULT_TOKEN_ENDPOINT,
  });

  provider.addSpanProcessor(new BatchSpanProcessor(exporter));
  provider.register();

  return provider;
}
