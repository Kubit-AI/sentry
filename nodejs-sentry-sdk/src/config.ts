/**
 * Configuration resolution for the Kubit Sentry SDK.
 *
 * Precedence: explicit options > environment variables > built-in default.
 * Env reads are guarded so the SDK also works in browser bundles where
 * `process` is undefined (bundlers typically inline `process.env.FOO` at
 * build time, but a runtime guard avoids a ReferenceError when they don't).
 */

/** Prod ingestion endpoint — same OTLP/HTTP entrypoint the LLM SDK uses. */
export const DEFAULT_ENDPOINT = "https://otel.kubit.ai/v1/traces";

/** User-facing options accepted by the integration / hook factories. */
export interface KubitSentryOptions {
  /** Workspace ingestion key (`rg.v1.*`). Falls back to `KUBIT_OTEL_API_KEY`. */
  apiKey?: string;
  /** OTLP/HTTP traces endpoint. Falls back to `KUBIT_OTEL_ENDPOINT`. */
  endpoint?: string;
  /** `service.name` resource attribute. Falls back to `KUBIT_SERVICE_NAME`. */
  serviceName?: string;
  /** `service.version` resource attribute. Falls back to the event `release`. */
  serviceVersion?: string;
  /** When true, failed exports are logged via `console.warn`. */
  debug?: boolean;
}

/** Fully-resolved config consumed by the transform + exporter. */
export interface KubitSentryConfig {
  apiKey: string;
  endpoint: string;
  serviceName?: string;
  serviceVersion?: string;
  debug: boolean;
}

const readEnv = (key: string): string | undefined =>
  typeof process !== "undefined" && process.env ? process.env[key] : undefined;

export const resolveConfig = (
  options: KubitSentryOptions = {},
): KubitSentryConfig => ({
  apiKey: options.apiKey ?? readEnv("KUBIT_OTEL_API_KEY") ?? "",
  endpoint: options.endpoint ?? readEnv("KUBIT_OTEL_ENDPOINT") ?? DEFAULT_ENDPOINT,
  serviceName: options.serviceName ?? readEnv("KUBIT_SERVICE_NAME"),
  serviceVersion: options.serviceVersion,
  debug: options.debug ?? false,
});
