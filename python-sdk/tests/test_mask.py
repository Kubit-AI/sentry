"""Unit tests for :mod:`kubit_otel.mask` helpers."""

from __future__ import annotations

import pytest
from opentelemetry.attributes import BoundedAttributes
from opentelemetry.sdk.trace import Event, ReadableSpan

from kubit_otel.mask import delete_attr, mask_events, set_attr


# ----------------------------------------------------------------------------
# Fakes — small enough to fit a single screen, but they expose the same
# private fields (``_attributes``, ``_events``) the real OTel ReadableSpan
# uses. Tests assert through the public ``.attributes`` / ``.events`` APIs so
# they survive any future OTel internals change.
# ----------------------------------------------------------------------------


def _fake_span(attrs=None, events=None) -> ReadableSpan:
    """
    Build a real ReadableSpan with the supplied attributes and events.

    Using the real class (not a duck) is important — the helpers depend on the
    exact private-attribute names, and exercising them against the genuine
    class is the only way to catch breakage when OTel renames internals.
    """
    return ReadableSpan(
        name="op",
        attributes=attrs,
        events=events or (),
    )


def _ev(name: str, attrs=None) -> Event:
    return Event(name=name, attributes=attrs)


# ----------------------------------------------------------------------------
# set_attr
# ----------------------------------------------------------------------------


class TestSetAttr:
    def test_adds_attribute_to_span_with_no_initial_attrs(self):
        span = _fake_span()
        set_attr(span, "gen_ai.prompt", "hi")
        assert span.attributes["gen_ai.prompt"] == "hi"

    def test_overwrites_existing_span_attribute(self):
        span = _fake_span({"gen_ai.prompt": "secret"})
        set_attr(span, "gen_ai.prompt", "[REDACTED]")
        assert span.attributes["gen_ai.prompt"] == "[REDACTED]"

    def test_works_with_bounded_attributes_backing_storage(self):
        # Spans built by the real TracerProvider use BoundedAttributes — make
        # sure the helper mutates it in place without falling back to a copy.
        ba = BoundedAttributes(attributes={"a": 1})
        span = _fake_span(ba)
        set_attr(span, "b", 2)
        assert span.attributes["a"] == 1
        assert span.attributes["b"] == 2

    def test_writes_to_event_attributes(self):
        ev = _ev("e1", {"keep": True})
        set_attr(ev, "added", "x")
        assert ev.attributes["keep"] is True
        assert ev.attributes["added"] == "x"

    def test_writes_to_event_with_no_initial_attributes(self):
        ev = _ev("e1", None)
        set_attr(ev, "k", "v")
        assert ev.attributes["k"] == "v"

    def test_accepts_non_string_values(self):
        span = _fake_span()
        set_attr(span, "i", 42)
        set_attr(span, "f", 3.14)
        set_attr(span, "b", False)
        set_attr(span, "seq", ("a", "b"))
        assert span.attributes["i"] == 42
        assert span.attributes["f"] == 3.14
        assert span.attributes["b"] is False
        assert span.attributes["seq"] == ("a", "b")


# ----------------------------------------------------------------------------
# delete_attr
# ----------------------------------------------------------------------------


class TestDeleteAttr:
    def test_removes_present_key_from_span(self):
        span = _fake_span({"gen_ai.prompt": "secret", "keep": 1})
        delete_attr(span, "gen_ai.prompt")
        assert "gen_ai.prompt" not in span.attributes
        assert span.attributes["keep"] == 1

    def test_absent_key_is_noop(self):
        span = _fake_span({"keep": 1})
        delete_attr(span, "missing")
        assert dict(span.attributes) == {"keep": 1}

    def test_none_attributes_is_noop(self):
        span = _fake_span(None)
        delete_attr(span, "anything")  # must not raise

    def test_removes_from_event(self):
        ev = _ev("e", {"a": 1, "b": 2})
        delete_attr(ev, "a")
        assert dict(ev.attributes or {}) == {"b": 2}

    def test_removes_from_bounded_attributes_in_place(self):
        # Cylon's identification guarantees rest on the assumption that the
        # processor's post-mask re-stamp can re-add an attribute the user
        # just deleted via this helper. Lock in that delete actually clears
        # the key from BoundedAttributes (not just from a shadow dict).
        ba = BoundedAttributes(attributes={"kubit.sdk.name": "x", "keep": 1})
        span = _fake_span(ba)
        delete_attr(span, "kubit.sdk.name")
        assert "kubit.sdk.name" not in span.attributes


# ----------------------------------------------------------------------------
# mask_events
# ----------------------------------------------------------------------------


class TestMaskEvents:
    def test_keeps_all_events_when_fn_returns_same(self):
        span = _fake_span(events=[_ev("a"), _ev("b")])
        mask_events(span, lambda e: e)
        assert [e.name for e in span.events] == ["a", "b"]

    def test_drops_events_for_which_fn_returns_none(self):
        span = _fake_span(events=[_ev("keep"), _ev("drop"), _ev("keep2")])
        mask_events(span, lambda e: None if e.name == "drop" else e)
        assert [e.name for e in span.events] == ["keep", "keep2"]

    def test_preserves_order(self):
        span = _fake_span(events=[_ev("a"), _ev("b"), _ev("c"), _ev("d")])
        mask_events(span, lambda e: None if e.name in ("a", "c") else e)
        assert [e.name for e in span.events] == ["b", "d"]

    def test_dropping_all_events_leaves_empty_sequence(self):
        span = _fake_span(events=[_ev("a"), _ev("b")])
        mask_events(span, lambda _e: None)
        assert list(span.events) == []

    def test_no_events_is_noop(self):
        span = _fake_span(events=[])
        mask_events(span, lambda e: e)
        assert list(span.events) == []

    def test_can_mutate_event_attributes_inside_callback(self):
        ev = _ev("e1", {"secret": "abc", "keep": 1})

        def fn(event):
            delete_attr(event, "secret")
            set_attr(event, "redacted", True)
            return event

        span = _fake_span(events=[ev])
        mask_events(span, fn)
        out = span.events[0]
        assert "secret" not in (out.attributes or {})
        assert (out.attributes or {})["redacted"] is True
        assert (out.attributes or {})["keep"] == 1

    def test_can_substitute_with_new_event(self):
        replacement = _ev("replaced")
        span = _fake_span(events=[_ev("orig")])
        mask_events(span, lambda _e: replacement)
        assert [e.name for e in span.events] == ["replaced"]

    def test_exception_in_callback_propagates_to_caller(self):
        # The outer mask path catches the exception and drops the span; if
        # mask_events swallowed it, half-masked events could ship.
        span = _fake_span(events=[_ev("a"), _ev("b")])

        def fn(_e):
            raise RuntimeError("kaboom")

        with pytest.raises(RuntimeError):
            mask_events(span, fn)


# ----------------------------------------------------------------------------
# End-to-end helper composition — simulates a realistic mask function shape so
# the docstring examples are exercised by CI.
# ----------------------------------------------------------------------------


class TestHelperComposition:
    def test_credit_card_style_redaction(self):
        span = _fake_span(
            {"gen_ai.prompt": "card 4111-1111-1111-1111", "gen_ai.model": "gpt-4"}
        )
        import re

        cc = re.compile(r"\b(?:\d[ -]*?){13,19}\b")
        prompt = span.attributes.get("gen_ai.prompt") or ""
        set_attr(span, "gen_ai.prompt", cc.sub("[REDACTED CC]", prompt))
        assert "4111" not in span.attributes["gen_ai.prompt"]
        assert "[REDACTED CC]" in span.attributes["gen_ai.prompt"]
        assert span.attributes["gen_ai.model"] == "gpt-4"

    def test_drop_genai_user_message_events(self):
        span = _fake_span(
            events=[
                _ev("gen_ai.user.message", {"content": "ssn 111-22-3333"}),
                _ev("gen_ai.assistant.message", {"content": "ok"}),
            ]
        )
        mask_events(
            span,
            lambda e: None if e.name == "gen_ai.user.message" else e,
        )
        names = [e.name for e in span.events]
        assert names == ["gen_ai.assistant.message"]
