"""Shared helpers used by the transformer core and framework adapters."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Optional


def first_attr(attrs: dict, keys: tuple[str, ...]) -> Any:
    """Return the first non-null value under any of ``keys`` in ``attrs``."""
    for key in keys:
        val = attrs.get(key)
        if val is not None:
            return val
    return None


def safe_int(val: Any) -> Optional[int]:
    if val is None:
        return None
    try:
        return int(val)
    except (ValueError, TypeError):
        return None


def safe_float(val: Any) -> Optional[float]:
    if val is None:
        return None
    try:
        return float(val)
    except (ValueError, TypeError):
        return None


def merge_json_blob(raw: Any, target: dict[str, Any]) -> None:
    """Parse ``raw`` as JSON and merge its top-level keys into ``target``.

    Existing keys on ``target`` win. Silently no-ops when the blob is
    missing, malformed, or not an object.
    """
    if not isinstance(raw, str) or not raw:
        return
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        return
    if not isinstance(parsed, dict):
        return
    for key, value in parsed.items():
        if value is None or key in target:
            continue
        target[key] = value


def clean_discriminator(raw: Any) -> str:
    """Trimmed lowercase form of a discriminator attribute, or ``""``."""
    if not isinstance(raw, str):
        return ""
    return raw.strip().lower()


def nanos_to_iso(nanos: Optional[int]) -> str:
    if not nanos:
        return now_iso()
    dt = datetime.fromtimestamp(nanos / 1e9, tz=timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def now_iso() -> str:
    dt = datetime.now(tz=timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"
