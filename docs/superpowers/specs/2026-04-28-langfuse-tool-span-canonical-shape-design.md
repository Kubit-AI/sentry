# Design — Langfuse TOOL-span canonical message synthesis

**Date:** 2026-04-28
**Status:** Approved, ready for implementation plan
**Affected SDKs:** `python-sdk/kubit_otel`, `nodejs-sdk/@kubit-ai/otel`
**Branch:** `rado/canonical-message-normalization`

## Problem

Langfuse emits TOOL-typed observations (`langfuse.observation.type == "tool"`) for LangGraph tool execution records. These spans carry the tool's args as `langfuse.observation.input` and the tool's result as `langfuse.observation.output`. The current `normalizeMessages` flow in the langfuse adapter treats the input as if it were a chat blob, producing a fake `role:"user"` message wrapping the raw args:

```
PY input "{'a': 47, 'b': 38}"      → [{role:"user", parts:[{type:"text", content:"{'a': 47, 'b': 38}"}]}]
JS input "{\"a\":47,\"b\":38}"     → [{role:"user", parts:[{type:"text", content:"{\"a\":47,\"b\":38}"}]}]
```

This is misleading. A TOOL span is a tool execution record, not a conversation turn. The "input" is structured args; the "output" is a tool result.

The output side already normalizes correctly post-Fix #1 (PY plain-dict ToolMessage handling) and the existing Serializable handler (JS), producing `[{role:"tool", name:"add", parts:[{type:"tool_call_response", id, response}]}]`. We need to synthesize the input into a matching shape so consumers can treat TOOL spans uniformly.

## Goal

For Langfuse TOOL-typed observations, produce canonical messages that faithfully represent a tool invocation:

- `input_messages` → `[{role:"assistant", parts:[{type:"tool_call", name, arguments, id}]}]`
- `output_messages` → `[{role:"tool", name, parts:[{type:"tool_call_response", response, id}]}]`

The shape mirrors how the same call appears in the parent generation's transcript, letting cross-adapter consumers stitch tool calls back to their parent generation via `tool_call_id`.

## Non-goals

- Cross-span enrichment (linking TOOL spans to their parent generation by walking sibling spans). Adapters operate on a single span's attributes; this is out of scope.
- Re-routing OpenInference tool spans through a shared synthesis path. The two adapters detect TOOL spans differently (`langfuse.observation.type` vs `openinference.span.kind`); the shared logic is the synthesis pattern, not the detection. Refactoring into a shared hook is deferred until a third emitter needs it.
- Recovering tool definitions on JS langfuse-sdk (separate upstream gap, tracked as audit item #3).

## Scope

Affects only `langfuse.observation.type == "tool"` spans in both SDKs. All other observation types (CHAIN, GENERATION, SPAN, EMBEDDING, …) keep current `normalizeMessages` behavior.

Cross-SDK parity rule: every change to PY mirrors to JS and vice versa, byte-equal where possible, semantically equivalent where Python idioms differ (e.g., `ast.literal_eval`).

## Architecture

A new private helper inside the langfuse adapter:

```
synthesizeToolSpanMessages(attrs) -> { input: Message[] | null, output: Message[] | null }
```

Mirrors the existing `synthesizeToolSpanMessages` helper in `frameworks/openinference.ts`. Returns `{null, null}` when prerequisites can't be met; caller falls through to the existing `blobToMessages` flow.

Called from `normalizeMessages` only when `attrs[OBSERVATION_TYPE_ATTR] == "tool"`. Synthesis takes precedence over `blobToMessages` in the priority chain.

## Data flow

```
normalizeMessages(attrs):
  if cleanDiscriminator(attrs[OBSERVATION_TYPE_ATTR]) == "tool":
    synth = synthesizeToolSpanMessages(attrs)
    input  = synth.input  ?? blobToMessages(rawInput,  "user")
    output = synth.output ?? blobToMessages(rawOutput, "assistant")
  else:
    # existing flow unchanged

  # existing tool_calls merge + rewriteToolNameRoles continue to run
```

`synthesizeToolSpanMessages(attrs)` algorithm:

1. **Parse output blob.**
   `parsedOutput = safeJsonParse(rawOutput) ?? rawOutput`.

2. **Run envelope translator on output.**
   `lcOut = langchainEnvelopeToCanonical(parsedOutput)`.
   - If `lcOut` is non-empty and its first message has `role:"tool"` with a `tool_call_response` part: lift `name = msg.name`, `id = part.id`. Use `lcOut` as the synthesized output.
   - Otherwise: `name = null`, `id = null`. Output enters fallback below.

3. **Tool name fallback.**
   If `name` is null, inspect `parsedOutput` directly:
   - Serializable envelope (`{lc:1, type:"constructor", id:[…,"ToolMessage"], kwargs:{name:T, tool_call_id:I}}`) → lift `T` and `I`.
   - Plain-dict ToolMessage (`{type:"tool", name:T, tool_call_id:I}`) → lift `T` and `I`.
   - Neither matches → leave `name = null`. Input synthesis will be skipped.

4. **Parse input args.**
   `argsParsed = safeJsonParse(rawInput)`. On Python only, if `argsParsed is None` and `rawInput` is a non-empty string, retry with `ast.literal_eval` (catches `SyntaxError`, `ValueError`). Fall back to the raw string if both fail.

5. **Synthesize input** when `name` is recoverable:
   `input = [{role:"assistant", parts:[toolCallPart(name, argsParsed, id)]}]`.
   Otherwise `input = null` (caller falls through to `blobToMessages`).

6. **Synthesize output fallback** when envelope didn't yield a tool message:
   - If `parsedOutput` is non-null/undefined: `output = [{role:"tool", parts:[toolCallResponsePart(parsedOutput, null)]}]`.
   - Otherwise `output = null`.

   When envelope succeeded, `output = lcOut` (already correct).

## What changes in code

| File | Change |
| :--- | :--- |
| `nodejs-sdk/src/transformer/frameworks/langfuse.ts` | Add `synthesizeToolSpanMessages` private helper; gate `normalizeMessages` on observation type. |
| `python-sdk/kubit_otel/transformer/frameworks/langfuse.py` | Mirror — add `_synthesize_tool_span_messages` helper; same gate. Import `ast`. |
| `nodejs-sdk/src/transformer/messages.ts` | No changes. Envelope translator already handles output. |
| `python-sdk/kubit_otel/transformer/messages.py` | No changes. |
| `nodejs-sdk/src/transformer/core.ts` | No changes. |
| `python-sdk/kubit_otel/transformer/core.py` | No changes. |
| `transformer/registry.{ts,py}` | No changes. |
| `transformer/span_filter.{ts,py}` | No changes. |

## Tests

Add four new test cases per SDK to `tests/transformer.normalization.test.ts` and `tests/test_normalization.py`. Tests 1–3 are byte-equal mirrors. Test 4 is PY-only (covers the `ast.literal_eval` fallback for the PY emitter's Python-repr quirk). Located inside the existing `langfuse normalizer` block / `TestLangfuseNormalizer` class.

### Test 1 — Plain-dict output (PY emitter shape, JSON args)

```
attrs: {
  "langfuse.observation.type": "tool",
  "langfuse.observation.input": '{"a":47,"b":38}',
  "langfuse.observation.output": '{"content":"85.0","type":"tool","name":"add","tool_call_id":"toolu_X","status":"success"}',
}
```

Expectations on both SDKs:
- `input_messages = [{role:"assistant", parts:[{type:"tool_call", name:"add", id:"toolu_X", arguments:{a:47,b:38}}]}]`
- `output_messages = [{role:"tool", name:"add", parts:[{type:"tool_call_response", response:"85.0", id:"toolu_X"}]}]`

### Test 2 — Serializable output (JS emitter shape, JSON args)

```
attrs: {
  "langfuse.observation.type": "tool",
  "langfuse.observation.input": '{"a":47,"b":38}',
  "langfuse.observation.output": '{"lc":1,"type":"constructor","id":["langchain_core","messages","ToolMessage"],"kwargs":{"name":"add","tool_call_id":"toolu_Y","content":"85","status":"success"}}',
}
```

Expectations on both SDKs:
- `input_messages = [{role:"assistant", parts:[{type:"tool_call", name:"add", id:"toolu_Y", arguments:{a:47,b:38}}]}]`
- `output_messages = [{role:"tool", name:"add", parts:[{type:"tool_call_response", response:"85", id:"toolu_Y"}]}]`

### Test 3 — Raw-string output fallback

```
attrs: {
  "langfuse.observation.type": "tool",
  "langfuse.observation.input": '{"x":1}',
  "langfuse.observation.output": '"85"',  # bare string, no envelope
}
```

Expectations on both SDKs:
- `input_messages = [{role:"user", parts:[{type:"text", content:"{\"x\":1}"}]}]` — no synthesis (no recoverable tool name → falls through to `blobToMessages`)
- `output_messages = [{role:"tool", parts:[{type:"tool_call_response", response:"85"}]}]` — fallback fires, no `id` (omitted because null)

### Test 4 — Python-repr args via `ast.literal_eval` (PY only)

The PY langfuse callback serializes tool args via `repr(dict)` (single-quoted), which is invalid JSON. JS never sees this shape — its callback uses `JSON.stringify`. PY-only test confirms `ast.literal_eval` recovers the parsed dict.

```
attrs: {
  "langfuse.observation.type": "tool",
  "langfuse.observation.input": "{'a': 47, 'b': 38}",  # Python repr — invalid JSON
  "langfuse.observation.output": '{"content":"85.0","type":"tool","name":"add","tool_call_id":"toolu_Z","status":"success"}',
}
```

Expectations on PY only:
- `input_messages = [{role:"assistant", parts:[{type:"tool_call", name:"add", id:"toolu_Z", arguments:{a:47,b:38}}]}]` — args recovered as parsed dict via `ast.literal_eval`
- `output_messages = [{role:"tool", name:"add", parts:[{type:"tool_call_response", response:"85.0", id:"toolu_Z"}]}]`

## Risks and tradeoffs

| Risk | Mitigation |
| :--- | :--- |
| `ast.literal_eval` adds a Python-specific code path. | Stdlib, safe (no `eval`); only fires when JSON parse fails. Cross-SDK semantic parity (both produce parsed dicts) outweighs byte-equality drift. |
| Synthesis bypasses `blobToMessages` for TOOL spans, so `rewriteToolNameRoles` and tool-definition stripping don't run on synthesized messages. | Synthesized messages already use canonical roles and don't contain phantom tool defs. Safe by construction. |
| Linkage to parent generation depends on output normalization producing a `tool_call_response` with id. If a future emitter ships TOOL output that doesn't yield this, input synthesis falls back to `id:null`. | Acceptable degradation — same fallback as openinference. Parent linkage is best-effort by design. |
| The `tools` CHAIN observation (not a TOOL — observation type is `chain` or folded `span`) won't go through this path. | Out of scope. The existing `rewriteToolNameRoles` Fix #2 handles its standalone `role:"add"` rewrite. |

## Open questions

None. Decisions locked through Q1–Q4 brainstorm:

- **Q1**: input shape is `[{role:"assistant", parts:[tool_call]}]` — mirrors openinference, structurally consistent with how the same call appears in parent generation transcripts.
- **Q2**: `tool_call_id` lifted from normalized output's `tool_call_response.id`. Single source of truth across SDKs.
- **Q3**: Args parsed with `safeJsonParse` then (PY only) `ast.literal_eval` then raw string fallback. Cross-SDK output parity, asymmetric implementation.
- **Q4**: Output synthesis fallback mirrors openinference — when envelope translator returns nothing, wrap raw output as `[{role:"tool", parts:[tool_call_response(rawOutput, null)]}]`.
