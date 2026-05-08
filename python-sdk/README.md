# kubit-otel

OpenTelemetry exporter for Kubit analytics. A thin convenience wrapper around the stock OTLP/HTTP exporter, preconfigured to ship spans to the Kubit collector.

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

Spans are sent as standard OTLP/HTTP protobuf to the Kubit collector, which normalizes them across LLM frameworks (OTel GenAI semconv, OpenInference, Langfuse, Vercel AI, Braintrust, Logfire, OpenLLMetry/Traceloop, Mastra, OpenAI Agents, Pydantic AI) into the canonical Kubit schema and routes them to your workspace.

## Configuration

| Option (kwarg) | Env var | Default |
| --- | --- | --- |
| `api_key` | — | _required_ |
| `endpoint` | `KUBIT_OTEL_ENDPOINT` | `https://otel.kubit.ai/v1/traces` |
| `service_name` | — | `default` |
| `service_version` | — | _unset_ |
| `resource_attributes` | — | `{}` |

`KUBIT_OTEL_LOG_LEVEL` (`debug` | `info` | `warn` | `error`) controls the SDK's internal logger.

The standard `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_ENDPOINT` env vars are honored too, sitting between `KUBIT_OTEL_ENDPOINT` and the built-in default in the resolution chain.

### Works alongside other OTel-based SDKs

`configure()` detects whether a real `TracerProvider` is already installed as the global OTel provider. If so, it attaches `KubitSpanProcessor` to that provider and merges in your resource attributes — it does **not** replace the existing provider. You can call `configure()` before or after other OTel-based libraries (Langfuse, OpenLLMetry, an OTel distro, …) and every span will reach both sinks.

If you want explicit "attach only, never register" behavior, use `attach()`:

```python
from kubit_otel import attach

# Must be called after another library has installed a real provider.
attach(api_key="rg.v1.xxx")
```

## Span filtering

By default, only LLM-relevant spans are forwarded to Kubit. A span is exported if it:

- was created by the Kubit SDK tracer (`kubit-sdk`),
- carries any `gen_ai.*` semantic-convention attribute, or
- comes from a known LLM instrumentation scope (OpenInference, Langfuse, Vercel AI SDK, Braintrust, Logfire, OpenLLMetry/Traceloop, Mastra, OpenAI Agents, …).

This keeps HTTP/DB/framework auto-instrumentation noise out of your Kubit workspace without extra configuration.

### Extend the default filter

```python
from kubit_otel import configure, is_default_export_span

configure(
    api_key="rg.v1.xxx",
    should_export_span=lambda span: (
        is_default_export_span(span)
        or (
            span.instrumentation_scope is not None
            and span.instrumentation_scope.name.startswith("my_framework")
        )
    ),
)
```

### Full override

```python
configure(
    api_key="rg.v1.xxx",
    should_export_span=lambda span: span.name.startswith("llm."),
)
```

### Export everything

```python
configure(api_key="rg.v1.xxx", should_export_span=lambda _span: True)
```

## Python compatibility

Python 3.9+

## License

Proprietary — see [LICENSE](./LICENSE).
