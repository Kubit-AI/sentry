# Canonical Message Normalization (`input` / `output`)

Both SDKs project per-source LLM telemetry into a single canonical shape — the **OpenTelemetry GenAI v2 message schema** — and emit it on every record under `input` and `output`. The lossless raw form (the original stringified blob, e.g. `ai.prompt`, `langfuse.observation.input`, `gen_ai.prompt`) lives alongside as `input_messages_raw` / `output_messages_raw` for consumers that need the unparsed shape.

This document is the source of truth for the canonical shape and per-adapter mapping. CLAUDE.md links here from the architecture overview.

---

## Canonical Shape

Defined verbatim from the upstream OTel JSON schemas:

- [`gen-ai-input-messages.json`](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-input-messages.json)
- [`gen-ai-output-messages.json`](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-output-messages.json)
- [`gen-ai-system-instructions.json`](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-system-instructions.json)

### Message

```ts
type Role = "system" | "developer" | "user" | "assistant" | "tool" | string;

type Message = {
  role: Role;
  parts: Part[];
  name?: string | null;
  finish_reason?: "stop" | "length" | "content_filter" | "tool_call" | "error" | string;
};
```

`finish_reason` is on output messages only.

### Parts (10 discriminated types)

| `type` discriminator | Required fields | Optional fields |
| :---- | :---- | :---- |
| `text` | `content: string` | — |
| `tool_call` | `name: string` | `id`, `arguments` |
| `tool_call_response` | `response` | `id` |
| `server_tool_call` | `name`, `server_tool_call` | `id` |
| `server_tool_call_response` | `server_tool_call_response` | `id` |
| `blob` | `modality`, `content` (base64) | `mime_type` |
| `file` | `modality`, `file_id` | `mime_type` |
| `uri` | `modality`, `uri` | `mime_type` |
| `reasoning` | `content: string` | — |
| (any other string) | `type` | passthrough → `GenericPart` |

`Modality ∈ {image, video, audio}` (spec also permits arbitrary strings).

`additionalProperties: true` on every part — adapters may attach extra namespaced fields without breaking the schema.

### Storage form on the record

Native JSON arrays (not stringified). Kinesis records are already JSON documents, so a nested array adds zero parse cost for downstream consumers.

### `null` semantics

- `input: null` / `output: null` means no canonical projection was found and no fallback wrapped anything. The raw form may still be present on `input_messages_raw` / `output_messages_raw`.
- A non-null array is always the canonical shape — consumers never need to JSON-parse the field.

---

## Resolution Chain

`core.{ts,py}::resolveCanonicalMessages` runs four steps per span:

1. **Per-adapter `normalizeMessages`** (registry order). Per-side first-non-null wins, so a span carrying both `gen_ai.prompt` (otelGenai input) and `langfuse.observation.output` (langfuse output) yields a complete canonical pair.
2. **Span-event fallback** (`canonicalizeGenAiEvents` / `canonicalize_gen_ai_events`). Catches emitters that put messages on `gen_ai.system.message` / `gen_ai.user.message` / `gen_ai.assistant.message` / `gen_ai.tool.message` / `gen_ai.choice` events instead of attributes.
3. **Best-effort text-wrap fallback** of the legacy `resolveInput`/`resolveOutput` result. Defensive — every shipped adapter today has a normalizer.
4. **`gen_ai.system_instructions` injection.** Prepended as the leading `role: "system"` message when the resolved input doesn't already start with one. Cross-cutting concern handled centrally because the attribute is OTel-standard regardless of source.

---

## Per-Adapter Mapping

Each adapter's `normalizeMessages` (Node) / `normalize_messages` (Python) lives in its respective framework module. Cross-SDK parity is mandatory: the same input must produce semantically identical canonical output in both SDKs.

| Adapter | Sources read | Output produced |
| :---- | :---- | :---- |
| **`otelGenai`** | `gen_ai.input.messages` / `gen_ai.output.messages` (canonical or OpenAI shape, JSON string); legacy `gen_ai.prompt` / `gen_ai.completion` text-wrap; `gen_ai.tool.calls` merged into trailing assistant message | Spec-shape arrays |
| **`openinference`** | Indexed flat `llm.input_messages.<n>.message.{role,content,tool_calls.<j>.tool_call.function.{name,arguments},tool_call_id}`; blob fallbacks `llm.input_messages` / `llm.prompts` / `input.value` (and output mirrors); retriever-span `retrieval.documents.<i>.document.*`; **LangChain Serializable envelopes** inside `input.value` / `output.value` (HumanMessage / SystemMessage / AIMessage with content + `kwargs.tool_calls` dedup / ToolMessage / FunctionMessage / ChatMessage); **TOOL-span synthesis** from `tool.name` + raw-args input + ToolMessage envelope output; provider inference from AIMessage `response_metadata.model_provider`; tool definitions from indexed `llm.tools.<n>.tool.json_schema` | `Message[]` with `TextPart` + `ToolCallRequestPart` + `ToolCallResponsePart`; retrieval docs become `tool` message with `GenericPart{type:"retrieval_document",...}` |
| **`traceloop`** | Indexed flat `gen_ai.prompt.<n>.{role,content,tool_calls.<j>.{id,name,arguments}}`; `gen_ai.completion.<n>.*` mirror; `traceloop.entity.input/output` blob fallback | Spec-shape arrays with optional `ToolCallRequestPart`s |
| **`braintrust`** | Indexed flat `braintrust.input.<n>.{role,content}`; OpenAI-shape JSON blobs `braintrust.input_json` / `braintrust.output_json` (and `gen_ai.prompt_json` / `gen_ai.completion_json` mirrors) | Spec-shape arrays |
| **`vercelAi`** | `ai.prompt.messages` (JSON string of OpenAI-shape with multimodal `image_url` / `image` / `input_audio` content parts); `ai.prompt` text wrap; `ai.toolCall.args` (tool execution span input); `ai.response.text`; `ai.response.toolCalls` (Vercel-camelCase `{toolCallId, toolName, args}`); `ai.toolCall.result` | `image_url` → `UriPart{modality:"image"}`; `data:image/...` URLs → `BlobPart{mime_type}`; tool span input is `ToolCallRequestPart` on synthetic assistant message; output is `ToolCallResponsePart` on synthetic tool message |
| **`logfire`** | `pydantic_ai.all_messages` (Pydantic AI envelope: `[{kind:"request"\|"response", parts:[{part_kind, content?, tool_name?, args?, tool_call_id?}]}]`) | `system-prompt`/`user-prompt`/`text` → `TextPart`; `tool-call` → `ToolCallRequestPart`; `tool-return` → `ToolCallResponsePart`; `thinking`/`reasoning` → `ReasoningPart`; `retry-prompt` → user message with `name="retry"`; everything else → `GenericPart` |
| **`langfuse`** | `langfuse.observation.input` / `output` (opaque blob — string OR JSON, OpenAI-shape if recognizable, lossy text wrap otherwise); `langfuse.observation.tool_calls` merged into trailing assistant message | Coerced messages or single `TextPart` text wrap |
| **`langsmith`** | None — LangSmith rides on `gen_ai.*` attrs, captured by `otelGenai` | n/a |
| **`generic`** | Bare `input` / `output` attrs (last-resort) | Coerced or text-wrapped messages |
| **`openaiAgents`** | None — Agents emits standard `gen_ai.*` events captured by step 2 events fallback | n/a |

---

## System Instructions (`gen_ai.system_instructions`)

Per the OTel spec the attribute carries a `Part[]` (e.g. `[{type: "text", content: "..."}]`). Both SDKs:

- Parse arrays of parts as-is (validating each item carries a `type`).
- Wrap a plain-string emitter as a single `TextPart`.
- Skip injection when the resolved input already starts with a `role: "system"` message.

The injected message is **prepended** to `input`. There is no separate top-level `system_instructions` array on the record (this was a deliberate design choice — every source ingested today already encodes the system prompt as the leading message of the conversation).

---

## Cross-SDK Parity

The CLAUDE.md rule *every alias added in Python must also be added in Node, in the same tuple, same position* extends to `normalizeMessages`. In addition:

- The shared `messages.{ts,py}` modules host every construction helper, parser, and the events canonicalizer in lockstep. TS uses camelCase, Python uses snake_case, but signatures map 1:1.
- Tests in `nodejs-sdk/tests/transformer.normalization.test.ts` and `python-sdk/tests/test_normalization.py` are kept structurally identical (44 JS / 45 PY cases, same fixtures — the +1 PY delta is intentional). Python adds one extra case (`test_synthesis_recovers_python_repr_args_via_literal_eval`) covering the PY-only `repr(dict)` recovery in the Langfuse tool-span synthesizer; that asymmetry is intentional and documented in `docs/otel-mapping/langfuse.md`.
- Construction helpers omit a field when its value is `null`/`None` (`tool_call_part`'s `id`, `arguments`; `blob_part`'s `mime_type`; etc.) so the JSON output is byte-identical between SDKs.
