/**
 * @kubit-ai/sentry — tee Sentry events (errors + transactions) to Kubit as
 * OTLP for behavior analytics.
 *
 * Usage (idiomatic):
 *     import * as Sentry from "@sentry/react";
 *     import { kubitSentryIntegration } from "@kubit-ai/sentry";
 *
 *     Sentry.init({
 *       dsn: "https://...@sentry.io/...",
 *       integrations: [kubitSentryIntegration({ serviceName: "my-app" })],
 *     });
 *
 * The ingestion key is read from `KUBIT_OTEL_API_KEY` (or pass `apiKey`); the
 * endpoint from `KUBIT_OTEL_ENDPOINT` (default `https://otel.kubit.ai/v1/traces`).
 *
 * This SDK does NOT replace Sentry — it runs alongside it and ships a copy of
 * each event to Kubit so the data can be modeled and displayed in the Kubit
 * product.
 */

export {
  kubitSentryIntegration,
  createKubitSentryHooks,
} from "./integration";
export {
  resolveConfig,
  DEFAULT_ENDPOINT,
  type KubitSentryOptions,
  type KubitSentryConfig,
} from "./config";
export {
  sentryEventToOtlp,
  sentryTransactionToOtlp,
  sentryErrorToOtlp,
} from "./sentryToOtel";
export { postOtlp, type PostResult } from "./exporter";
export type {
  OtlpExportRequest,
  OtlpSpan,
  OtlpSpanEvent,
  OtlpKeyValue,
  OtlpAnyValue,
} from "./types";
