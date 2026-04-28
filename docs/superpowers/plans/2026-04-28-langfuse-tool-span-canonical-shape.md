# Langfuse TOOL-span canonical message synthesis — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Synthesize canonical `input_messages` and `output_messages` for `langfuse.observation.type == "tool"` spans so they faithfully represent a tool invocation (assistant `tool_call` request → tool `tool_call_response` reply) instead of a fake `role:"user"` message wrapping raw args.

**Architecture:** A new private helper `synthesizeToolSpanMessages(attrs)` lives inside the langfuse adapter (mirroring the existing helper of the same name in `frameworks/openinference.ts`). It runs the LangChain envelope translator on the output blob to extract tool name + `tool_call_id`, parses input args (JSON; PY also `ast.literal_eval`), and synthesizes the canonical request/response pair. Called from `normalizeMessages` only when observation type is `tool`; falls back to existing `blobToMessages` when prerequisites can't be met.

**Tech Stack:** TypeScript (vitest) for nodejs-sdk, Python 3.9+ (pytest, mocker) for python-sdk. Both target OpenTelemetry GenAI v2 canonical message shape.

**Spec:** `docs/superpowers/specs/2026-04-28-langfuse-tool-span-canonical-shape-design.md`

---

## File Structure

| File | Role | Action |
| :--- | :--- | :--- |
| `nodejs-sdk/src/transformer/frameworks/langfuse.ts` | Langfuse JS adapter | Modify — add `synthesizeToolSpanMessages` private helper; gate `normalizeMessages` on observation type. |
| `nodejs-sdk/tests/transformer.normalization.test.ts` | JS canonical-message tests | Modify — append 3 new test cases inside `describe("langfuse normalizer", …)`. |
| `python-sdk/kubit_otel/transformer/frameworks/langfuse.py` | Langfuse PY adapter | Modify — mirror with `_synthesize_tool_span_messages` helper; `import ast` for `literal_eval`. |
| `python-sdk/tests/test_normalization.py` | PY canonical-message tests | Modify — append 4 new test methods inside `class TestLangfuseNormalizer`. The 4th is PY-only (`ast.literal_eval` coverage). |

No changes to `core.{ts,py}`, `messages.{ts,py}`, `registry.{ts,py}`, or `span_filter.{ts,py}`.

---

## Task 1: Write 3 failing JS tests

**Files:**
- Modify: `nodejs-sdk/tests/transformer.normalization.test.ts`

The new tests go inside the existing `describe("langfuse normalizer", …)` block, immediately before its closing `});` (after the existing "rewrites standalone tool-name role even without a preceding tool_call" test).

- [ ] **Step 1: Append the three test cases**

Use the Edit tool to insert these tests just before the closing `});` of the `describe("langfuse normalizer", …)` block. The exact insertion point is after the existing test `it("rewrites standalone tool-name role even without a preceding tool_call", …)` and before the next `describe(...)` block (`describe("span-event fallback", …)`).

```typescript
  // TOOL-span synthesis: a `langfuse.observation.type == "tool"` span carries
  // structured tool args under `input` and a tool-result envelope under
  // `output`. Wrap them as a canonical assistant tool_call request +
  // tool tool_call_response reply, mirroring how the same call appears in
  // the parent generation's transcript. Lifts tool name and tool_call_id
  // from the normalized output so input/output stay linked.
  it("synthesizes assistant tool_call from plain-dict TOOL output", () => {
    const attrs: Record<string, unknown> = {
      "langfuse.observation.type": "tool",
      "langfuse.observation.input": JSON.stringify({ a: 47, b: 38 }),
      "langfuse.observation.output": JSON.stringify({
        content: "85.0",
        type: "tool",
        name: "add",
        tool_call_id: "toolu_X",
        status: "success",
      }),
    };
    const r = obs(transformSpans([makeSpan({ attrs })], "w", "c"));
    expect(r.input_messages).toEqual([
      {
        role: "assistant",
        parts: [
          {
            type: "tool_call",
            name: "add",
            id: "toolu_X",
            arguments: { a: 47, b: 38 },
          },
        ],
      },
    ]);
    expect(r.output_messages).toEqual([
      {
        role: "tool",
        name: "add",
        parts: [
          {
            type: "tool_call_response",
            id: "toolu_X",
            response: "85.0",
          },
        ],
      },
    ]);
  });

  // Same synthesis but with a LangChain Serializable ToolMessage envelope on
  // the output (the JS langfuse-sdk shape). The envelope translator extracts
  // the same name + tool_call_id; the synthesized input mirrors them.
  it("synthesizes assistant tool_call from Serializable TOOL output", () => {
    const attrs: Record<string, unknown> = {
      "langfuse.observation.type": "tool",
      "langfuse.observation.input": JSON.stringify({ a: 47, b: 38 }),
      "langfuse.observation.output": JSON.stringify({
        lc: 1,
        type: "constructor",
        id: ["langchain_core", "messages", "ToolMessage"],
        kwargs: {
          name: "add",
          tool_call_id: "toolu_Y",
          content: "85",
          status: "success",
        },
      }),
    };
    const r = obs(transformSpans([makeSpan({ attrs })], "w", "c"));
    expect(r.input_messages).toEqual([
      {
        role: "assistant",
        parts: [
          {
            type: "tool_call",
            name: "add",
            id: "toolu_Y",
            arguments: { a: 47, b: 38 },
          },
        ],
      },
    ]);
    expect(r.output_messages).toEqual([
      {
        role: "tool",
        name: "add",
        parts: [
          {
            type: "tool_call_response",
            id: "toolu_Y",
            response: "85",
          },
        ],
      },
    ]);
  });

  // Output envelope unrecognized (bare-string output): synthesis can't lift
  // a tool name, so input falls through to existing blobToMessages
  // text-wrap. Output gets the fallback synthesis -- a tool message with
  // the raw response and no id linkage.
  it("falls back to raw-string output wrap when envelope unrecognized", () => {
    const attrs: Record<string, unknown> = {
      "langfuse.observation.type": "tool",
      "langfuse.observation.input": JSON.stringify({ x: 1 }),
      "langfuse.observation.output": JSON.stringify("85"),
    };
    const r = obs(transformSpans([makeSpan({ attrs })], "w", "c"));
    expect(r.input_messages).toEqual([
      {
        role: "user",
        parts: [{ type: "text", content: '{"x":1}' }],
      },
    ]);
    expect(r.output_messages).toEqual([
      {
        role: "tool",
        parts: [{ type: "tool_call_response", response: "85" }],
      },
    ]);
  });
```

- [ ] **Step 2: Run the three new tests to verify they fail**

```bash
cd /Volumes/Dev/eng/dradis/nodejs-sdk
npm test -- --run tests/transformer.normalization.test.ts -t "TOOL"
```

Expected: 3 failing tests with messages roughly matching:
- "expected `output_messages[0].role` to be `'assistant'` … received `'user'`" (or similar) — for the JSON-args tests
- input shape mismatch on the third test

If all 42 tests pass instead of 3 failing, the tests aren't actually exercising new behavior — re-check the insertion point.

- [ ] **Step 3: Don't commit yet — RED state preserved for next task**

---

## Task 2: Implement `synthesizeToolSpanMessages` in JS and wire into `normalizeMessages`

**Files:**
- Modify: `nodejs-sdk/src/transformer/frameworks/langfuse.ts`

- [ ] **Step 1: Add the helper function**

Use the Edit tool to insert this helper. The natural insertion point is between the existing `isToolDefinitionMessage` helper and the `rewriteToolNameRoles` helper. Open the file and search for `function rewriteToolNameRoles(messages: Message[] | null)` — insert the new helper directly above it.

```typescript
/**
 * For `langfuse.observation.type == "tool"` spans, synthesize canonical
 * `input_messages` (assistant `tool_call` request) and `output_messages`
 * (tool `tool_call_response` reply) so they faithfully represent a tool
 * invocation instead of the default `role:"user"` text-wrap of raw args.
 *
 * Strategy:
 * 1. Parse the output blob and run `langchainEnvelopeToCanonical` on it.
 *    Both the JS Serializable ToolMessage envelope and the PY plain-dict
 *    `{type:"tool",...}` shape are recognized by the envelope translator
 *    (post-Fix #1), producing `[{role:"tool", name, parts:[{type:
 *    "tool_call_response", id, ...}]}]`.
 * 2. Lift `name` and the `tool_call_response.id` from the normalized
 *    output. These become the synthesized assistant tool_call's name + id,
 *    keeping input/output linked via the same id that the parent
 *    generation emitted.
 * 3. Parse args from the input blob (`safeJsonParse` first; fall back to
 *    the raw string).
 * 4. Synthesize input only when a tool name was recoverable; otherwise
 *    return `null` so the caller falls through to `blobToMessages`.
 * 5. Synthesize output fallback when the envelope didn't yield a tool
 *    message: wrap the raw output as `[{role:"tool", parts:[
 *    tool_call_response(rawOutput, null)]}]`. Mirrors the openinference
 *    adapter's `synthesizeToolSpanMessages`.
 */
function synthesizeToolSpanMessages(attrs: Record<string, unknown>): {
  input: Message[] | null;
  output: Message[] | null;
} {
  const rawOut = attrs["langfuse.observation.output"];
  if (rawOut === undefined || rawOut === null) {
    return { input: null, output: null };
  }
  const parsedOut = typeof rawOut === "string"
    ? safeJsonParse(rawOut) ?? rawOut
    : rawOut;

  let toolName: string | null = null;
  let toolCallId: string | null = null;
  let output: Message[] | null = null;

  const lcOut = langchainEnvelopeToCanonical(parsedOut);
  if (lcOut && lcOut.length > 0) {
    output = lcOut;
    const first = lcOut[0];
    if (first.role === "tool") {
      if (typeof first.name === "string") toolName = first.name;
      const part = first.parts[0];
      if (part && (part as { type?: unknown }).type === "tool_call_response") {
        const id = (part as { id?: unknown }).id;
        if (typeof id === "string") toolCallId = id;
      }
    }
  }

  // Output fallback: when envelope didn't produce a tool message but raw
  // output exists, wrap it as a tool message so consumers still get a
  // canonical response part (without an id linkage).
  if (output === null && parsedOut !== null && parsedOut !== undefined) {
    output = [{
      role: "tool",
      parts: [toolCallResponsePart(parsedOut, null)],
    }];
  }

  // Input synthesis only fires when we can name the tool.
  let input: Message[] | null = null;
  if (toolName !== null) {
    const rawIn = attrs["langfuse.observation.input"];
    let argsParsed: unknown;
    if (rawIn === undefined || rawIn === null) {
      argsParsed = undefined;
    } else if (typeof rawIn === "string") {
      argsParsed = safeJsonParse(rawIn) ?? rawIn;
    } else {
      argsParsed = rawIn;
    }
    input = [{
      role: "assistant",
      parts: [toolCallPart(toolName, argsParsed, toolCallId)],
    }];
  }

  return { input, output };
}
```

- [ ] **Step 2: Wire into `normalizeMessages`**

Open `nodejs-sdk/src/transformer/frameworks/langfuse.ts`, locate the `normalizeMessages` body. The current block starts:

```typescript
  normalizeMessages(attrs): CanonicalMessages | null {
    let input = blobToMessages(attrs["langfuse.observation.input"], "user");
    let output = blobToMessages(attrs["langfuse.observation.output"], "assistant");
```

Replace those two lines with this block (use the Edit tool):

```typescript
  normalizeMessages(attrs): CanonicalMessages | null {
    let input: Message[] | null = null;
    let output: Message[] | null = null;

    // For TOOL spans, synthesize canonical request/response from raw args
    // + envelope-normalized output. Falls through to blobToMessages when
    // synthesis can't produce a result (e.g. no recoverable tool name).
    if (cleanDiscriminator(attrs[OBSERVATION_TYPE_ATTR]) === "tool") {
      const synth = synthesizeToolSpanMessages(attrs);
      input = synth.input;
      output = synth.output;
    }

    if (input === null) {
      input = blobToMessages(attrs["langfuse.observation.input"], "user");
    }
    if (output === null) {
      output = blobToMessages(attrs["langfuse.observation.output"], "assistant");
    }
```

The rest of `normalizeMessages` (tool-call merge, `rewriteToolNameRoles` calls, return statement) stays unchanged.

- [ ] **Step 3: Run the three new tests to verify GREEN**

```bash
cd /Volumes/Dev/eng/dradis/nodejs-sdk
npm test -- --run tests/transformer.normalization.test.ts -t "TOOL"
```

Expected: 3 passing tests (the ones added in Task 1).

If any fails, read the diff. Common failure modes:
- "expected `arguments: {a:47,b:38}`, received string" — `safeJsonParse` chain didn't run; check args parsing in the helper.
- "expected `id: 'toolu_X'`, missing" — the envelope translator may not have produced a `tool_call_response` with id; check the lift in the helper.
- "expected `role: 'tool'`, received 'assistant'" — the output fallback is overwriting envelope output; check that the fallback only fires when `output === null`.

- [ ] **Step 4: Run the full JS test suite**

```bash
cd /Volumes/Dev/eng/dradis/nodejs-sdk
npm test
```

Expected: 195 tests, 0 failures (192 prior + 3 new).

If anything else breaks, the most likely cause is the `normalizeMessages` rewrite touching non-TOOL spans. Re-verify the `cleanDiscriminator(attrs[OBSERVATION_TYPE_ATTR]) === "tool"` gate is exact and the `if (input === null)` / `if (output === null)` fallthroughs preserve existing behavior.

- [ ] **Step 5: Commit**

```bash
git -C /Volumes/Dev/eng/dradis add \
  nodejs-sdk/src/transformer/frameworks/langfuse.ts \
  nodejs-sdk/tests/transformer.normalization.test.ts
git -C /Volumes/Dev/eng/dradis commit -m "Synthesize canonical request/response messages for Langfuse TOOL spans (JS)"
```

---

## Task 3: Mirror — write 4 failing PY tests

**Files:**
- Modify: `python-sdk/tests/test_normalization.py`

The new tests go as methods inside the existing `class TestLangfuseNormalizer:` block, after the last existing method (`test_rewrites_standalone_tool_name_role_without_preceding_tool_call`).

- [ ] **Step 1: Append the four test methods**

Use the Edit tool to insert the four methods just before `# ── Span-event fallback ────────────────────────────────────────────────────` (the comment that introduces the next test class).

```python
    # TOOL-span synthesis: a ``langfuse.observation.type == "tool"`` span
    # carries structured tool args under ``input`` and a tool-result envelope
    # under ``output``. Wrap them as a canonical assistant tool_call request
    # + tool tool_call_response reply, mirroring how the same call appears
    # in the parent generation's transcript. Lifts tool name and
    # tool_call_id from the normalized output so input/output stay linked.
    def test_synthesizes_assistant_tool_call_from_plain_dict_tool_output(self):
        span = _mock_span(attrs={
            "langfuse.observation.type": "tool",
            "langfuse.observation.input": json.dumps({"a": 47, "b": 38}),
            "langfuse.observation.output": json.dumps({
                "content": "85.0",
                "type": "tool",
                "name": "add",
                "tool_call_id": "toolu_X",
                "status": "success",
            }),
        })
        r = _obs(_transform(span))
        assert r["input_messages"] == [
            {
                "role": "assistant",
                "parts": [
                    {
                        "type": "tool_call",
                        "name": "add",
                        "id": "toolu_X",
                        "arguments": {"a": 47, "b": 38},
                    },
                ],
            },
        ]
        assert r["output_messages"] == [
            {
                "role": "tool",
                "name": "add",
                "parts": [
                    {
                        "type": "tool_call_response",
                        "id": "toolu_X",
                        "response": "85.0",
                    },
                ],
            },
        ]

    # Same synthesis but with a LangChain Serializable ToolMessage envelope
    # on the output (the JS langfuse-sdk shape). The envelope translator
    # extracts the same name + tool_call_id; the synthesized input mirrors
    # them.
    def test_synthesizes_assistant_tool_call_from_serializable_tool_output(self):
        span = _mock_span(attrs={
            "langfuse.observation.type": "tool",
            "langfuse.observation.input": json.dumps({"a": 47, "b": 38}),
            "langfuse.observation.output": json.dumps({
                "lc": 1,
                "type": "constructor",
                "id": ["langchain_core", "messages", "ToolMessage"],
                "kwargs": {
                    "name": "add",
                    "tool_call_id": "toolu_Y",
                    "content": "85",
                    "status": "success",
                },
            }),
        })
        r = _obs(_transform(span))
        assert r["input_messages"] == [
            {
                "role": "assistant",
                "parts": [
                    {
                        "type": "tool_call",
                        "name": "add",
                        "id": "toolu_Y",
                        "arguments": {"a": 47, "b": 38},
                    },
                ],
            },
        ]
        assert r["output_messages"] == [
            {
                "role": "tool",
                "name": "add",
                "parts": [
                    {
                        "type": "tool_call_response",
                        "id": "toolu_Y",
                        "response": "85",
                    },
                ],
            },
        ]

    # Output envelope unrecognized (bare-string output): synthesis can't
    # lift a tool name, so input falls through to existing blob_to_messages
    # text-wrap. Output gets the fallback synthesis -- a tool message with
    # the raw response and no id linkage.
    def test_falls_back_to_raw_string_output_wrap_when_envelope_unrecognized(self):
        span = _mock_span(attrs={
            "langfuse.observation.type": "tool",
            "langfuse.observation.input": json.dumps({"x": 1}),
            "langfuse.observation.output": json.dumps("85"),
        })
        r = _obs(_transform(span))
        assert r["input_messages"] == [
            {
                "role": "user",
                "parts": [{"type": "text", "content": '{"x": 1}'}],
            },
        ]
        assert r["output_messages"] == [
            {
                "role": "tool",
                "parts": [{"type": "tool_call_response", "response": "85"}],
            },
        ]

    # PY-only: the Langfuse PY callback serializes tool args via
    # ``repr(dict)`` (single-quoted), which is invalid JSON. Recover the
    # parsed dict via ``ast.literal_eval`` so the canonical tool_call's
    # ``arguments`` field stays parsed (parity with JS, which sees JSON).
    def test_synthesis_recovers_python_repr_args_via_literal_eval(self):
        span = _mock_span(attrs={
            "langfuse.observation.type": "tool",
            "langfuse.observation.input": "{'a': 47, 'b': 38}",
            "langfuse.observation.output": json.dumps({
                "content": "85.0",
                "type": "tool",
                "name": "add",
                "tool_call_id": "toolu_Z",
                "status": "success",
            }),
        })
        r = _obs(_transform(span))
        assert r["input_messages"] == [
            {
                "role": "assistant",
                "parts": [
                    {
                        "type": "tool_call",
                        "name": "add",
                        "id": "toolu_Z",
                        "arguments": {"a": 47, "b": 38},
                    },
                ],
            },
        ]
        assert r["output_messages"] == [
            {
                "role": "tool",
                "name": "add",
                "parts": [
                    {
                        "type": "tool_call_response",
                        "id": "toolu_Z",
                        "response": "85.0",
                    },
                ],
            },
        ]
```

- [ ] **Step 2: Run the four new tests to verify they fail**

```bash
cd /Volumes/Dev/eng/dradis/python-sdk
.venv/bin/pytest tests/test_normalization.py -k "synthesizes_assistant or falls_back_to_raw_string or recovers_python_repr" -v
```

Expected: 4 failing tests.

- [ ] **Step 3: Don't commit yet — RED state preserved for next task**

---

## Task 4: Mirror — implement `_synthesize_tool_span_messages` in PY and wire into `normalize_messages`

**Files:**
- Modify: `python-sdk/kubit_otel/transformer/frameworks/langfuse.py`

- [ ] **Step 1: Add `import ast` at the top of the file**

Open `python-sdk/kubit_otel/transformer/frameworks/langfuse.py`. Find the existing import block (typically `import json` or `from typing import …`). Add `import ast` alphabetically:

```python
import ast
```

If `import json` is already present, place `import ast` directly above it. If not, place it as the first stdlib import.

- [ ] **Step 2: Add the `_synthesize_tool_span_messages` helper**

Use the Edit tool to insert this helper just above the existing `def _rewrite_tool_name_roles(messages: Optional[list]) -> Optional[list]:` definition.

```python
def _synthesize_tool_span_messages(attrs: dict) -> dict:
    """Synthesize canonical request/response messages for a TOOL-typed
    Langfuse observation.

    Strategy mirrors ``synthesizeToolSpanMessages`` in the JS adapter and
    the openinference adapter helper of the same name:

    1. Parse the output blob and run ``langchain_envelope_to_canonical`` on
       it. Both the JS Serializable ToolMessage envelope and the PY
       plain-dict ``{type:"tool",...}`` shape are recognized by the
       envelope translator (post-Fix #1), producing
       ``[{role:"tool", name, parts:[{type:"tool_call_response", id, ...}]}]``.
    2. Lift ``name`` and the ``tool_call_response.id`` from the normalized
       output. These become the synthesized assistant tool_call's name +
       id, keeping input/output linked via the same id that the parent
       generation emitted.
    3. Parse args from the input blob: ``safe_json_parse`` first; on
       failure, ``ast.literal_eval`` (catches the PY-callback ``repr(dict)``
       quirk -- single-quoted dict literals that aren't valid JSON);
       fall back to the raw string.
    4. Synthesize input only when a tool name was recoverable; otherwise
       return ``None`` so the caller falls through to ``blob_to_messages``.
    5. Output fallback: when the envelope didn't yield a tool message, wrap
       the raw output as ``[{role:"tool", parts:[tool_call_response(
       raw_output, None)]}]``.
    """
    raw_out = attrs.get("langfuse.observation.output")
    if raw_out is None:
        return {"input": None, "output": None}
    if isinstance(raw_out, str):
        parsed_out: Any = safe_json_parse(raw_out)
        if parsed_out is None:
            parsed_out = raw_out
    else:
        parsed_out = raw_out

    tool_name: Optional[str] = None
    tool_call_id: Optional[str] = None
    output: Optional[list] = None

    lc_out = langchain_envelope_to_canonical(parsed_out)
    if lc_out:
        output = lc_out
        first = lc_out[0]
        if first.get("role") == "tool":
            name = first.get("name")
            if isinstance(name, str):
                tool_name = name
            parts = first.get("parts", [])
            if (
                parts
                and isinstance(parts[0], dict)
                and parts[0].get("type") == "tool_call_response"
            ):
                pid = parts[0].get("id")
                if isinstance(pid, str):
                    tool_call_id = pid

    # Output fallback: when envelope didn't produce a tool message but raw
    # output exists, wrap it as a tool message so consumers still get a
    # canonical response part (without an id linkage).
    if output is None and parsed_out is not None:
        output = [{
            "role": "tool",
            "parts": [tool_call_response_part(parsed_out, None)],
        }]

    # Input synthesis only fires when we can name the tool.
    input_msgs: Optional[list] = None
    if tool_name is not None:
        raw_in = attrs.get("langfuse.observation.input")
        if raw_in is None:
            args_parsed: Any = None
        elif isinstance(raw_in, str):
            args_parsed = safe_json_parse(raw_in)
            if args_parsed is None:
                try:
                    args_parsed = ast.literal_eval(raw_in)
                except (SyntaxError, ValueError):
                    args_parsed = raw_in
        else:
            args_parsed = raw_in
        input_msgs = [{
            "role": "assistant",
            "parts": [tool_call_part(tool_name, args_parsed, tool_call_id)],
        }]

    return {"input": input_msgs, "output": output}
```

You'll need these symbols imported into `langfuse.py`. Verify by searching the existing imports for:
- `langchain_envelope_to_canonical` — likely already imported via `from ..messages import …`. If not, add it.
- `tool_call_part` — likely already imported (used elsewhere in the file).
- `tool_call_response_part` — likely already imported.
- `safe_json_parse` — likely already imported.

If any are missing, extend the existing `from ..messages import (...)` block.

- [ ] **Step 3: Wire into `normalize_messages`**

Search for the `normalize_messages` body in `python-sdk/kubit_otel/transformer/frameworks/langfuse.py`. The current block starts:

```python
def normalize_messages(self, attrs: dict) -> Optional[dict]:
    input_msgs = blob_to_messages(attrs.get("langfuse.observation.input"), "user")
    output_msgs = blob_to_messages(attrs.get("langfuse.observation.output"), "assistant")
```

Replace those two lines with:

```python
def normalize_messages(self, attrs: dict) -> Optional[dict]:
    input_msgs: Optional[list] = None
    output_msgs: Optional[list] = None

    # For TOOL spans, synthesize canonical request/response from raw args
    # + envelope-normalized output. Falls through to blob_to_messages when
    # synthesis can't produce a result (e.g. no recoverable tool name).
    if clean_discriminator(attrs.get(_OBSERVATION_TYPE_ATTR)) == "tool":
        synth = _synthesize_tool_span_messages(attrs)
        input_msgs = synth["input"]
        output_msgs = synth["output"]

    if input_msgs is None:
        input_msgs = blob_to_messages(attrs.get("langfuse.observation.input"), "user")
    if output_msgs is None:
        output_msgs = blob_to_messages(attrs.get("langfuse.observation.output"), "assistant")
```

The rest of `normalize_messages` (tool-call merge, `_rewrite_tool_name_roles` calls, return statement) stays unchanged.

Note: PY uses `_OBSERVATION_TYPE_ATTR` (underscore-prefixed module-private constant), unlike JS's `OBSERVATION_TYPE_ATTR`. The constant is already declared at the top of `langfuse.py` and used by `resolve_observation_type`, so no new import needed.

- [ ] **Step 4: Run the four new tests to verify GREEN**

```bash
cd /Volumes/Dev/eng/dradis/python-sdk
.venv/bin/pytest tests/test_normalization.py -k "synthesizes_assistant or falls_back_to_raw_string or recovers_python_repr" -v
```

Expected: 4 passing tests.

If any fails, common failure modes:
- "expected `arguments: {'a':47,'b':38}`, received `'{'a': 47, 'b': 38}'`" — `ast.literal_eval` chain didn't run; check the PY-only fallback in `_synthesize_tool_span_messages`.
- "AttributeError: module 'ast' has no attribute…" — missing `import ast` at top of file.
- "NameError: clean_discriminator" — wiring path is missing the import; verify `normalize_messages` has the symbols in scope.

- [ ] **Step 5: Run the full PY test suite**

```bash
cd /Volumes/Dev/eng/dradis/python-sdk
.venv/bin/pytest tests/
```

Expected: 211 tests, 0 failures (207 prior + 4 new).

- [ ] **Step 6: Cross-SDK parity verification**

Run the JS suite again to confirm it still passes (catches any drift introduced while editing PY):

```bash
cd /Volumes/Dev/eng/dradis/nodejs-sdk
npm test
```

Expected: 195 passing, 0 failing.

- [ ] **Step 7: Commit**

```bash
git -C /Volumes/Dev/eng/dradis add \
  python-sdk/kubit_otel/transformer/frameworks/langfuse.py \
  python-sdk/tests/test_normalization.py
git -C /Volumes/Dev/eng/dradis commit -m "Mirror Langfuse TOOL-span canonical synthesis to Python SDK"
```

---

## Acceptance criteria

- All four planned tests (3 JS + 4 PY, 7 total) pass.
- Both full test suites pass: JS 195/195, PY 211/211.
- A `langfuse.observation.type == "tool"` span with JSON-string args and a recognizable output envelope (Serializable on JS, plain-dict on PY) produces:
  - `input_messages = [{role:"assistant", parts:[{type:"tool_call", name, id, arguments}]}]`
  - `output_messages = [{role:"tool", name, parts:[{type:"tool_call_response", id, response}]}]`
- A TOOL span with unrecognizable output falls back to a `role:"tool"` synthesized output and existing-behavior `role:"user"` text input.
- A TOOL span with PY repr args (`"{'a':47,'b':38}"`) on the PY SDK only recovers parsed args via `ast.literal_eval`.
- Non-TOOL spans (CHAIN, GENERATION, SPAN, …) keep existing behavior — nothing in the prior 192 JS / 207 PY tests regresses.
