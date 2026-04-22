# LangSmith Attribute Resolution and Internal Trace Translation

LangSmith Run taxonomy, span-event handling, and vendor-specific translation from OpenInference/Traceloop.

See also: [`README.md`](README.md) for the OTel GenAI baseline conventions.

---

LangSmith, originally conceptualized as an observability layer strictly for LangChain and LangGraph applications, has evolved significantly to offer full end-to-end OpenTelemetry support. It now functions as both an OTLP ingestion backend capable of receiving traces from agnostic frameworks, and an OTel emission provider that exports traces to downstream platforms. LangSmith's translation engine maps standard GenAI conventions into its highly proprietary "Run" taxonomy.

The core of LangSmith's trace mapping hinges on the resolution of the `langsmith.span.kind` attribute, which supersedes the OTel standard `gen_ai.operation.name` if present. Supported values such as `llm`, `chain`, `tool`, `retriever`, `embedding`, `prompt`, and `parser` map directly to LangSmith Run Types. If the `langsmith.span.kind` is absent during OTLP ingestion, LangSmith applies a semantic inference engine based on OTel conventions: a span with `gen_ai.operation.name` set to `chat` or `text_completion` is translated to an `llm` Run Type, while the presence of the `gen_ai.tool.name` attribute automatically mutates the Run Type to `tool`.

LangSmith's approach to conversational message translation is particularly sophisticated, bridging the gap between flat telemetry attributes and deeply nested JSON states. It meticulously extracts individual message roles and text contents from OTel indexed attributes (e.g., `gen_ai.prompt.{n}.role` and `gen_ai.prompt.{n}.content`) and reconstructs them into structured JSON arrays natively rendered under `inputs.messages[n]` and `outputs.messages[n]` in the LangSmith UI. Furthermore, it parses native OTel span events; events labeled `gen_ai.system.message` or `gen_ai.user.message` are dynamically appended to the `inputs.messages` array, reflecting the broader industry shift toward event-based payload logging for reduced attribute cardinality.

| OTel GenAI / Third-Party Attribute | LangSmith Internal Run Model | Translation Mechanics |
| :---- | :---- | :---- |
| `gen_ai.operation.name` | Run type | `chat` → `llm`; `embeddings` → `embedding`. |
| `gen_ai.system` | `metadata.ls_provider` | Maps the foundational model provider (e.g., `openai`). |
| `gen_ai.prompt.{n}.role` | `inputs.messages[n]` | Reconstructs flattened arrays into JSON conversational objects. |
| `gen_ai.completion.{n}.content` | `outputs.messages[n]` | Reconstructs generated outputs into JSON conversational objects. |
| `gen_ai.tool.name` | `invocation_params.tool_name` | Extracts the specific function or tool invoked. |
| `gen_ai.request.model` | `invocation_params.model` | Maps the requested parameter model identifier. |
| `gen_ai.usage.prompt_tokens` | `usage_metadata.input_tokens` | Correlates input consumption for cost analysis. |
| `gen_ai.usage.completion_tokens` | `usage_metadata.output_tokens` | Correlates generation consumption for cost analysis. |
| `openinference.span.kind` | Run type | Vendor-specific mapping from Arize OpenInference. |
| `traceloop.entity.input` | `inputs` | Vendor-specific mapping from OpenLLMetry. |

Vendor-specific translation is natively supported within the LangSmith ingestion pipeline. If traces arrive from a system instrumented with OpenInference, LangSmith maps the `openinference.span.kind` directly to its Run model, and translates `input.value` and `output.value` into `inputs` and `outputs`. Similarly, attributes originating from Logfire or TraceLoop are detected and re-routed; for instance, `retrieval.documents.{n}.document.content` is mapped to `outputs.documents[n].page_content`, preserving the lineage of retrieval-augmented generation across vastly different instrumentation paradigms.
