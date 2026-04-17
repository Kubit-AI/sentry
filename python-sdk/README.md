# kubit-otel

OpenTelemetry exporter for Kubit analytics.

## Install

```bash
pip install kubit-otel
```

## Quick start

```python
from kubit_otel import configure
from opentelemetry import trace

configure(api_key="rg.v1.xxx", service_name="my-app")
tracer = trace.get_tracer("my-app")

with tracer.start_as_current_span("chat.completion") as span:
    span.set_attribute("gen_ai.request.model", "gpt-4o")
    span.set_attribute("gen_ai.prompt", "Hello, world!")
    span.set_attribute("gen_ai.completion", "Hi there!")
    span.set_attribute("gen_ai.usage.input_tokens", 10)
    span.set_attribute("gen_ai.usage.output_tokens", 5)
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

## Python compatibility

Python 3.9+

## License

Proprietary — see [LICENSE](./LICENSE).
