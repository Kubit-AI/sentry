"""OpenAI Agents SDK attribute mappings.

The ``opentelemetry-instrumentation-openai-agents-v2`` package emits purely
standard OTel GenAI semconv — ``gen_ai.operation.name=invoke_agent``, flat
``gen_ai.request.*`` params, ``gen_ai.agent.{name,id,version}`` identity
attrs, and ``gen_ai.tool.name`` for tool invocations. Those keys are all
declared on the ``otel_genai`` adapter already; this module exists only to
reserve a registry slot for future Agents-specific keys without churning the
canonical alias concatenation order.
"""

from __future__ import annotations

NAME = "openai_agents"

MODEL_ATTRS: tuple[str, ...] = ()
PROVIDED_MODEL_ATTRS: tuple[str, ...] = ()
INPUT_ATTRS: tuple[str, ...] = ()
OUTPUT_ATTRS: tuple[str, ...] = ()
INPUT_TOKENS_ATTRS: tuple[str, ...] = ()
OUTPUT_TOKENS_ATTRS: tuple[str, ...] = ()
TOTAL_TOKENS_ATTRS: tuple[str, ...] = ()
INPUT_COST_ATTRS: tuple[str, ...] = ()
OUTPUT_COST_ATTRS: tuple[str, ...] = ()
TOTAL_COST_ATTRS: tuple[str, ...] = ()

SESSION_ID_ATTRS: tuple[str, ...] = ()
USER_ID_ATTRS: tuple[str, ...] = ()
TAGS_ATTRS: tuple[str, ...] = ()
TIME_TO_FIRST_TOKEN_ATTRS: tuple[str, ...] = ()
TOOL_CALLS_ATTRS: tuple[str, ...] = ()
TOOL_CALL_NAMES_ATTRS: tuple[str, ...] = ()
TOOL_DEFINITIONS_ATTRS: tuple[str, ...] = ()
PROVIDER_ATTRS: tuple[str, ...] = ()
AGENT_NAME_ATTRS: tuple[str, ...] = ()
AGENT_ID_ATTRS: tuple[str, ...] = ()
AGENT_VERSION_ATTRS: tuple[str, ...] = ()
TOOL_NAME_ATTRS: tuple[str, ...] = ()
SYSTEM_INSTRUCTIONS_ATTRS: tuple[str, ...] = ()

CACHE_TOKEN_MAP: tuple[tuple[str, str], ...] = ()
PARAMS_BLOB_ATTRS: tuple[str, ...] = ()
FLAT_PARAM_ATTRS: tuple[str, ...] = ()
