/**
 * Span filter predicates for controlling which OTel spans ship to Kubit.
 *
 * The default predicate {@link isDefaultExportSpan} keeps only LLM-relevant
 * spans:
 *
 *   - spans created by the Kubit SDK tracer (`kubit-sdk`)
 *   - spans carrying any `gen_ai.*` semantic-convention attribute
 *   - spans whose instrumentation-scope name matches a known LLM instrumentor
 *     prefix (see {@link KNOWN_LLM_INSTRUMENTATION_SCOPE_PREFIXES})
 *
 * Consumers can compose their own rule:
 *
 * ```ts
 * import { KubitSpanProcessor, isDefaultExportSpan } from "@kubit-ai/otel";
 *
 * provider.addSpanProcessor(new KubitSpanProcessor({
 *   apiKey: "rg.v1.xxx",
 *   shouldExportSpan: ({ otelSpan }) =>
 *     isDefaultExportSpan(otelSpan) ||
 *     (getScopeName(otelSpan)?.startsWith("my-framework") ?? false),
 * }));
 * ```
 *
 * Or disable filtering entirely:
 *
 * ```ts
 * new KubitSpanProcessor({ apiKey: "rg.v1.xxx", shouldExportSpan: () => true });
 * ```
 */

import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

export const KUBIT_TRACER_NAME = "kubit-sdk";

export type ShouldExportSpan = (params: { otelSpan: ReadableSpan }) => boolean;

export const KNOWN_LLM_INSTRUMENTATION_SCOPE_PREFIXES = [
  KUBIT_TRACER_NAME,
  // Langfuse's default allow-list (verbatim) — kept for apps that instrument
  // with the Langfuse SDK or any of the upstream frameworks it supports.
  "langfuse-sdk",
  "agent_framework",
  "ai", // Vercel AI SDK
  "haystack",
  "langsmith",
  "litellm",
  "openinference", // Arize / OpenInference family
  "opentelemetry.instrumentation.anthropic",
  "strands-agents",
  "vllm",
  // Additional scopes this project's transformer already aliases per CLAUDE.md
  // (Braintrust, Logfire, OpenLLMetry/Traceloop family).
  "braintrust",
  "logfire",
  "opentelemetry.instrumentation.openai",
  "opentelemetry.instrumentation.bedrock",
  "opentelemetry.instrumentation.vertexai",
  "opentelemetry.instrumentation.google_generativeai",
  "opentelemetry.instrumentation.cohere",
  "opentelemetry.instrumentation.mistralai",
  "opentelemetry.instrumentation.groq",
  "opentelemetry.instrumentation.ollama",
  "opentelemetry.instrumentation.together",
  "opentelemetry.instrumentation.replicate",
  // OpenAI Agents SDK — opentelemetry-instrumentation-openai-agents-v2 emits
  // under this scope. Trailing `_agents` makes it distinct from
  // `opentelemetry.instrumentation.openai`.
  "opentelemetry.instrumentation.openai_agents",
  // Traceloop / OpenLLMetry SDK workflow + task decorator spans.
  "traceloop.tracer", // Python SDK tracer name
  "@traceloop/node-server-sdk", // JS SDK tracer name
] as const;

/**
 * Return the instrumentation scope name for a span, handling both OTel JS v1
 * (`instrumentationLibrary`) and v2 (`instrumentationScope`).
 */
export function getInstrumentationScopeName(span: ReadableSpan): string | null {
  const anySpan = span as unknown as {
    instrumentationLibrary?: { name?: string };
    instrumentationScope?: { name?: string };
  };
  return (
    anySpan.instrumentationScope?.name ??
    anySpan.instrumentationLibrary?.name ??
    null
  );
}

export function isKubitSpan(span: ReadableSpan): boolean {
  return getInstrumentationScopeName(span) === KUBIT_TRACER_NAME;
}

export function isGenAISpan(span: ReadableSpan): boolean {
  const attrs = span.attributes ?? {};
  for (const key of Object.keys(attrs)) {
    if (key.startsWith("gen_ai.")) return true;
  }
  return false;
}

export function isKnownLLMInstrumentor(span: ReadableSpan): boolean {
  const scope = getInstrumentationScopeName(span);
  if (scope === null) return false;
  return KNOWN_LLM_INSTRUMENTATION_SCOPE_PREFIXES.some(
    (prefix) => scope === prefix || scope.startsWith(`${prefix}.`),
  );
}

export function isDefaultExportSpan(span: ReadableSpan): boolean {
  return isKubitSpan(span) || isGenAISpan(span) || isKnownLLMInstrumentor(span);
}
