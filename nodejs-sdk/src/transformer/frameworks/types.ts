/**
 * Shape of a framework adapter module.
 *
 * Each framework file exports a subset of these fields as named constants.
 * The `core` transformer concatenates the tuple fields across all adapters
 * (registry order = priority) to build the canonical alias lists, and calls
 * the optional hook functions for blob parsing, discriminator resolution,
 * indexed message unpacking, and metadata enrichment.
 */

// ── OTel GenAI v2 canonical message shape ───────────────────────────────────
// Defined verbatim from the upstream JSON schemas:
//   https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-input-messages.json
//   https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-output-messages.json
//   https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-system-instructions.json
// Each part variant has additionalProperties:true upstream — adapters may
// attach extra namespaced fields without breaking the schema.

export type Role = "system" | "developer" | "user" | "assistant" | "tool" | string;
export type Modality = "image" | "video" | "audio" | string;
export type FinishReason =
  | "stop"
  | "length"
  | "content_filter"
  | "tool_call"
  | "error"
  | string;

export type TextPart = { type: "text"; content: string; [k: string]: unknown };
export type ReasoningPart = {
  type: "reasoning";
  content: string;
  [k: string]: unknown;
};
export type ToolCallRequestPart = {
  type: "tool_call";
  name: string;
  id?: string | null;
  arguments?: unknown;
  [k: string]: unknown;
};
export type ToolCallResponsePart = {
  type: "tool_call_response";
  response: unknown;
  id?: string | null;
  [k: string]: unknown;
};
export type ServerToolCallPart = {
  type: "server_tool_call";
  name: string;
  server_tool_call: unknown;
  id?: string | null;
  [k: string]: unknown;
};
export type ServerToolCallResponsePart = {
  type: "server_tool_call_response";
  server_tool_call_response: unknown;
  id?: string | null;
  [k: string]: unknown;
};
export type BlobPart = {
  type: "blob";
  modality: Modality;
  content: string;
  mime_type?: string | null;
  [k: string]: unknown;
};
export type FilePart = {
  type: "file";
  modality: Modality;
  file_id: string;
  mime_type?: string | null;
  [k: string]: unknown;
};
export type UriPart = {
  type: "uri";
  modality: Modality;
  uri: string;
  mime_type?: string | null;
  [k: string]: unknown;
};
export type GenericPart = { type: string; [k: string]: unknown };

export type Part =
  | TextPart
  | ReasoningPart
  | ToolCallRequestPart
  | ToolCallResponsePart
  | ServerToolCallPart
  | ServerToolCallResponsePart
  | BlobPart
  | FilePart
  | UriPart
  | GenericPart;

export type Message = {
  role: Role;
  parts: Part[];
  name?: string | null;
  finish_reason?: FinishReason;
  [k: string]: unknown;
};

/**
 * Result of an adapter's `normalizeMessages` hook. `null` on either side
 * means the adapter has no canonical projection for that direction; the
 * core falls through to the next adapter or the events / text-wrap chain.
 */
export type CanonicalMessages = {
  input: Message[] | null;
  output: Message[] | null;
};

export interface FrameworkAdapter {
  readonly NAME: string;

  readonly MODEL_ATTRS: readonly string[];
  readonly PROVIDED_MODEL_ATTRS: readonly string[];
  readonly INPUT_ATTRS: readonly string[];
  readonly OUTPUT_ATTRS: readonly string[];
  readonly INPUT_TOKENS_ATTRS: readonly string[];
  readonly OUTPUT_TOKENS_ATTRS: readonly string[];
  readonly TOTAL_TOKENS_ATTRS: readonly string[];
  readonly INPUT_COST_ATTRS: readonly string[];
  readonly OUTPUT_COST_ATTRS: readonly string[];
  readonly TOTAL_COST_ATTRS: readonly string[];
  readonly SESSION_ID_ATTRS: readonly string[];
  readonly USER_ID_ATTRS: readonly string[];
  readonly TAGS_ATTRS: readonly string[];
  readonly TIME_TO_FIRST_TOKEN_ATTRS: readonly string[];
  readonly TOOL_CALLS_ATTRS: readonly string[];
  readonly TOOL_CALL_NAMES_ATTRS: readonly string[];
  readonly TOOL_DEFINITIONS_ATTRS: readonly string[];
  readonly PROVIDER_ATTRS: readonly string[];
  readonly AGENT_NAME_ATTRS: readonly string[];
  readonly AGENT_ID_ATTRS: readonly string[];
  readonly AGENT_VERSION_ATTRS: readonly string[];
  readonly TOOL_NAME_ATTRS: readonly string[];
  readonly SYSTEM_INSTRUCTIONS_ATTRS: readonly string[];
  readonly PARAMS_BLOB_ATTRS: readonly string[];
  readonly FLAT_PARAM_ATTRS: readonly string[];
  readonly ENVIRONMENT_ATTRS: readonly string[];
  readonly RELEASE_ATTRS: readonly string[];
  readonly CACHE_TOKEN_MAP: ReadonlyArray<readonly [string, string]>;

  resolveObservationType?(attrs: Record<string, unknown>): string | null;
  resolveObservationTypeFallback?(attrs: Record<string, unknown>): string | null;
  resolveProvider?(attrs: Record<string, unknown>): string | null;
  parseUsageBlobs?(attrs: Record<string, unknown>, usageDetails: Record<string, unknown>): void;
  parseCostBlobs?(attrs: Record<string, unknown>, costDetails: Record<string, unknown>): void;
  buildParams?(attrs: Record<string, unknown>, merged: Record<string, unknown>): void;
  unpackMessages?(attrs: Record<string, unknown>): [string | null, string | null];
  /**
   * Project the adapter's native input/output attributes into the OTel GenAI
   * v2 canonical shape (`Message[]` with discriminated `Part[]`). Returns
   * `null` if the adapter doesn't recognize anything in `attrs`. Per-side
   * `null` is also valid (recognized the namespace, nothing to extract).
   *
   * Distinct from `unpackMessages`: that hook returns a JSON string used by
   * the raw `input_messages_raw`/`output_messages_raw` fields.
   * `normalizeMessages` powers the canonical `input`/`output` fields and
   * shares no machinery with the raw path.
   */
  normalizeMessages?(attrs: Record<string, unknown>): CanonicalMessages | null;
  enrichMetadata?(attrs: Record<string, unknown>, metadata: Record<string, unknown>): void;
  /**
   * Aggregate `tool_definitions` from non-blob sources (e.g. indexed
   * `llm.tools.<n>.tool.json_schema` flattening). Adapters that emit
   * a single attribute should leave this unset and rely on
   * `TOOL_DEFINITIONS_ATTRS` instead. Core falls back to that single-attribute
   * path when every adapter returns `null` here.
   */
  aggregateToolDefinitions?(attrs: Record<string, unknown>): unknown[] | null;
}
