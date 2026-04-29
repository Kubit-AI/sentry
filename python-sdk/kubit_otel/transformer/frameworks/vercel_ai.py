"""Vercel AI SDK (``ai.*`` namespace) attribute mappings.

Vercel emits its own ``ai.*`` telemetry alongside standard ``gen_ai.*``. The
``otel_genai`` adapter handles the ``gen_ai.*`` fields on ``ai.*.doGenerate`` /
``ai.*.doStream`` spans; this adapter covers the additional ``ai.*`` fields on
outer agent spans (``ai.generateText``, ``ai.streamText``, …) and tool spans
(``ai.toolCall``).

Includes provider normalisation (``amazon-bedrock.*`` → ``aws_bedrock``,
``anthropic.messages`` → ``anthropic``, …) via the ``resolve_provider`` hook.
"""

from __future__ import annotations

from typing import Any, Optional

from ..messages import (
    coerce_to_messages,
    safe_json_parse,
    text_message,
    tool_call_part,
    tool_call_response_part,
)

NAME = "vercel_ai"

MODEL_ATTRS = (
    "ai.response.model",
    "ai.model.id",
    "ai.model",
)
PROVIDED_MODEL_ATTRS = (
    "ai.model.id",
    "ai.model",
)

INPUT_ATTRS = (
    "ai.prompt.messages",
    "ai.prompt",
    "ai.toolCall.args",
    # Embedding spans: ``ai.value`` (singular) on ``ai.embed``, ``ai.values``
    # (string-array) on ``ai.embedMany`` and the inner ``*.doEmbed`` provider
    # calls. These are the texts being embedded.
    "ai.value",
    "ai.values",
)
OUTPUT_ATTRS = (
    "ai.response.text",
    "ai.response.toolCalls",
    "ai.toolCall.result",
)

# ``ai.usage.tokens`` (singular) is what Vercel emits on embedding spans,
# which have no completion side. Listed as a fallback after the chat
# attributes so non-embedding Vercel spans still prefer ``promptTokens``.
INPUT_TOKENS_ATTRS = ("ai.usage.promptTokens", "ai.usage.tokens")
OUTPUT_TOKENS_ATTRS = ("ai.usage.completionTokens",)
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

PROVIDER_ATTRS = ("ai.model.provider",)
AGENT_NAME_ATTRS = ("ai.telemetry.functionId",)
AGENT_ID_ATTRS: tuple[str, ...] = ()
AGENT_VERSION_ATTRS: tuple[str, ...] = ()
TOOL_NAME_ATTRS = ("ai.toolCall.name",)
SYSTEM_INSTRUCTIONS_ATTRS: tuple[str, ...] = ()

CACHE_TOKEN_MAP: tuple[tuple[str, str], ...] = ()
PARAMS_BLOB_ATTRS: tuple[str, ...] = ()
FLAT_PARAM_ATTRS: tuple[str, ...] = ()

# Vercel has emitted both camelCase (``topP``, ``maxTokens``, …) and snake_case
# (``top_p``, ``max_tokens``, …) variants of ``ai.request.*`` across SDK versions.
# Accept both; first-non-null per canonical key wins.
_AI_REQUEST_PARAM_MAP = (
    ("ai.request.temperature", "temperature"),
    ("ai.request.topP", "top_p"),
    ("ai.request.top_p", "top_p"),
    ("ai.request.topK", "top_k"),
    ("ai.request.top_k", "top_k"),
    ("ai.request.maxTokens", "max_tokens"),
    ("ai.request.max_tokens", "max_tokens"),
    ("ai.request.frequencyPenalty", "frequency_penalty"),
    ("ai.request.frequency_penalty", "frequency_penalty"),
    ("ai.request.presencePenalty", "presence_penalty"),
    ("ai.request.presence_penalty", "presence_penalty"),
    ("ai.request.seed", "seed"),
    ("ai.request.stopSequences", "stop_sequences"),
    ("ai.request.stop_sequences", "stop_sequences"),
)

_PROVIDER_PREFIX_MAP = (
    ("amazon-bedrock", "aws_bedrock"),
    ("google-vertex", "vertex_ai"),
    ("google", "vertex_ai"),
    ("openai", "openai"),
    ("anthropic", "anthropic"),
    ("mistral", "mistral_ai"),
    ("cohere", "cohere"),
)


def _normalise_provider(raw: Any) -> Optional[str]:
    """Normalise a raw provider string to an OTel system id.

    Vercel emits values like ``openai.chat``, ``amazon-bedrock.claude-3-5``,
    ``anthropic.messages``. We take the portion before the first ``.`` and map
    it to the OTel ``gen_ai.system`` convention. Unknown prefixes pass through
    verbatim (lowercased).
    """
    if not isinstance(raw, str) or not raw:
        return None
    head = raw.split(".", 1)[0].strip().lower()
    for prefix, target in _PROVIDER_PREFIX_MAP:
        if head == prefix:
            return target
    return head or None


def resolve_observation_type(span_attrs: dict) -> str | None:
    op = span_attrs.get("ai.operationId")
    if not isinstance(op, str):
        return None
    if op == "ai.toolCall":
        return "TOOL"
    if op in ("ai.generateText", "ai.streamText"):
        return "AGENT"
    if op in ("ai.generateObject", "ai.streamObject"):
        return "AGENT"
    # Both the outer (``ai.embed`` / ``ai.embedMany``) and the inner provider
    # call (``ai.embed.doEmbed`` / ``ai.embedMany.doEmbed``) classify as
    # EMBEDDINGS — they carry only ``ai.*`` attrs (no ``gen_ai.*``), so
    # without an explicit match the inner spans would fall through to core's
    # ``model present ⇒ GENERATION`` rule.
    if op in ("ai.embed", "ai.embedMany"):
        return "EMBEDDINGS"
    if op in ("ai.embed.doEmbed", "ai.embedMany.doEmbed"):
        return "EMBEDDINGS"
    # `.doGenerate` / `.doStream` fall through to otel_genai's `gen_ai.*` handling.
    return None


def resolve_provider(span_attrs: dict) -> Optional[str]:
    """Normalise Vercel-specific provider values.

    Only fires for Vercel-emitted spans (identified by ``ai.operationId``).
    Vercel puts dotted values like ``anthropic.messages`` into both
    ``ai.model.provider`` and ``gen_ai.system``; non-Vercel callers should fall
    through to the canonical PROVIDER_ATTRS chain undisturbed.
    """
    if not isinstance(span_attrs.get("ai.operationId"), str):
        return None
    return (
        _normalise_provider(span_attrs.get("ai.model.provider"))
        or _normalise_provider(span_attrs.get("gen_ai.system"))
    )


def build_params(span_attrs: dict, merged: dict[str, Any]) -> None:
    """Map ``ai.request.<camelCase|snake_case>`` attributes into ``merged`` using snake_case keys."""
    for src_attr, canonical_key in _AI_REQUEST_PARAM_MAP:
        val = span_attrs.get(src_attr)
        if val is None:
            continue
        if canonical_key not in merged:
            merged[canonical_key] = val


def aggregate_tool_definitions(span_attrs: dict) -> Optional[list]:
    """Parse ``ai.prompt.tools`` into a list of tool definitions.

    Vercel emits ``ai.prompt.tools`` on ``*.doGenerate`` / ``*.doStream``
    spans as a string-array (each entry is a JSON-encoded tool-definition
    object — ``{type, name, description, inputSchema, ...}``). OTel attribute
    typing forbids nested objects, so the array-of-strings form is the wire
    encoding. Parse each entry; keep raw on parse failure.
    """
    raw = span_attrs.get("ai.prompt.tools")
    if not isinstance(raw, (list, tuple)) or not raw:
        return None
    out: list = []
    for entry in raw:
        if isinstance(entry, str):
            parsed = safe_json_parse(entry)
            out.append(parsed if parsed is not None else entry)
        else:
            out.append(entry)
    return out or None


def normalize_messages(span_attrs: dict) -> Optional[dict]:
    # ── Input side ───────────────────────────────────────────────────────
    input_msgs: Optional[list] = None
    prompt_messages = span_attrs.get("ai.prompt.messages")
    if prompt_messages is not None:
        coerced = coerce_to_messages(prompt_messages)
        if coerced:
            input_msgs = coerced
    if input_msgs is None:
        prompt = span_attrs.get("ai.prompt")
        if isinstance(prompt, str) and prompt:
            input_msgs = _unpack_ai_prompt_blob(prompt) or [text_message("user", prompt)]
    # Tool execution span: input represents the tool invocation.
    if input_msgs is None:
        args = span_attrs.get("ai.toolCall.args")
        tool_name = span_attrs.get("ai.toolCall.name")
        tool_call_id = span_attrs.get("ai.toolCall.id")
        if not isinstance(tool_call_id, str):
            tool_call_id = None
        if args is not None and isinstance(tool_name, str):
            parsed_args = safe_json_parse(args) if isinstance(args, str) else args
            if parsed_args is None and isinstance(args, str):
                parsed_args = args
            input_msgs = [{
                "role": "assistant",
                "parts": [tool_call_part(tool_name, parsed_args, tool_call_id)],
            }]
    # Embedding span inputs: project ``ai.value`` / ``ai.values`` as one
    # canonical user-text message per text being embedded. Each entry in
    # ``ai.values`` is JSON.stringify-encoded by Vercel to fit OTel's
    # string-array constraint; unwrap when the entry parses back to a string,
    # fall through otherwise.
    if input_msgs is None:
        embed_msgs = _embed_inputs_to_messages(span_attrs)
        if embed_msgs is not None:
            input_msgs = embed_msgs

    # ── Output side ──────────────────────────────────────────────────────
    output_msgs: Optional[list] = None
    response_text = span_attrs.get("ai.response.text")
    if isinstance(response_text, str) and response_text:
        output_msgs = [text_message("assistant", response_text)]

    raw_tool_calls = span_attrs.get("ai.response.toolCalls")
    if raw_tool_calls is not None:
        parts = _parse_vercel_tool_calls(raw_tool_calls)
        if parts:
            if output_msgs and output_msgs[-1].get("role") == "assistant":
                output_msgs[-1]["parts"] = list(output_msgs[-1].get("parts", [])) + parts
            else:
                synthesized = {"role": "assistant", "parts": parts}
                output_msgs = (output_msgs or []) + [synthesized]

    if output_msgs is None:
        result = span_attrs.get("ai.toolCall.result")
        if result is not None:
            tool_call_id = span_attrs.get("ai.toolCall.id")
            if not isinstance(tool_call_id, str):
                tool_call_id = None
            output_msgs = [{
                "role": "tool",
                "parts": [tool_call_response_part(result, tool_call_id)],
            }]

    if input_msgs is None and output_msgs is None:
        return None
    return {"input": input_msgs, "output": output_msgs}


def _embed_inputs_to_messages(span_attrs: dict) -> Optional[list]:
    """Project Vercel embedding-span inputs into canonical user-text messages.

    ``ai.value`` (singular, on ``ai.embed``) is the raw string being embedded.
    ``ai.values`` (string-array, on ``ai.embedMany`` and the inner
    ``*.doEmbed`` provider calls) is one entry per text being embedded; each
    entry is JSON.stringify-encoded by Vercel to fit OTel's string-array
    constraint, so unwrap when the entry parses back to a string and fall
    through to the raw value otherwise.
    """
    value = span_attrs.get("ai.value")
    if isinstance(value, str) and value:
        return [text_message("user", value)]
    values = span_attrs.get("ai.values")
    if isinstance(values, (list, tuple)) and values:
        out: list = []
        for entry in values:
            if not isinstance(entry, str):
                text = _stringify_embed_entry(entry)
                if text:
                    out.append(text_message("user", text))
                continue
            parsed = safe_json_parse(entry)
            text = parsed if isinstance(parsed, str) else entry
            if text:
                out.append(text_message("user", text))
        return out or None
    return None


def _stringify_embed_entry(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, str):
        return v
    try:
        import json as _json
        return _json.dumps(v)
    except Exception:
        return str(v)


def _unpack_ai_prompt_blob(raw: str) -> Optional[list]:
    """Vercel AI's outer agent spans (``ai.streamText`` / ``ai.generateText`` /
    ``ai.streamObject`` / ``ai.generateObject``) emit the full prompt as a
    single JSON blob in ``ai.prompt`` rather than indexed
    ``ai.prompt.messages.*``. Shape: ``{system?: str, messages: [{role,
    content: ...}, ...]}``. Unpack it so the system instruction becomes a
    leading system message and the inner messages route through the
    OpenAI/Vercel-shape coercer (which already understands ``tool-call`` /
    ``tool-result`` Vercel content parts).
    """
    parsed = safe_json_parse(raw)
    if not isinstance(parsed, dict):
        return None
    messages = parsed.get("messages")
    if not isinstance(messages, list):
        return None
    out: list = []
    system = parsed.get("system")
    if isinstance(system, str) and system:
        out.append(text_message("system", system))
    coerced = coerce_to_messages(messages)
    if coerced:
        out.extend(coerced)
    return out or None


def _parse_vercel_tool_calls(raw: Any) -> list:
    parsed = safe_json_parse(raw) if isinstance(raw, str) else raw
    if not isinstance(parsed, list):
        return []
    out: list = []
    for tc in parsed:
        if not isinstance(tc, dict):
            continue
        # Vercel uses {toolCallId, toolName, input} in ai.response.toolCalls
        # (camelCase, with `input` rather than `args`/`arguments`). Older
        # shapes and other emitters may use `args` or `arguments`; fall
        # through.
        name = (
            tc.get("toolName") if isinstance(tc.get("toolName"), str)
            else (tc.get("name") if isinstance(tc.get("name"), str) else None)
        )
        if not name:
            continue
        call_id = (
            tc.get("toolCallId") if isinstance(tc.get("toolCallId"), str)
            else (tc.get("id") if isinstance(tc.get("id"), str) else None)
        )
        # Match TS `obj.input ?? obj.args ?? obj.arguments`: only fall
        # through when the key is missing/None, not when key present with
        # falsy value.
        args = tc.get("input")
        if args is None:
            args = tc.get("args")
        if args is None:
            args = tc.get("arguments")
        parsed_args = safe_json_parse(args) if isinstance(args, str) else args
        if parsed_args is None and isinstance(args, str):
            parsed_args = args
        out.append(tool_call_part(name, parsed_args, call_id))
    return out
