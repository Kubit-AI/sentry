/**
 * OpenLLMetry / Traceloop attribute mappings.
 *
 * Traceloop emits the underscore cache-token variant (distinct from the
 * dot-separated OTel semconv variant), exposes trace-wide metadata under
 * `traceloop.association.properties.*`, and uses `traceloop.span.kind` as
 * its span-kind discriminator. Provides the `llm.request.type` fallback for
 * operation-name resolution and unpacks indexed `gen_ai.prompt.<n>.*` /
 * `gen_ai.completion.<n>.*` conversational attrs.
 */

import { cleanDiscriminator } from "../helpers";
import {
  coerceToMessages,
  langchainEnvelopeToCanonical,
  unpackIndexedMessages,
} from "../messages";
import type { CanonicalMessages, Message } from "./types";
import { makeAdapter } from "./makeAdapter";

const SPAN_KIND_ATTR = "traceloop.span.kind";
const LLM_REQUEST_TYPE_ATTR = "llm.request.type";
const PROMPT_INDEX_PREFIX = "gen_ai.prompt.";
const COMPLETION_INDEX_PREFIX = "gen_ai.completion.";

const LLM_REQUEST_TYPE_MAP: Record<string, string> = {
  chat: "GENERATION",
  completion: "GENERATION",
  embedding: "EMBEDDINGS",
  rerank: "WORKFLOW",
};

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
    const idxStr = rest.slice(0, dotIdx);
    const field = rest.slice(dotIdx + 1);
    const idx = Number(idxStr);
    if (!Number.isInteger(idx)) continue;
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
  NAME: "traceloop",
  // OpenLLMetry's @workflow / @task decorators emit raw JSON payloads here.
  INPUT_ATTRS: ["traceloop.entity.input"],
  OUTPUT_ATTRS: ["traceloop.entity.output"],
  SESSION_ID_ATTRS: ["traceloop.association.properties.session_id"],
  USER_ID_ATTRS: ["traceloop.association.properties.user_id"],
  TAGS_ATTRS: ["traceloop.association.properties.tags"],
  CACHE_TOKEN_MAP: [
    ["gen_ai.usage.cache_read_input_tokens", "cache_read_input"],
    ["gen_ai.usage.cache_creation_input_tokens", "cache_creation_input"],
  ],
  resolveObservationType(attrs) {
    const tl = cleanDiscriminator(attrs[SPAN_KIND_ATTR]);
    if (tl) return tl.toUpperCase();
    return null;
  },
  // `llm.request.type` is a last-resort fallback: it must lose to the
  // standard `gen_ai.operation.name`, so it lives on the fallback pass
  // rather than in the primary discriminator chain.
  resolveObservationTypeFallback(attrs) {
    const req = cleanDiscriminator(attrs[LLM_REQUEST_TYPE_ATTR]);
    if (!req) return null;
    return LLM_REQUEST_TYPE_MAP[req] ?? req.toUpperCase();
  },
  unpackMessages(attrs) {
    return [
      unpackIndexed(attrs, PROMPT_INDEX_PREFIX),
      unpackIndexed(attrs, COMPLETION_INDEX_PREFIX),
    ];
  },
  normalizeMessages(attrs): CanonicalMessages | null {
    const indexedIn = unpackIndexedMessages(attrs, PROMPT_INDEX_PREFIX, "");
    const indexedOut = unpackIndexedMessages(attrs, COMPLETION_INDEX_PREFIX, "");

    const input = indexedIn ?? entityToMessages(attrs["traceloop.entity.input"]);
    const output = indexedOut ?? entityToMessages(attrs["traceloop.entity.output"]);

    if (input === null && output === null) return null;
    return { input, output };
  },
});

/**
 * Translate a `traceloop.entity.input` / `traceloop.entity.output` JSON blob
 * into canonical messages. The blob is OpenLLMetry's opaque
 * `@workflow`/`@task` decorator payload; sometimes it carries real messages
 * (LangGraph workflow input/output: `{inputs|outputs: {messages: [...]}}`),
 * sometimes it's an arbitrary entity I/O record (`{input_str, tags, metadata}`).
 * Return canonical only when we can extract a real message array — never
 * synthesize a fake `[{role:user, parts:[text:<blob>]}]` envelope, which would
 * misrepresent a non-conversational entity blob as a chat message.
 */
function entityToMessages(raw: unknown): Message[] | null {
  if (raw === undefined || raw === null) return null;
  const coerced = coerceToMessages(raw);
  if (coerced && coerced.length > 0) return coerced;
  const lc = langchainEnvelopeToCanonical(raw);
  if (lc && lc.length > 0) return lc;
  return null;
}
