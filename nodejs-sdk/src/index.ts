/**
 * @kubit-ai/otel — OpenTelemetry exporter for Kubit analytics.
 *
 * Usage:
 *     import { configure } from "@kubit-ai/otel";
 *     configure({ apiKey: "rg.v1.xxx", serviceName: "my-app" });
 *
 * Internal SDK log verbosity is controlled by the `KUBIT_OTEL_LOG_LEVEL`
 * environment variable (debug | info | warn | error). Default: info.
 */

export { KubitExporter, type KubitExporterConfig } from "./exporter";
export {
  KubitSpanProcessor,
  type KubitSpanProcessorConfig,
} from "./processor";
export { configure, type ConfigureOptions } from "./setup";
export {
  CredentialManager,
  CredentialError,
  type KinesisCredentials,
  type WorkspaceIdentity,
} from "./credentials";
export { transformSpans, type KubitRecord } from "./transformer";
export {
  KNOWN_LLM_INSTRUMENTATION_SCOPE_PREFIXES,
  KUBIT_TRACER_NAME,
  getInstrumentationScopeName,
  isDefaultExportSpan,
  isGenAISpan,
  isKnownLLMInstrumentor,
  isKubitSpan,
  type ShouldExportSpan,
} from "./spanFilter";
