/**
 * Shape of a framework adapter module.
 *
 * Each framework file exports a subset of these fields as named constants.
 * The `core` transformer concatenates the tuple fields across all adapters
 * (registry order = priority) to build the canonical alias lists, and calls
 * the optional hook functions for blob parsing, discriminator resolution,
 * indexed message unpacking, and metadata enrichment.
 */
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
  enrichMetadata?(attrs: Record<string, unknown>, metadata: Record<string, unknown>): void;
}
