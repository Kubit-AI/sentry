/**
 * Logfire / Pydantic AI attribute mappings.
 *
 * Logfire is built natively on OTel GenAI semconv, so the bulk of its spans
 * land through `otelGenai`. This module adds `logfire.tags` and
 * `pydantic_ai.all_messages` for multi-agent conversation-state capture.
 */

import { pydanticAIEnvelopeToCanonical } from "../messages";
import type { CanonicalMessages } from "./types";
import { makeAdapter } from "./makeAdapter";

export const adapter = makeAdapter({
  NAME: "logfire",
  INPUT_ATTRS: ["pydantic_ai.all_messages"],
  TAGS_ATTRS: ["logfire.tags"],
  normalizeMessages(attrs): CanonicalMessages | null {
    const raw = attrs["pydantic_ai.all_messages"];
    if (raw === undefined || raw === null) return null;
    const result = pydanticAIEnvelopeToCanonical(raw);
    if (result.input === null && result.output === null) return null;
    return result;
  },
});
