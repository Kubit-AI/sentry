/**
 * Vercel AI SDK (`ai.*` namespace) attribute mappings.
 *
 * Vercel emits its own `ai.*` telemetry alongside standard `gen_ai.*`. The
 * otelGenai adapter handles the `gen_ai.*` fields on `ai.*.doGenerate` /
 * `ai.*.doStream` spans; this adapter covers the additional `ai.*` fields
 * on outer agent spans (`ai.generateText`, `ai.streamText`, etc.) and tool
 * spans (`ai.toolCall`).
 *
 * Includes provider normalisation (`amazon-bedrock.*` → `aws_bedrock`,
 * `anthropic.messages` → `anthropic`, ...) via the `resolveProvider` hook.
 */

import {
  coerceToMessages,
  safeJsonParse,
  textMessage,
  toolCallPart,
  toolCallResponsePart,
} from "../messages";
import type { CanonicalMessages, Message, ToolCallRequestPart } from "./types";
import { makeAdapter } from "./makeAdapter";

// Vercel has emitted both camelCase (`topP`, `maxTokens`, …) and snake_case
// (`top_p`, `max_tokens`, …) variants of `ai.request.*` across SDK versions.
// Accept both; first-non-null per canonical key wins.
const AI_REQUEST_PARAM_MAP: ReadonlyArray<readonly [string, string]> = [
  ["ai.request.temperature", "temperature"],
  ["ai.request.topP", "top_p"],
  ["ai.request.top_p", "top_p"],
  ["ai.request.topK", "top_k"],
  ["ai.request.top_k", "top_k"],
  ["ai.request.maxTokens", "max_tokens"],
  ["ai.request.max_tokens", "max_tokens"],
  ["ai.request.frequencyPenalty", "frequency_penalty"],
  ["ai.request.frequency_penalty", "frequency_penalty"],
  ["ai.request.presencePenalty", "presence_penalty"],
  ["ai.request.presence_penalty", "presence_penalty"],
  ["ai.request.seed", "seed"],
  ["ai.request.stopSequences", "stop_sequences"],
  ["ai.request.stop_sequences", "stop_sequences"],
];

const PROVIDER_PREFIX_MAP: ReadonlyArray<readonly [string, string]> = [
  ["amazon-bedrock", "aws_bedrock"],
  ["google-vertex", "vertex_ai"],
  ["google", "vertex_ai"],
  ["openai", "openai"],
  ["anthropic", "anthropic"],
  ["mistral", "mistral_ai"],
  ["cohere", "cohere"],
];

/**
 * Normalise a raw `ai.model.provider` string to an OTel system id. Vercel
 * emits values like `openai.chat`, `amazon-bedrock.claude-3-5`,
 * `anthropic.messages`. We take the portion before the first `.` and map
 * it to the OTel `gen_ai.system` convention. Unknown prefixes pass through
 * verbatim (lowercased).
 */
export function normaliseProvider(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const head = raw.split(".", 1)[0].trim().toLowerCase();
  for (const [prefix, target] of PROVIDER_PREFIX_MAP) {
    if (head === prefix) return target;
  }
  return head || null;
}

export const adapter = makeAdapter({
  NAME: "vercel_ai",
  MODEL_ATTRS: ["ai.response.model", "ai.model.id", "ai.model"],
  PROVIDED_MODEL_ATTRS: ["ai.model.id", "ai.model"],
  INPUT_ATTRS: [
    "ai.prompt.messages",
    "ai.prompt",
    "ai.toolCall.args",
    // Embedding spans: `ai.value` (singular) on `ai.embed`, `ai.values`
    // (string-array) on `ai.embedMany` and on the inner `*.doEmbed` provider
    // calls. These are the texts being embedded.
    "ai.value",
    "ai.values",
  ],
  OUTPUT_ATTRS: [
    "ai.response.text",
    "ai.response.toolCalls",
    "ai.toolCall.result",
  ],
  // `ai.usage.tokens` (singular) is what Vercel emits on embedding spans,
  // which have no completion side. Listed as a fallback after the chat
  // attributes so non-embedding Vercel spans still prefer `promptTokens`.
  INPUT_TOKENS_ATTRS: ["ai.usage.promptTokens", "ai.usage.tokens"],
  OUTPUT_TOKENS_ATTRS: ["ai.usage.completionTokens"],
  PROVIDER_ATTRS: ["ai.model.provider"],
  TOOL_NAME_ATTRS: ["ai.toolCall.name"],
  AGENT_NAME_ATTRS: ["ai.telemetry.functionId"],
  buildParams(attrs, merged) {
    for (const [srcAttr, canonicalKey] of AI_REQUEST_PARAM_MAP) {
      const val = attrs[srcAttr];
      if (val === undefined || val === null) continue;
      if (!(canonicalKey in merged)) merged[canonicalKey] = val;
    }
  },
  aggregateToolDefinitions(attrs) {
    // Vercel emits `ai.prompt.tools` on `*.doGenerate` / `*.doStream` spans
    // as a string-array (each entry is a JSON-encoded tool-definition object
    // — `{type, name, description, inputSchema, ...}`). OTel attribute
    // typing forbids nested objects, so the array-of-strings form is the
    // wire encoding. Parse each entry; keep raw on parse failure.
    const raw = attrs["ai.prompt.tools"];
    if (!Array.isArray(raw) || raw.length === 0) return null;
    const out: unknown[] = [];
    for (const entry of raw) {
      if (typeof entry === "string") {
        out.push(safeJsonParse(entry) ?? entry);
      } else {
        out.push(entry);
      }
    }
    return out.length > 0 ? out : null;
  },
  resolveObservationType(attrs) {
    const op = attrs["ai.operationId"];
    if (typeof op !== "string") return null;
    if (op === "ai.toolCall") return "TOOL";
    if (op === "ai.generateText" || op === "ai.streamText") return "AGENT";
    if (op === "ai.generateObject" || op === "ai.streamObject") return "AGENT";
    // Both the outer (`ai.embed` / `ai.embedMany`) and the inner provider
    // call (`ai.embed.doEmbed` / `ai.embedMany.doEmbed`) classify as
    // EMBEDDINGS — they carry only `ai.*` attrs (no `gen_ai.*`), so without
    // an explicit match the inner spans would fall through to core's
    // "model present ⇒ GENERATION" rule.
    if (op === "ai.embed" || op === "ai.embedMany") return "EMBEDDINGS";
    if (op === "ai.embed.doEmbed" || op === "ai.embedMany.doEmbed") return "EMBEDDINGS";
    // `.doGenerate` / `.doStream` fall through to the otelGenai adapter's
    // `gen_ai.*` handling (they always carry GenAI semconv attrs).
    return null;
  },
  resolveProvider(attrs) {
    // Only fire for Vercel-emitted spans (identified by `ai.operationId`).
    // Vercel puts dotted values like `anthropic.messages` into both
    // `ai.model.provider` and `gen_ai.system`; non-Vercel callers should
    // fall through to the canonical PROVIDER_ATTRS chain undisturbed.
    if (typeof attrs["ai.operationId"] !== "string") return null;
    return (
      normaliseProvider(attrs["ai.model.provider"]) ??
      normaliseProvider(attrs["gen_ai.system"])
    );
  },
  normalizeMessages(attrs): CanonicalMessages | null {
    // ── Input side ───────────────────────────────────────────────────────
    let input: Message[] | null = null;
    const promptMessages = attrs["ai.prompt.messages"];
    if (promptMessages !== undefined && promptMessages !== null) {
      const coerced = coerceToMessages(promptMessages);
      if (coerced && coerced.length > 0) input = coerced;
    }
    if (input === null && typeof attrs["ai.prompt"] === "string" && (attrs["ai.prompt"] as string).length > 0) {
      input = unpackAiPromptBlob(attrs["ai.prompt"] as string)
        ?? [textMessage("user", attrs["ai.prompt"] as string)];
    }
    // Tool execution span: input represents the tool invocation.
    if (input === null) {
      const args = attrs["ai.toolCall.args"];
      const toolName = attrs["ai.toolCall.name"];
      const toolCallId = typeof attrs["ai.toolCall.id"] === "string" ? (attrs["ai.toolCall.id"] as string) : null;
      if (args !== undefined && args !== null && typeof toolName === "string") {
        const parsedArgs = typeof args === "string" ? safeJsonParse(args) ?? args : args;
        input = [
          {
            role: "assistant",
            parts: [toolCallPart(toolName, parsedArgs, toolCallId)],
          },
        ];
      }
    }
    // Embedding span inputs: project `ai.value` / `ai.values` as one canonical
    // user-text message per text being embedded. Each entry in `ai.values` is
    // JSON.stringify-encoded by Vercel to fit OTel's string-array constraint;
    // unwrap when the entry parses back to a string, fall through otherwise.
    if (input === null) {
      const messages = embedInputsToMessages(attrs);
      if (messages !== null) input = messages;
    }

    // ── Output side ──────────────────────────────────────────────────────
    let output: Message[] | null = null;
    const responseText = attrs["ai.response.text"];
    if (typeof responseText === "string" && responseText.length > 0) {
      output = [textMessage("assistant", responseText)];
    }

    // Merge tool-call invocations from the assistant.
    const rawToolCalls = attrs["ai.response.toolCalls"];
    if (rawToolCalls !== undefined && rawToolCalls !== null) {
      const parts = parseVercelToolCalls(rawToolCalls);
      if (parts.length > 0) {
        if (output && output[output.length - 1].role === "assistant") {
          output[output.length - 1].parts = [
            ...output[output.length - 1].parts,
            ...parts,
          ];
        } else {
          const synthesized: Message = { role: "assistant", parts };
          output = output ? [...output, synthesized] : [synthesized];
        }
      }
    }

    // Tool execution span: output is the tool result.
    if (output === null) {
      const result = attrs["ai.toolCall.result"];
      if (result !== undefined && result !== null) {
        const toolCallId = typeof attrs["ai.toolCall.id"] === "string" ? (attrs["ai.toolCall.id"] as string) : null;
        output = [
          { role: "tool", parts: [toolCallResponsePart(result, toolCallId)] },
        ];
      }
    }

    if (input === null && output === null) return null;
    return { input, output };
  },
});

/**
 * Project Vercel embedding-span inputs (`ai.value` singular for `ai.embed`,
 * `ai.values` string-array for `ai.embedMany` / `*.doEmbed`) into canonical
 * `user`-text messages. Each entry in `ai.values` is JSON.stringify-encoded
 * by Vercel to fit OTel's string-array attribute constraint, so unwrap when
 * the entry parses back to a string and fall through to the raw value
 * otherwise.
 */
function embedInputsToMessages(
  attrs: Record<string, unknown>,
): Message[] | null {
  const value = attrs["ai.value"];
  if (typeof value === "string" && value.length > 0) {
    return [textMessage("user", value)];
  }
  const values = attrs["ai.values"];
  if (Array.isArray(values) && values.length > 0) {
    const out: Message[] = [];
    for (const entry of values) {
      if (typeof entry !== "string") {
        const text = stringifyEmbedEntry(entry);
        if (text.length > 0) out.push(textMessage("user", text));
        continue;
      }
      const parsed = safeJsonParse(entry);
      const text = typeof parsed === "string" ? parsed : entry;
      if (text.length > 0) out.push(textMessage("user", text));
    }
    return out.length > 0 ? out : null;
  }
  return null;
}

function stringifyEmbedEntry(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Vercel AI's outer agent spans (`ai.streamText` / `ai.generateText` /
 * `ai.streamObject` / `ai.generateObject`) emit the full prompt as a single
 * JSON blob in `ai.prompt` rather than indexed `ai.prompt.messages.*`. Shape:
 * `{system?: string, messages: [{role, content: ...}, ...]}`. Unpack it so
 * the system instruction becomes a leading system message and the inner
 * messages route through the OpenAI/Vercel-shape coercer (which already
 * understands `tool-call` / `tool-result` Vercel content parts).
 *
 * Returns null when the blob doesn't match the shape — caller falls back to
 * wrapping the raw string as a user-text message.
 */
function unpackAiPromptBlob(raw: string): Message[] | null {
  const parsed = safeJsonParse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.messages)) return null;
  const out: Message[] = [];
  if (typeof obj.system === "string" && obj.system.length > 0) {
    out.push(textMessage("system", obj.system));
  }
  const coerced = coerceToMessages(obj.messages);
  if (coerced) out.push(...coerced);
  return out.length > 0 ? out : null;
}

function parseVercelToolCalls(raw: unknown): ToolCallRequestPart[] {
  const parsed = typeof raw === "string" ? safeJsonParse(raw) : raw;
  if (!Array.isArray(parsed)) return [];
  const out: ToolCallRequestPart[] = [];
  for (const tc of parsed) {
    if (!tc || typeof tc !== "object") continue;
    const obj = tc as Record<string, unknown>;
    // Vercel uses { toolCallId, toolName, input } in ai.response.toolCalls
    // (camelCase, with `input` rather than `args`/`arguments`). Older shapes
    // and other emitters may use `args` or `arguments`; fall through.
    const name =
      (typeof obj.toolName === "string" ? obj.toolName : undefined) ??
      (typeof obj.name === "string" ? obj.name : undefined);
    if (!name) continue;
    const id =
      (typeof obj.toolCallId === "string" ? obj.toolCallId : undefined) ??
      (typeof obj.id === "string" ? obj.id : undefined) ??
      null;
    const args = obj.input ?? obj.args ?? obj.arguments;
    const parsedArgs = typeof args === "string" ? safeJsonParse(args) ?? args : args;
    out.push(toolCallPart(name, parsedArgs, id));
  }
  return out;
}
