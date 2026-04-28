/**
 * OpenInference (Arize / Phoenix) attribute mappings.
 *
 * Uses the `llm.*` namespace rather than `gen_ai.*`. `openinference.span.kind`
 * is the authoritative span-kind discriminator. Embedding spans carry the
 * model under `embedding.model_name` rather than `llm.model_name`.
 *
 * Handles indexed message flattening: `llm.input_messages.<n>.message.role`,
 * `llm.input_messages.<n>.message.content` (and output equivalents),
 * reconstructing them into a JSON messages array.
 */

import { cleanDiscriminator } from "../helpers";
import {
  coerceToMessages,
  genericPart,
  stringifyForText,
  textMessage,
  unpackIndexedMessages,
} from "../messages";
import type { CanonicalMessages, Message, Part } from "./types";
import { makeAdapter } from "./makeAdapter";

const SPAN_KIND_ATTR = "openinference.span.kind";
const INPUT_INDEX_PREFIX = "llm.input_messages.";
const OUTPUT_INDEX_PREFIX = "llm.output_messages.";
const RETRIEVAL_DOCS_PREFIX = "retrieval.documents.";

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
    const inner = rest.slice(dotIdx + 1);
    const idx = Number(idxStr);
    if (!Number.isInteger(idx)) continue;
    if (!inner.startsWith("message.")) continue;
    const field = inner.slice("message.".length);
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

// Retriever spans encode RAG hits as `retrieval.documents.<n>.document.<field>`
// (content, id, score, metadata). Strip the constant `document.` segment and
// emit `{content, id, score, metadata}` objects ordered by index.
function unpackRetrievalDocs(attrs: Record<string, unknown>): string | null {
  const docs = new Map<number, Record<string, unknown>>();
  for (const [key, value] of Object.entries(attrs)) {
    if (!key.startsWith(RETRIEVAL_DOCS_PREFIX)) continue;
    const rest = key.slice(RETRIEVAL_DOCS_PREFIX.length);
    const dotIdx = rest.indexOf(".");
    if (dotIdx === -1) continue;
    const idx = Number(rest.slice(0, dotIdx));
    if (!Number.isInteger(idx)) continue;
    let inner = rest.slice(dotIdx + 1);
    if (inner.startsWith("document.")) inner = inner.slice("document.".length);
    let doc = docs.get(idx);
    if (!doc) {
      doc = {};
      docs.set(idx, doc);
    }
    doc[inner] = value;
  }
  if (docs.size === 0) return null;
  const ordered = [...docs.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, d]) => d);
  return JSON.stringify(ordered);
}

export const adapter = makeAdapter({
  NAME: "openinference",
  MODEL_ATTRS: ["llm.model_name", "llm.response.model", "embedding.model_name"],
  PROVIDED_MODEL_ATTRS: ["llm.request.model"],
  INPUT_ATTRS: ["llm.input_messages", "llm.prompts", "input.value"],
  OUTPUT_ATTRS: ["llm.output_messages", "llm.completions", "output.value"],
  INPUT_TOKENS_ATTRS: ["llm.token_count.prompt", "llm.usage.prompt_tokens"],
  OUTPUT_TOKENS_ATTRS: ["llm.token_count.completion", "llm.usage.completion_tokens"],
  TOTAL_TOKENS_ATTRS: ["llm.token_count.total", "llm.usage.total_tokens"],
  INPUT_COST_ATTRS: ["llm.cost.prompt"],
  OUTPUT_COST_ATTRS: ["llm.cost.completion"],
  TOTAL_COST_ATTRS: ["llm.cost.total"],
  TAGS_ATTRS: ["tag.tags"],
  TIME_TO_FIRST_TOKEN_ATTRS: ["llm.time_to_first_token"],
  PROVIDER_ATTRS: ["llm.system", "llm.provider"],
  CACHE_TOKEN_MAP: [
    ["llm.token_count.prompt_details.cache_read", "cache_read_input"],
    ["llm.token_count.prompt_details.cache_write", "cache_creation_input"],
    ["llm.token_count.completion_details.reasoning", "completion_reasoning"],
  ],
  PARAMS_BLOB_ATTRS: ["llm.invocation_parameters"],
  resolveObservationType(attrs) {
    const oi = cleanDiscriminator(attrs[SPAN_KIND_ATTR]);
    if (!oi || oi === "unknown") return null;
    if (oi === "llm") return "GENERATION";
    return oi.toUpperCase();
  },
  unpackMessages(attrs) {
    return [
      unpackIndexed(attrs, INPUT_INDEX_PREFIX),
      unpackIndexed(attrs, OUTPUT_INDEX_PREFIX) ?? unpackRetrievalDocs(attrs),
    ];
  },
  normalizeMessages(attrs): CanonicalMessages | null {
    const indexedIn = unpackIndexedMessages(attrs, INPUT_INDEX_PREFIX, "message.");
    const indexedOut = unpackIndexedMessages(attrs, OUTPUT_INDEX_PREFIX, "message.");

    let input = indexedIn ?? blobToMessages(attrs["llm.input_messages"], "user")
      ?? blobToMessages(attrs["llm.prompts"], "user")
      ?? blobToMessages(attrs["input.value"], "user");

    let output = indexedOut ?? blobToMessages(attrs["llm.output_messages"], "assistant")
      ?? blobToMessages(attrs["llm.completions"], "assistant")
      ?? blobToMessages(attrs["output.value"], "assistant");

    // Retriever-span fallback: only on output side, only when nothing else
    // produced output messages. Encodes `retrieval.documents.<i>.document.*`
    // as a single tool-role message holding one GenericPart per document.
    if (output === null) {
      const docMsg = retrievalDocsToMessage(attrs);
      if (docMsg) output = [docMsg];
    }

    if (input === null && output === null) return null;
    return { input, output };
  },
});

function blobToMessages(raw: unknown, role: "user" | "assistant"): Message[] | null {
  if (raw === undefined || raw === null) return null;
  const coerced = coerceToMessages(raw);
  if (coerced && coerced.length > 0) return coerced;
  const str = stringifyForText(raw);
  if (!str) return null;
  return [textMessage(role, str)];
}

function retrievalDocsToMessage(attrs: Record<string, unknown>): Message | null {
  const buckets = new Map<number, Record<string, unknown>>();
  for (const [key, value] of Object.entries(attrs)) {
    if (!key.startsWith(RETRIEVAL_DOCS_PREFIX)) continue;
    const rest = key.slice(RETRIEVAL_DOCS_PREFIX.length);
    const dot = rest.indexOf(".");
    if (dot === -1) continue;
    const idx = Number(rest.slice(0, dot));
    if (!Number.isInteger(idx)) continue;
    let inner = rest.slice(dot + 1);
    if (inner.startsWith("document.")) inner = inner.slice("document.".length);
    let bucket = buckets.get(idx);
    if (!bucket) {
      bucket = {};
      buckets.set(idx, bucket);
    }
    bucket[inner] = value;
  }
  if (buckets.size === 0) return null;
  const parts: Part[] = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, b]) => genericPart("retrieval_document", b));
  return { role: "tool", parts };
}
