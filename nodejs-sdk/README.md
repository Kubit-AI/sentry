# @kubit-ai/otel

OpenTelemetry exporter for Kubit analytics.

## Install

```bash
npm install @kubit-ai/otel
```

## Quick start

```ts
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { KubitExporter } from "@kubit-ai/otel";

const provider = new NodeTracerProvider();
provider.addSpanProcessor(
  new BatchSpanProcessor(new KubitExporter({ apiKey: "rg.v1.xxx" })),
);
provider.register();

import { trace } from "@opentelemetry/api";
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

Spans are exported to Kubit with standard OpenTelemetry GenAI semantic
conventions. Root spans become traces, child spans become enriched
observations. `gen_ai.*` attributes are extracted into dedicated columns
for model name, prompt/completion, token counts, and cost.

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

## Node compatibility

Node.js 18+

## License

Proprietary — see [LICENSE](./LICENSE).
