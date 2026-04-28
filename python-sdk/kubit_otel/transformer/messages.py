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
            msg: Message = {"role": role, "parts": list(item["parts"])}
            msg.update(extras)
            out.append(msg)
            continue
        out.append(openai_message_to_canonical(item))
    return out


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
            finish = attrs.get("finish_reason") or attrs.get("gen_ai.response.finish_reason")
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
