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
  INPUT_ATTRS: ["ai.prompt.messages", "ai.prompt", "ai.toolCall.args"],
  OUTPUT_ATTRS: [
    "ai.response.text",
    "ai.response.toolCalls",
    "ai.toolCall.result",
  ],
  INPUT_TOKENS_ATTRS: ["ai.usage.promptTokens"],
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
  resolveObservationType(attrs) {
    const op = attrs["ai.operationId"];
    if (typeof op !== "string") return null;
    if (op === "ai.toolCall") return "TOOL";
    if (op === "ai.generateText" || op === "ai.streamText") return "AGENT";
    if (op === "ai.generateObject" || op === "ai.streamObject") return "AGENT";
    if (op === "ai.embed" || op === "ai.embedMany") return "EMBEDDING";
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
      input = [textMessage("user", attrs["ai.prompt"] as string)];
    }
    // Tool execution span: input represents the tool invocation.
    if (input === null) {
      const args = attrs["ai.toolCall.args"];
      const toolName = attrs["ai.toolCall.name"];
      if (args !== undefined && args !== null && typeof toolName === "string") {
        const parsedArgs = typeof args === "string" ? safeJsonParse(args) ?? args : args;
        input = [
          {
            role: "assistant",
            parts: [toolCallPart(toolName, parsedArgs, null)],
          },
        ];
      }
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
        output = [
          { role: "tool", parts: [toolCallResponsePart(result, null)] },
        ];
      }
    }

    if (input === null && output === null) return null;
    return { input, output };
  },
});

function parseVercelToolCalls(raw: unknown): ToolCallRequestPart[] {
  const parsed = typeof raw === "string" ? safeJsonParse(raw) : raw;
  if (!Array.isArray(parsed)) return [];
  const out: ToolCallRequestPart[] = [];
  for (const tc of parsed) {
    if (!tc || typeof tc !== "object") continue;
    const obj = tc as Record<string, unknown>;
    // Vercel uses { toolCallId, toolName, args } (camelCase, custom keys).
    const name =
      (typeof obj.toolName === "string" ? obj.toolName : undefined) ??
      (typeof obj.name === "string" ? obj.name : undefined);
    if (!name) continue;
    const id =
      (typeof obj.toolCallId === "string" ? obj.toolCallId : undefined) ??
      (typeof obj.id === "string" ? obj.id : undefined) ??
      null;
    const args = obj.args ?? obj.arguments;
    const parsedArgs = typeof args === "string" ? safeJsonParse(args) ?? args : args;
    out.push(toolCallPart(name, parsedArgs, id));
  }
  return out;
}
