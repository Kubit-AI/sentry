/**
 * OpenTelemetry GenAI semantic-convention attribute mappings.
 *
 * The authoritative standard. Covers both modern (2025+) `gen_ai.input.messages`
 * array form and the legacy `gen_ai.prompt`/`gen_ai.completion` indexed form
 * still emitted by several vendors.
 *
 * Also hosts the `gen_ai.agent.*` and `gen_ai.tool.*` families used by
 * OpenAI-Agents instrumentation, and `gen_ai.system_instructions` emitted by
 * Logfire v2.
 */

import { cleanDiscriminator } from "../helpers";
import {
  coerceToMessages,
  safeJsonParse,
  textMessage,
  toolCallPart,
} from "../messages";
import type {
  CanonicalMessages,
  Message,
  ToolCallRequestPart,
} from "./types";
import { makeAdapter } from "./makeAdapter";

const FLAT_PARAM_ATTRS = [
  "gen_ai.request.temperature",
  "gen_ai.request.top_p",
  "gen_ai.request.top_k",
  "gen_ai.request.max_tokens",
  "gen_ai.request.frequency_penalty",
  "gen_ai.request.presence_penalty",
  "gen_ai.request.seed",
  "gen_ai.request.stop_sequences",
  "gen_ai.request.choice.count",
  "gen_ai.request.thinking_budget_tokens",
  "gen_ai.request.thinking_type",
] as const;

const OPERATION_NAME_ATTR = "gen_ai.operation.name";
const GENERATION_OPS = new Set(["chat", "text_completion", "generate_content"]);

export const adapter = makeAdapter({
  NAME: "otel_genai",
  MODEL_ATTRS: ["gen_ai.response.model", "gen_ai.request.model"],
  PROVIDED_MODEL_ATTRS: ["gen_ai.request.model"],
  INPUT_ATTRS: [
    "gen_ai.input.messages",
    "gen_ai.prompt",
    "gen_ai.content.prompt",
  ],
  OUTPUT_ATTRS: [
    "gen_ai.output.messages",
    "gen_ai.completion",
    "gen_ai.content.completion",
  ],
  INPUT_TOKENS_ATTRS: ["gen_ai.usage.input_tokens", "gen_ai.usage.prompt_tokens"],
  OUTPUT_TOKENS_ATTRS: ["gen_ai.usage.output_tokens", "gen_ai.usage.completion_tokens"],
  TOTAL_TOKENS_ATTRS: ["gen_ai.usage.total_tokens"],
  INPUT_COST_ATTRS: ["gen_ai.usage.input_cost", "gen_ai.usage.cost.prompt"],
  OUTPUT_COST_ATTRS: ["gen_ai.usage.output_cost", "gen_ai.usage.cost.completion"],
  TOTAL_COST_ATTRS: [
    "gen_ai.usage.cost",
    "gen_ai.usage.total_cost",
    "gen_ai.usage.cost.total",
  ],
  SESSION_ID_ATTRS: ["session.id", "gen_ai.conversation.id"],
  USER_ID_ATTRS: ["enduser.id", "user.id"],
  // OTel GenAI semconv emits TTFT in seconds (float). Core converts to ms.
  TIME_TO_FIRST_TOKEN_SECONDS_ATTRS: ["gen_ai.response.time_to_first_chunk"],
  TOOL_CALLS_ATTRS: ["gen_ai.tool.calls"],
  TOOL_CALL_NAMES_ATTRS: ["gen_ai.tool.call_names"],
  TOOL_DEFINITIONS_ATTRS: ["gen_ai.tool.definitions"],
  PROVIDER_ATTRS: ["gen_ai.provider.name", "gen_ai.system"],
  AGENT_NAME_ATTRS: ["gen_ai.agent.name"],
  AGENT_ID_ATTRS: ["gen_ai.agent.id"],
  AGENT_VERSION_ATTRS: ["gen_ai.agent.version"],
  TOOL_NAME_ATTRS: ["gen_ai.tool.name"],
  SYSTEM_INSTRUCTIONS_ATTRS: ["gen_ai.system_instructions"],
  PARAMS_BLOB_ATTRS: ["gen_ai.request.model_parameters"],
  FLAT_PARAM_ATTRS,
  CACHE_TOKEN_MAP: [
    ["gen_ai.usage.cache_read.input_tokens", "cache_read_input"],
    ["gen_ai.usage.cache_creation.input_tokens", "cache_creation_input"],
  ],
  resolveObservationType(attrs) {
    const op = cleanDiscriminator(attrs[OPERATION_NAME_ATTR]);
    if (!op) return null;
    if (GENERATION_OPS.has(op)) return "GENERATION";
    if (op === "embedding" || op === "embeddings") return "EMBEDDINGS";
    if (op === "execute_tool") return "TOOL";
    return op.toUpperCase();
  },
  buildParams(attrs, merged) {
    for (const attr of FLAT_PARAM_ATTRS) {
      const val = attrs[attr];
      if (val === undefined || val === null) continue;
      const key = attr.slice("gen_ai.request.".length);
      if (!(key in merged)) merged[key] = val;
    }
  },
  normalizeMessages(attrs): CanonicalMessages | null {
    const input = canonicalizeSide(
      attrs["gen_ai.input.messages"],
      attrs["gen_ai.prompt"] ?? attrs["gen_ai.content.prompt"],
      "user",
    );
    let output = canonicalizeSide(
      attrs["gen_ai.output.messages"],
      attrs["gen_ai.completion"] ?? attrs["gen_ai.content.completion"],
      "assistant",
    );
    output = mergeToolCallsIntoOutput(output, attrs["gen_ai.tool.calls"]);
    if (input === null && output === null) return null;
    return { input, output };
  },
});

function canonicalizeSide(
  messagesAttr: unknown,
  textAttr: unknown,
  textRole: "user" | "assistant",
): Message[] | null {
  if (messagesAttr !== undefined && messagesAttr !== null) {
    const coerced = coerceToMessages(messagesAttr);
    if (coerced && coerced.length > 0) return coerced;
  }
  if (typeof textAttr === "string" && textAttr.length > 0) {
    return [textMessage(textRole, textAttr)];
  }
  return null;
}

/**
 * If `gen_ai.tool.calls` is present (JSON string of `[{id, name, arguments}]`
 * or OpenAI-shape `[{id, type, function:{name, arguments}}]`), append them as
 * `ToolCallRequestPart`s onto the trailing assistant message. Synthesizes an
 * assistant message if none exists yet.
 */
function mergeToolCallsIntoOutput(
  output: Message[] | null,
  rawToolCalls: unknown,
): Message[] | null {
  if (rawToolCalls === undefined || rawToolCalls === null) return output;
  const parsed =
    typeof rawToolCalls === "string"
      ? safeJsonParse(rawToolCalls)
      : rawToolCalls;
  if (!Array.isArray(parsed) || parsed.length === 0) return output;

  const parts: ToolCallRequestPart[] = [];
  for (const tc of parsed) {
    if (!tc || typeof tc !== "object") continue;
    const obj = tc as Record<string, unknown>;
    const fn = obj.function as Record<string, unknown> | undefined;
    const name =
      (typeof obj.name === "string" ? obj.name : undefined) ??
      (typeof fn?.name === "string" ? (fn.name as string) : undefined);
    if (!name) continue;
    const rawArgs = obj.arguments ?? fn?.arguments;
    const args =
      typeof rawArgs === "string" ? safeJsonParse(rawArgs) ?? rawArgs : rawArgs;
    parts.push(
      toolCallPart(
        name,
        args,
        typeof obj.id === "string" ? obj.id : null,
      ),
    );
  }
  if (parts.length === 0) return output;

  if (output && output.length > 0) {
    const last = output[output.length - 1];
    if (last.role === "assistant") {
      last.parts = [...last.parts, ...parts];
      return output;
    }
  }
  const synthesized: Message = { role: "assistant", parts };
  return output ? [...output, synthesized] : [synthesized];
}
