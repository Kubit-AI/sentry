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
 *       integrations: [
 *         kubitSentryIntegration({ apiKey: "rg.v1...", serviceName: "my-app" }),
 *       ],
 *     });
 *
 * `apiKey` is the workspace ingestion key you mint in the Kubit app; pass it as
 * an option (required in the browser) or set `KUBIT_OTEL_API_KEY` in Node. The
 * endpoint defaults to `https://otel.kubit.ai/v1/traces` (override via `endpoint`
 * or `KUBIT_OTEL_ENDPOINT` only for a non-prod Kubit env).
 *
 * This SDK does NOT replace Sentry — it runs alongside it and ships a copy of
 * each event to Kubit so the data can be modeled and displayed in the Kubit
 * product.
 */

export { kubitSentryIntegration } from "./integration";
export { SDK_VERSION } from "./version";
export {
  resolveConfig,
  DEFAULT_ENDPOINT,
  type KubitSentryOptions,
  type KubitSentryConfig,
} from "./config";
export {
  createRollingSession,
  type RollingSessionOptions,
  type SessionIdProvider,
  type SessionStorageLike,
} from "./session";
// Cookie-backed visitor identity shared across Kubit web surfaces: mint-once
// anonymous id (optionally fingerprint-seeded) + explicit-start 30-min
// hard-clock session. `getSessionId`/`getAnonymousId` are the read surface
// for consumers that attach the ids to their own transport (e.g. request
// headers); `getIdentityAttributes` returns them under the canonical
// `session.id` / `user.anonymous_id` attribute names.
export {
  getAnonymousId,
  hasEstablishedAnonymousId,
  upgradeAnonymousId,
  seedAnonymousId,
  startSession,
  startSessionFromToken,
  getSessionId,
  clearSession,
  getIdentityAttributes,
  getRegistrableCookieDomain,
} from "./identity";
// Client-context attributes (browser/os/locale/timezone + async geo) under
// OTel semconv keys — the SDK owns this naming so every emitter lands on the
// same attribute keys.
export {
  getClientContextAttributes,
  initGeoContext,
  type GeoContextOptions,
} from "./clientContext";
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
