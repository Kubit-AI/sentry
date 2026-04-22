# OpenInference: The Legacy Precursor to GenAI Conventions

OpenInference's `llm.*` / `embedding.*` namespace, span-kind philosophy, and explicit cost attributes.

See also: [`README.md`](README.md) for the OTel GenAI baseline conventions this spec predates.

---

OpenInference, maintained primarily by Arize AI for the Phoenix observability platform, operates as a comprehensive, parallel semantic convention standard. Because OpenInference was developed and widely adopted prior to the final stabilization of the official OTel GenAI specification, it utilizes an entirely distinct namespace and structural philosophy. Observability backends such as MLflow, Datadog, and LangSmith maintain dedicated OpenInference translation pipelines to bridge this structural gap and support the massive footprint of existing OpenInference instrumentation.

The fundamental identifier within an OpenInference trace is the `openinference.span.kind` attribute. This attribute explicitly categorizes the architectural purpose of the span, requiring values such as `LLM`, `EMBEDDING`, `CHAIN`, `RETRIEVER`, `RERANKER`, `TOOL`, or `AGENT`. This methodology deviates significantly from the OTel standard, which relies on the general network-level `span.kind` (e.g., `CLIENT` or `INTERNAL`) used in conjunction with the `gen_ai.operation.name`.

Attribute naming in OpenInference relies primarily on the `llm.*` and `embedding.*` prefixes rather than `gen_ai.*`. Consequently, `llm.model_name` maps conceptually to the OTel `gen_ai.request.model`, and `llm.invocation_parameters` captures as a single JSON string what OTel would distribute across individual `gen_ai.request.*` keys (such as `temperature` and `top_p`). Token counting methodologies are extensively detailed in OpenInference, utilizing `llm.token_count.prompt` and `llm.token_count.completion`, mapping structurally to `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens`.

| OpenInference Attribute (`llm.*`) | OTel GenAI Semantic Convention Equivalent | Architectural Difference |
| :---- | :---- | :---- |
| `openinference.span.kind` | `gen_ai.operation.name` | OI uses explicit types (`LLM`, `RETRIEVER`), OTel combines span kinds with operation names. |
| `llm.model_name` | `gen_ai.request.model` | OI does not distinguish between requested and response models by default. |
| `llm.system` / `llm.provider` | `gen_ai.system` / `gen_ai.provider.name` | System identification (e.g., `anthropic`, `openai`). |
| `llm.token_count.prompt` | `gen_ai.usage.input_tokens` | Input token accounting. |
| `llm.token_count.completion` | `gen_ai.usage.output_tokens` | Generation token accounting. |
| `llm.input_messages.<index>.message.role` | `gen_ai.prompt.<index>.role` | OI uses deep hierarchical index notation for lists. |
| `output.value` | `gen_ai.output.messages` | OI often serializes outputs into a single string or JSON value. |
| `llm.cost.total` | Backend Calculated (No OTel direct equivalent) | OI explicitly places monetary cost (in USD) on the span. |
| `embedding.model_name` | `gen_ai.request.model` | OI separates embedding attributes from LLM attributes entirely. |

A notable architectural divergence is OpenInference's explicit inclusion of cost metrics directly on the span. Attributes such as `llm.cost.prompt`, `llm.cost.completion`, and `llm.cost.total` represent monetary values (in USD) calculated at runtime. The official OTel GenAI specification generally omits direct cost tracking on the telemetry layer, explicitly delegating price calculations to the downstream observability backend based on token metrics and dynamic provider lookup tables. To unify these systems in production environments, infrastructure teams deploy OpenTelemetry Collector Contrib components like the `genaisemconv` processor, which intercepts telemetry in transit, rewriting `llm.model_name` to `gen_ai.request.model` and dropping redundant attributes to ensure compatibility with modern OTel backends.
