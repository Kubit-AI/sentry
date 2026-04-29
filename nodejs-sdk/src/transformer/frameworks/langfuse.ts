/**
 * Langfuse SDK v3/v4 attribute mappings.
 *
 * Langfuse serialises `usage_details` and `cost_details` as single JSON
 * strings. Model parameters likewise arrive as a JSON blob under either
 * `langfuse.observation.model.parameters` (v4) or
 * `langfuse.observation.model_parameters` (v3). Trace- and observation-level
 * metadata are exposed via dotted prefixes and can be promoted to first-level
 * metadata keys.
 */

import { cleanDiscriminator, mergeJsonBlob } from "../helpers";
import {
  coerceToMessages,
  langchainEnvelopeToCanonical,
  safeJsonParse,
  stringifyForText,
  textMessage,
  toolCallPart,
  toolCallResponsePart,
} from "../messages";
import type {
  CanonicalMessages,
  Message,
  Part,
  TextPart,
  ToolCallRequestPart,
} from "./types";
import { makeAdapter } from "./makeAdapter";

const USAGE_BLOB_ATTR = "langfuse.observation.usage_details";
const COST_BLOB_ATTR = "langfuse.observation.cost_details";
const OBSERVATION_TYPE_ATTR = "langfuse.observation.type";

const METADATA_PREFIXES = [
  "langfuse.trace.metadata.",
  "langfuse.observation.metadata.",
] as const;

// Both underscore (`prompt_id`, `prompt_name`, `prompt_version`) and dotted
// (`prompt.id`, `prompt.name`, `prompt.version`) forms have appeared across
// Langfuse SDK versions and docs; accept both.
export const COMPLETION_START_ATTRS = ["langfuse.observation.completion_start_time"] as const;
export const PROMPT_ID_ATTRS = [
  "langfuse.observation.prompt_id",
  "langfuse.observation.prompt.id",
] as const;
export const PROMPT_NAME_ATTRS = [
  "langfuse.observation.prompt_name",
  "langfuse.observation.prompt.name",
  "langfuse.prompt.name",
] as const;
export const PROMPT_VERSION_ATTRS = [
  "langfuse.observation.prompt_version",
  "langfuse.observation.prompt.version",
  "langfuse.prompt.version",
] as const;

// LangChain integrations expose richer metadata than Langfuse's first-class
// fields — they tag spans with the model provider and the resolved model
// name under `langfuse.observation.metadata.ls_*`. Surface them as
// first-class `provider` / `provided_model_name` aliases so consumers don't
// have to dig through the metadata bag.
const LS_PROVIDER_ATTR = "langfuse.observation.metadata.ls_provider";
const LS_MODEL_NAME_ATTR = "langfuse.observation.metadata.ls_model_name";
const LS_INTEGRATION_ATTR = "langfuse.observation.metadata.ls_integration";

export const adapter = makeAdapter({
  NAME: "langfuse",
  MODEL_ATTRS: ["langfuse.observation.model.name", "langfuse.observation.model"],
  PROVIDED_MODEL_ATTRS: [
    "langfuse.observation.provided_model_name",
    LS_MODEL_NAME_ATTR,
  ],
  PROVIDER_ATTRS: [LS_PROVIDER_ATTR],
  INPUT_ATTRS: ["langfuse.observation.input"],
  OUTPUT_ATTRS: ["langfuse.observation.output"],
  INPUT_TOKENS_ATTRS: ["langfuse.observation.usage_details.input"],
  OUTPUT_TOKENS_ATTRS: ["langfuse.observation.usage_details.output"],
  TOTAL_TOKENS_ATTRS: ["langfuse.observation.usage_details.total"],
  INPUT_COST_ATTRS: ["langfuse.observation.cost_details.input"],
  OUTPUT_COST_ATTRS: ["langfuse.observation.cost_details.output"],
  TOTAL_COST_ATTRS: [
    "langfuse.observation.cost_details.total",
    "langfuse.observation.total_cost",
  ],
  // Session/user resolution priority:
  //   1. `langfuse.session.id` / `langfuse.user.id` — the v3/v4 trace-level
  //      setter form (`updateActiveTrace({ sessionId, userId })`).
  //   2. `langfuse.trace.metadata.{sessionId,userId}` — caller passed them in
  //      trace-level metadata bag.
  //   3. `langfuse.observation.metadata.{sessionId,userId}` — caller passed
  //      them in observation-level metadata bag (e.g.
  //      `updateActiveObservation({ metadata: { sessionId, userId } })`).
  // The metadata-prefixed forms also remain in `metadata` via
  // `enrichMetadata` — surfacing them as session_id/user_id is additive, not
  // a replacement.
  SESSION_ID_ATTRS: [
    "langfuse.session.id",
    "langfuse.trace.metadata.sessionId",
    "langfuse.observation.metadata.sessionId",
  ],
  USER_ID_ATTRS: [
    "langfuse.user.id",
    "langfuse.trace.metadata.userId",
    "langfuse.observation.metadata.userId",
  ],
  TAGS_ATTRS: ["langfuse.trace.tags"],
  TOOL_CALLS_ATTRS: ["langfuse.observation.tool_calls"],
  TOOL_CALL_NAMES_ATTRS: ["langfuse.observation.tool_call_names"],
  TOOL_DEFINITIONS_ATTRS: ["langfuse.observation.tool_definitions"],
  ENVIRONMENT_ATTRS: ["langfuse.environment"],
  RELEASE_ATTRS: ["langfuse.release"],
  PARAMS_BLOB_ATTRS: [
    "langfuse.observation.model.parameters",
    "langfuse.observation.model_parameters",
  ],
  resolveObservationType(attrs) {
    const lf = cleanDiscriminator(attrs[OBSERVATION_TYPE_ATTR]);
    if (!lf) return null;
    if (lf === "generation") return "GENERATION";
    // Langfuse JS SDK emits `span` for LangChain wrapper observations
    // (LangGraph root, `tools`, `model_request`, `RunnableLambda`, `__start__`),
    // while the Python SDK emits `chain` for the same logical spans. Fold
    // back to CHAIN whenever the integration metadata says we're inside a
    // LangChain run, so cross-SDK observation types stay aligned.
    if (lf === "span") {
      const integ = attrs[LS_INTEGRATION_ATTR];
      if (typeof integ === "string" && integ.startsWith("langchain")) return "CHAIN";
    }
    return lf.toUpperCase();
  },
  parseUsageBlobs(attrs, usageDetails) {
    mergeJsonBlob(attrs[USAGE_BLOB_ATTR], usageDetails);
  },
  parseCostBlobs(attrs, costDetails) {
    mergeJsonBlob(attrs[COST_BLOB_ATTR], costDetails);
  },
  enrichMetadata(attrs, metadata) {
    for (const [key, value] of Object.entries(attrs)) {
      for (const prefix of METADATA_PREFIXES) {
        if (key.startsWith(prefix)) {
          const shortKey = key.slice(prefix.length);
          if (!(shortKey in metadata)) metadata[shortKey] = value;
          break;
        }
      }
    }
  },
  aggregateToolDefinitions(attrs) {
    // Langfuse-LangChain (Python) injects each tool definition as a phantom
    // `{role:"tool", content:{name, input_schema, description}}` entry inside
    // `langfuse.observation.input`. They aren't chat messages — surface them
    // here so they land in the top-level `tool_definitions` field while the
    // normalizer drops them from the canonical `input` array.
    const raw = attrs["langfuse.observation.input"];
    if (raw === undefined || raw === null) return null;
    const parsed = typeof raw === "string" ? safeJsonParse(raw) : raw;
    if (!Array.isArray(parsed)) return null;
    const defs: unknown[] = [];
    for (const m of parsed) {
      if (isToolDefinitionMessage(m)) {
        defs.push((m as Record<string, unknown>).content);
      }
    }
    return defs.length > 0 ? defs : null;
  },
  normalizeMessages(attrs): CanonicalMessages | null {
    let input: Message[] | null = null;
    let output: Message[] | null = null;

    // For TOOL spans, synthesize canonical request/response from raw args
    // + envelope-normalized output. Falls through to blobToMessages when
    // synthesis can't produce a result (e.g. no recoverable tool name).
    if (cleanDiscriminator(attrs[OBSERVATION_TYPE_ATTR]) === "tool") {
      const synth = synthesizeToolSpanMessages(attrs);
      input = synth.input;
      output = synth.output;
    }

    if (input === null) {
      input = blobToMessages(attrs["langfuse.observation.input"], "user");
    }
    if (output === null) {
      output = blobToMessages(attrs["langfuse.observation.output"], "assistant");
    }

    // Tool-call merge: `langfuse.observation.tool_calls` is a JSON array of
    // `{id, name, arguments}` (or OpenAI shape). Merge into trailing assistant
    // message of output, or synthesize one.
    const rawCalls = attrs["langfuse.observation.tool_calls"];
    if (rawCalls !== undefined && rawCalls !== null) {
      const parts = parseLangfuseToolCalls(rawCalls);
      if (parts.length > 0) {
        if (output && output[output.length - 1].role === "assistant") {
          output[output.length - 1].parts = [
            ...output[output.length - 1].parts,
            ...parts,
          ];
        } else {
          const synthesized: Message = { role: "assistant", parts };
          output = output ? [...output, synthesized] : [synthesized];
        }
      }
    }

    input = rewriteToolNameRoles(input);
    output = rewriteToolNameRoles(output);

    if (input === null && output === null) return null;
    return { input, output };
  },
});

function blobToMessages(raw: unknown, role: "user" | "assistant"): Message[] | null {
  if (raw === undefined || raw === null) return null;

  // Parse strings up front so the same pipeline handles stringified and
  // already-parsed blobs identically.
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    const p = safeJsonParse(raw);
    if (p === null) return raw.length > 0 ? [textMessage(role, raw)] : null;
    parsed = p;
  }

  // Strip phantom tool-definition entries before normalization — they're
  // surfaced via `aggregateToolDefinitions` instead.
  if (Array.isArray(parsed)) {
    const filtered = parsed.filter((m) => !isToolDefinitionMessage(m));
    parsed = filtered;
  }

  // LangChain envelope translator handles {messages:[...]}, AIMessage with
  // content:[{type:"tool_use",...}] arrays, ToolMessage with tool_call_id,
  // and the OpenAI-shape fallback for non-Serializable arrays.
  const lc = langchainEnvelopeToCanonical(parsed);
  if (lc && lc.length > 0) return lc;

  const coerced = coerceToMessages(parsed);
  if (coerced && coerced.length > 0) return coerced;

  // Single OpenAI-shape object: Langfuse Python serializes the trailing
  // AIMessage of a tool-use turn as a bare object, not in an array. Wrap
  // and retry so canonical message extraction still runs.
  if (
    parsed !== null &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    typeof (parsed as Record<string, unknown>).role === "string"
  ) {
    const wrapped = coerceToMessages([parsed]);
    if (wrapped && wrapped.length > 0) return wrapped;
  }

  // Lossy text fallback so the payload still surfaces (langfuse.observation.input
  // is intentionally opaque for non-conversational chains).
  const str = stringifyForText(raw);
  return str ? [textMessage(role, str)] : null;
}

/**
 * Drop phantom `{role:"tool", content:{name, input_schema, description}}`
 * entries that LangChain-Langfuse instrumentation injects alongside real
 * messages. They're tool *definitions*, not chat turns.
 */
function isToolDefinitionMessage(m: unknown): boolean {
  if (!m || typeof m !== "object") return false;
  const obj = m as Record<string, unknown>;
  if (obj.role !== "tool") return false;
  const c = obj.content;
  if (!c || typeof c !== "object" || Array.isArray(c)) return false;
  const cc = c as Record<string, unknown>;
  return (
    typeof cc.name === "string" &&
    cc.input_schema !== undefined &&
    cc.input_schema !== null &&
    typeof cc.input_schema === "object"
  );
}

/**
 * For `langfuse.observation.type == "tool"` spans, synthesize canonical
 * `input` (assistant `tool_call` request) and `output` (tool
 * `tool_call_response` reply) so they faithfully represent a tool invocation
 * instead of the default `role:"user"` text-wrap of raw args.
 *
 * Strategy:
 * 1. Parse the output blob and run `langchainEnvelopeToCanonical` on it.
 *    Both the JS Serializable ToolMessage envelope and the PY plain-dict
 *    `{type:"tool",...}` shape are recognized by the envelope translator
 *    (post-Fix #1), producing `[{role:"tool", name, parts:[{type:
 *    "tool_call_response", id, ...}]}]`.
 * 2. Lift `name` and the `tool_call_response.id` from the normalized
 *    output. These become the synthesized assistant tool_call's name + id,
 *    keeping input/output linked via the same id that the parent
 *    generation emitted.
 * 3. Parse args from the input blob (`safeJsonParse` first; fall back to
 *    the raw string).
 * 4. Synthesize input only when a tool name was recoverable; otherwise
 *    return `null` so the caller falls through to `blobToMessages`.
 * 5. Synthesize output fallback when the envelope didn't yield a tool
 *    message: wrap the raw output as `[{role:"tool", parts:[
 *    tool_call_response(rawOutput, null)]}]`. Mirrors the openinference
 *    adapter's `synthesizeToolSpanMessages`.
 */
function synthesizeToolSpanMessages(attrs: Record<string, unknown>): {
  input: Message[] | null;
  output: Message[] | null;
} {
  const rawOut = attrs["langfuse.observation.output"];
  if (rawOut === undefined || rawOut === null) {
    return { input: null, output: null };
  }
  const parsedOut = typeof rawOut === "string"
    ? safeJsonParse(rawOut) ?? rawOut
    : rawOut;

  let toolName: string | null = null;
  let toolCallId: string | null = null;
  let output: Message[] | null = null;

  const lcOut = langchainEnvelopeToCanonical(parsedOut);
  if (lcOut && lcOut.length > 0) {
    output = lcOut;
    const first = lcOut[0];
    if (first.role === "tool") {
      if (typeof first.name === "string") toolName = first.name;
      const part = first.parts[0];
      if (part && (part as { type?: unknown }).type === "tool_call_response") {
        const id = (part as { id?: unknown }).id;
        if (typeof id === "string") toolCallId = id;
      }
    }
  }

  // Output fallback: when envelope didn't produce a tool message but raw
  // output exists, wrap it as a tool message so consumers still get a
  // canonical response part (without an id linkage).
  if (output === null && parsedOut !== null && parsedOut !== undefined) {
    output = [{
      role: "tool",
      parts: [toolCallResponsePart(parsedOut, null)],
    }];
  }

  // Input synthesis only fires when we can name the tool.
  let input: Message[] | null = null;
  if (toolName !== null) {
    const rawIn = attrs["langfuse.observation.input"];
    let argsParsed: unknown;
    if (rawIn === undefined || rawIn === null) {
      argsParsed = undefined;
    } else if (typeof rawIn === "string") {
      argsParsed = safeJsonParse(rawIn) ?? rawIn;
    } else {
      argsParsed = rawIn;
    }
    input = [{
      role: "assistant",
      parts: [toolCallPart(toolName, argsParsed, toolCallId)],
    }];
  }

  return { input, output };
}

/**
 * The Langfuse JS LangChain integration projects a LangChain ToolMessage as
 * `{role: <tool_name>, content: <result>}` — using the tool name as the role
 * with no `tool_call_id` link. Recover the canonical `role:"tool"` +
 * `tool_call_response` part by rewriting any non-canonical string role to
 * `"tool"` and lifting the tool_call_id from a same-array assistant
 * `tool_call` part with the matching name when one is present. Standalone
 * tool-result spans (e.g. the JS `tools` CHAIN observation, which only
 * carries the result message) get the rewrite without the linkage.
 */
function rewriteToolNameRoles(messages: Message[] | null): Message[] | null {
  if (!messages || messages.length === 0) return messages;
  const canonical = new Set(["system", "developer", "user", "assistant", "tool"]);
  const nameToId = new Map<string, string | null>();
  const out: Message[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      for (const p of m.parts) {
        if ((p as { type?: unknown }).type === "tool_call") {
          const tc = p as ToolCallRequestPart;
          if (typeof tc.name === "string") {
            nameToId.set(tc.name, typeof tc.id === "string" ? tc.id : null);
          }
        }
      }
      out.push(m);
      continue;
    }
    if (!canonical.has(m.role) && typeof m.role === "string") {
      const id = nameToId.get(m.role) ?? null;
      const response =
        m.parts.length === 1 && (m.parts[0] as { type?: unknown }).type === "text"
          ? (m.parts[0] as TextPart).content
          : (m.parts as Part[]);
      out.push({
        role: "tool",
        name: m.role,
        parts: [toolCallResponsePart(response, id)],
      });
      continue;
    }
    out.push(m);
  }
  return out;
}

function parseLangfuseToolCalls(raw: unknown): ToolCallRequestPart[] {
  const parsed = typeof raw === "string" ? safeJsonParse(raw) : raw;
  if (!Array.isArray(parsed)) return [];
  const out: ToolCallRequestPart[] = [];
  for (const tc of parsed) {
    if (!tc || typeof tc !== "object") continue;
    const obj = tc as Record<string, unknown>;
    const fn = obj.function as Record<string, unknown> | undefined;
    const name =
      (typeof obj.name === "string" ? obj.name : undefined) ??
      (typeof fn?.name === "string" ? (fn.name as string) : undefined);
    if (!name) continue;
    const id = typeof obj.id === "string" ? obj.id : null;
    const rawArgs = obj.arguments ?? fn?.arguments;
    const args =
      typeof rawArgs === "string" ? safeJsonParse(rawArgs) ?? rawArgs : rawArgs;
    out.push(toolCallPart(name, args, id));
  }
  return out;
}
