# @kubit-ai/sentry

[![npm](https://img.shields.io/npm/v/%40kubit-ai%2Fsentry)](https://www.npmjs.com/package/@kubit-ai/sentry)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/Kubit-AI/sentry/blob/master/LICENSE)
[![Source](https://img.shields.io/badge/GitHub-Kubit--AI%2Fsentry-181717?logo=github)](https://github.com/Kubit-AI/sentry/tree/master/nodejs-sentry-sdk)

Tee your existing Sentry telemetry into Kubit. The SDK observes the **error**
and **transaction** events your app already sends to Sentry, translates them to
OTLP/HTTP+JSON, and POSTs a copy to the Kubit collector with an `x-api-key`
header. It does **not** replace Sentry and does not change what Sentry
receives — it runs alongside it.

This is the Behavior counterpart to
[`@kubit-ai/otel`](https://www.npmjs.com/package/@kubit-ai/otel) (the LLM/Agent
OTel exporter): same wire contract and `KUBIT_OTEL_API_KEY` convention, a
different *source* (the Sentry SDK's client hooks rather than an OpenTelemetry
`TracerProvider`).

## Install

```bash
npm install @kubit-ai/sentry
# peer: @sentry/core (provided by @sentry/react | @sentry/browser | @sentry/node | …)
```

## Usage

### Integration

```ts
import * as Sentry from "@sentry/react";
import { kubitSentryIntegration } from "@kubit-ai/sentry";

Sentry.init({
  dsn: "https://…@sentry.io/…",
  environment: "production",              // Sentry env → Kubit deployment.environment
  integrations: [
    kubitSentryIntegration({
      apiKey: "rg.v1…",                   // required — mint per workspace in the Kubit app
      serviceName: "my-app",              // optional — names this app inside the workspace
      // endpoint defaults to prod; set it only to target a non-prod Kubit env
    }),
  ],
});
```

The integration registers on the Sentry client's single `afterSendEvent` hook —
which covers both errors and transactions — so Kubit receives a copy of exactly
what Sentry sends, after sampling, event processors, and your `beforeSend` /
`beforeSendTransaction` scrubbing. Events Sentry drops are never exported to
Kubit.

### Browser, no bundler (`<script>` tag)

> **Use this bundle only on a page that doesn't already load Sentry.** It bundles
> its own `@sentry/browser` and calls `Sentry.init`; on a page that already has
> Sentry you'd run two Sentry instances — double-reported errors and duplicated
> bundle weight. If you have a bundler or an existing Sentry on the page, use the
> `kubitSentryIntegration` path above against that Sentry instead.

For a static site that can't run a bundler, build the self-contained browser
bundle (`npm run build:browser` → `dist/browser/kubit-sentry.global.js`,
`@sentry/browser` bundled in) and drop the one file in:

```html
<script src="/kubit-sentry.global.js"></script>
<script>
  KubitSentry.init({
    dsn: "https://…@sentry.io/…",                 // your Sentry project
    apiKey: "rg.v1…",                              // Kubit ingestion key
    endpoint: "https://otel.kubit.ai/v1/traces",
    serviceName: "my-app",
    environment: "production",
  });

  // Named behavior events (the "clicked / action" family) flow through with
  // their name intact:
  KubitSentry.trackEvent("Product Added", { productId: 1, price: 49.99 });
</script>
```

`KubitSentry.init` wires `Sentry.init` with browser tracing (pageload /
navigation / `http.client` spans — the "page view" and "api call" families)
plus the Kubit tee. `KubitSentry.trackEvent(name, attributes)` emits a named,
zero-duration root transaction the tee exports as one OTLP span. The bundle also
re-exports `Sentry` and `kubitSentryIntegration` on the `KubitSentry` global for
advanced wiring.

## Configuration

| Option           | Env var               | Default                             |
| ---------------- | --------------------- | ----------------------------------- |
| `apiKey`         | `KUBIT_OTEL_API_KEY`  | — (required; export is a no-op without it) |
| `endpoint`       | `KUBIT_OTEL_ENDPOINT` | `https://otel.kubit.ai/v1/traces`   |
| `serviceName`    | `KUBIT_SERVICE_NAME`  | `"sentry-app"`                      |
| `serviceVersion` | —                     | the Sentry event `release`          |
| `debug`          | —                     | `false`                             |

`apiKey` is the only required value — mint it for a **Behavior** workspace in the
Kubit app (Settings → Workspace API Keys). `serviceName` is the `service.name`
resource attribute: it names *this app* within the workspace (set it when several
apps share one workspace; otherwise the default is fine). The Sentry
**`environment`** is *not* a Kubit option — set it on `Sentry.init({ environment })`
and the tee copies it to `deployment.environment`.

Environment variables are read at runtime in Node; in browser builds your bundler
must inline them (e.g. via `define` / `EnvironmentPlugin`), or pass the values as
options instead.

**Key handling.** Use a key minted for trace ingestion only. In browser apps
the key is embedded in the served bundle and visible to end users — treat it
like your Sentry DSN, and never reuse a key that carries broader permissions.

## What gets sent

- **Transactions** → OTLP spans (root from `contexts.trace`, one child per
  `event.spans[]`).
- **Errors** → one OTLP span with `status = ERROR` carrying an `exception`
  span event per `exception.values[]` (`exception.type` / `.message` /
  `.stacktrace` / `.escaped`), anchored on the trace context when present,
  otherwise on the Sentry `event_id`.

`service.*` / `deployment.environment` / browser / OS / device land as OTLP
resource attributes. Error spans also carry the event's `tags` and `extra` as
span attributes — anything you don't want exported should be scrubbed in your
Sentry pipeline (the integration runs after your `beforeSend`, so your existing
scrubbing applies).

**Identity attributes.** Every exported span is stamped with `session.id` (when
a session id is configured — the browser bundle enables a rolling session by
default) and `user.id` when your app called `Sentry.setUser({ id })`. `user.id`
is the only user field exported: the user's name and email set via
`Sentry.setUser` are **never** sent to Kubit — user details are resolved
backend-side from the id. If your ids are themselves sensitive, hash them
before passing to `Sentry.setUser`.

## Limitations

- Export is one fire-and-forget POST per event — no batching, sampling, or
  retry. A failed export is dropped (logged via `console.warn` when
  `debug: true`) and never affects your Sentry pipeline.
- Requests time out after 10 seconds.
- In browsers, payloads under ~60 KB are sent with `keepalive` so events fired
  near page unload survive navigation; larger payloads may be lost on unload.
