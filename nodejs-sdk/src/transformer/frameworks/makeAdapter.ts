import type { FrameworkAdapter } from "./types";

type AdapterOverrides = Partial<FrameworkAdapter> & { readonly NAME: string };

const EMPTY: readonly string[] = [];
const EMPTY_PAIRS: ReadonlyArray<readonly [string, string]> = [];

/**
 * Build a FrameworkAdapter with defaults for all tuple fields. Callers only
 * need to specify the attribute lists and hooks their framework actually
 * contributes — everything else defaults to an empty array.
 */
export function makeAdapter(overrides: AdapterOverrides): FrameworkAdapter {
  return {
    NAME: overrides.NAME,
    MODEL_ATTRS: overrides.MODEL_ATTRS ?? EMPTY,
    PROVIDED_MODEL_ATTRS: overrides.PROVIDED_MODEL_ATTRS ?? EMPTY,
    INPUT_ATTRS: overrides.INPUT_ATTRS ?? EMPTY,
    OUTPUT_ATTRS: overrides.OUTPUT_ATTRS ?? EMPTY,
    INPUT_TOKENS_ATTRS: overrides.INPUT_TOKENS_ATTRS ?? EMPTY,
    OUTPUT_TOKENS_ATTRS: overrides.OUTPUT_TOKENS_ATTRS ?? EMPTY,
    TOTAL_TOKENS_ATTRS: overrides.TOTAL_TOKENS_ATTRS ?? EMPTY,
    INPUT_COST_ATTRS: overrides.INPUT_COST_ATTRS ?? EMPTY,
    OUTPUT_COST_ATTRS: overrides.OUTPUT_COST_ATTRS ?? EMPTY,
    TOTAL_COST_ATTRS: overrides.TOTAL_COST_ATTRS ?? EMPTY,
    SESSION_ID_ATTRS: overrides.SESSION_ID_ATTRS ?? EMPTY,
    USER_ID_ATTRS: overrides.USER_ID_ATTRS ?? EMPTY,
    TAGS_ATTRS: overrides.TAGS_ATTRS ?? EMPTY,
    TIME_TO_FIRST_TOKEN_ATTRS: overrides.TIME_TO_FIRST_TOKEN_ATTRS ?? EMPTY,
    TOOL_CALLS_ATTRS: overrides.TOOL_CALLS_ATTRS ?? EMPTY,
    TOOL_CALL_NAMES_ATTRS: overrides.TOOL_CALL_NAMES_ATTRS ?? EMPTY,
    TOOL_DEFINITIONS_ATTRS: overrides.TOOL_DEFINITIONS_ATTRS ?? EMPTY,
    PROVIDER_ATTRS: overrides.PROVIDER_ATTRS ?? EMPTY,
    AGENT_NAME_ATTRS: overrides.AGENT_NAME_ATTRS ?? EMPTY,
    AGENT_ID_ATTRS: overrides.AGENT_ID_ATTRS ?? EMPTY,
    AGENT_VERSION_ATTRS: overrides.AGENT_VERSION_ATTRS ?? EMPTY,
    TOOL_NAME_ATTRS: overrides.TOOL_NAME_ATTRS ?? EMPTY,
    SYSTEM_INSTRUCTIONS_ATTRS: overrides.SYSTEM_INSTRUCTIONS_ATTRS ?? EMPTY,
    PARAMS_BLOB_ATTRS: overrides.PARAMS_BLOB_ATTRS ?? EMPTY,
    FLAT_PARAM_ATTRS: overrides.FLAT_PARAM_ATTRS ?? EMPTY,
    ENVIRONMENT_ATTRS: overrides.ENVIRONMENT_ATTRS ?? EMPTY,
    RELEASE_ATTRS: overrides.RELEASE_ATTRS ?? EMPTY,
    CACHE_TOKEN_MAP: overrides.CACHE_TOKEN_MAP ?? EMPTY_PAIRS,
    resolveObservationType: overrides.resolveObservationType,
    resolveObservationTypeFallback: overrides.resolveObservationTypeFallback,
    resolveProvider: overrides.resolveProvider,
    parseUsageBlobs: overrides.parseUsageBlobs,
    parseCostBlobs: overrides.parseCostBlobs,
    buildParams: overrides.buildParams,
    unpackMessages: overrides.unpackMessages,
    normalizeMessages: overrides.normalizeMessages,
    enrichMetadata: overrides.enrichMetadata,
    aggregateToolDefinitions: overrides.aggregateToolDefinitions,
  };
}
