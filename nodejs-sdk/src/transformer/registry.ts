/**
 * Registry of framework adapters in attribute-priority order.
 *
 * Each adapter contributes its own alias tuples; `core` concatenates them at
 * module-load time to build the canonical MODEL_ATTRS / INPUT_ATTRS / …
 * tuples. The order here determines cross-framework priority when multiple
 * emitters set the same canonical field.
 *
 * Currently shipped set (see docs/otel-mapping/README.md and the sibling
 * `frameworks/_disabled/` directory for adapters kept in the repo but excluded
 * from the published package):
 *   1. otelGenai — the standard. Most specific, most authoritative.
 *   2. generic   — short-name catch-alls (`model`, `input`, `output`).
 *   3. langfuse  — `langfuse.*` + usage/cost/params JSON blobs.
 */

import { adapter as generic } from "./frameworks/generic";
import { adapter as langfuse } from "./frameworks/langfuse";
import { adapter as otelGenai } from "./frameworks/otelGenai";
import type { FrameworkAdapter } from "./frameworks/types";

export const FRAMEWORKS: readonly FrameworkAdapter[] = [
  otelGenai,
  generic,
  langfuse,
];

/**
 * Observation-type discriminator priority. Independent of alias priority:
 * emitters that set both a vendor discriminator AND their own native attrs
 * still expect the vendor discriminator to win.
 */
export const DISCRIMINATOR_ORDER: readonly FrameworkAdapter[] = [
  langfuse,
  otelGenai,
];
