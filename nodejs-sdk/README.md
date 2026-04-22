# @kubit-ai/otel

OpenTelemetry exporter for Kubit analytics.

## Install

```bash
npm install @kubit-ai/otel
```

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

`configure()` detects whether a real `TracerProvider` is already installed
as the global OTel provider. If so, it attaches `KubitSpanProcessor` to
that provider and merges in your resource attributes — it does **not**
replace the existing provider. You can call `configure()` before or after
other OTel-based libraries (Langfuse, OpenLLMetry, an OTel distro, …) and
every span will reach both sinks.

If you want explicit "attach only, never register" behavior, use `attach()`:

```ts
import { attach } from "@kubit-ai/otel";

// Must be called after another library has installed a real provider.
attach({ apiKey: "rg.v1.xxx" });
```

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

## Node compatibility

Node.js 18+

## License

Proprietary — see [LICENSE](./LICENSE).
