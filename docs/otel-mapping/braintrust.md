# Braintrust Trace Translation and Routing Mechanics

Braintrust-specific attribute translation, metadata/scores handling, and OTel routing headers.

See also: [`README.md`](README.md) for the OTel GenAI baseline conventions that Braintrust translates against.

---

Braintrust operates primarily as a sophisticated evaluation, prompt engineering, and observability platform that bridges its native logging paradigms with OpenTelemetry via custom span processors and backend OTLP endpoints. When an application instrumented with OpenLLMetry, the Vercel AI SDK, or Braintrust's native Python and TypeScript SDKs routes traces to Braintrust, the system maps OTel spans into Braintrust-specific projects, experiments, and evaluation datasets.

The routing architecture relies heavily on custom HTTP headers injected into the OTLP exporter payload. The `x-bt-parent` header serves as the primary routing mechanism. It accepts specific prefixes—such as `project_id:<ID>`, `project_name:<Name>`, or `experiment_id:<ID>`—to anchor the incoming OpenTelemetry trace hierarchy precisely within the Braintrust database structure. Furthermore, a span slug derived from `span.export()` can be passed to nest the incoming OTel trace underneath a specific, pre-existing span within the parent object, enabling highly complex distributed tracing across asynchronous workers.

At the attribute translation level, Braintrust accommodates both the standard `gen_ai.*` namespace and its internal `braintrust.*` equivalents, applying a translation layer upon ingestion. Input and output messages are systematically translated from standardized flat formats. To bypass the limitations of OpenTelemetry array flattening, Braintrust deeply integrates JSON-serialized payloads, mapping standard OTel structures directly to `braintrust.input_json` and `braintrust.output_json` to preserve complex nested objects, such as tool call arguments and multimodal image arrays.

Braintrust deliberately isolates application-specific metadata and evaluation metrics from standard GenAI semantics to prevent attribute collision. Any attribute prefixed with `braintrust.metadata.<key>` is extracted from the OpenTelemetry span and stored as an indexed, searchable metadata column in Braintrust. Similarly, `braintrust.metrics.<key>` translates custom numerical values—such as proprietary relevance scores or latency constraints—into the telemetry timeline. The following table defines the exact mapping parameters required to translate standard OpenTelemetry data into the Braintrust schema.

| OpenTelemetry GenAI Attribute | Braintrust Target Attribute | Data Type & Translation Context |
| :---- | :---- | :---- |
| `gen_ai.prompt.<index>.role` | `braintrust.input.<index>.role` | String. Maps the specific role (e.g., `system`, `user`) for a structured prompt. |
| `gen_ai.prompt.<index>.content` | `braintrust.input.<index>.content` | String. Maps the text payload of the prompt input. |
| `gen_ai.completion.<index>.role` | `braintrust.output.<index>.role` | String. Maps the role for the generated completion. |
| `gen_ai.completion.<index>.content` | `braintrust.output.<index>.content` | String. Maps the text payload of the generative output. |
| `gen_ai.prompt_json` | `braintrust.input_json` | JSON String. Preserves complex nested arrays bypassing dot-notation limits. |
| `gen_ai.completion_json` | `braintrust.output_json` | JSON String. Preserves structured tool outputs and JSON mode completions. |
| `gen_ai.request.model` | Model Name | String. Anchors the model identifier for cost and latency profiling. |
| `gen_ai.usage.prompt_tokens` | `braintrust.metrics.prompt_tokens` | Integer. Translated directly into the Braintrust metrics engine. |
| `gen_ai.usage.completion_tokens` | `braintrust.metrics.completion_tokens` | Integer. Translated directly into the Braintrust metrics engine. |
| Custom Evaluation Score | `braintrust.scores` | JSON String. Maps external pipeline evaluations (e.g., `{"accuracy": 1.0}`). |

Braintrust's OTel compatibility mode effectively synchronizes span context between native Braintrust decorators and raw OpenTelemetry traces. This ensures that distributed contexts, such as standard W3C Trace Context headers, persist accurately across microservice boundaries, allowing a Python backend evaluating a prompt to maintain trace lineage with a Node.js frontend initiating the request.
