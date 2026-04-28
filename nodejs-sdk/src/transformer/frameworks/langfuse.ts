/**
 * Langfuse SDK v3/v4 attribute mappings.
 *
 * Langfuse serialises `usage_details` and `cost_details` as single JSON
 * strings. Model parameters likewise arrive as a JSON blob under either
 * `langfuse.observation.model.parameters` (v4) or
 * `langfuse.observation.model_parameters` (v3). Trace- and observation-level
 * metadata are exposed via dotted prefixes and can be promoted to first-level
 * metadata keys.
 */

import { cleanDiscriminator, mergeJsonBlob } from "../helpers";
import {
  coerceToMessages,
  safeJsonParse,
  stringifyForText,
  textMessage,
  toolCallPart,
} from "../messages";
import type { CanonicalMessages, Message, ToolCallRequestPart } from "./types";
import { makeAdapter } from "./makeAdapter";

const USAGE_BLOB_ATTR = "langfuse.observation.usage_details";
const COST_BLOB_ATTR = "langfuse.observation.cost_details";
const OBSERVATION_TYPE_ATTR = "langfuse.observation.type";

const METADATA_PREFIXES = [
  "langfuse.trace.metadata.",
  "langfuse.observation.metadata.",
] as const;

// Both underscore (`prompt_id`, `prompt_name`, `prompt_version`) and dotted
// (`prompt.id`, `prompt.name`, `prompt.version`) forms have appeared across
// Langfuse SDK versions and docs; accept both.
export const COMPLETION_START_ATTRS = ["langfuse.observation.completion_start_time"] as const;
export const PROMPT_ID_ATTRS = [
  "langfuse.observation.prompt_id",
  "langfuse.observation.prompt.id",
] as const;
export const PROMPT_NAME_ATTRS = [
  "langfuse.observation.prompt_name",
  "langfuse.observation.prompt.name",
  "langfuse.prompt.name",
] as const;
export const PROMPT_VERSION_ATTRS = [
  "langfuse.observation.prompt_version",
  "langfuse.observation.prompt.version",
  "langfuse.prompt.version",
] as const;

export const adapter = makeAdapter({
  NAME: "langfuse",
  MODEL_ATTRS: ["langfuse.observation.model.name", "langfuse.observation.model"],
  PROVIDED_MODEL_ATTRS: ["langfuse.observation.provided_model_name"],
  INPUT_ATTRS: ["langfuse.observation.input"],
  OUTPUT_ATTRS: ["langfuse.observation.output"],
  INPUT_TOKENS_ATTRS: ["langfuse.observation.usage_details.input"],
  OUTPUT_TOKENS_ATTRS: ["langfuse.observation.usage_details.output"],
  TOTAL_TOKENS_ATTRS: ["langfuse.observation.usage_details.total"],
  INPUT_COST_ATTRS: ["langfuse.observation.cost_details.input"],
  OUTPUT_COST_ATTRS: ["langfuse.observation.cost_details.output"],
  TOTAL_COST_ATTRS: [
    "langfuse.observation.cost_details.total",
    "langfuse.observation.total_cost",
  ],
  SESSION_ID_ATTRS: ["langfuse.session.id"],
  USER_ID_ATTRS: ["langfuse.user.id"],
  TAGS_ATTRS: ["langfuse.trace.tags"],
  TOOL_CALLS_ATTRS: ["langfuse.observation.tool_calls"],
  TOOL_CALL_NAMES_ATTRS: ["langfuse.observation.tool_call_names"],
  TOOL_DEFINITIONS_ATTRS: ["langfuse.observation.tool_definitions"],
  ENVIRONMENT_ATTRS: ["langfuse.environment"],
  RELEASE_ATTRS: ["langfuse.release"],
  PARAMS_BLOB_ATTRS: [
    "langfuse.observation.model.parameters",
    "langfuse.observation.model_parameters",
  ],
  resolveObservationType(attrs) {
    const lf = cleanDiscriminator(attrs[OBSERVATION_TYPE_ATTR]);
    if (!lf) return null;
    if (lf === "generation") return "GENERATION";
    return lf.toUpperCase();
  },
  parseUsageBlobs(attrs, usageDetails) {
    mergeJsonBlob(attrs[USAGE_BLOB_ATTR], usageDetails);
  },
  parseCostBlobs(attrs, costDetails) {
    mergeJsonBlob(attrs[COST_BLOB_ATTR], costDetails);
  },
  enrichMetadata(attrs, metadata) {
    for (const [key, value] of Object.entries(attrs)) {
      for (const prefix of METADATA_PREFIXES) {
        if (key.startsWith(prefix)) {
          const shortKey = key.slice(prefix.length);
          if (!(shortKey in metadata)) metadata[shortKey] = value;
          break;
        }
      }
    }
  },
  normalizeMessages(attrs): CanonicalMessages | null {
    const input = blobToMessages(attrs["langfuse.observation.input"], "user");
    let output = blobToMessages(attrs["langfuse.observation.output"], "assistant");

    // Tool-call merge: `langfuse.observation.tool_calls` is a JSON array of
    // `{id, name, arguments}` (or OpenAI shape). Merge into trailing assistant
    // message of output, or synthesize one.
    const rawCalls = attrs["langfuse.observation.tool_calls"];
    if (rawCalls !== undefined && rawCalls !== null) {
      const parts = parseLangfuseToolCalls(rawCalls);
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

    if (input === null && output === null) return null;
    return { input, output };
  },
});

function blobToMessages(raw: unknown, role: "user" | "assistant"): Message[] | null {
  if (raw === undefined || raw === null) return null;
  const coerced = coerceToMessages(raw);
  if (coerced && coerced.length > 0) return coerced;
  // Non-array JSON / plain string: lossy text wrap so the payload still
  // surfaces (langfuse.observation.input is intentionally opaque).
  const str = stringifyForText(raw);
  if (!str) return null;
  return [textMessage(role, str)];
}

function parseLangfuseToolCalls(raw: unknown): ToolCallRequestPart[] {
  const parsed = typeof raw === "string" ? safeJsonParse(raw) : raw;
  if (!Array.isArray(parsed)) return [];
  const out: ToolCallRequestPart[] = [];
  for (const tc of parsed) {
    if (!tc || typeof tc !== "object") continue;
    const obj = tc as Record<string, unknown>;
    const fn = obj.function as Record<string, unknown> | undefined;
    const name =
      (typeof obj.name === "string" ? obj.name : undefined) ??
      (typeof fn?.name === "string" ? (fn.name as string) : undefined);
    if (!name) continue;
    const id = typeof obj.id === "string" ? obj.id : null;
    const rawArgs = obj.arguments ?? fn?.arguments;
    const args =
      typeof rawArgs === "string" ? safeJsonParse(rawArgs) ?? rawArgs : rawArgs;
    out.push(toolCallPart(name, args, id));
  }
  return out;
}
