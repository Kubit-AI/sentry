# OpenLLMetry (Traceloop) and Hybrid Standardization

Traceloop's hybrid OTel GenAI emission with `llm.request.type` fallbacks, indexed message flattening, and PostHog event translation.

See also: [`README.md`](README.md) for the OTel GenAI baseline conventions.

---

OpenLLMetry, developed by Traceloop, occupies a highly transitional space in the LLM observability landscape. As heavy contributors and leaders within the OTel GenAI SIG, Traceloop's SDK natively emits standard `gen_ai.*` attributes. However, because the SDK supports a vast array of legacy frameworks and edge cases, it retains specific fallback mechanisms, custom namespaces, and proprietary extensions designed for complex prompt capturing.

When `gen_ai.operation.name` is absent or functionally insufficient to describe a complex orchestration step, OpenLLMetry relies on the `llm.request.type` attribute as a structural fallback. Enterprise backends like Datadog have built explicit logic to handle this mapping: `llm.request.type=chat` maps to the Datadog internal `llm` span kind, while `llm.request.type=rerank` maps to a general `workflow` operation. Similarly, if the definitive `gen_ai.provider.name` is missing during payload construction, OpenLLMetry captures the provider under `gen_ai.system` (e.g., mapping to `meta.model_provider` in Datadog) to ensure vendor attribution is preserved.

A critical aspect of OpenLLMetry's implementation is its handling of conversational input and output messages. Unlike libraries that serialize messages into a single, monolithic JSON payload (`input.value` in OpenInference), OpenLLMetry heavily relies on index-based attribute flattening to bypass parsing overhead. Attributes are formatted explicitly as `gen_ai.prompt.<index>.role` and `gen_ai.prompt.<index>.content`. For completions involving complex function calling, OpenLLMetry nests tool execution instructions directly into the indexed completion attributes, mapping `gen_ai.completion.<index>.tool_call_id` to establish a causal link between the generative step and the subsequent `execute_tool` span.

| OpenLLMetry / Traceloop Attribute | OTel GenAI Standard | Integration Target (e.g., PostHog / Datadog) |
| :---- | :---- | :---- |
| `llm.request.type` | `gen_ai.operation.name` | Datadog Span Kind (`llm`, `workflow`, `embedding`). |
| `gen_ai.system` | `gen_ai.provider.name` | Datadog `meta.model_provider`. |
| `llm.usage.total_tokens` | `gen_ai.usage.total_tokens` | PostHog `$ai_input_tokens` + `$ai_output_tokens`. |
| `gen_ai.prompt.<index>.role` | `gen_ai.input.messages` | Datadog `meta.input.messages`. |
| `gen_ai.completion.<index>.content` | `gen_ai.output.messages` | Datadog `meta.output.messages`. |
| `gen_ai.prompt.<index>.tool_call_id` | `gen_ai.tool.call.id` (Standardized) | Links generation to tool execution identifiers. |

Because OpenLLMetry is strictly governed by the inherent constraints of OpenTelemetry span attributes, it applies aggressive truncation limits. Depending on the configuration, payloads are often capped at 256 characters per value in certain backend exports to prevent payload bloat, ensuring high-performance tracing across high-throughput distributed microservices without inducing memory exhaustion at the collector level. Furthermore, when exporting data to product analytics tools like PostHog, OpenLLMetry spans are translated into user behavior events: `server.address` becomes `$ai_base_url`, and span timestamps calculate `$ai_latency`, seamlessly blending application performance metrics with user behavioral analytics.
