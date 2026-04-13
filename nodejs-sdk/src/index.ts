/**
 * @kubit/otel — OpenTelemetry exporter for Kubit analytics.
 *
 * Usage:
 *     import { configure } from "@kubit/otel";
 *     configure({ apiKey: "rg.v1.xxx", serviceName: "my-app" });
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
