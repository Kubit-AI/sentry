/**
 * Local smoke test for @kubit-ai/sentry.
 *
 * Exercises the REAL transform + exporter against the collector, from Node —
 * so there's no browser and no CORS in the picture (CORS only applies to
 * browser origins). Proves the SDK's happy path end to end:
 *   synthetic Sentry transaction -> sentryTransactionToOtlp -> POST /v1/traces.
 *
 * Dry run (prints the OTLP payload, skips the POST — no key needed):
 *   npm run smoke
 *
 * Live run (POSTs to the collector; KUBIT_OTEL_ENDPOINT overrides the default):
 *   KUBIT_OTEL_API_KEY=rg.v1.xxxxx npm run smoke
 *
 * The key is read from the environment, never hardcoded — mint one in the
 * Kubit app (Settings > Workspace API Keys, or download its .env).
 */

const {
  resolveConfig,
  sentryTransactionToOtlp,
  postOtlp,
} = require("../dist/index.js");

// A synthetic "workspace switch" transaction: a root span with three child
// spans (open menu -> click -> finish), mirroring the user-flow example. The
// shape matches Sentry's TransactionEvent closely enough for the transform.
const now = Date.now() / 1000;
const traceId = "abcdef0123456789abcdef0123456789";
const rootSpanId = "1111111111111111";

const childSpan = (spanId, op, description, offset, duration) => ({
  span_id: spanId,
  parent_span_id: rootSpanId,
  trace_id: traceId,
  op,
  description,
  start_timestamp: now + offset,
  timestamp: now + offset + duration,
  status: "ok",
  data: { "user.flow": "workspace-switch" },
});

const event = {
  type: "transaction",
  transaction: "workspace-switch",
  start_timestamp: now,
  timestamp: now + 1.2,
  release: "smoke-1.0.0",
  environment: "smoke",
  contexts: {
    trace: {
      trace_id: traceId,
      span_id: rootSpanId,
      op: "ui.action",
      status: "ok",
    },
    browser: { name: "Chrome", version: "126.0" },
    os: { name: "macOS", version: "14.5" },
  },
  spans: [
    childSpan("2222222222222222", "ui.action", "open menu", 0.0, 0.2),
    childSpan("3333333333333333", "ui.action.click", "click", 0.3, 0.1),
    childSpan("4444444444444444", "navigation", "finish", 0.5, 0.7),
  ],
};

const main = async () => {
  const config = resolveConfig({ serviceName: "smoke-test" });
  const payload = sentryTransactionToOtlp(event, config);

  const spanCount =
    payload.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.length ?? 0;
  console.info(`\n[smoke] transform OK — ${spanCount} spans in payload:\n`);
  console.info(JSON.stringify(payload, null, 2));

  if (!config.apiKey) {
    console.info(
      "\n[smoke] DRY RUN — no KUBIT_OTEL_API_KEY set, skipping live POST.\n" +
        "[smoke] To send for real:\n" +
        "  KUBIT_OTEL_API_KEY=rg.v1.xxx npm run smoke\n",
    );
    return;
  }

  console.info(`\n[smoke] POST -> ${config.endpoint}\n`);
  const result = await postOtlp(payload, config);
  console.info("[smoke] result:", result);
  if (!result.ok) {
    process.exitCode = 1;
  }
};

main().catch((e) => {
  console.error("[smoke] unexpected error:", e);
  process.exitCode = 1;
});
