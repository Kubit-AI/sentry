/**
 * Helpers for projecting heterogeneous source attribute shapes into the
 * OTel GenAI v2 canonical message form (`Message[]` with discriminated
 * `Part[]`). Used by every adapter's `normalizeMessages` hook and by the
 * `canonicalizeGenAiEvents` event-fallback path in `core.ts`.
 *
 * Cross-SDK parity: every exported function has a snake_case mirror in
 * `python-sdk/kubit_otel/transformer/messages.py`. Same inputs must
 * produce semantically identical outputs.
 */

import type {
  BlobPart,
  CanonicalMessages,
  FilePart,
  GenericPart,
  Message,
  Modality,
  Part,
  ReasoningPart,
  Role,
  TextPart,
  ToolCallRequestPart,
  ToolCallResponsePart,
  UriPart,
} from "./frameworks/types";

// ── Part constructors ──────────────────────────────────────────────────────

export function textPart(content: string): TextPart {
  return { type: "text", content };
}

export function reasoningPart(content: string): ReasoningPart {
  return { type: "reasoning", content };
}

export function toolCallPart(
  name: string,
  args?: unknown,
  id?: string | null,
): ToolCallRequestPart {
  const part: ToolCallRequestPart = { type: "tool_call", name };
  // Skip null/undefined to keep the JSON output identical to Python's
  // `tool_call_part` (which uses `is not None`). Cross-SDK parity rule.
  if (id !== undefined && id !== null) part.id = id;
  if (args !== undefined && args !== null) part.arguments = args;
  return part;
}

export function toolCallResponsePart(
  response: unknown,
  id?: string | null,
): ToolCallResponsePart {
  const part: ToolCallResponsePart = { type: "tool_call_response", response };
  if (id !== undefined && id !== null) part.id = id;
  return part;
}

export function blobPart(
  modality: Modality,
  content: string,
  mimeType?: string | null,
): BlobPart {
  const part: BlobPart = { type: "blob", modality, content };
  if (mimeType !== undefined && mimeType !== null) part.mime_type = mimeType;
  return part;
}

export function filePart(
  modality: Modality,
  fileId: string,
  mimeType?: string | null,
): FilePart {
  const part: FilePart = { type: "file", modality, file_id: fileId };
  if (mimeType !== undefined && mimeType !== null) part.mime_type = mimeType;
  return part;
}

export function uriPart(
  modality: Modality,
  uri: string,
  mimeType?: string | null,
): UriPart {
  const part: UriPart = { type: "uri", modality, uri };
  if (mimeType !== undefined && mimeType !== null) part.mime_type = mimeType;
  return part;
}

export function genericPart(
  type: string,
  extras: Record<string, unknown> = {},
): GenericPart {
  return { type, ...extras };
}

// ── Message constructors ────────────────────────────────────────────────────

export function textMessage(role: Role, content: string): Message {
  return { role, parts: [textPart(content)] };
}

export function messageWithParts(
  role: Role,
  parts: Part[],
  extras: Partial<Message> = {},
): Message {
  return { role, parts, ...extras };
}

// ── Parsing helpers ─────────────────────────────────────────────────────────

export function safeJsonParse(raw: unknown): unknown {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Render any value as a string suitable for wrapping in a `TextPart`.
 * Strings pass through; objects/arrays JSON-stringify; primitives `String()`.
 */
export function stringifyForText(val: unknown): string {
  if (typeof val === "string") return val;
  if (val === null || val === undefined) return "";
  if (typeof val === "object") {
    try {
      return JSON.stringify(val);
    } catch {
      return String(val);
    }
  }
  return String(val);
}

/**
 * Best-effort detector for "this is already an array of canonical-ish
 * messages." Accepts:
 *   - Array of `{role, parts: [...]}`  → already canonical, validated
 *   - Array of `{role, content: string | object[]}` → OpenAI shape, translated
 *   - Anything else → null (caller text-wraps)
 */
export function coerceToMessages(raw: unknown): Message[] | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    const parsed = safeJsonParse(raw);
    if (parsed === null) return null;
    value = parsed;
  }
  if (!Array.isArray(value) || value.length === 0) return null;

  const out: Message[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const obj = item as Record<string, unknown>;
    if (typeof obj.role !== "string") return null;
    if (Array.isArray(obj.parts)) {
      // Already canonical-shaped — pass through, trust the source.
      const parts = dedupeToolUseTextMirror(obj.parts as Part[]);
      out.push({ role: obj.role, parts, ...stripCanonicalKeys(obj) });
      continue;
    }
    // OpenAI-shape: {role, content, tool_calls?, tool_call_id?, name?, ...}
    out.push(openAIMessageToCanonical(obj));
  }
  return out;
}

/**
 * OpenLLMetry / Traceloop's LangChain instrumentation serializes Anthropic-
 * style assistant `content` arrays that contain `tool_use` blocks by
 * stringifying each block into a TextPart *and* emitting the parallel
 * structured `tool_call` part. Drop the redundant text mirror so the canonical
 * view doesn't duplicate the same tool invocation. Keyed on a sibling
 * tool_call part with matching `id` (or matching `name` when no id present).
 */
function dedupeToolUseTextMirror(parts: Part[]): Part[] {
  const toolCallIds = new Set<string>();
  const toolCallNames = new Set<string>();
  for (const p of parts) {
    if (p && typeof p === "object" && (p as { type?: unknown }).type === "tool_call") {
      const tc = p as ToolCallRequestPart;
      if (typeof tc.id === "string") toolCallIds.add(tc.id);
      if (typeof tc.name === "string") toolCallNames.add(tc.name);
    }
  }
  if (toolCallIds.size === 0 && toolCallNames.size === 0) return parts;

  return parts.filter((p) => {
    if (!p || typeof p !== "object") return true;
    const obj = p as Record<string, unknown>;
    if (obj.type !== "text" || typeof obj.content !== "string") return true;
    const parsed = safeJsonParse(obj.content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return true;
    const inner = parsed as Record<string, unknown>;
    if (inner.type !== "tool_use" && inner.type !== "tool_call") return true;
    const innerId = typeof inner.id === "string" ? inner.id : null;
    const innerName = typeof inner.name === "string" ? inner.name : null;
    if (innerId !== null && toolCallIds.has(innerId)) return false;
    if (innerId === null && innerName !== null && toolCallNames.has(innerName)) return false;
    return true;
  });
}

function stripCanonicalKeys(msg: Record<string, unknown>): Partial<Message> {
  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(msg)) {
    if (k === "role" || k === "parts") continue;
    extras[k] = v;
  }
  return extras as Partial<Message>;
}

// ── OpenAI message → canonical translation ─────────────────────────────────

type OpenAIToolCall = {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: unknown };
};

/**
 * Translate a single OpenAI Chat Completions message into canonical form.
 * Handles: string content, multimodal content array (text/image_url/image/
 * input_audio), assistant.tool_calls, tool.tool_call_id.
 */
export function openAIMessageToCanonical(msg: Record<string, unknown>): Message {
  const role = (msg.role as Role) ?? "user";
  const parts: Part[] = [];

  const content = msg.content;
  if (role === "tool" && typeof msg.tool_call_id === "string") {
    parts.push(toolCallResponsePart(content ?? null, msg.tool_call_id as string));
  } else if (typeof content === "string") {
    if (content.length > 0) parts.push(textPart(content));
  } else if (Array.isArray(content)) {
    for (const cp of content) {
      const part = openAIContentPartToCanonical(cp);
      if (part) parts.push(part);
    }
  } else if (content !== null && content !== undefined) {
    parts.push(textPart(stringifyForText(content)));
  }

  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls as OpenAIToolCall[]) {
      const name = tc?.function?.name;
      if (typeof name !== "string") continue;
      const rawArgs = tc.function?.arguments;
      const args = typeof rawArgs === "string" ? safeJsonParse(rawArgs) ?? rawArgs : rawArgs;
      parts.push(toolCallPart(name, args, tc.id ?? null));
    }
  }

  const out: Message = { role, parts };
  if (typeof msg.name === "string") out.name = msg.name;
  if (typeof msg.finish_reason === "string") out.finish_reason = msg.finish_reason;
  return out;
}

function openAIContentPartToCanonical(raw: unknown): Part | null {
  if (typeof raw === "string") return textPart(raw);
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const type = obj.type;
  if (type === "text" && typeof obj.text === "string") return textPart(obj.text);
  // Vercel AI SDK uses kebab-case content parts inside ai.prompt.messages
  // for tool invocations and results. Map them to canonical snake_case parts
  // so consumers don't have to know about the Vercel-specific shape.
  if (type === "tool-call" && typeof obj.toolName === "string") {
    const id = typeof obj.toolCallId === "string" ? obj.toolCallId : null;
    const rawArgs = obj.input ?? obj.args ?? obj.arguments;
    const args = typeof rawArgs === "string" ? safeJsonParse(rawArgs) ?? rawArgs : rawArgs;
    return toolCallPart(obj.toolName, args, id);
  }
  if (type === "tool-result") {
    const id = typeof obj.toolCallId === "string" ? obj.toolCallId : null;
    return toolCallResponsePart(unwrapVercelToolResult(obj.output), id);
  }
  if (type === "image_url") {
    const url =
      typeof obj.image_url === "string"
        ? obj.image_url
        : (obj.image_url as Record<string, unknown> | undefined)?.url;
    if (typeof url !== "string") return null;
    return parseImageUrl(url);
  }
  if (type === "image" && typeof obj.image === "string") {
    return blobPart("image", obj.image);
  }
  if (type === "input_audio") {
    const audio = obj.input_audio as Record<string, unknown> | undefined;
    if (audio && typeof audio.data === "string") {
      return blobPart(
        "audio",
        audio.data,
        typeof audio.format === "string" ? `audio/${audio.format}` : null,
      );
    }
    return null;
  }
  // Pass through unknown content types as GenericPart so nothing is lost.
  if (typeof type === "string") return genericPart(type, obj);
  return null;
}

function parseImageUrl(url: string): Part {
  const dataMatch = /^data:([^;]+);base64,(.*)$/i.exec(url);
  if (dataMatch) return blobPart("image", dataMatch[2], dataMatch[1]);
  return uriPart("image", url);
}

/**
 * Unwrap Vercel AI SDK's tool-result `output` envelope, which uses a
 * discriminated `{type, value}` shape (e.g. `{type: "json", value: 85}`,
 * `{type: "text", value: "..."}`, `{type: "error-text", value: "..."}`).
 * Returns the inner value for the common `text`/`json`/`error-text`/
 * `error-json` variants and passes the envelope through unchanged for any
 * other shape so nothing is lost.
 */
function unwrapVercelToolResult(output: unknown): unknown {
  if (!output || typeof output !== "object") return output;
  const obj = output as Record<string, unknown>;
  const t = obj.type;
  if (
    (t === "text" || t === "json" || t === "error-text" || t === "error-json") &&
    "value" in obj
  ) {
    return obj.value;
  }
  return output;
}

// ── Pydantic AI envelope translator ────────────────────────────────────────
//
// Pydantic AI's `pydantic_ai.all_messages` is a JSON array of envelopes:
//   [{kind: "request"|"response", parts: [{part_kind, content?, ...}, ...]}]
//
// `request` envelopes carry system-prompt / user-prompt / tool-return / retry-
// prompt parts; `response` envelopes carry text / tool-call / thinking parts.
// We split by part_kind into role-typed canonical messages.

type PydanticAIPart = {
  part_kind?: string;
  content?: unknown;
  tool_name?: string;
  tool_call_id?: string;
  args?: unknown;
};

type PydanticAIEnvelope = {
  kind?: string;
  parts?: PydanticAIPart[];
};

export function pydanticAIEnvelopeToCanonical(raw: unknown): CanonicalMessages {
  let value: unknown = raw;
  if (typeof raw === "string") value = safeJsonParse(raw);
  if (!Array.isArray(value)) return { input: null, output: null };

  const inputs: Message[] = [];
  const outputs: Message[] = [];
  for (const env of value as PydanticAIEnvelope[]) {
    if (!env || typeof env !== "object") continue;
    const parts = Array.isArray(env.parts) ? env.parts : [];
    if (env.kind === "response") {
      const msg = pydanticAIResponseToMessage(parts);
      if (msg) outputs.push(msg);
    } else {
      // Default to request semantics for any non-response envelope (covers
      // `request` and any future-tagged variant we haven't seen yet).
      inputs.push(...pydanticAIRequestToMessages(parts));
    }
  }
  return {
    input: inputs.length ? inputs : null,
    output: outputs.length ? outputs : null,
  };
}

function pydanticAIRequestToMessages(parts: PydanticAIPart[]): Message[] {
  const out: Message[] = [];
  for (const p of parts) {
    if (!p || typeof p !== "object") continue;
    switch (p.part_kind) {
      case "system-prompt":
        out.push(textMessage("system", stringifyForText(p.content)));
        break;
      case "user-prompt":
        out.push(textMessage("user", stringifyForText(p.content)));
        break;
      case "tool-return":
        out.push({
          role: "tool",
          parts: [toolCallResponsePart(p.content ?? null, p.tool_call_id ?? null)],
          ...(p.tool_name ? { name: p.tool_name } : {}),
        });
        break;
      case "retry-prompt":
        out.push({
          role: "user",
          parts: [textPart(stringifyForText(p.content))],
          name: "retry",
        });
        break;
      default:
        out.push({
          role: "user",
          parts: [genericPart(p.part_kind ?? "unknown", { ...p })],
        });
    }
  }
  return out;
}

function pydanticAIResponseToMessage(parts: PydanticAIPart[]): Message | null {
  const canonical: Part[] = [];
  for (const p of parts) {
    if (!p || typeof p !== "object") continue;
    switch (p.part_kind) {
      case "text":
        canonical.push(textPart(stringifyForText(p.content)));
        break;
      case "thinking":
      case "reasoning":
        canonical.push(reasoningPart(stringifyForText(p.content)));
        break;
      case "tool-call":
        canonical.push(
          toolCallPart(p.tool_name ?? "", p.args, p.tool_call_id ?? null),
        );
        break;
      default:
        canonical.push(genericPart(p.part_kind ?? "unknown", { ...p }));
    }
  }
  if (canonical.length === 0) return null;
  return { role: "assistant", parts: canonical };
}

// ── LangChain Serializable envelope translator ─────────────────────────────
//
// LangChain (JS via `@arizeai/openinference-instrumentation-langchain`,
// Python via `openinference.instrumentation.langchain`) emits message
// envelopes inside `input.value` / `output.value` blobs as LangChain
// `Serializable` objects:
//
//   {lc:1, type:"constructor",
//    id:["langchain_core","messages","HumanMessage"|"AIMessage"|...],
//    kwargs:{content, tool_calls?, tool_call_id?, name?, ...}}
//
// Wrappers vary: `{messages:[...]}` (most common), bare array, single
// Serializable, `{output: <ToolMessage>}` (LangGraph TOOL span output
// convention), `{input: ...}` (some chain nodes). Callers should treat a
// `null` return as "not LangChain shape, fall through."

type LangchainSerializable = {
  lc?: unknown;
  type?: unknown;
  id?: unknown;
  kwargs?: Record<string, unknown>;
};

function isLangchainMessageSerializable(v: unknown): v is LangchainSerializable {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (o.lc !== 1) return false;
  if (!Array.isArray(o.id) || o.id.length < 2) return false;
  return o.id[o.id.length - 2] === "messages";
}

function unwrapLangchainEnvelope(value: unknown): unknown[] | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const parsed = safeJsonParse(value);
    if (parsed === null) return null;
    return unwrapLangchainEnvelope(parsed);
  }
  if (Array.isArray(value)) {
    if (value.some(isLangchainMessageSerializable)) return value;
    if (value.length > 0 && value.every(isOpenAIShapeMessage)) return value;
    return null;
  }
  if (typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  if (Array.isArray(obj.messages)) {
    // LangChain JS BaseChatModel.invoke uses a batch convention: `messages`
    // is BaseMessage[][] (each outer slot = one conversation in the batch).
    // For single-conversation calls there's still one outer wrapper around
    // the inner turn list. Flatten one level when every outer item is itself
    // an array of Serializables.
    if (
      obj.messages.length > 0 &&
      obj.messages.every(
        (x) =>
          Array.isArray(x) &&
          (x as unknown[]).some(isLangchainMessageSerializable),
      )
    ) {
      return ([] as unknown[]).concat(...(obj.messages as unknown[][]));
    }
    return obj.messages;
  }
  // LangChain LLMResult: `{generations: [[{text, message: <Serializable>}, ...], ...], llmOutput}`.
  // Each `generations[i]` is an array of `{text, message}` records — collect
  // every `message` field across the nested structure.
  if (Array.isArray(obj.generations)) {
    const collected: unknown[] = [];
    for (const gen of obj.generations as unknown[]) {
      const inner = Array.isArray(gen) ? gen : [gen];
      for (const item of inner as unknown[]) {
        if (item && typeof item === "object") {
          const msg = (item as Record<string, unknown>).message;
          if (msg !== undefined) collected.push(msg);
        }
      }
    }
    if (collected.some(isLangchainMessageSerializable)) return collected;
  }
  if (obj.output !== undefined) {
    if (Array.isArray(obj.output) && obj.output.some(isLangchainMessageSerializable)) {
      return obj.output;
    }
    if (isLangchainMessageSerializable(obj.output)) return [obj.output];
  }
  if (obj.input !== undefined) return unwrapLangchainEnvelope(obj.input);
  // OpenLLMetry's @workflow / @task entity blobs nest the actual messages
  // under plural `inputs` / `outputs` keys (often with sibling `tags`,
  // `metadata`, `kwargs`). Recurse through them like the singular variants.
  if (obj.inputs !== undefined) return unwrapLangchainEnvelope(obj.inputs);
  if (obj.outputs !== undefined) return unwrapLangchainEnvelope(obj.outputs);
  if (isLangchainMessageSerializable(obj)) return [obj];
  return null;
}

function isOpenAIShapeMessage(v: unknown): boolean {
  return (
    !!v &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    typeof (v as Record<string, unknown>).role === "string"
  );
}

export function langchainEnvelopeToCanonical(raw: unknown): Message[] | null {
  const items = unwrapLangchainEnvelope(raw);
  if (!items || items.length === 0) return null;
  const out: Message[] = [];
  for (const item of items) {
    const msg = langchainSerializableToMessage(item);
    if (msg) out.push(msg);
  }
  return out.length > 0 ? out : null;
}

function langchainSerializableToMessage(item: unknown): Message | null {
  if (!isLangchainMessageSerializable(item)) {
    // Be lenient: if the item carries a `role` we can still translate via the
    // OpenAI-shape coercer (covers `{messages:[{role,content}]}` mixed with
    // Serializables, which the empirical __start__ envelope produces).
    if (item && typeof item === "object") {
      const obj = item as Record<string, unknown>;
      if (typeof obj.role === "string") return openAIMessageToCanonical(obj);
    }
    return null;
  }
  const idArr = item.id as unknown[];
  const lcType = String(idArr[idArr.length - 1]);
  const kwargs = (item.kwargs && typeof item.kwargs === "object")
    ? (item.kwargs as Record<string, unknown>)
    : {};
  const content = kwargs.content;

  switch (lcType) {
    case "HumanMessage":
      return langchainTextOnlyMessage("user", content);
    case "SystemMessage":
      return langchainTextOnlyMessage("system", content);
    case "AIMessage":
    case "AIMessageChunk": {
      const parts = aiMessageContentAndToolCallsToParts(content, kwargs.tool_calls);
      if (parts.length === 0) return null;
      return { role: "assistant", parts };
    }
    case "ToolMessage": {
      const callId = typeof kwargs.tool_call_id === "string"
        ? (kwargs.tool_call_id as string)
        : null;
      const msg: Message = {
        role: "tool",
        parts: [toolCallResponsePart(content ?? null, callId)],
      };
      if (typeof kwargs.name === "string") msg.name = kwargs.name as string;
      return msg;
    }
    case "FunctionMessage": {
      const msg: Message = {
        role: "tool",
        parts: [toolCallResponsePart(content ?? null, null)],
      };
      if (typeof kwargs.name === "string") msg.name = kwargs.name as string;
      return msg;
    }
    case "ChatMessage": {
      const role = (typeof kwargs.role === "string" ? kwargs.role : "user") as Role;
      return langchainTextOnlyMessage(role, content);
    }
    default:
      return null;
  }
}

function langchainTextOnlyMessage(role: Role, content: unknown): Message | null {
  const parts = langchainContentToParts(content);
  if (parts.length === 0) return null;
  return { role, parts };
}

function langchainContentToParts(content: unknown): Part[] {
  if (content === null || content === undefined) return [];
  if (typeof content === "string") {
    return content.length > 0 ? [textPart(content)] : [];
  }
  if (Array.isArray(content)) {
    const out: Part[] = [];
    for (const item of content) {
      if (typeof item === "string") {
        if (item.length > 0) out.push(textPart(item));
        continue;
      }
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      const t = obj.type;
      if (t === "text" && typeof obj.text === "string") {
        if ((obj.text as string).length > 0) out.push(textPart(obj.text as string));
        continue;
      }
      // Anthropic-shape inline tool call carried inside the content array.
      if (t === "tool_use" && typeof obj.name === "string") {
        const id = typeof obj.id === "string" ? (obj.id as string) : null;
        out.push(toolCallPart(obj.name as string, obj.input, id));
        continue;
      }
      const oai = openAIContentPartToCanonical(item);
      if (oai) {
        out.push(oai);
        continue;
      }
      if (typeof t === "string") out.push(genericPart(t, obj));
    }
    return out;
  }
  const str = stringifyForText(content);
  return str.length > 0 ? [textPart(str)] : [];
}

function aiMessageContentAndToolCallsToParts(
  content: unknown,
  toolCalls: unknown,
): Part[] {
  const parts = langchainContentToParts(content);
  const seenIds = new Set<string>();
  for (const p of parts) {
    if (p.type === "tool_call") {
      const id = (p as ToolCallRequestPart).id;
      if (typeof id === "string") seenIds.add(id);
    }
  }
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls) {
      if (!tc || typeof tc !== "object") continue;
      const obj = tc as Record<string, unknown>;
      const name = typeof obj.name === "string" ? (obj.name as string) : null;
      if (!name) continue;
      const id = typeof obj.id === "string" ? (obj.id as string) : null;
      if (id !== null && seenIds.has(id)) continue;
      const args = obj.args ?? obj.arguments;
      parts.push(toolCallPart(name, args, id));
      if (id !== null) seenIds.add(id);
    }
  }
  return parts;
}

/**
 * Walk a LangChain envelope (string or already-parsed) for the first
 * AIMessage Serializable and return its `kwargs.response_metadata.model_provider`
 * (or `kwargs.additional_kwargs.model_provider`). Returns null when no
 * AIMessage is present or the field is missing — used by the OpenInference
 * adapter's `resolveProvider` hook.
 */
export function findLangchainModelProvider(raw: unknown): string | null {
  const items = unwrapLangchainEnvelope(raw);
  if (!items) return null;
  for (const item of items) {
    if (!isLangchainMessageSerializable(item)) continue;
    const idArr = item.id as unknown[];
    const lcType = String(idArr[idArr.length - 1]);
    if (lcType !== "AIMessage" && lcType !== "AIMessageChunk") continue;
    const kwargs = (item.kwargs && typeof item.kwargs === "object")
      ? (item.kwargs as Record<string, unknown>)
      : {};
    const rm = kwargs.response_metadata;
    if (rm && typeof rm === "object") {
      const mp = (rm as Record<string, unknown>).model_provider;
      if (typeof mp === "string" && mp.length > 0) return mp;
    }
    const ak = kwargs.additional_kwargs;
    if (ak && typeof ak === "object") {
      const mp = (ak as Record<string, unknown>).model_provider;
      if (typeof mp === "string" && mp.length > 0) return mp;
    }
  }
  return null;
}

// ── Span-event canonicalization ────────────────────────────────────────────

const GEN_AI_INPUT_EVENT_ROLES: Record<string, Role> = {
  "gen_ai.system.message": "system",
  "gen_ai.user.message": "user",
  "gen_ai.assistant.message": "assistant",
  "gen_ai.tool.message": "tool",
};
const GEN_AI_OUTPUT_EVENT_NAME = "gen_ai.choice";

export type SpanEventLike = {
  name: string;
  attributes?: Record<string, unknown>;
  time?: [number, number];
};

/**
 * Refactor of the legacy `unpackGenAiEvents` (in core.ts) producing canonical
 * `Message[]` instead of JSON strings. Used by the core `resolveCanonical-
 * Messages` chain as the events-based fallback when no adapter recognized
 * any attribute-shape input/output.
 */
export function canonicalizeGenAiEvents(
  events: readonly SpanEventLike[] | undefined | null,
): CanonicalMessages {
  if (!events || events.length === 0) return { input: null, output: null };

  const inputs: Array<{ __t: number; msg: Message }> = [];
  const outputs: Array<{ __t: number; msg: Message }> = [];

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const t = ev.time ? ev.time[0] * 1e9 + ev.time[1] : i;
    const attrs = ev.attributes ?? {};
    const role = GEN_AI_INPUT_EVENT_ROLES[ev.name];
    if (role !== undefined) {
      inputs.push({ __t: t, msg: eventAttrsToMessage(role, attrs) });
      continue;
    }
    if (ev.name === GEN_AI_OUTPUT_EVENT_NAME) {
      const evRole = typeof attrs.role === "string" ? (attrs.role as Role) : "assistant";
      const msg = eventAttrsToMessage(evRole, attrs);
      const finishReason = attrs.finish_reason ?? attrs["gen_ai.response.finish_reason"];
      if (typeof finishReason === "string") msg.finish_reason = finishReason;
      outputs.push({ __t: t, msg });
    }
  }

  const sortByTime = (a: { __t: number }, b: { __t: number }) => a.__t - b.__t;
  return {
    input: inputs.length ? inputs.sort(sortByTime).map((e) => e.msg) : null,
    output: outputs.length ? outputs.sort(sortByTime).map((e) => e.msg) : null,
  };
}

function eventAttrsToMessage(role: Role, attrs: Record<string, unknown>): Message {
  const parts: Part[] = [];
  const content = attrs.content;
  if (role === "tool") {
    const id = typeof attrs.id === "string" ? attrs.id : (attrs.tool_call_id as string | undefined) ?? null;
    parts.push(toolCallResponsePart(content ?? null, id));
  } else if (typeof content === "string" && content.length > 0) {
    parts.push(textPart(content));
  } else if (Array.isArray(content)) {
    for (const cp of content) {
      const p = openAIContentPartToCanonical(cp);
      if (p) parts.push(p);
    }
  } else if (content !== null && content !== undefined) {
    parts.push(textPart(stringifyForText(content)));
  }
  if (Array.isArray(attrs.tool_calls)) {
    for (const tc of attrs.tool_calls as OpenAIToolCall[]) {
      const name = tc?.function?.name;
      if (typeof name !== "string") continue;
      const raw = tc.function?.arguments;
      const args = typeof raw === "string" ? safeJsonParse(raw) ?? raw : raw;
      parts.push(toolCallPart(name, args, tc.id ?? null));
    }
  }
  const msg: Message = { role, parts };
  if (typeof attrs.name === "string") msg.name = attrs.name;
  return msg;
}

// ── Indexed-flat unpacker (shared core for openinference / traceloop / braintrust) ─

/**
 * Generic indexed-flat unpacker. Walks `attrs` for keys matching
 * `<prefix><idx><innerSep><field>` and groups by `<idx>`, producing one
 * canonical `Message` per index. The `innerSep` lets openinference's
 * `llm.input_messages.<n>.message.<field>` form coexist with traceloop's
 * `gen_ai.prompt.<n>.<field>` and braintrust's `braintrust.input.<n>.<field>`.
 *
 * `roleResolver` and `partsBuilder` let callers customize how each index's
 * fields collapse into a Message.
 */
export function unpackIndexedMessages(
  attrs: Record<string, unknown>,
  prefix: string,
  innerSep: string,  // empty string for direct .<field>; "message." for OI
): Message[] | null {
  const grouped = new Map<number, Record<string, unknown>>();
  const fullPrefix = prefix.endsWith(".") ? prefix : prefix + ".";
  for (const [key, value] of Object.entries(attrs)) {
    if (!key.startsWith(fullPrefix)) continue;
    const rest = key.slice(fullPrefix.length);
    const dotIdx = rest.indexOf(".");
    if (dotIdx === -1) continue;
    const idxStr = rest.slice(0, dotIdx);
    const idx = Number(idxStr);
    if (!Number.isInteger(idx)) continue;
    let inner = rest.slice(dotIdx + 1);
    if (innerSep && inner.startsWith(innerSep)) {
      inner = inner.slice(innerSep.length);
    } else if (innerSep) {
      // innerSep required but missing — skip; lets openinference filter
      // out non-`message.` siblings.
      continue;
    }
    let bucket = grouped.get(idx);
    if (!bucket) {
      bucket = {};
      grouped.set(idx, bucket);
    }
    bucket[inner] = value;
  }
  if (grouped.size === 0) return null;

  const ordered = [...grouped.entries()].sort((a, b) => a[0] - b[0]);
  return ordered.map(([, fields]) => indexedFieldsToMessage(fields));
}

function indexedFieldsToMessage(fields: Record<string, unknown>): Message {
  const role = typeof fields.role === "string" ? (fields.role as Role) : "user";
  const parts: Part[] = [];
  const content = fields.content;
  const toolCallId = fields.tool_call_id ?? fields["tool_call.id"];

  if (role === "tool" && typeof toolCallId === "string") {
    parts.push(toolCallResponsePart(content ?? null, toolCallId));
  } else if (typeof content === "string" && content.length > 0) {
    parts.push(textPart(content));
  } else if (content !== null && content !== undefined) {
    parts.push(textPart(stringifyForText(content)));
  }

  // Collect nested tool_calls from indexed sub-fields.
  // OpenInference: tool_calls.<j>.tool_call.function.{name,arguments}, tool_calls.<j>.tool_call.id
  // Traceloop:    tool_calls.<j>.{name,arguments,id}
  const toolCalls = collectIndexedToolCalls(fields);
  for (const tc of toolCalls) parts.push(tc);

  const msg: Message = { role, parts };
  if (typeof fields.name === "string") msg.name = fields.name;
  if (typeof fields.finish_reason === "string") msg.finish_reason = fields.finish_reason;
  return msg;
}

function collectIndexedToolCalls(
  fields: Record<string, unknown>,
): ToolCallRequestPart[] {
  const buckets = new Map<number, Record<string, unknown>>();
  for (const [k, v] of Object.entries(fields)) {
    if (!k.startsWith("tool_calls.")) continue;
    const rest = k.slice("tool_calls.".length);
    const dot = rest.indexOf(".");
    if (dot === -1) continue;
    const idx = Number(rest.slice(0, dot));
    if (!Number.isInteger(idx)) continue;
    let inner = rest.slice(dot + 1);
    if (inner.startsWith("tool_call.")) inner = inner.slice("tool_call.".length);
    if (inner.startsWith("function.")) inner = inner.slice("function.".length);
    let bucket = buckets.get(idx);
    if (!bucket) {
      bucket = {};
      buckets.set(idx, bucket);
    }
    bucket[inner] = v;
  }
  if (buckets.size === 0) return [];
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, b]) => {
      const name = typeof b.name === "string" ? b.name : "";
      if (!name) return null;
      const rawArgs = b.arguments;
      const args =
        typeof rawArgs === "string" ? safeJsonParse(rawArgs) ?? rawArgs : rawArgs;
      const id = typeof b.id === "string" ? b.id : null;
      return toolCallPart(name, args, id);
    })
    .filter((x): x is ToolCallRequestPart => x !== null);
}

// ── Result helpers ─────────────────────────────────────────────────────────

export function emptyCanonical(): CanonicalMessages {
  return { input: null, output: null };
}

export function isCanonicalEmpty(m: CanonicalMessages | null): boolean {
  return !m || (m.input === null && m.output === null);
}
