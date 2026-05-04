/**
 * Mastra (`mastra.*` namespace) attribute mappings.
 *
 * Mastra emits its own `mastra.*` telemetry alongside standard `gen_ai.*` keys.
 * The same attribute shape ships under any Mastra-owned tracer (the published
 * `@mastra/otel-exporter`, the Sentry/Datadog/Langfuse/etc. exporters, or an
 * in-tree emitter — apps wiring Mastra into Kubit have been observed using
 * resource/scope name `@mastra/kubit`).
 *
 * `MODEL_GENERATION` spans carry the full GenAI semconv set (model, tokens,
 * `gen_ai.input.messages` / `gen_ai.output.messages`) which the `otelGenai`
 * adapter handles unchanged. This adapter covers the additional Mastra span
 * types that store their payload under per-span-type keys:
 *   - `mastra.span.type=agent_run`     → `mastra.agent_run.input/output`
 *   - `mastra.span.type=workflow_run`  → `mastra.workflow_run.input/output`
 *     (and the `workflow_step`, `workflow_conditional[_eval]`,
 *     `workflow_parallel`, `workflow_loop`, `workflow_sleep`,
 *     `workflow_wait_event` siblings)
 *   - `mastra.span.type=processor_run` → `mastra.processor_run.input/output`
 *   - `mastra.span.type=model_step`    → `mastra.model_step.input/output`
 *     plus the raw HTTP `mastra.metadata.body/headers/modelMetadata` blob
 *   - `mastra.span.type=tool_call` /
 *     `mastra.span.type=mcp_tool_call`  → `mastra.<...>.input/output`
 *   - `mastra.span.type=generic`       → `mastra.generic.input/output`
 *
 * `mastra.span.type=model_chunk` spans are stream-coordination noise (payload
 * is always `"{}"`). They are dropped at the span-filter layer
 * (`isMastraInternalSpan` in `spanFilter.ts`) before they reach the
 * transformer; matches Mastra's own Sentry exporter behaviour.
 *
 * `mastra.completion_start_time` (ISO ms) is exported as
 * {@link COMPLETION_START_ATTRS} so `core.ts` can merge it with Langfuse's
 * equivalent and derive `time_to_first_token`.
 *
 * See `docs/otel-mapping/mastra.md` for the per-span-type attribute schemas
 * and the OTel GenAI overlap.
 */

import {
  coerceToMessages,
  messageWithParts,
  safeJsonParse,
  textMessage,
  textPart,
  toolCallPart,
  toolCallResponsePart,
} from "../messages";
import type { CanonicalMessages, Message, Part } from "./types";
import { makeAdapter } from "./makeAdapter";

const SPAN_TYPE_ATTR = "mastra.span.type";

const MODEL_METADATA_ATTR = "mastra.metadata.modelMetadata";

/**
 * `mastra.completion_start_time` aliases. Re-exported (parallel to
 * `frameworks/langfuse.ts:COMPLETION_START_ATTRS`) so `core.ts` can merge them
 * into the single chain it consults when deriving `time_to_first_token` from
 * a first-chunk timestamp. Keep the export name stable — it's imported by
 * name in `core.ts`.
 */
export const COMPLETION_START_ATTRS = ["mastra.completion_start_time"] as const;

export const adapter = makeAdapter({
  NAME: "mastra",
  // MODEL / PROVIDED_MODEL: GENERATION spans carry `gen_ai.request.model` /
  // `gen_ai.response.model` and route through `otelGenai`. MODEL_STEP spans
  // have no canonical model alias — `resolveProvidedModel` below pulls the
  // value out of the `mastra.metadata.modelMetadata` JSON blob.
  INPUT_ATTRS: [
    "mastra.agent_run.input",
    "mastra.workflow_run.input",
    "mastra.workflow_step.input",
    "mastra.workflow_conditional.input",
    "mastra.workflow_conditional_eval.input",
    "mastra.workflow_parallel.input",
    "mastra.workflow_loop.input",
    "mastra.workflow_sleep.input",
    "mastra.workflow_wait_event.input",
    "mastra.processor_run.input",
    "mastra.model_step.input",
    "mastra.tool_call.input",
    "mastra.mcp_tool_call.input",
    "mastra.generic.input",
  ],
  OUTPUT_ATTRS: [
    "mastra.agent_run.output",
    "mastra.workflow_run.output",
    "mastra.workflow_step.output",
    "mastra.workflow_conditional.output",
    "mastra.workflow_conditional_eval.output",
    "mastra.workflow_parallel.output",
    "mastra.workflow_loop.output",
    "mastra.workflow_sleep.output",
    "mastra.workflow_wait_event.output",
    "mastra.processor_run.output",
    "mastra.model_step.output",
    "mastra.tool_call.output",
    "mastra.mcp_tool_call.output",
    "mastra.generic.output",
  ],
  // Mastra's `ToolCallAttributes` interface exposes `toolId` as the canonical
  // name. Both `tool_call` and `mcp_tool_call` span types share the schema.
  TOOL_NAME_ATTRS: ["mastra.tool_call.toolId", "mastra.mcp_tool_call.toolId"],
  resolveProvider(attrs) {
    const meta = parseModelMetadata(attrs[MODEL_METADATA_ATTR]);
    const provider = meta?.modelProvider;
    return typeof provider === "string" && provider.length > 0 ? provider : null;
  },
  resolveProvidedModel(attrs) {
    // Fires only after the canonical PROVIDED_MODEL_ATTRS chain misses, so
    // `gen_ai.request.model` (set on MODEL_GENERATION) wins. MODEL_STEP spans
    // have no `gen_ai.*` model alias — recover it from modelMetadata here.
    const meta = parseModelMetadata(attrs[MODEL_METADATA_ATTR]);
    const id = meta?.modelId;
    return typeof id === "string" && id.length > 0 ? id : null;
  },
  enrichMetadata(attrs, metadata) {
    // Hoist Mastra's run-context identifiers and the structured modelMetadata
    // blob into the metadata bag. Leave `mastra.metadata.body` and
    // `mastra.metadata.headers` in raw `attributes.span` — `body` is a
    // multi-KB provider response payload that consumers may not want surfaced
    // as first-class metadata.
    const runId = attrs["mastra.metadata.runId"];
    const orgId = attrs["mastra.metadata.orgId"];
    const workspaceId = attrs["mastra.metadata.workspaceId"];
    if (runId !== undefined && runId !== null) metadata.runId = runId;
    if (orgId !== undefined && orgId !== null) metadata.orgId = orgId;
    if (workspaceId !== undefined && workspaceId !== null) {
      metadata.workspaceId = workspaceId;
    }
    const meta = parseModelMetadata(attrs[MODEL_METADATA_ATTR]);
    if (meta !== null) metadata.mastra_modelMetadata = meta;
  },
  normalizeMessages(attrs): CanonicalMessages | null {
    const spanType = attrs[SPAN_TYPE_ATTR];
    if (typeof spanType !== "string") return null;
    switch (spanType) {
      case "agent_run":
        return normalizeAgentRun(attrs);
      case "processor_run":
        return normalizeProcessorRun(attrs);
      case "model_step":
        return normalizeModelStep(attrs);
      case "tool_call":
      case "mcp_tool_call":
        return normalizeToolCall(attrs, spanType);
      case "workflow_run":
      case "workflow_step":
      case "workflow_conditional":
      case "workflow_conditional_eval":
      case "workflow_parallel":
      case "workflow_loop":
      case "workflow_sleep":
      case "workflow_wait_event":
        return normalizeWorkflow(attrs, spanType);
      case "generic":
        return normalizeGeneric(attrs);
      // model_generation routes through otelGenai (gen_ai.input.messages /
      // gen_ai.output.messages); model_chunk is dropped at the span filter.
      default:
        return null;
    }
  },
});

// ── Per-span-type normalizers ───────────────────────────────────────────────

function normalizeAgentRun(attrs: Record<string, unknown>): CanonicalMessages {
  // mastra.agent_run.input is the raw user prompt (plain string). The system
  // instructions piece is already injected via core's gen_ai.system_instructions
  // pass, so we only emit the user-role message here.
  let input: Message[] | null = null;
  const rawIn = attrs["mastra.agent_run.input"];
  if (typeof rawIn === "string" && rawIn.length > 0) {
    input = [textMessage("user", rawIn)];
  }

  // mastra.agent_run.output shape: {text, object?, files?}. `object` is a
  // parsed view of `text` for structured-response agents — preferring `text`
  // keeps the canonical view byte-aligned with what the model emitted.
  let output: Message[] | null = null;
  const rawOut = attrs["mastra.agent_run.output"];
  const parsedOut = parseObject(rawOut);
  if (parsedOut !== null) {
    const text = parsedOut.text;
    if (typeof text === "string" && text.length > 0) {
      output = [textMessage("assistant", text)];
    } else if (parsedOut.object !== undefined && parsedOut.object !== null) {
      output = [textMessage("assistant", stringify(parsedOut.object))];
    }
  } else if (typeof rawOut === "string" && rawOut.length > 0) {
    output = [textMessage("assistant", rawOut)];
  }

  return { input, output };
}

function normalizeProcessorRun(
  attrs: Record<string, unknown>,
): CanonicalMessages {
  // mastra.processor_run.input shape (input phase): `{phase, ...}`.
  // mastra.processor_run.output shape (output phase): `{phase, messageList:
  // {messages, systemMessages?}}`. The richer structure is on the output side.
  let input: Message[] | null = null;
  const inObj = parseObject(attrs["mastra.processor_run.input"]);
  if (inObj !== null) {
    const fromList = unpackMessageList(inObj.messageList);
    if (fromList) input = fromList;
  }

  let output: Message[] | null = null;
  const outObj = parseObject(attrs["mastra.processor_run.output"]);
  if (outObj !== null) {
    const fromList = unpackMessageList(outObj.messageList);
    if (fromList) output = fromList;
  }

  return { input, output };
}

function normalizeModelStep(
  attrs: Record<string, unknown>,
): CanonicalMessages {
  // mastra.model_step.input is a JSON-encoded message array `[{role,
  // parts:[{text}]}]` — Gemini-shape parts (bare `{text}`, no `type`).
  // `coerceToMessages` would pass those through verbatim assuming canonical
  // shape; we have to project to `{type:"text", content}` ourselves.
  let input: Message[] | null = null;
  const rawIn = attrs["mastra.model_step.input"];
  const parsedIn = typeof rawIn === "string" ? safeJsonParse(rawIn) : rawIn;
  if (Array.isArray(parsedIn)) {
    const projected = parsedIn.map(geminiToCanonicalMessage).filter(
      (m): m is Message => m !== null,
    );
    if (projected.length > 0) input = projected;
  }

  // mastra.model_step.output shape: {text, toolCalls?, object?}. Mirror
  // otelGenai's `mergeToolCallsIntoOutput`: assistant message with text part
  // + tool_call parts.
  let output: Message[] | null = null;
  const outObj = parseObject(attrs["mastra.model_step.output"]);
  if (outObj !== null) {
    const parts: Part[] = [];
    const text = outObj.text;
    if (typeof text === "string" && text.length > 0) parts.push(textPart(text));
    const toolCalls = outObj.toolCalls;
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        if (!tc || typeof tc !== "object") continue;
        const obj = tc as Record<string, unknown>;
        const name =
          (typeof obj.toolName === "string" ? obj.toolName : undefined) ??
          (typeof obj.name === "string" ? obj.name : undefined);
        if (!name) continue;
        const id =
          (typeof obj.toolCallId === "string" ? obj.toolCallId : undefined) ??
          (typeof obj.id === "string" ? obj.id : undefined) ??
          null;
        const rawArgs = obj.args ?? obj.arguments ?? obj.input;
        const args =
          typeof rawArgs === "string"
            ? safeJsonParse(rawArgs) ?? rawArgs
            : rawArgs;
        parts.push(toolCallPart(name, args, id));
      }
    }
    if (parts.length > 0) {
      output = [messageWithParts("assistant", parts)];
    }
  }

  return { input, output };
}

function normalizeToolCall(
  attrs: Record<string, unknown>,
  spanType: "tool_call" | "mcp_tool_call",
): CanonicalMessages {
  const inputAttr = `mastra.${spanType}.input`;
  const outputAttr = `mastra.${spanType}.output`;
  const idAttr = `mastra.${spanType}.toolCallId`;
  const nameAttr = `mastra.${spanType}.toolId`;

  const toolName = attrs[nameAttr];
  if (typeof toolName !== "string") return { input: null, output: null };

  const callId = typeof attrs[idAttr] === "string" ? (attrs[idAttr] as string) : null;

  let input: Message[] | null = null;
  const rawIn = attrs[inputAttr];
  if (rawIn !== undefined && rawIn !== null) {
    const parsedIn = typeof rawIn === "string" ? safeJsonParse(rawIn) ?? rawIn : rawIn;
    input = [
      messageWithParts("assistant", [toolCallPart(toolName, parsedIn, callId)]),
    ];
  }

  let output: Message[] | null = null;
  const rawOut = attrs[outputAttr];
  if (rawOut !== undefined && rawOut !== null) {
    const parsedOut =
      typeof rawOut === "string" ? safeJsonParse(rawOut) ?? rawOut : rawOut;
    output = [
      messageWithParts("tool", [toolCallResponsePart(parsedOut, callId)]),
    ];
  }

  return { input, output };
}

function normalizeWorkflow(
  attrs: Record<string, unknown>,
  spanType: string,
): CanonicalMessages {
  // Workflow span input/output are arbitrary user-shaped JSON. Best effort:
  // coerce to canonical messages if the blob already matches a known message
  // shape; otherwise wrap the stringified value in a single text message.
  const inAttr = `mastra.${spanType}.input`;
  const outAttr = `mastra.${spanType}.output`;
  return {
    input: coerceOrWrap(attrs[inAttr], "user"),
    output: coerceOrWrap(attrs[outAttr], "assistant"),
  };
}

function normalizeGeneric(attrs: Record<string, unknown>): CanonicalMessages {
  return {
    input: coerceOrWrap(attrs["mastra.generic.input"], "user"),
    output: coerceOrWrap(attrs["mastra.generic.output"], "assistant"),
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Parse `mastra.metadata.modelMetadata` JSON to its `{modelId, modelVersion,
 * modelProvider}` shape, or return `null` for any other input.
 */
function parseModelMetadata(raw: unknown): {
  modelId?: string;
  modelVersion?: string;
  modelProvider?: string;
} | null {
  if (raw === undefined || raw === null) return null;
  const parsed = typeof raw === "string" ? safeJsonParse(raw) : raw;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as { modelId?: string; modelVersion?: string; modelProvider?: string };
}

/**
 * Decode a JSON-string-or-object attribute to its object form, returning null
 * for anything that doesn't end up an object literal.
 */
function parseObject(raw: unknown): Record<string, unknown> | null {
  if (raw === undefined || raw === null) return null;
  const parsed = typeof raw === "string" ? safeJsonParse(raw) : raw;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

/**
 * Project Mastra's processor `messageList: {messages, systemMessages?}` shape
 * into canonical messages. `systemMessages` (if present) is prepended as a
 * leading system message; the main `messages` array is run through the OpenAI
 * coercer (already understands `[{role, content:[{type,text}]}]`).
 */
function unpackMessageList(raw: unknown): Message[] | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const out: Message[] = [];
  const sys = obj.systemMessages;
  if (Array.isArray(sys)) {
    for (const entry of sys) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const content = e.content;
      if (typeof content === "string" && content.length > 0) {
        out.push(textMessage("system", content));
      } else if (Array.isArray(content)) {
        const coerced = coerceToMessages([{ role: "system", content }]);
        if (coerced) out.push(...coerced);
      }
    }
  }
  const messages = obj.messages;
  if (Array.isArray(messages)) {
    const coerced = coerceToMessages(messages);
    if (coerced) out.push(...coerced);
  }
  return out.length > 0 ? out : null;
}

function coerceOrWrap(raw: unknown, role: "user" | "assistant"): Message[] | null {
  if (raw === undefined || raw === null) return null;
  const parsed = typeof raw === "string" ? safeJsonParse(raw) : raw;
  if (Array.isArray(parsed)) {
    const coerced = coerceToMessages(parsed);
    if (coerced && coerced.length > 0) return coerced;
  }
  const text = typeof raw === "string" ? raw : stringify(raw);
  if (text.length === 0) return null;
  return [textMessage(role, text)];
}

/**
 * Project a Gemini-shape message (`{role, parts:[{text}]}`) into canonical
 * `Message`. Mastra's `model_step` input is the array Mastra hands to the
 * Google client verbatim, so the parts use Gemini's bare `{text}` form
 * rather than canonical `{type:"text", content}`. Returns `null` for
 * unrecognised entries.
 */
function geminiToCanonicalMessage(item: unknown): Message | null {
  if (!item || typeof item !== "object") return null;
  const obj = item as Record<string, unknown>;
  const role = obj.role;
  if (typeof role !== "string") return null;
  const partsIn = obj.parts;
  if (!Array.isArray(partsIn)) {
    return coerceToMessages([item])?.[0] ?? null;
  }
  const partsOut: Part[] = [];
  for (const part of partsIn) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    if (typeof p.type === "string") {
      // Already canonical / typed (e.g. tool-call) — pass through.
      partsOut.push(p as Part);
      continue;
    }
    if (typeof p.text === "string") {
      partsOut.push(textPart(p.text));
      continue;
    }
    // Unknown shape — keep verbatim under a generic part so we don't drop data.
    partsOut.push({ type: "unknown", ...p } as Part);
  }
  return partsOut.length > 0 ? { role, parts: partsOut } : null;
}

function stringify(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

