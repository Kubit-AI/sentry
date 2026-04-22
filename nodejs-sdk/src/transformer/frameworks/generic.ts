/**
 * Generic short-name aliases commonly emitted across vendors.
 *
 * Kept at its own priority tier so the ordering of `model` / `input` /
 * `output` relative to vendor-specific keys matches the pre-refactor
 * transformer behaviour verbatim.
 */

import { makeAdapter } from "./makeAdapter";

export const adapter = makeAdapter({
  NAME: "generic",
  MODEL_ATTRS: ["model"],
  PROVIDED_MODEL_ATTRS: ["model"],
  INPUT_ATTRS: ["input"],
  OUTPUT_ATTRS: ["output"],
});
