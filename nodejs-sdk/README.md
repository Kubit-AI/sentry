# @kubit-ai/otel

OpenTelemetry exporter for Kubit analytics.

## Install

```bash
npm install @kubit-ai/otel
```

Requires the OpenTelemetry JS SDK **v2** as a peer dependency:

```bash
npm install \
  @opentelemetry/api \
  @opentelemetry/resources@^2 \
  @opentelemetry/sdk-trace-base@^2 \
  @opentelemetry/sdk-trace-node@^2
```

OTel JS SDK v1 is **not** supported — the transformer reads
`ReadableSpan.parentSpanContext.spanId` (v2-only) and `configure()`
uses `resourceFromAttributes()` and constructor-time `spanProcessors`
(v2-only APIs).

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

Spans are exported to Kubit using standard OpenTelemetry GenAI semantic
conventions. Each trace's root span is recorded as the trace; every span
(including the root) is recorded as an observation under it. `gen_ai.*`
attributes are mapped to first-class, queryable fields for model name,
prompt/completion, token counts, and cost.

For finer-grained control you can compose `KubitSpanProcessor` or the raw
`KubitExporter` with your own `TracerProvider` / `BatchSpanProcessor`
instead of calling `configure()`.

### Works alongside other OTel-based SDKs

`configure()` always constructs a fresh `NodeTracerProvider` and
registers it as the global provider. OTel JS SDK v2 removed
`addSpanProcessor` from `BasicTracerProvider` / `NodeTracerProvider`,
so there is no public API to add a processor to an already-running
provider — and `@kubit-ai/otel` does not export `attach()`.

To compose Kubit with another OTel-based SDK (Langfuse, OpenLLMetry,
Phoenix/OpenInference, an OTel distro, …), construct **one**
`NodeTracerProvider` (or `NodeSDK`) yourself and pass both processors
at construction time via `spanProcessors: [...]`:

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

Calling `configure()` in addition to standing up your own provider
would register a second, parallel `NodeTracerProvider` and clobber
the first registration — pick one or the other.

## Supported attributes

| OpenTelemetry attribute | Purpose |
|---|---|
| `gen_ai.request.model` / `gen_ai.response.model` | Model name |
| `gen_ai.prompt` / `gen_ai.content.prompt` | Input prompt |
| `gen_ai.completion` / `gen_ai.content.completion` | Output completion |
| `gen_ai.usage.input_tokens` | Input token count |
| `gen_ai.usage.output_tokens` | Output token count |
| `gen_ai.usage.cost` | Total cost (USD) |
| `session.id` | Conversation session id |
| `enduser.id` | End-user id |

## Span filtering

By default, only LLM-relevant spans are forwarded to Kubit. A span is exported if it:

- was created by the Kubit SDK tracer (`kubit-sdk`),
- carries any `gen_ai.*` semantic-convention attribute, or
- comes from a known LLM instrumentation scope (OpenInference, LangSmith, LiteLLM, Vercel AI SDK, OpenLLMetry/Traceloop, Braintrust, Logfire, …).

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

## Compatibility

- Node.js 18+
- OpenTelemetry JS SDK **v2** (`@opentelemetry/sdk-trace-base`,
  `@opentelemetry/sdk-trace-node`, `@opentelemetry/resources` all
  `>= 2.0.0`). v1 is not supported.

## License

Proprietary — see [LICENSE](./LICENSE).
