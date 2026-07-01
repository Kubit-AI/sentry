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
  /**
   * Session id source. A string, or a function called per teed event to read
   * the current id (e.g. `createRollingSession(...)`). When set, every exported
   * span carries a `session.id` attribute. The browser `init()` defaults this to
   * a 30-min rolling session; elsewhere, omit it for no session id.
   */
  sessionId?: string | (() => string | undefined);
}

/** Fully-resolved config consumed by the transform + exporter. */
export interface KubitSentryConfig {
  apiKey: string;
  endpoint: string;
  serviceName?: string;
  serviceVersion?: string;
  debug: boolean;
  /** Resolved session-id reader; absent when no session id was configured. */
  getSessionId?: () => string | undefined;
}

const readEnv = (key: string): string | undefined =>
  typeof process !== "undefined" && process.env ? process.env[key] : undefined;

/** Normalize the `sessionId` option (string | function | undefined) to a reader. */
const resolveSessionProvider = (
  sessionId: KubitSentryOptions["sessionId"],
): (() => string | undefined) | undefined => {
  if (sessionId === undefined) {
    return undefined;
  }
  if (typeof sessionId === "function") {
    return sessionId;
  }
  return () => sessionId;
};

export const resolveConfig = (
  options: KubitSentryOptions = {},
): KubitSentryConfig => ({
  apiKey: options.apiKey ?? readEnv("KUBIT_OTEL_API_KEY") ?? "",
  endpoint: options.endpoint ?? readEnv("KUBIT_OTEL_ENDPOINT") ?? DEFAULT_ENDPOINT,
  serviceName: options.serviceName ?? readEnv("KUBIT_SERVICE_NAME"),
  serviceVersion: options.serviceVersion,
  debug: options.debug ?? false,
  getSessionId: resolveSessionProvider(options.sessionId),
});
