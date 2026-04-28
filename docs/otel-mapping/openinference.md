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
| `llm.cost.prompt` / `llm.cost.completion` / `llm.cost.total` | (no OTel equivalent — backend-calculated) | OI emits per-call USD cost on the span; adapter surfaces these as `input_cost` / `output_cost` / `total_cost` on the enriched observation. |
| `tag.tags` | (no direct OTel equivalent; cf. `gen_ai.system` for system identification) | OI's free-form tag list; surfaced as `tags`. |
| `llm.time_to_first_token` | (no OTel equivalent — backend-calculated) | OI emits TTFT (ms) directly on the span; adapter surfaces as `time_to_first_token`. |
| `llm.token_count.prompt_details.cache_read` | `gen_ai.usage.cache_read.input_tokens` | Cached-prompt token reuse; OI nests under `prompt_details`. |
| `llm.token_count.prompt_details.cache_write` | `gen_ai.usage.cache_creation.input_tokens` | Cache-write tokens; OI nests under `prompt_details`. |
| `llm.token_count.completion_details.reasoning` | (no direct OTel equivalent) | Reasoning-trace token accounting (e.g. o1-style models); OI nests under `completion_details`. |
| `llm.invocation_parameters` | `gen_ai.request.<param>` (multiple) | OI captures all hyperparameters as a single JSON blob; adapter parses and merges into the per-key `params.*` shape that OTel splits across distinct `gen_ai.request.*` keys. |

A notable architectural divergence is OpenInference's explicit inclusion of cost metrics directly on the span. Attributes such as `llm.cost.prompt`, `llm.cost.completion`, and `llm.cost.total` represent monetary values (in USD) calculated at runtime. The official OTel GenAI specification generally omits direct cost tracking on the telemetry layer, explicitly delegating price calculations to the downstream observability backend based on token metrics and dynamic provider lookup tables. To unify these systems in production environments, infrastructure teams deploy OpenTelemetry Collector Contrib components like the `genaisemconv` processor, which intercepts telemetry in transit, rewriting `llm.model_name` to `gen_ai.request.model` and dropping redundant attributes to ensure compatibility with modern OTel backends.

---

## LangChain via OpenInference

Both `@arizeai/openinference-instrumentation-langchain` (JS) and `openinference.instrumentation.langchain` (Python) emit OpenInference spans, but with three quirks that need explicit handling because LangChain's `Serializable` interface produces a richer message form than OpenInference's flat indexed projection can carry. The kubit-otel `openinference` adapter handles all three; **no separate LangChain adapter exists** — LangChain rides on this one.

### Serializable envelope

LangChain message envelopes appear inside `input.value` / `output.value` blobs (and occasionally `llm.input_messages` / `llm.output_messages` blob slots) as JSON of the form:

```json
{
  "lc": 1,
  "type": "constructor",
  "id": ["langchain_core", "messages", "HumanMessage" | "AIMessage" | "ToolMessage" | "SystemMessage" | "FunctionMessage" | "ChatMessage" | "AIMessageChunk"],
  "kwargs": {
    "content": "<string OR array of {type:'text'|'tool_use', ...}>",
    "tool_calls": [{ "name": "...", "args": {...}, "id": "...", "type": "tool_call" }],
    "tool_call_id": "...",
    "name": "...",
    "additional_kwargs": {...},
    "response_metadata": { "model": "...", "model_provider": "..." }
  }
}
```

Wrappers vary: `{messages: [<env>, ...]}` (most common), bare array, single envelope, `{output: <ToolMessage>}` (LangGraph TOOL span output convention), `{input: ...}`. The detector is shape-based, so it works identically for JS and Python LangChain.

### Per-message-type role mapping

| LangChain class | Canonical role | Notes |
| :---- | :---- | :---- |
| `HumanMessage` | `user` | content (string or multimodal array) → text/multimodal parts |
| `SystemMessage` | `system` | same |
| `AIMessage` / `AIMessageChunk` | `assistant` | content array can hold Anthropic-shape `{type:"tool_use", id, name, input}` parts; **dedup-aware merge** with `kwargs.tool_calls` (canonical form) — same `id` is emitted only once |
| `ToolMessage` | `tool` | parts = `[tool_call_response_part(content, kwargs.tool_call_id)]`; preserves `kwargs.name` as `msg.name` |
| `FunctionMessage` | `tool` | parts = `[tool_call_response_part(content, null)]` |
| `ChatMessage` | `kwargs.role` | content → text parts |

### TOOL-span synthesis

LangChain TOOL spans (`openinference.span.kind = "TOOL"`) have no message-shape attributes — only `tool.name`, raw-args `input.value`, and a `ToolMessage` envelope on `output.value`. The adapter synthesizes canonical messages:

- **input** → `[{role:"assistant", parts:[tool_call_part(toolName, parsedArgs, null)]}]`
- **output** → result of `langchain_envelope_to_canonical(output.value)`, which handles the `{output: <ToolMessage>}` wrapper. Falls back to `[{role:"tool", parts:[tool_call_response_part(rawValue, null)]}]` when the output isn't a recognized envelope.

Synthesis runs **before** the text-wrap fallback for any TOOL span — text-wrapping the args JSON would produce a degraded `user` text part instead of a structured tool_call.

The adapter also adds `"tool.name"` to its `TOOL_NAME_ATTRS`, so the enriched observation's `tool_name` field is populated for LangChain TOOL spans.

### Provider inference

LangChain doesn't set `llm.provider` / `llm.system`. The provider is buried inside the `AIMessage` envelope on `output.value`, at `kwargs.response_metadata.model_provider` (or `kwargs.additional_kwargs.model_provider`). The adapter's `resolveProvider` hook walks the envelope on `output.value`, finds the first AIMessage, and returns the provider string — falling back to `null` so non-LangChain spans continue to use the standard `PROVIDER_ATTRS` chain.

### Tool definitions

LangChain emits tool/function schemas as **indexed** `llm.tools.<n>.tool.json_schema` (each value is a JSON-encoded schema). The adapter's `aggregateToolDefinitions` hook walks these in index order, parses each schema, and returns the array — populating the `tool_definitions` field on the enriched observation. The schemas are passed through verbatim; no normalization to OpenAI-function shape is performed, consistent with how other adapters surface `tool_definitions`.

### Indexed-vs-blob precedence

When BOTH indexed `llm.input_messages.<n>.message.*` AND a richer LangChain `input.value` blob are present (the common case for GENERATION spans), the LangChain blob wins. The indexed form is structurally degraded — assistant tool-call messages have `{role:"assistant", content:""}` only, with the actual `tool_use` data missing. The blob carries the full `tool_calls` array. Detection is shape-based: non-LangChain OpenInference users (whose blobs are not Serializable envelopes) get `null` from the LangChain branch and fall through to the unchanged existing cascade — **no behavior change for OpenAI / Phoenix / generic OpenInference users.**
