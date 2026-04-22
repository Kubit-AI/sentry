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
  TIME_TO_FIRST_TOKEN_ATTRS: ["gen_ai.usage.time_to_first_token"],
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
    if (op === "embedding") return "EMBEDDING";
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
});
