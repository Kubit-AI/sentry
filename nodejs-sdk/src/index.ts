/**
 * @kubit/otel — OpenTelemetry exporter for Kubit analytics.
 *
 * Usage:
 *     import { configure } from "@kubit/otel";
 *     configure({ apiKey: "rg.v1.xxx", serviceName: "my-app" });
 */

export { KubitExporter, type KubitExporterConfig } from "./exporter.js";
export {
  KubitSpanProcessor,
  type KubitSpanProcessorConfig,
} from "./processor.js";
export { configure, type ConfigureOptions } from "./setup.js";
export {
  CredentialManager,
  CredentialError,
  type KinesisCredentials,
  type WorkspaceIdentity,
} from "./credentials.js";
export { transformSpans, type KubitRecord } from "./transformer.js";
