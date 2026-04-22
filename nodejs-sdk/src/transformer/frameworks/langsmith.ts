/**
 * LangSmith attribute mappings.
 *
 * Mixes modern `gen_ai.*` keys with its own `langsmith.*` namespace.
 * Token-detail JSON blobs (`gen_ai.usage.input_token_details`,
 * `gen_ai.usage.output_token_details`) are parsed into `usage_details` so
 * cache/audio/reasoning counts land alongside input/output.
 */

import { cleanDiscriminator, mergeJsonBlob } from "../helpers";
import { makeAdapter } from "./makeAdapter";

const SPAN_KIND_ATTR = "langsmith.span.kind";
const USAGE_DETAIL_BLOB_ATTRS = [
  "gen_ai.usage.input_token_details",
  "gen_ai.usage.output_token_details",
] as const;

export const adapter = makeAdapter({
  NAME: "langsmith",
  SESSION_ID_ATTRS: ["langsmith.trace.session_id"],
  TAGS_ATTRS: ["langsmith.span.tags"],
  resolveObservationType(attrs) {
    const ls = cleanDiscriminator(attrs[SPAN_KIND_ATTR]);
    if (!ls) return null;
    if (ls === "llm") return "GENERATION";
    return ls.toUpperCase();
  },
  parseUsageBlobs(attrs, usageDetails) {
    for (const attr of USAGE_DETAIL_BLOB_ATTRS) {
      mergeJsonBlob(attrs[attr], usageDetails);
    }
  },
});
