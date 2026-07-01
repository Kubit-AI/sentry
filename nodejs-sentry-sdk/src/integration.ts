/**
 * Public wiring for teeing Sentry events into Kubit.
 *
 * Two integration styles, both non-destructive (they never drop or mutate the
 * event Sentry sends):
 *
 *   1. `kubitSentryIntegration(options)` — the idiomatic Sentry v8+ functional
 *      integration. Add it to `Sentry.init({ integrations: [...] })`. It
 *      registers on the client's `afterSendEvent` hook, so Kubit receives a
 *      copy of exactly what Sentry sends — after sampling, event processors,
 *      and the app's own `beforeSend` / `beforeSendTransaction` scrubbing.
 *      Events dropped before sending never reach Kubit.
 *
 *   2. `createKubitSentryHooks(options)` — returns `{ beforeSend,
 *      beforeSendTransaction }` for apps that prefer to wire the explicit
 *      `Sentry.init` hooks (or already compose their own integration list).
 *      The tee sees the event exactly as the hook receives it — if you scrub
 *      PII in your own `beforeSend`, scrub first and call the Kubit wrapper
 *      on the scrubbed event.
 *
 * Both share `teeEvent`: translate -> fire-and-forget OTLP POST. Export errors
 * are swallowed (optionally logged when `debug: true`) so a failing Kubit
 * endpoint can never break the host app's Sentry pipeline.
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
 *       integrations: [kubitSentryIntegration({ serviceName: "my-app" })],
 *     });
 *
 * `apiKey` defaults to `process.env.KUBIT_OTEL_API_KEY`; `endpoint` to
 * `KUBIT_OTEL_ENDPOINT` or the prod default.
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

/**
 * Explicit-hook factory for apps that wire `Sentry.init` hooks directly:
 *
 *     const { beforeSend, beforeSendTransaction } = createKubitSentryHooks();
 *     Sentry.init({ dsn: "...", beforeSend, beforeSendTransaction });
 *
 * If the app already has its own `beforeSend`, compose: scrub/transform in
 * your own hook first, then call the Kubit wrapper on the result so the copy
 * sent to Kubit is the scrubbed event.
 */
export const createKubitSentryHooks = (options: KubitSentryOptions = {}) => {
  const config = resolveConfig(options);
  return {
    beforeSend: (event: Event): Event => {
      teeEvent(event, config);
      return event;
    },
    beforeSendTransaction: (event: Event): Event => {
      teeEvent(event, config);
      return event;
    },
  };
};
