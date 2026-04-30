"""Helpers for projecting heterogeneous source attribute shapes into the
OTel GenAI v2 canonical message form (``list[Message]`` with discriminated
``list[Part]``). Used by every adapter's ``normalize_messages`` hook and by
the ``canonicalize_gen_ai_events`` event-fallback path in ``core.py``.

Cross-SDK parity: every public function has a camelCase mirror in
``nodejs-sdk/src/transformer/messages.ts``. Same inputs must produce
semantically identical outputs.

Canonical shape per the upstream JSON schemas:
    https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-input-messages.json
    https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-output-messages.json
    https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-system-instructions.json
"""

from __future__ import annotations

import ast
import json
from typing import Any, Optional

# ── Type shorthands ─────────────────────────────────────────────────────────
# Plain dicts; we document shape rather than declare TypedDicts so adapters
# stay duck-typed in line with existing convention.
Part = dict
Message = dict
CanonicalMessages = dict  # {"input": list[Message] | None, "output": list[Message] | None}


# ── Part constructors ──────────────────────────────────────────────────────


def text_part(content: str) -> Part:
    return {"type": "text", "content": content}


def reasoning_part(content: str) -> Part:
    return {"type": "reasoning", "content": content}


def tool_call_part(
    name: str,
    args: Any = None,
    call_id: Optional[str] = None,
) -> Part:
    part: Part = {"type": "tool_call", "name": name}
    if call_id is not None:
        part["id"] = call_id
    if args is not None:
        part["arguments"] = args
    return part


def tool_call_response_part(
    response: Any,
    call_id: Optional[str] = None,
) -> Part:
    part: Part = {"type": "tool_call_response", "response": response}
    if call_id is not None:
        part["id"] = call_id
    return part


def blob_part(modality: str, content: str, mime_type: Optional[str] = None) -> Part:
    part: Part = {"type": "blob", "modality": modality, "content": content}
    if mime_type is not None:
        part["mime_type"] = mime_type
    return part


def file_part(modality: str, file_id: str, mime_type: Optional[str] = None) -> Part:
    part: Part = {"type": "file", "modality": modality, "file_id": file_id}
    if mime_type is not None:
        part["mime_type"] = mime_type
    return part


def uri_part(modality: str, uri: str, mime_type: Optional[str] = None) -> Part:
    part: Part = {"type": "uri", "modality": modality, "uri": uri}
    if mime_type is not None:
        part["mime_type"] = mime_type
    return part


def generic_part(type_: str, extras: Optional[dict] = None) -> Part:
    out: Part = {"type": type_}
    if extras:
        for k, v in extras.items():
            if k == "type":
                continue
            out[k] = v
    return out


# ── Message constructors ────────────────────────────────────────────────────


def text_message(role: str, content: str) -> Message:
    return {"role": role, "parts": [text_part(content)]}


def message_with_parts(role: str, parts: list, extras: Optional[dict] = None) -> Message:
    msg: Message = {"role": role, "parts": parts}
    if extras:
        msg.update(extras)
    return msg


# ── Parsing helpers ─────────────────────────────────────────────────────────


def safe_json_parse(raw: Any) -> Any:
    if not isinstance(raw, str) or not raw:
        return None
    try:
        return json.loads(raw)
    except (ValueError, TypeError):
        return None


def safe_python_literal_parse(raw: Any) -> Any:
    # ``ast.literal_eval`` accepts only Python literal nodes (dicts, lists,
    # tuples, sets, numbers, strings, bools, None) — no code execution. It is
    # the safe complement to ``safe_json_parse`` for payloads serialised via
    # ``str(obj)`` / ``repr(obj)`` (notably OpenInference's Python LangChain
    # instrumentor, which writes ``input.value`` for TOOL spans as
    # ``str(args_dict)`` rather than ``json.dumps``).
    if not isinstance(raw, str) or not raw:
        return None
    try:
        return ast.literal_eval(raw)
    except (ValueError, SyntaxError, MemoryError, TypeError):
        return None


def stringify_for_text(val: Any) -> str:
    """Render any value as a string suitable for wrapping in a ``TextPart``."""
    if isinstance(val, str):
        return val
    if val is None:
        return ""
    if isinstance(val, (dict, list, tuple)):
        try:
            return json.dumps(val, ensure_ascii=False)
        except (TypeError, ValueError):
            return str(val)
    return str(val)


def coerce_to_messages(raw: Any) -> Optional[list]:
    """Best-effort detector for "this is already an array of messages."

    Accepts:
      - list of ``{"role", "parts": [...]}`` (already canonical, validated)
      - list of ``{"role", "content": str | list}`` (OpenAI shape, translated)
      - anything else: returns ``None`` so caller can text-wrap.
    """
    value: Any = raw
    if isinstance(raw, str):
        value = safe_json_parse(raw)
        if value is None:
            return None
    if not isinstance(value, list) or not value:
        return None

    out: list = []
    for item in value:
        if not isinstance(item, dict):
            return None
        role = item.get("role")
        if not isinstance(role, str):
            return None
        if isinstance(item.get("parts"), list):
            extras = {k: v for k, v in item.items() if k not in ("role", "parts")}
            msg: Message = {
                "role": role,
                "parts": _dedupe_tool_use_text_mirror(list(item["parts"])),
            }
            msg.update(extras)
            out.append(msg)
            continue
        out.append(openai_message_to_canonical(item))
    return out


def _dedupe_tool_use_text_mirror(parts: list) -> list:
    """Drop redundant TextPart mirrors of `tool_use` blocks.

    OpenLLMetry / Traceloop's LangChain instrumentation serializes Anthropic-
    style assistant ``content`` arrays that contain ``tool_use`` blocks by
    stringifying each block into a TextPart *and* emitting the parallel
    structured ``tool_call`` part. The text mirror duplicates information that
    the structured part already carries, so canonical-passthrough strips it.
    Keyed on a sibling tool_call with matching ``id`` (or matching ``name``
    when no id is present).
    """
    tool_call_ids: set = set()
    tool_call_names: set = set()
    for p in parts:
        if isinstance(p, dict) and p.get("type") == "tool_call":
            pid = p.get("id")
            if isinstance(pid, str):
                tool_call_ids.add(pid)
            pname = p.get("name")
            if isinstance(pname, str):
                tool_call_names.add(pname)
    if not tool_call_ids and not tool_call_names:
        return parts

    kept: list = []
    for p in parts:
        if not isinstance(p, dict):
            kept.append(p)
            continue
        if p.get("type") != "text" or not isinstance(p.get("content"), str):
            kept.append(p)
            continue
        parsed = safe_json_parse(p["content"])
        if not isinstance(parsed, dict):
            kept.append(p)
            continue
        inner_type = parsed.get("type")
        if inner_type not in ("tool_use", "tool_call"):
            kept.append(p)
            continue
        inner_id = parsed.get("id") if isinstance(parsed.get("id"), str) else None
        inner_name = parsed.get("name") if isinstance(parsed.get("name"), str) else None
        if inner_id is not None and inner_id in tool_call_ids:
            continue
        if inner_id is None and inner_name is not None and inner_name in tool_call_names:
            continue
        kept.append(p)
    return kept


# ── OpenAI message → canonical translation ─────────────────────────────────


def openai_message_to_canonical(msg: dict) -> Message:
    """Translate a single OpenAI Chat Completions message into canonical form.

    Handles: string content, multimodal content array (text/image_url/image/
    input_audio), assistant.tool_calls, tool.tool_call_id.
    """
    role = msg.get("role") or "user"
    parts: list = []

    content = msg.get("content")
    tool_call_id = msg.get("tool_call_id")
    if role == "tool" and isinstance(tool_call_id, str):
        parts.append(tool_call_response_part(content if content is not None else None, tool_call_id))
    elif isinstance(content, str):
        if content:
            parts.append(text_part(content))
    elif isinstance(content, list):
        for cp in content:
            part = _openai_content_part_to_canonical(cp)
            if part is not None:
                parts.append(part)
    elif content is not None:
        parts.append(text_part(stringify_for_text(content)))

    tool_calls = msg.get("tool_calls")
    if isinstance(tool_calls, list):
        # Accept both OpenAI shape (``{id, type, function:{name, arguments}}``)
        # and LangChain shape (``{name, args, id, type:"tool_call"}`` —
        # tool_calls emitted by ``langchain_core`` BaseMessage and surfaced in
        # Langfuse-Python observation blobs).
        #
        # Dedup against tool_call parts already produced from ``content`` (e.g.
        # Anthropic ``{"type": "tool_use", ...}`` blocks): when both exist they
        # describe the same invocation and would otherwise duplicate.
        seen_ids: set = set()
        for p in parts:
            if isinstance(p, dict) and p.get("type") == "tool_call":
                pid = p.get("id")
                if isinstance(pid, str):
                    seen_ids.add(pid)
        for tc in tool_calls:
            if not isinstance(tc, dict):
                continue
            fn = tc.get("function") if isinstance(tc.get("function"), dict) else None
            name = tc.get("name") if isinstance(tc.get("name"), str) else None
            if name is None and fn is not None:
                name = fn.get("name") if isinstance(fn.get("name"), str) else None
            if not isinstance(name, str):
                continue
            call_id = tc.get("id") if isinstance(tc.get("id"), str) else None
            if call_id is not None and call_id in seen_ids:
                continue
            raw_args = tc.get("args")
            if raw_args is None:
                raw_args = tc.get("arguments")
            if raw_args is None and fn is not None:
                raw_args = fn.get("arguments")
            args = safe_json_parse(raw_args) if isinstance(raw_args, str) else raw_args
            if args is None and isinstance(raw_args, str):
                args = raw_args
            parts.append(tool_call_part(name, args, call_id))
            if call_id is not None:
                seen_ids.add(call_id)

    out: Message = {"role": role, "parts": parts}
    if isinstance(msg.get("name"), str):
        out["name"] = msg["name"]
    if isinstance(msg.get("finish_reason"), str):
        out["finish_reason"] = msg["finish_reason"]
    return out


def _openai_content_part_to_canonical(raw: Any) -> Optional[Part]:
    if isinstance(raw, str):
        return text_part(raw)
    if not isinstance(raw, dict):
        return None
    type_ = raw.get("type")
    if type_ == "text" and isinstance(raw.get("text"), str):
        return text_part(raw["text"])
    # Anthropic-style inline tool call: ``{"type": "tool_use", "id", "name",
    # "input"}``. LangChain AIMessage content arrays carry these verbatim,
    # and Langfuse serializes them straight through. Drop sibling fields
    # (e.g. ``caller``) so the canonical part stays clean.
    if type_ == "tool_use" and isinstance(raw.get("name"), str):
        call_id = raw.get("id") if isinstance(raw.get("id"), str) else None
        return tool_call_part(raw["name"], raw.get("input"), call_id)
    # Vercel AI SDK uses kebab-case content parts inside ai.prompt.messages
    # for tool invocations and results. Map them to canonical snake_case
    # parts so consumers don't have to know about the Vercel-specific shape.
    if type_ == "tool-call" and isinstance(raw.get("toolName"), str):
        call_id = raw.get("toolCallId") if isinstance(raw.get("toolCallId"), str) else None
        raw_args = raw.get("input")
        if raw_args is None:
            raw_args = raw.get("args")
        if raw_args is None:
            raw_args = raw.get("arguments")
        if isinstance(raw_args, str):
            parsed = safe_json_parse(raw_args)
            args = parsed if parsed is not None else raw_args
        else:
            args = raw_args
        return tool_call_part(raw["toolName"], args, call_id)
    if type_ == "tool-result":
        call_id = raw.get("toolCallId") if isinstance(raw.get("toolCallId"), str) else None
        return tool_call_response_part(_unwrap_vercel_tool_result(raw.get("output")), call_id)
    if type_ == "image_url":
        image_url = raw.get("image_url")
        url = image_url if isinstance(image_url, str) else (image_url or {}).get("url")
        if not isinstance(url, str):
            return None
        return _parse_image_url(url)
    if type_ == "image" and isinstance(raw.get("image"), str):
        return blob_part("image", raw["image"])
    if type_ == "input_audio":
        audio = raw.get("input_audio")
        if isinstance(audio, dict) and isinstance(audio.get("data"), str):
            fmt = audio.get("format")
            mime = f"audio/{fmt}" if isinstance(fmt, str) else None
            return blob_part("audio", audio["data"], mime)
        return None
    if isinstance(type_, str):
        # Pass through unknown content types; nothing is lost.
        return generic_part(type_, raw)
    return None


def _parse_image_url(url: str) -> Part:
    import re

    m = re.match(r"^data:([^;]+);base64,(.*)$", url, re.IGNORECASE)
    if m:
        return blob_part("image", m.group(2), m.group(1))
    return uri_part("image", url)


def _unwrap_vercel_tool_result(output: Any) -> Any:
    """Unwrap Vercel AI SDK's tool-result ``output`` envelope, which uses a
    discriminated ``{type, value}`` shape (e.g. ``{type: "json", value: 85}``,
    ``{type: "text", value: "..."}``, ``{type: "error-text", value: "..."}``).
    Returns the inner value for the common ``text`` / ``json`` /
    ``error-text`` / ``error-json`` variants and passes the envelope through
    unchanged for any other shape so nothing is lost.
    """
    if not isinstance(output, dict):
        return output
    t = output.get("type")
    if t in ("text", "json", "error-text", "error-json") and "value" in output:
        return output["value"]
    return output


# ── Pydantic AI envelope translator ────────────────────────────────────────
#
# Pydantic AI's ``pydantic_ai.all_messages`` is a JSON array of envelopes:
#   [{"kind": "request"|"response", "parts": [{"part_kind", "content"?, ...}]}]
#
# ``request`` envelopes carry system-prompt / user-prompt / tool-return /
# retry-prompt parts; ``response`` envelopes carry text / tool-call / thinking
# parts. We split by part_kind into role-typed canonical messages.


def pydantic_ai_envelope_to_canonical(raw: Any) -> CanonicalMessages:
    value: Any = raw
    if isinstance(raw, str):
        value = safe_json_parse(raw)
    if not isinstance(value, list):
        return {"input": None, "output": None}

    inputs: list = []
    outputs: list = []
    for env in value:
        if not isinstance(env, dict):
            continue
        parts = env.get("parts") if isinstance(env.get("parts"), list) else []
        if env.get("kind") == "response":
            msg = _pydantic_ai_response_to_message(parts)
            if msg is not None:
                outputs.append(msg)
        else:
            inputs.extend(_pydantic_ai_request_to_messages(parts))

    return {
        "input": inputs if inputs else None,
        "output": outputs if outputs else None,
    }


def _pydantic_ai_request_to_messages(parts: list) -> list:
    out: list = []
    for p in parts:
        if not isinstance(p, dict):
            continue
        kind = p.get("part_kind")
        if kind == "system-prompt":
            out.append(text_message("system", stringify_for_text(p.get("content"))))
        elif kind == "user-prompt":
            out.append(text_message("user", stringify_for_text(p.get("content"))))
        elif kind == "tool-return":
            extras = {"name": p["tool_name"]} if isinstance(p.get("tool_name"), str) else None
            out.append(message_with_parts(
                "tool",
                [tool_call_response_part(p.get("content"), p.get("tool_call_id"))],
                extras,
            ))
        elif kind == "retry-prompt":
            out.append(message_with_parts(
                "user",
                [text_part(stringify_for_text(p.get("content")))],
                {"name": "retry"},
            ))
        else:
            out.append({
                "role": "user",
                "parts": [generic_part(kind or "unknown", dict(p))],
            })
    return out


def _pydantic_ai_response_to_message(parts: list) -> Optional[Message]:
    canonical: list = []
    for p in parts:
        if not isinstance(p, dict):
            continue
        kind = p.get("part_kind")
        if kind == "text":
            canonical.append(text_part(stringify_for_text(p.get("content"))))
        elif kind in ("thinking", "reasoning"):
            canonical.append(reasoning_part(stringify_for_text(p.get("content"))))
        elif kind == "tool-call":
            canonical.append(tool_call_part(
                p.get("tool_name") or "",
                p.get("args"),
                p.get("tool_call_id"),
            ))
        else:
            canonical.append(generic_part(kind or "unknown", dict(p)))
    if not canonical:
        return None
    return {"role": "assistant", "parts": canonical}


# ── LangChain Serializable envelope translator ─────────────────────────────
#
# LangChain (JS via ``@arizeai/openinference-instrumentation-langchain``,
# Python via ``openinference.instrumentation.langchain``) emits message
# envelopes inside ``input.value`` / ``output.value`` blobs as LangChain
# ``Serializable`` objects:
#
#   {"lc": 1, "type": "constructor",
#    "id": ["langchain_core", "messages", "HumanMessage" | "AIMessage" | ...],
#    "kwargs": {"content": ..., "tool_calls"?: [...], "tool_call_id"?: ..., ...}}
#
# Wrappers vary: ``{"messages": [...]}`` (most common), bare list, single
# Serializable, ``{"output": <ToolMessage>}`` (LangGraph TOOL span output
# convention), ``{"input": ...}`` (some chain nodes). Callers should treat a
# ``None`` return as "not LangChain shape, fall through."


def _is_langchain_message_serializable(v: Any) -> bool:
    if not isinstance(v, dict):
        return False
    if v.get("lc") != 1:
        return False
    id_ = v.get("id")
    if not isinstance(id_, list) or len(id_) < 2:
        return False
    return id_[-2] == "messages"


def _unwrap_langchain_envelope(value: Any) -> Optional[list]:
    if value is None:
        return None
    if isinstance(value, str):
        parsed = safe_json_parse(value)
        if parsed is None:
            return None
        return _unwrap_langchain_envelope(parsed)
    if isinstance(value, list):
        if any(_is_langchain_message_serializable(x) for x in value):
            return value
        if value and all(
            _is_openai_shape_message(x) or _is_langchain_plain_dict_message(x)
            for x in value
        ):
            return value
        return None
    if not isinstance(value, dict):
        return None
    if isinstance(value.get("messages"), list):
        msgs = value["messages"]
        # LangChain JS BaseChatModel.invoke uses a batch convention:
        # ``messages`` is BaseMessage[][] (each outer slot = one conversation
        # in the batch). For single-conversation calls there's still one
        # outer wrapper around the inner turn list. Flatten one level when
        # every outer item is itself a list of Serializables.
        if (
            msgs
            and all(
                isinstance(x, list)
                and any(_is_langchain_message_serializable(y) for y in x)
                for x in msgs
            )
        ):
            flat: list = []
            for x in msgs:
                flat.extend(x)
            return flat
        return msgs
    # LangChain LLMResult: ``{generations: [[{text, message: <Serializable>}, ...], ...], llmOutput}``.
    # Each ``generations[i]`` is a list of ``{text, message}`` records — collect
    # every ``message`` field across the nested structure.
    if isinstance(value.get("generations"), list):
        collected: list = []
        for gen in value["generations"]:
            inner = gen if isinstance(gen, list) else [gen]
            for item in inner:
                if isinstance(item, dict) and "message" in item:
                    collected.append(item["message"])
        if any(_is_langchain_message_serializable(x) for x in collected):
            return collected
    if "output" in value:
        out = value["output"]
        if isinstance(out, list) and any(_is_langchain_message_serializable(x) for x in out):
            return out
        if _is_langchain_message_serializable(out):
            return [out]
    if "input" in value:
        return _unwrap_langchain_envelope(value["input"])
    # OpenLLMetry's @workflow / @task entity blobs nest the actual messages
    # under plural ``inputs`` / ``outputs`` keys (often with sibling ``tags``,
    # ``metadata``, ``kwargs``). Recurse through them like the singular variants.
    if "inputs" in value:
        return _unwrap_langchain_envelope(value["inputs"])
    if "outputs" in value:
        return _unwrap_langchain_envelope(value["outputs"])
    # ``langgraph.types.Command`` is the standard return value for nodes that
    # steer the graph plus update state. OpenInference serializes it as
    # ``{graph: ..., update: <state-delta>, resume: ..., goto: <node>}``.
    # First try the standard recursion (handles the default ``MessagesState``
    # with key ``messages`` plus the existing ``output``/``input`` paths).
    if "goto" in value and isinstance(value.get("update"), dict):
        update = value["update"]
        standard = _unwrap_langchain_envelope(update)
        if standard is not None:
            return standard
        # Multi-agent / custom-state LangGraph apps rename their message
        # channels (``researcher_messages``, ``supervisor_messages``,
        # ``chat_history``, …). Walk every value of ``update`` and collect any
        # list-of-messages we recognise; non-message values (scalars, lists of
        # plain strings) drop through to None and are ignored. Channels are
        # concatenated in dict-insertion order (stable across CPython 3.7+
        # and V8 string-keyed objects).
        collected: list = []
        for v in update.values():
            if isinstance(v, (dict, list)):
                sub = _unwrap_langchain_envelope(v)
                if sub:
                    collected.extend(sub)
        return collected if collected else None
    if _is_langchain_message_serializable(value):
        return [value]
    if _is_langchain_plain_dict_message(value):
        return [value]
    return None


def _is_openai_shape_message(v: Any) -> bool:
    return isinstance(v, dict) and isinstance(v.get("role"), str)


# LangChain Python's ``BaseMessage.dict()`` serialization (used by the Langfuse
# PY callback for ChatAnthropic / LangGraph spans) drops the ``lc:1, type:
# "constructor"`` Serializable envelope and emits a flat dict tagged by a
# short ``type`` string ("human", "ai", "system", "tool", "function"). The JS
# SDK uses ``role`` for the same data, so neither the Serializable check nor
# the OpenAI-shape check catches these. Recognize them here so
# ``langchain_envelope_to_canonical`` can translate them through
# ``_langchain_plain_dict_to_message``.
def _is_langchain_plain_dict_message(v: Any) -> bool:
    if not isinstance(v, dict):
        return False
    t = v.get("type")
    if not isinstance(t, str):
        return False
    return t in ("human", "ai", "AIMessageChunk", "system", "tool", "function")


def langchain_envelope_to_canonical(raw: Any) -> Optional[list]:
    items = _unwrap_langchain_envelope(raw)
    if not items:
        return None
    out: list = []
    for item in items:
        msg = _langchain_serializable_to_message(item)
        if msg:
            out.append(msg)
    return out if out else None


def _langchain_serializable_to_message(item: Any) -> Optional[Message]:
    if not _is_langchain_message_serializable(item):
        # Lenient: accept plain ``{"role": ..., "content": ...}`` items mixed
        # with Serializables (the empirical __start__ envelope produces this).
        # And if the item carries a ``type`` matching a known LangChain
        # BaseMessage tag, route through the plain-dict translator (covers PY
        # callbacks that emit ``BaseMessage.dict()`` instead of the
        # Serializable envelope).
        if isinstance(item, dict):
            if isinstance(item.get("role"), str):
                return openai_message_to_canonical(item)
            if isinstance(item.get("type"), str) and _is_langchain_plain_dict_message(item):
                return _langchain_plain_dict_to_message(item)
        return None
    id_arr = item["id"]
    lc_type = str(id_arr[-1])
    kwargs = item.get("kwargs") if isinstance(item.get("kwargs"), dict) else {}
    content = kwargs.get("content")

    if lc_type == "HumanMessage":
        return _langchain_text_only_message("user", content)
    if lc_type == "SystemMessage":
        return _langchain_text_only_message("system", content)
    if lc_type in ("AIMessage", "AIMessageChunk"):
        parts = _ai_message_content_and_tool_calls_to_parts(content, kwargs.get("tool_calls"))
        if not parts:
            return None
        return {"role": "assistant", "parts": parts}
    if lc_type == "ToolMessage":
        call_id = kwargs.get("tool_call_id") if isinstance(kwargs.get("tool_call_id"), str) else None
        msg: Message = {
            "role": "tool",
            "parts": [tool_call_response_part(content if content is not None else None, call_id)],
        }
        if isinstance(kwargs.get("name"), str):
            msg["name"] = kwargs["name"]
        return msg
    if lc_type == "FunctionMessage":
        msg = {
            "role": "tool",
            "parts": [tool_call_response_part(content if content is not None else None, None)],
        }
        if isinstance(kwargs.get("name"), str):
            msg["name"] = kwargs["name"]
        return msg
    if lc_type == "ChatMessage":
        role = kwargs.get("role") if isinstance(kwargs.get("role"), str) else "user"
        return _langchain_text_only_message(role, content)
    return None


def _langchain_plain_dict_to_message(obj: dict) -> Optional[Message]:
    # ``langchain_core.messages.utils.messages_to_dict`` wraps each BaseMessage
    # as ``{"type": <role>, "data": {<actual fields>}}`` (used by LangGraph
    # state serialization and CHAIN-span output blobs). Descend into ``data``
    # so the flat-dict reader below finds ``content`` / ``tool_calls`` /
    # ``tool_call_id`` / ``name``. The plain ``BaseMessage.dict()`` shape has
    # no ``data`` key and falls through unchanged.
    data = obj.get("data")
    if isinstance(data, dict):
        obj = data
    t = str(obj.get("type"))
    content = obj.get("content")
    if t == "human":
        return _langchain_text_only_message("user", content)
    if t == "system":
        return _langchain_text_only_message("system", content)
    if t in ("ai", "AIMessageChunk"):
        parts = _ai_message_content_and_tool_calls_to_parts(content, obj.get("tool_calls"))
        if not parts:
            return None
        return {"role": "assistant", "parts": parts}
    if t == "tool":
        call_id = obj.get("tool_call_id") if isinstance(obj.get("tool_call_id"), str) else None
        msg: Message = {
            "role": "tool",
            "parts": [tool_call_response_part(content if content is not None else None, call_id)],
        }
        if isinstance(obj.get("name"), str):
            msg["name"] = obj["name"]
        return msg
    if t == "function":
        msg = {
            "role": "tool",
            "parts": [tool_call_response_part(content if content is not None else None, None)],
        }
        if isinstance(obj.get("name"), str):
            msg["name"] = obj["name"]
        return msg
    return None


def _langchain_text_only_message(role: str, content: Any) -> Optional[Message]:
    parts = _langchain_content_to_parts(content)
    if not parts:
        return None
    return {"role": role, "parts": parts}


def _langchain_content_to_parts(content: Any) -> list:
    if content is None:
        return []
    if isinstance(content, str):
        return [text_part(content)] if content else []
    if isinstance(content, list):
        out: list = []
        for item in content:
            if isinstance(item, str):
                if item:
                    out.append(text_part(item))
                continue
            if not isinstance(item, dict):
                continue
            t = item.get("type")
            if t == "text" and isinstance(item.get("text"), str):
                if item["text"]:
                    out.append(text_part(item["text"]))
                continue
            # Anthropic-shape inline tool call carried inside the content array.
            if t == "tool_use" and isinstance(item.get("name"), str):
                call_id = item.get("id") if isinstance(item.get("id"), str) else None
                out.append(tool_call_part(item["name"], item.get("input"), call_id))
                continue
            oai = _openai_content_part_to_canonical(item)
            if oai is not None:
                out.append(oai)
                continue
            if isinstance(t, str):
                out.append(generic_part(t, item))
        return out
    s = stringify_for_text(content)
    return [text_part(s)] if s else []


def _ai_message_content_and_tool_calls_to_parts(content: Any, tool_calls: Any) -> list:
    parts = _langchain_content_to_parts(content)
    seen_ids: set = set()
    for p in parts:
        if p.get("type") == "tool_call" and isinstance(p.get("id"), str):
            seen_ids.add(p["id"])
    if isinstance(tool_calls, list):
        for tc in tool_calls:
            if not isinstance(tc, dict):
                continue
            name = tc.get("name") if isinstance(tc.get("name"), str) else None
            if not name:
                continue
            call_id = tc.get("id") if isinstance(tc.get("id"), str) else None
            if call_id is not None and call_id in seen_ids:
                continue
            args = tc.get("args")
            if args is None:
                args = tc.get("arguments")
            parts.append(tool_call_part(name, args, call_id))
            if call_id is not None:
                seen_ids.add(call_id)
    return parts


def find_langchain_model_provider(raw: Any) -> Optional[str]:
    """Walk a LangChain envelope and return the first AIMessage's
    ``kwargs.response_metadata.model_provider`` (or ``additional_kwargs``
    fallback). Returns None when no AIMessage is present.
    """
    items = _unwrap_langchain_envelope(raw)
    if not items:
        return None
    for item in items:
        if not _is_langchain_message_serializable(item):
            continue
        id_arr = item["id"]
        lc_type = str(id_arr[-1])
        if lc_type not in ("AIMessage", "AIMessageChunk"):
            continue
        kwargs = item.get("kwargs") if isinstance(item.get("kwargs"), dict) else {}
        rm = kwargs.get("response_metadata")
        if isinstance(rm, dict):
            mp = rm.get("model_provider")
            if isinstance(mp, str) and mp:
                return mp
        ak = kwargs.get("additional_kwargs")
        if isinstance(ak, dict):
            mp = ak.get("model_provider")
            if isinstance(mp, str) and mp:
                return mp
    return None


# ── Span-event canonicalization ────────────────────────────────────────────

_GEN_AI_INPUT_EVENT_ROLES = {
    "gen_ai.system.message": "system",
    "gen_ai.user.message": "user",
    "gen_ai.assistant.message": "assistant",
    "gen_ai.tool.message": "tool",
}
_GEN_AI_OUTPUT_EVENT_NAME = "gen_ai.choice"


def canonicalize_gen_ai_events(events: Any) -> CanonicalMessages:
    """Refactor of legacy ``_unpack_gen_ai_events`` (in core.py) producing
    canonical ``Message[]`` instead of JSON strings. Used by the core
    ``resolve_canonical_messages`` chain as the events-based fallback.
    """
    if not events:
        return {"input": None, "output": None}

    inputs: list = []  # list[(ts, msg)]
    outputs: list = []
    events = list(events)
    for i, ev in enumerate(events):
        name = getattr(ev, "name", None)
        ts = getattr(ev, "timestamp", None) or i
        attrs = dict(getattr(ev, "attributes", None) or {})
        role = _GEN_AI_INPUT_EVENT_ROLES.get(name)
        if role is not None:
            inputs.append((ts, _event_attrs_to_message(role, attrs)))
            continue
        if name == _GEN_AI_OUTPUT_EVENT_NAME:
            ev_role = attrs.get("role") if isinstance(attrs.get("role"), str) else "assistant"
            msg = _event_attrs_to_message(ev_role, attrs)
            # Match TS `attrs.finish_reason ?? attrs["gen_ai.response.finish_reason"]`:
            # only fall through when finish_reason is missing (None), not when
            # key is present with a falsy non-None value.
            finish = attrs.get("finish_reason")
            if finish is None:
                finish = attrs.get("gen_ai.response.finish_reason")
            if isinstance(finish, str):
                msg["finish_reason"] = finish
            outputs.append((ts, msg))

    inputs.sort(key=lambda p: p[0])
    outputs.sort(key=lambda p: p[0])
    return {
        "input": [m for _, m in inputs] if inputs else None,
        "output": [m for _, m in outputs] if outputs else None,
    }


def _event_attrs_to_message(role: str, attrs: dict) -> Message:
    parts: list = []
    content = attrs.get("content")
    if role == "tool":
        call_id = attrs.get("id")
        if not isinstance(call_id, str):
            call_id = attrs.get("tool_call_id") if isinstance(attrs.get("tool_call_id"), str) else None
        parts.append(tool_call_response_part(content, call_id))
    elif isinstance(content, str) and content:
        parts.append(text_part(content))
    elif isinstance(content, list):
        for cp in content:
            p = _openai_content_part_to_canonical(cp)
            if p is not None:
                parts.append(p)
    elif content is not None:
        parts.append(text_part(stringify_for_text(content)))

    tool_calls = attrs.get("tool_calls")
    if isinstance(tool_calls, list):
        for tc in tool_calls:
            if not isinstance(tc, dict):
                continue
            fn = tc.get("function") or {}
            name = fn.get("name") if isinstance(fn, dict) else None
            if not isinstance(name, str):
                continue
            raw_args = fn.get("arguments") if isinstance(fn, dict) else None
            args = safe_json_parse(raw_args) if isinstance(raw_args, str) else raw_args
            if args is None and isinstance(raw_args, str):
                args = raw_args
            parts.append(tool_call_part(name, args, tc.get("id")))

    msg: Message = {"role": role, "parts": parts}
    if isinstance(attrs.get("name"), str):
        msg["name"] = attrs["name"]
    return msg


# ── Indexed-flat unpacker (shared core for openinference / traceloop / braintrust) ─


def unpack_indexed_messages(
    attrs: dict,
    prefix: str,
    inner_sep: str,
) -> Optional[list]:
    """Walk ``attrs`` for keys matching ``<prefix><idx><inner_sep><field>`` and
    group by ``<idx>``, producing one canonical ``Message`` per index.

    ``inner_sep`` is the empty string for direct ``.<field>`` form (traceloop /
    braintrust) or ``"message."`` for openinference's
    ``llm.input_messages.<n>.message.<field>`` form.
    """
    full_prefix = prefix if prefix.endswith(".") else prefix + "."
    grouped: dict[int, dict] = {}
    for key, value in attrs.items():
        if not key.startswith(full_prefix):
            continue
        rest = key[len(full_prefix):]
        dot = rest.find(".")
        if dot == -1:
            continue
        idx_str = rest[:dot]
        try:
            idx = int(idx_str)
        except ValueError:
            continue
        inner = rest[dot + 1:]
        if inner_sep:
            if not inner.startswith(inner_sep):
                continue
            inner = inner[len(inner_sep):]
        bucket = grouped.setdefault(idx, {})
        bucket[inner] = value

    if not grouped:
        return None

    return [
        _indexed_fields_to_message(grouped[idx])
        for idx in sorted(grouped.keys())
    ]


def _indexed_fields_to_message(fields: dict) -> Message:
    role = fields.get("role") if isinstance(fields.get("role"), str) else "user"
    parts: list = []
    content = fields.get("content")
    tool_call_id = fields.get("tool_call_id") or fields.get("tool_call.id")

    if role == "tool" and isinstance(tool_call_id, str):
        parts.append(tool_call_response_part(content, tool_call_id))
    elif isinstance(content, str) and content:
        parts.append(text_part(content))
    elif content is not None:
        parts.append(text_part(stringify_for_text(content)))

    for tc in _collect_indexed_tool_calls(fields):
        parts.append(tc)

    msg: Message = {"role": role, "parts": parts}
    if isinstance(fields.get("name"), str):
        msg["name"] = fields["name"]
    if isinstance(fields.get("finish_reason"), str):
        msg["finish_reason"] = fields["finish_reason"]
    return msg


def _collect_indexed_tool_calls(fields: dict) -> list:
    buckets: dict[int, dict] = {}
    for k, v in fields.items():
        if not k.startswith("tool_calls."):
            continue
        rest = k[len("tool_calls."):]
        dot = rest.find(".")
        if dot == -1:
            continue
        try:
            idx = int(rest[:dot])
        except ValueError:
            continue
        inner = rest[dot + 1:]
        if inner.startswith("tool_call."):
            inner = inner[len("tool_call."):]
        if inner.startswith("function."):
            inner = inner[len("function."):]
        buckets.setdefault(idx, {})[inner] = v

    if not buckets:
        return []

    out: list = []
    for idx in sorted(buckets.keys()):
        b = buckets[idx]
        name = b.get("name") if isinstance(b.get("name"), str) else None
        if not name:
            continue
        raw_args = b.get("arguments")
        args = safe_json_parse(raw_args) if isinstance(raw_args, str) else raw_args
        if args is None and isinstance(raw_args, str):
            args = raw_args
        call_id = b.get("id") if isinstance(b.get("id"), str) else None
        out.append(tool_call_part(name, args, call_id))
    return out


# ── Result helpers ─────────────────────────────────────────────────────────


def empty_canonical() -> CanonicalMessages:
    return {"input": None, "output": None}


def is_canonical_empty(m: Optional[CanonicalMessages]) -> bool:
    return not m or (m.get("input") is None and m.get("output") is None)
