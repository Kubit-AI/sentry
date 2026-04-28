/**
 * Generic short-name aliases commonly emitted across vendors.
 *
 * Kept at its own priority tier so the ordering of `model` / `input` /
 * `output` relative to vendor-specific keys matches the pre-refactor
 * transformer behaviour verbatim.
 */

import { coerceToMessages, stringifyForText, textMessage } from "../messages";
import type { CanonicalMessages, Message } from "./types";
import { makeAdapter } from "./makeAdapter";

export const adapter = makeAdapter({
  NAME: "generic",
  MODEL_ATTRS: ["model"],
  PROVIDED_MODEL_ATTRS: ["model"],
  INPUT_ATTRS: ["input"],
  OUTPUT_ATTRS: ["output"],
  normalizeMessages(attrs): CanonicalMessages | null {
    // Last-resort wrap. `coerceToMessages` first lets a JSON-string with an
    // OpenAI-shape array still surface as structured messages even on this
    // generic path.
    const input = wrap(attrs["input"], "user");
    const output = wrap(attrs["output"], "assistant");
    if (input === null && output === null) return null;
    return { input, output };
  },
});

function wrap(val: unknown, role: "user" | "assistant"): Message[] | null {
  if (val === undefined || val === null) return null;
  const coerced = coerceToMessages(val);
  if (coerced && coerced.length > 0) return coerced;
  const str = stringifyForText(val);
  if (!str) return null;
  return [textMessage(role, str)];
}
