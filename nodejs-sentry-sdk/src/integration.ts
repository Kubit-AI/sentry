/**
 * Public wiring for teeing Sentry events into Kubit.
 *
 * `kubitSentryIntegration(options)` — the idiomatic Sentry v8+ functional
 * integration. Add it to `Sentry.init({ integrations: [...] })`. It registers
 * on the client's single `afterSendEvent` hook, which covers BOTH error and
 * transaction events, so Kubit receives a copy of exactly what Sentry sends —
 * after sampling, event processors, and the app's own `beforeSend` /
 * `beforeSendTransaction` scrubbing. Events dropped before sending never reach
 * Kubit. The integration is non-destructive: it never drops or mutates the
 * event Sentry sends.
 *
 * `teeEvent` does the work: translate -> fire-and-forget OTLP POST. Export
 * errors are swallowed (optionally logged when `debug: true`) so a failing
 * Kubit endpoint can never break the host app's Sentry pipeline.
 */

import type { Event, Integration } from "@sentry/core";
import {
  resolveConfig,
  type KubitSentryConfig,
  type KubitSentryOptions,
} from "./config";
import { postOtlp } from "./exporter";
import { sentryEventToOtlp } from "./sentryToOtel";

const INTEGRATION_NAME = "KubitSentry";

const teeEvent = (event: Event, config: KubitSentryConfig): void => {
  if (!config.apiKey) {
    return;
  }
  // Only tee error and transaction events; ignore replay/profile/feedback/etc.
  if (event.type !== undefined && event.type !== "transaction") {
    return;
  }

  // Resolved here, at the impure boundary, so the transform stays pure: a
  // rolling session reads the clock / storage on each tee.
  const sessionId = config.getSessionId?.();

  let payload;
  try {
    payload = sentryEventToOtlp(event, config, sessionId);
  } catch {
    return;
  }
  if ((payload.resourceSpans[0]?.scopeSpans[0]?.spans.length ?? 0) === 0) {
    return;
  }

  void postOtlp(payload, config)
    .then((result) => {
      if (!config.debug) {
        return;
      }
      const spans = payload.resourceSpans[0]?.scopeSpans[0]?.spans ?? [];
      const names = spans.map((s) => s.name);
      if (result.ok) {
        console.info(
          `[kubit-sentry] sent ${spans.length} span(s) → ${config.endpoint} [${result.status}]`,
          names,
        );
      } else {
        console.warn(
          `[kubit-sentry] export failed: ${result.status} ${result.message ?? ""}`,
          names,
        );
      }
    })
    .catch(() => {
      // postOtlp never throws; defend against it anyway.
    });
};

/**
 * Sentry functional integration. Usage:
 *
 *     Sentry.init({
 *       dsn: "...",
 *       environment: "production",
 *       integrations: [
 *         kubitSentryIntegration({ apiKey: "rg.v1...", serviceName: "my-app" }),
 *       ],
 *     });
 *
 * `apiKey` is the Kubit workspace ingestion key (required; pass it as an option
 * — mandatory in the browser — or set `KUBIT_OTEL_API_KEY` in Node). `endpoint`
 * defaults to the prod collector (override via `endpoint` / `KUBIT_OTEL_ENDPOINT`
 * only for a non-prod Kubit env). `environment` is a Sentry.init field, not a
 * Kubit option — the tee copies the event's environment to
 * `deployment.environment`.
 *
 * Tees on `afterSendEvent` (not `processEvent`) so the copy sent to Kubit
 * reflects sampling, event processors, and the app's `beforeSend` scrubbing —
 * events Sentry drops are never exported.
 */
export const kubitSentryIntegration = (
  options: KubitSentryOptions = {},
): Integration => {
  const config = resolveConfig(options);
  return {
    name: INTEGRATION_NAME,
    setup(client) {
      client.on("afterSendEvent", (event) => {
        teeEvent(event, config);
      });
    },
  };
};
