# kubit-otel

OpenTelemetry SDKs for Kubit analytics. Available for Python and Node.js.

---

## Python SDK

### Install

```bash
pip install kubit-otel
```

### Quick start

```python
from kubit_otel import configure
from opentelemetry import trace

provider = configure(api_key="rg.v1.xxx", service_name="my-app")
tracer = trace.get_tracer("my-app")

with tracer.start_as_current_span("my-operation") as span:
    span.set_attribute("gen_ai.request.model", "gpt-4o")
    span.set_attribute("gen_ai.prompt", "Hello, world!")
    span.set_attribute("gen_ai.completion", "Hi there!")
    span.set_attribute("gen_ai.usage.input_tokens", 10)
    span.set_attribute("gen_ai.usage.output_tokens", 5)
    # ... your code here

provider.force_flush()
provider.shutdown()
```

### Three ways to use it

**Option 1 — `configure()` one-liner** (recommended)

```python
from kubit_otel import configure

provider = configure(
    api_key="rg.v1.xxx",
    service_name="my-app",
    service_version="1.0.0",
    resource_attributes={
        "deployment.environment": "production",
    },
)
```

**Option 2 — `KubitSpanProcessor`** (add to existing provider)

```python
from opentelemetry.sdk.trace import TracerProvider
from kubit_otel import KubitSpanProcessor

provider = TracerProvider()
provider.add_span_processor(KubitSpanProcessor(api_key="rg.v1.xxx"))
```

**Option 3 — `KubitExporter`** (full control)

```python
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from kubit_otel import KubitExporter

exporter = KubitExporter(api_key="rg.v1.xxx")
provider = TracerProvider()
provider.add_span_processor(BatchSpanProcessor(exporter))
```

### Build

```bash
cd python-sdk
pip install build
python -m build
```

### Publish

```bash
pip install twine
twine upload dist/*
```

---

## Node.js SDK

### Install

```bash
npm install @kubit-ai/otel
```

### Quick start

```typescript
import { configure } from "@kubit-ai/otel";
import { trace, SpanKind } from "@opentelemetry/api";

const provider = configure({ apiKey: "rg.v1.xxx", serviceName: "my-app" });
const tracer = trace.getTracer("my-app");

const span = tracer.startSpan("my-operation", { kind: SpanKind.CLIENT });
span.setAttribute("gen_ai.request.model", "gpt-4o");
span.setAttribute("gen_ai.prompt", "Hello, world!");
span.setAttribute("gen_ai.completion", "Hi there!");
span.setAttribute("gen_ai.usage.input_tokens", 10);
span.setAttribute("gen_ai.usage.output_tokens", 5);
// ... your code here
span.end();

await provider.forceFlush();
await provider.shutdown();
```

### Three ways to use it

**Option 1 — `configure()` one-liner** (recommended)

```typescript
import { configure } from "@kubit-ai/otel";

const provider = configure({
  apiKey: "rg.v1.xxx",
  serviceName: "my-app",
  serviceVersion: "1.0.0",
  resourceAttributes: {
    "deployment.environment": "production",
  },
});
```

**Option 2 — `KubitSpanProcessor`** (compose with your own provider)

OTel JS SDK v2 removed `addSpanProcessor` from `NodeTracerProvider`, so processors must be supplied at construction time:

```typescript
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { KubitSpanProcessor } from "@kubit-ai/otel";

const provider = new NodeTracerProvider({
  spanProcessors: [new KubitSpanProcessor({ apiKey: "rg.v1.xxx" })],
});
provider.register();
```

**Option 3 — `KubitExporter`** (full control)

```typescript
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { KubitExporter } from "@kubit-ai/otel";

const exporter = new KubitExporter({ apiKey: "rg.v1.xxx" });
const provider = new NodeTracerProvider({
  spanProcessors: [new BatchSpanProcessor(exporter)],
});
provider.register();
```

### Build

```bash
cd nodejs-sdk
npm run build
```

### Publish

```bash
npm publish
```

---

## Resource attributes

These OTel resource attributes are automatically mapped to dedicated fields in Kubit:

| Resource attribute | Kubit field |
|---|---|
| `service.name` | service name |
| `service.version` | `release` / `version` |
| `deployment.environment` | `environment` |

Any other resource attributes are stored in the `metadata` field.

## GenAI attributes

Spans with [GenAI semantic convention](https://opentelemetry.io/docs/specs/semconv/gen-ai/) attributes are automatically mapped:

| Span attribute | Kubit field |
|---|---|
| `gen_ai.request.model` / `gen_ai.response.model` | `model` |
| `gen_ai.prompt` | `input` |
| `gen_ai.completion` | `output` |
| `gen_ai.usage.input_tokens` | `usage_details.input` |
| `gen_ai.usage.output_tokens` | `usage_details.output` |
| `gen_ai.usage.cost` | `total_cost` |

Spans with a model attribute or `SpanKind.CLIENT`/`PRODUCER` are typed as `GENERATION`. All others are typed as `SPAN`.
