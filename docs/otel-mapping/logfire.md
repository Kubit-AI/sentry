# Logfire Telemetry and Vercel AI SDK Integration Dynamics

Logfire's native OTel GenAI semantics and the `ai.*` → `gen_ai.*` translation applied to Vercel AI SDK spans.

See also: [`README.md`](README.md) for the OTel GenAI baseline conventions.

---

Logfire, an observability platform developed by the creators of Pydantic, introduces a novel tracing paradigm by storing telemetry data directly in a PostgreSQL-compatible SQL engine. This architectural decision enables developers to query deep trace data alongside application business logic using standard SQL syntax. Logfire is intrinsically built around the native OpenTelemetry GenAI Semantic Conventions, requiring zero proprietary configuration to render complex LLM workflows, provided the incoming spans adhere strictly to the `gen_ai.*` specification.

The Logfire LLM Panels automatically identify GenAI spans by executing queries against the `gen_ai.system` and `gen_ai.operation.name` attributes. In Version 2 of its instrumentation logic, Logfire explicitly monitors the `gen_ai.system_instructions` attribute to capture the high-level system prompts governing agent behavior, while extracting dynamic, multi-turn conversation flows from the `gen_ai.input.messages` and `gen_ai.output.messages` arrays. For sophisticated multi-agent frameworks built on Pydantic AI, Logfire captures agent-to-agent delegation via the specialized `pydantic_ai.all_messages` attribute, bypassing the limitations of tracking conversation state across isolated, disconnected request spans.

A critical integration point for Logfire exists within the JavaScript ecosystem, specifically via the Vercel AI SDK. Vercel natively emits comprehensive telemetry under an isolated `ai.*` namespace (e.g., `ai.model.provider`, `ai.request.stopSequences`), which is incompatible with native GenAI visualizers. To align this with the OTel standard, specialized OpenTelemetry Span Processors (such as the `ai-sdk-otel-adapter`) are deployed to intercept these spans during creation. These processors map `ai.model.provider` directly to `gen_ai.system`, converting proprietary values like `openai.*` strictly to `openai`, or `google.*` to `vertex_ai`.

| Vercel AI SDK Attribute (`ai.*`) | Logfire Target (OTel Standard `gen_ai.*`) | Translation Context |
| :---- | :---- | :---- |
| `ai.model.provider` | `gen_ai.system` | Maps the AI provider, normalizing prefixes (e.g., `amazon-bedrock.*` → `aws_bedrock`). |
| `ai.model.id` | `gen_ai.request.model` | Maps the exact model version requested by the Next.js frontend. |
| `ai.response.model` | `gen_ai.response.model` | Maps the model version returned in the response headers. |
| `ai.usage.promptTokens` | `gen_ai.usage.input_tokens` | Translates token tracking for billing calculations. |
| `ai.usage.completionTokens` | `gen_ai.usage.output_tokens` | Translates generation token tracking for billing calculations. |
| `ai.request.temperature` | `gen_ai.request.temperature` | Captures generation hyper-parameters. |
| `ai.request.stopSequences` | `gen_ai.request.stop_sequences` | Captures constraints applied to the generation loop. |
| `ai.prompt.tools` | `gen_ai.tool.definitions` | Vercel emits the available tool catalogue on `*.doStream` / `*.doGenerate` spans as a string-array of JSON-encoded definitions (`{type, name, description, inputSchema, ...}`). The kubit-otel `vercel_ai` adapter parses each entry and exposes the result as `tool_definitions` on the enriched observation. |
| `ai.telemetry.metadata.sessionId` | (no OTel equivalent) | Caller-supplied via `experimental_telemetry: { metadata: { sessionId } }`. The kubit-otel `vercel_ai` adapter surfaces it as `session_id` on the enriched observation and trace. |
| `ai.telemetry.metadata.userId` | (no OTel equivalent) | Caller-supplied via `experimental_telemetry: { metadata: { userId } }`. The kubit-otel `vercel_ai` adapter surfaces it as `user_id` on the enriched observation and trace. |
| `ai.telemetry.metadata.tags` | (no OTel equivalent) | Caller-supplied via `experimental_telemetry: { metadata: { tags: [...] } }` — string-array. The kubit-otel `vercel_ai` adapter surfaces it as `tags` on the enriched observation and trace. |
| `logfire.tags` | (no OTel equivalent) | Logfire-native free-form tag list; the kubit-otel `logfire` adapter surfaces it as `tags` on the enriched observation. |

Logfire ingests these translated `gen_ai.*` attributes to render distinct token usage badges and cascading tool-call traces, seamlessly correlating backend Python Pydantic validation models with frontend Next.js generation spans. Because Logfire is built natively on standard OTel conventions, it achieves deep visibility without requiring the installation of proprietary Logfire instrumentation SDKs, operating entirely via OTLP exporters.
