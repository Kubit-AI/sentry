/**
 * Browser entry for `@kubit-ai/sentry`.
 *
 * Bundles `@sentry/browser` together with the Kubit tee into a single IIFE so a
 * site with NO bundler can wire "Sentry + Kubit behavior analytics" from one
 * `<script>` tag (see `scripts/build-browser.mjs` → `dist/browser/`):
 *
 *     <script src="kubit-sentry.global.js"></script>
 *     <script>
 *       KubitSentry.init({
 *         dsn: "https://...@sentry.io/...",          // your Sentry project
 *         apiKey: "rg.v1...",                         // Kubit ingestion key
 *         endpoint: "https://otel.kubit.ai/v1/traces",
 *         serviceName: "my-app",
 *         environment: "production",
 *       });
 *       KubitSentry.trackEvent("Product Added", { productId: 1, price: 49.99 });
 *     </script>
 *
 * `init` runs `Sentry.init` with browser tracing (pageload / navigation /
 * `http.client` spans — the "page view" and "api call" families) plus the
 * `kubitSentryIntegration` that tees every event Sentry sends to the Kubit
 * collector. `trackEvent` emits a named, zero-duration root transaction (the
 * "clicked / action" family) whose name flows straight through to Kubit.
 *
 * This entry is additive: the CommonJS `index.ts` (bundler-based consumers) is
 * untouched. Only `<script>`-tag consumers use this file.
 */

import * as Sentry from "@sentry/browser";
import { kubitSentryIntegration } from "./integration";
import { createRollingSession } from "./session";
import type { KubitSentryOptions } from "./config";

/** Attribute values accepted on a behavior event. */
type EventAttributeValue = string | number | boolean;

export interface KubitInitOptions extends KubitSentryOptions {
  /** Sentry DSN for your error/transaction project. Omit to skip Sentry capture. */
  dsn?: string;
  /** `deployment.environment` (e.g. "staging", "production"). */
  environment?: string;
  /** Release identifier — also used as `service.version` when set. */
  release?: string;
  /**
   * Fraction of transactions sampled. Behavior analytics wants full capture, so
   * this defaults to 1.0 — lower it only if Sentry is also your perf tool.
   */
  tracesSampleRate?: number;
}

let initialized = false;

/**
 * Initialize Sentry browser + the Kubit tee in one call. Safe to call once per
 * page load. Returns the Sentry namespace for advanced use (manual captures).
 */
export const init = (options: KubitInitOptions = {}): typeof Sentry => {
  const {
    dsn,
    environment,
    release,
    tracesSampleRate = 1.0,
    apiKey,
    endpoint,
    serviceName,
    serviceVersion,
    debug,
    sessionId,
  } = options;

  Sentry.init({
    dsn,
    environment,
    release,
    tracesSampleRate,
    integrations: [
      Sentry.browserTracingIntegration(),
      kubitSentryIntegration({
        apiKey,
        endpoint,
        serviceName,
        serviceVersion: serviceVersion ?? release,
        debug,
        // Default to a 30-min rolling session so every browser consumer gets a
        // `session.id` for free. Pass your own `sessionId` (string or function,
        // e.g. createRollingSession({ initialId: ... })) to override.
        sessionId: sessionId ?? createRollingSession(),
      }),
    ],
  });
  initialized = true;
  return Sentry;
};

/**
 * Emit a named behavior event. Creates a zero-duration root transaction
 * (`forceTransaction`) so the Kubit tee exports it as its own OTLP span named
 * exactly `name`, carrying `attributes` as span attributes. No-op (warns) when
 * called before `init()`.
 */
export const trackEvent = (
  name: string,
  attributes: Record<string, EventAttributeValue> = {},
): void => {
  if (!initialized) {
    console.warn("[kubit-sentry] trackEvent called before init()");
    return;
  }
  Sentry.startSpan(
    { name, op: "ui.action", forceTransaction: true, attributes },
    () => {
      // Zero-duration: the span starts and ends immediately, producing a
      // standalone transaction event the tee converts to one OTLP span.
    },
  );
};

export { Sentry };
export { kubitSentryIntegration } from "./integration";
export {
  createRollingSession,
  type RollingSessionOptions,
  type SessionIdProvider,
  type SessionStorageLike,
} from "./session";
