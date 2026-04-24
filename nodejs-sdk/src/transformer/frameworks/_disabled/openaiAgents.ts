/**
 * OpenAI Agents SDK attribute mappings.
 *
 * The `opentelemetry-instrumentation-openai-agents-v2` package emits purely
 * standard OTel GenAI semconv — `gen_ai.operation.name=invoke_agent`, flat
 * `gen_ai.request.*` params, `gen_ai.agent.{name,id,version}` identity
 * attrs, and `gen_ai.tool.name` for tool invocations. Those keys all live
 * on the `otelGenai` adapter already; this module exists to reserve a
 * registry slot for future Agents-specific keys without churning the
 * canonical alias concatenation order.
 */

import { makeAdapter } from "../makeAdapter";

export const adapter = makeAdapter({ NAME: "openai_agents" });
