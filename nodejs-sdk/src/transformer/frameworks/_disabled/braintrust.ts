/**
 * Braintrust OTel-compat attribute mappings.
 *
 * Braintrust serialises nested payloads as JSON strings
 * (`braintrust.input_json`, `braintrust.output_json`) to bypass OTel
 * array-flattening limits, and exposes custom metrics under
 * `braintrust.metrics.<key>`. The span-kind discriminator is
 * `span_attributes.type`.
 */

import { cleanDiscriminator, safeFloat } from "../../helpers";
import { makeAdapter } from "../makeAdapter";

// Some emitters namespace the discriminator under `braintrust.` per OTel
// attribute-naming conventions; native Braintrust keeps it unprefixed.
// Accept both, preferring the namespaced form if present.
const SPAN_TYPE_ATTRS = [
  "braintrust.span_attributes.type",
  "span_attributes.type",
] as const;
const METRICS_PREFIX = "braintrust.metrics.";
const INPUT_INDEX_PREFIX = "braintrust.input.";
const OUTPUT_INDEX_PREFIX = "braintrust.output.";
const METADATA_PREFIX = "braintrust.metadata.";
const SCORES_ATTR = "braintrust.scores";

function unpackIndexed(
  attrs: Record<string, unknown>,
  prefix: string,
): string | null {
  const messages = new Map<number, Record<string, unknown>>();
  for (const [key, value] of Object.entries(attrs)) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const dotIdx = rest.indexOf(".");
    if (dotIdx === -1) continue;
    const idx = Number(rest.slice(0, dotIdx));
    if (!Number.isInteger(idx)) continue;
    const field = rest.slice(dotIdx + 1);
    let msg = messages.get(idx);
    if (!msg) {
      msg = {};
      messages.set(idx, msg);
    }
    msg[field] = value;
  }
  if (messages.size === 0) return null;
  const ordered = [...messages.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, msg]) => msg);
  return JSON.stringify(ordered);
}

export const adapter = makeAdapter({
  NAME: "braintrust",
  // JSON-serialised payloads — native + translation targets.
  INPUT_ATTRS: ["braintrust.input_json", "gen_ai.prompt_json"],
  OUTPUT_ATTRS: ["braintrust.output_json", "gen_ai.completion_json"],
  resolveObservationType(attrs) {
    for (const key of SPAN_TYPE_ATTRS) {
      const bt = cleanDiscriminator(attrs[key]);
      if (!bt) continue;
      if (bt === "llm") return "GENERATION";
      return bt.toUpperCase();
    }
    return null;
  },
  unpackMessages(attrs) {
    return [
      unpackIndexed(attrs, INPUT_INDEX_PREFIX),
      unpackIndexed(attrs, OUTPUT_INDEX_PREFIX),
    ];
  },
  parseUsageBlobs(attrs, usageDetails) {
    for (const [key, value] of Object.entries(attrs)) {
      if (!key.startsWith(METRICS_PREFIX)) continue;
      const metricKey = key.slice(METRICS_PREFIX.length);
      if (metricKey in usageDetails) continue;
      const parsed = safeFloat(value);
      if (parsed === null) continue;
      // Preserve integer source values.
      usageDetails[metricKey] =
        Number.isInteger(value) && typeof value === "number" ? value : parsed;
    }
  },
  enrichMetadata(attrs, metadata) {
    for (const [key, value] of Object.entries(attrs)) {
      if (!key.startsWith(METADATA_PREFIX)) continue;
      const shortKey = key.slice(METADATA_PREFIX.length);
      if (!(shortKey in metadata)) metadata[shortKey] = value;
    }
    const scores = attrs[SCORES_ATTR];
    if (scores === undefined || scores === null || "scores" in metadata) return;
    if (typeof scores === "string") {
      try {
        metadata.scores = JSON.parse(scores);
      } catch {
        metadata.scores = scores;
      }
    } else {
      metadata.scores = scores;
    }
  },
});
