# OpenAI-Agents Instrumentation: Tracing Agentic Workflows

`invoke_agent` operation semantics, CLIENT vs INTERNAL span-kind routing for remote vs in-process agents, and privacy-aware content capture.

See also: [`README.md`](README.md) for the OTel GenAI baseline conventions.

---

The `opentelemetry-instrumentation-openai-agents` package provides native, deep visibility into the OpenAI Agents SDK, generating specialized spans that encompass multi-step reasoning, dynamic guardrail evaluations, inter-agent handoffs, and external tool execution. This instrumentation bridges the critical gap between deterministic software execution and the non-deterministic, autonomous behavior of agentic systems by mapping runtime decisions directly into the OTel GenAI specification.

Agent operations are uniquely identified using a precise combination of operation names and agent-specific contextual attributes. A span representing an agent invocation is tagged with `gen_ai.operation.name=invoke_agent`, accompanied by critical lineage attributes including `gen_ai.agent.name` (the human-readable identifier), `gen_ai.agent.id`, and `gen_ai.agent.version`.

The instrumentation architecture handles internal trace routing distinctively based on the execution context of the agent. Spans representing remote agent services—such as API calls to the hosted OpenAI Assistants API or AWS Bedrock Agents—are assigned the standard OpenTelemetry span kind `CLIENT`, indicating an out-of-process network call. Conversely, if the agent logic, planning, and memory management are executed in-process (e.g., using local LangChain runtimes or internal Swarm logic), the span kind is explicitly set to `INTERNAL`. This distinction allows trace visualizers to accurately differentiate between network I/O boundaries and local CPU execution time.

| OpenAI-Agents Attribute | OTel GenAI / Value Resolution | Architectural Implication |
| :---- | :---- | :---- |
| `gen_ai.operation.name` | `invoke_agent`, `execute_tool` | Identifies the autonomous action being taken. |
| `gen_ai.agent.name` | Agent Identifier | Tracks which specific agent (e.g., `"researcher"`) executed the step. |
| `gen_ai.agent.version` | Version String | Crucial for A/B testing different agent instructions. |
| Span Kind `CLIENT` | Remote Execution | Indicates the agent logic is hosted remotely (OpenAI Assistants). |
| Span Kind `INTERNAL` | In-Process Execution | Indicates the agent is orchestrated locally by the application. |
| `gen_ai.system` | Environment Overridden | Can be overridden via `OTEL_INSTRUMENTATION_OPENAI_AGENTS_SYSTEM`. |

Data privacy and payload overhead are aggressively managed within this package. Developers can toggle the `OTEL_INSTRUMENTATION_OPENAI_AGENTS_CAPTURE_CONTENT` (or `TRACELOOP_TRACE_CONTENT`) environment variable to determine whether sensitive prompt and completion content is logged as span attributes, emitted as separate span events, or completely redacted (`no_content`) to comply strictly with data privacy regulations like GDPR or HIPAA. By default, the package maps the deployment platform to the `gen_ai.system` attribute, though this can be programmatically overridden for custom or self-hosted proxy environments.
