/**
 * Registry of framework adapters in attribute-priority order.
 *
 * Each adapter contributes its own alias tuples; `core` concatenates them at
 * module-load time to build the canonical MODEL_ATTRS / INPUT_ATTRS / …
 * tuples. The order here determines cross-framework priority when multiple
 * emitters set the same canonical field.
 *
 * Ordering rationale:
 *   1. otelGenai     — the standard. Most specific, most authoritative.
 *   2. openinference — large installed base (Arize Phoenix) `llm.*` namespace.
 *   3. generic       — short-name catch-alls (`model`, `input`, `output`)
 *                      kept between OI and Langfuse to preserve pre-refactor priority.
 *   4. langsmith     — `langsmith.*` + token-detail JSON blobs.
 *   5. langfuse      — `langfuse.*` + usage/cost/params JSON blobs.
 *   6. braintrust    — `braintrust.*` JSON payloads + metrics.
 *   7. traceloop     — OpenLLMetry + underscore cache + indexed prompts.
 *   8. vercelAi      — raw `ai.*` (apps without the ai-sdk-otel-adapter).
 *   9. openaiAgents  — reserved slot; agent keys live on `otelGenai`.
 *   10. logfire      — `logfire.tags` + `pydantic_ai.all_messages`.
 */

import { adapter as braintrust } from "./frameworks/braintrust";
import { adapter as generic } from "./frameworks/generic";
import { adapter as langfuse } from "./frameworks/langfuse";
import { adapter as langsmith } from "./frameworks/langsmith";
import { adapter as logfire } from "./frameworks/logfire";
import { adapter as openaiAgents } from "./frameworks/openaiAgents";
import { adapter as openinference } from "./frameworks/openinference";
import { adapter as otelGenai } from "./frameworks/otelGenai";
import { adapter as traceloop } from "./frameworks/traceloop";
import type { FrameworkAdapter } from "./frameworks/types";
import { adapter as vercelAi } from "./frameworks/vercelAi";

export const FRAMEWORKS: readonly FrameworkAdapter[] = [
  otelGenai,
  openinference,
  generic,
  langsmith,
  langfuse,
  braintrust,
  traceloop,
  vercelAi,
  openaiAgents,
  logfire,
];

/**
 * Observation-type discriminator priority. Independent of alias priority:
 * emitters that set both a vendor discriminator AND their own native attrs
 * still expect the vendor discriminator to win. Langfuse and Vercel keep
 * top priority (explicit user intent / `ai.operationId`); native vendor
 * discriminators follow; OTel GenAI's `gen_ai.operation.name` is the
 * standards fallback.
 */
export const DISCRIMINATOR_ORDER: readonly FrameworkAdapter[] = [
  langfuse,
  vercelAi,
  openinference,
  langsmith,
  braintrust,
  traceloop,
  otelGenai,
];
