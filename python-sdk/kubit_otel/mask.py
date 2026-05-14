"""
Helpers for writing a ``mask`` function for :class:`kubit_otel.KubitSpanProcessor`.

A mask function lets the user redact, rewrite, or drop sensitive content from a
span *before* it is queued for export. It is configured per processor::

    from kubit_otel import configure
    from kubit_otel.mask import set_attr, delete_attr, mask_events

    def mask(span):
        set_attr(span, "gen_ai.prompt", "[REDACTED]")
        delete_attr(span, "http.request.body")
        mask_events(span, lambda e: None if e.name == "gen_ai.user.message" else e)
        return span

    configure(api_key="rg.v1.xxx", mask=mask)

The helpers in this module are the only supported way to mutate a
``ReadableSpan`` from within a mask function — they encapsulate the OTel-private
attribute access so user code stays portable across OTel SDK versions.

Pipeline ordering inside :class:`KubitSpanProcessor.on_end`::

    should_export_span → mask → re-stamp kubit.sdk.{name,version} → BatchSpanProcessor

The mask function:

- must be **synchronous** (OTel's ``on_end`` is sync; coroutines are not awaited)
- must not perform I/O or network calls (it runs on the producer thread)
- must return a :class:`ReadableSpan` (typically the same one it received, mutated
  in place via these helpers)
- if it raises, the SDK **drops the span and error-logs**; un-masked data is
  never shipped (fail-closed)

To drop a span outright, use ``should_export_span`` instead — mask is a transform,
not a filter.

**Bare ``KubitExporter`` consumers do not inherit masking.** Masking lives in
``KubitSpanProcessor`` so dropped spans never enter the batch queue. Users who
wrap ``KubitExporter`` in their own ``SpanProcessor`` must apply the mask in
that processor.
"""

from __future__ import annotations

from typing import Any, Callable, Optional, Union

from opentelemetry.sdk.trace import Event, ReadableSpan

__all__ = [
    "MaskSpan",
    "MaskEventFn",
    "set_attr",
    "delete_attr",
    "mask_events",
]


MaskSpan = Callable[[ReadableSpan], ReadableSpan]
"""Type of the ``mask`` callable passed to :class:`KubitSpanProcessor`."""

MaskEventFn = Callable[[Event], Optional[Event]]
"""Per-event callback used with :func:`mask_events`."""


_AttrTarget = Union[ReadableSpan, Event]


def _ensure_mutable_attrs(target: _AttrTarget) -> dict:
    """
    Return a mutable mapping for ``target._attributes``, replacing immutable
    fillers (``None``, frozen mapping proxies) with a fresh ``dict`` so the
    caller can ``__setitem__`` / ``__delitem__`` on it.

    OTel's ``BoundedAttributes`` is mutable in place; ``None`` (events with no
    initial attrs) is replaced; everything else is wrapped into a dict copy on
    first write so we never silently fail.
    """
    attrs = getattr(target, "_attributes", None)
    if attrs is None:
        new: dict = {}
        target._attributes = new  # type: ignore[attr-defined]
        return new
    try:
        attrs["__kubit_probe__"] = None  # type: ignore[index]
        del attrs["__kubit_probe__"]  # type: ignore[index]
        return attrs  # type: ignore[return-value]
    except Exception:
        new = dict(attrs)
        target._attributes = new  # type: ignore[attr-defined]
        return new


def set_attr(target: _AttrTarget, key: str, value: Any) -> None:
    """
    Overwrite or add an attribute on a span or an event.

    ``target`` may be a :class:`ReadableSpan` or an :class:`Event` (the same
    helper covers both surfaces). ``value`` should be an OTel-compatible type
    (str, int, float, bool, or a homogeneous sequence of one of those).

    No-op-ness is not enforced: passing ``None`` writes ``None``. If you mean
    "remove this attribute" use :func:`delete_attr`.
    """
    attrs = _ensure_mutable_attrs(target)
    attrs[key] = value


def delete_attr(target: _AttrTarget, key: str) -> None:
    """
    Remove an attribute from a span or an event. No-op if the key is absent.
    """
    attrs = getattr(target, "_attributes", None)
    if not attrs:
        return
    try:
        del attrs[key]  # type: ignore[index]
    except KeyError:
        return
    except Exception:
        # Underlying mapping doesn't support __delitem__ (rare). Fall back to
        # a fresh dict that omits the key.
        new = {k: v for k, v in dict(attrs).items() if k != key}
        target._attributes = new  # type: ignore[attr-defined]


def mask_events(span: ReadableSpan, fn: MaskEventFn) -> None:
    """
    Apply ``fn`` to every event on ``span``.

    ``fn`` receives an :class:`Event` and must return either:

    - the same event (optionally mutated via :func:`set_attr` / :func:`delete_attr`)
    - a new :class:`Event` instance to substitute
    - ``None`` to drop the event entirely

    The span's underlying events sequence is rewritten in place with the result.
    Order is preserved for kept events.
    """
    raw = getattr(span, "_events", None)
    if not raw:
        return
    # If `fn` raises mid-iteration, the exception propagates *before* we
    # rewrite `span._events`, so the outer mask path's fail-closed handler
    # drops the whole span — half-masked events never ship.
    kept: list = []
    for event in list(raw):
        replacement = fn(event)
        if replacement is None:
            continue
        kept.append(replacement)
    span._events = kept  # type: ignore[attr-defined]
