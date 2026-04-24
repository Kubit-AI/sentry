/**
 * Vercel AI SDK (`ai.*` namespace) attribute mappings.
 *
 * Vercel emits its own `ai.*` telemetry that is incompatible with native
 * GenAI visualisers. The `ai-sdk-otel-adapter` translates these to `gen_ai.*`
 * at the Node layer, but apps that ship raw Vercel telemetry without the
 * adapter still reach us. This module maps the raw keys and includes
 * provider normalisation (e.g. `amazon-bedrock.*` → `aws_bedrock`).
 */

import { makeAdapter } from "../makeAdapter";

const AI_REQUEST_PARAM_MAP: ReadonlyArray<readonly [string, string]> = [
  ["ai.request.temperature", "temperature"],
  ["ai.request.topP", "top_p"],
  ["ai.request.topK", "top_k"],
  ["ai.request.maxTokens", "max_tokens"],
  ["ai.request.frequencyPenalty", "frequency_penalty"],
  ["ai.request.presencePenalty", "presence_penalty"],
  ["ai.request.seed", "seed"],
  ["ai.request.stopSequences", "stop_sequences"],
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
 * emits values like `openai.chat`, `amazon-bedrock.claude-3-5`. We take the
 * portion before the first `.` and map it to the OTel `gen_ai.system`
 * convention. Unknown prefixes pass through verbatim.
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
  INPUT_ATTRS: ["ai.prompt"],
  OUTPUT_ATTRS: ["ai.response"],
  INPUT_TOKENS_ATTRS: ["ai.usage.promptTokens"],
  OUTPUT_TOKENS_ATTRS: ["ai.usage.completionTokens"],
  PROVIDER_ATTRS: ["ai.model.provider"],
  buildParams(attrs, merged) {
    for (const [srcAttr, canonicalKey] of AI_REQUEST_PARAM_MAP) {
      const val = attrs[srcAttr];
      if (val === undefined || val === null) continue;
      if (!(canonicalKey in merged)) merged[canonicalKey] = val;
    }
  },
});
