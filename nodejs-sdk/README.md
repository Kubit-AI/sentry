# @kubit-ai/otel

OpenTelemetry exporter for Kubit analytics. A thin convenience wrapper around the stock OTLP/HTTP exporter, preconfigured to ship spans to the Kubit collector.

## Install

```bash
npm install @kubit-ai/otel
```

Requires the OpenTelemetry JS SDK **v2** plus the OTLP/HTTP protobuf exporter as peer dependencies:

```bash
npm install \
  @opentelemetry/api \
  @opentelemetry/exporter-trace-otlp-proto \
  @opentelemetry/resources@^2 \
  @opentelemetry/sdk-trace-base@^2 \
  @opentelemetry/sdk-trace-node@^2
```

OTel JS SDK v1 is **not** supported — `configure()` uses `resourceFromAttributes()` and constructor-time `spanProcessors` (v2-only APIs).

## Quick start

```ts
import { configure } from "@kubit-ai/otel";
import { trace } from "@opentelemetry/api";

configure({ apiKey: "rg.v1.xxx", serviceName: "my-app" });

const tracer = trace.getTracer("my-app");

tracer.startActiveSpan("chat.completion", (span) => {
  span.setAttribute("gen_ai.request.model", "gpt-4o");
  span.setAttribute("gen_ai.prompt", "Hello, world!");
  span.setAttribute("gen_ai.completion", "Hi there!");
  span.setAttribute("gen_ai.usage.input_tokens", 10);
  span.setAttribute("gen_ai.usage.output_tokens", 5);
  span.end();
});
```

Spans are sent as standard OTLP/HTTP protobuf to the Kubit collector, which normalizes them across LLM frameworks (OTel GenAI semconv, OpenInference, Langfuse, Vercel AI, Braintrust, Logfire, OpenLLMetry/Traceloop, Mastra, OpenAI Agents, Pydantic AI) into the canonical Kubit schema and routes them to your workspace.

For finer-grained control you can compose `KubitSpanProcessor` or the raw `KubitExporter` with your own `TracerProvider` / `BatchSpanProcessor` instead of calling `configure()`.

## Configuration

| Option | Env var | Default |
| --- | --- | --- |
| `apiKey` | — | _required_ |
| `endpoint` | `KUBIT_OTEL_ENDPOINT` | `https://otel.kubit.ai/v1/traces` |
| `serviceName` | — | `default` |
| `serviceVersion` | — | _unset_ |
| `resourceAttributes` | — | `{}` |

`KUBIT_OTEL_LOG_LEVEL` (`debug` | `info` | `warn` | `error`) controls the SDK's internal logger.

The standard `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_ENDPOINT` env vars are intentionally **not** consulted — they are process-wide and would silently redirect Kubit traces if another OTel-based SDK in the same process sets them. Use `KUBIT_OTEL_ENDPOINT` to override.

### Works alongside other OTel-based SDKs

`configure()` always constructs a fresh `NodeTracerProvider` and registers it as the global provider. OTel JS SDK v2 removed `addSpanProcessor` from `BasicTracerProvider` / `NodeTracerProvider`, so there is no public API to add a processor to an already-running provider — and `@kubit-ai/otel` does not export `attach()`.

To compose Kubit with another OTel-based SDK (Langfuse, OpenLLMetry, Phoenix/OpenInference, an OTel distro, …), construct **one** `NodeTracerProvider` (or `NodeSDK`) yourself and pass both processors at construction time via `spanProcessors: [...]`:

```ts
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { KubitSpanProcessor } from "@kubit-ai/otel";
// …plus the other SDK's span processor.

const provider = new NodeTracerProvider({
  resource: resourceFromAttributes({ "service.name": "my-app" }),
  spanProcessors: [
    otherSdkProcessor,
    new KubitSpanProcessor({ apiKey: "rg.v1.xxx" }),
  ],
});
provider.register();
```

Calling `configure()` in addition to standing up your own provider would register a second, parallel `NodeTracerProvider` and clobber the first registration — pick one or the other.

## Span filtering

By default, only LLM-relevant spans are forwarded to Kubit. A span is exported if it:

- was created by the Kubit SDK tracer (`kubit-sdk`),
- carries any `gen_ai.*` semantic-convention attribute, or
- comes from a known LLM instrumentation scope (OpenInference, Langfuse, Vercel AI SDK, Braintrust, Logfire, OpenLLMetry/Traceloop, Mastra, OpenAI Agents, …).

This keeps HTTP/DB/framework auto-instrumentation noise out of your Kubit workspace without extra configuration. Filtering lives on `KubitSpanProcessor`; bare `KubitExporter` consumers can apply the helpers manually.

### Extend the default filter

```ts
import {
  KubitSpanProcessor,
  isDefaultExportSpan,
  getInstrumentationScopeName,
} from "@kubit-ai/otel";

new KubitSpanProcessor({
  apiKey: "rg.v1.xxx",
  shouldExportSpan: ({ otelSpan }) =>
    isDefaultExportSpan(otelSpan) ||
    (getInstrumentationScopeName(otelSpan)?.startsWith("my-framework") ?? false),
});
```

### Full override

```ts
new KubitSpanProcessor({
  apiKey: "rg.v1.xxx",
  shouldExportSpan: ({ otelSpan }) => otelSpan.name.startsWith("llm."),
});
```

### Export everything

```ts
new KubitSpanProcessor({ apiKey: "rg.v1.xxx", shouldExportSpan: () => true });
```

## Masking sensitive content

Pass a `mask` function to redact PII, secrets, or regulated data *before* spans leave your process. Masking is opt-in, synchronous, and runs after the filter but before the batch queue — un-masked spans never sit in memory waiting to flush. If the function throws or returns `null`/`undefined`, the SDK drops the span and error-logs (fail-closed).

Helpers live in `@kubit-ai/otel/mask`:

```ts
import { configure } from "@kubit-ai/otel";
import { setAttr, maskEvents } from "@kubit-ai/otel/mask";

const CARD_RE = /\b(?:\d[ -]*?){13,19}\b/g;

configure({
  apiKey: "rg.v1.xxx",
  mask: (span) => {
    // 1. Scrub credit-card numbers out of the prompt attribute (OTel GenAI v1).
    const prompt = (span.attributes as Record<string, unknown>)["gen_ai.prompt"];
    if (typeof prompt === "string") {
      setAttr(span, "gen_ai.prompt", prompt.replace(CARD_RE, "[REDACTED CC]"));
    }
    // 2. Drop user-message events entirely (OTel GenAI v2 puts prompts here).
    maskEvents(span, (e) => (e.name === "gen_ai.user.message" ? null : e));
    return span;
  },
});
```

`setAttr` / `deleteAttr` work on both spans and events. `maskEvents(span, fn)` keeps events for which `fn` returns the event, drops events for which it returns `null` or `undefined`. To drop the entire span, use `shouldExportSpan` — `mask` is a transform, not a filter.

> **Bare `KubitExporter` consumers do not inherit masking.** Masking lives in `KubitSpanProcessor` so dropped spans never enter the batch queue. Wrap the exporter in your own `SpanProcessor` and apply the helpers there.

## Compatibility

- Node.js 18+
- OpenTelemetry JS SDK **v2** (`@opentelemetry/sdk-trace-base`, `@opentelemetry/sdk-trace-node`, `@opentelemetry/resources` all `>= 2.0.0`). v1 is not supported.

## License

Proprietary — see [LICENSE](./LICENSE).
