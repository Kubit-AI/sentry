"""Tests for :class:`kubit_otel.processor.KubitSpanProcessor` filtering."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from opentelemetry.sdk.trace.export import BatchSpanProcessor


@pytest.fixture
def clean_otlp_env(monkeypatch):
    monkeypatch.delenv("KUBIT_OTEL_ENDPOINT", raising=False)


def _silence_exporter():
    """Replace KubitExporter with a MagicMock so no real network exporter is wired."""
    return patch("kubit_otel.processor.KubitExporter", return_value=MagicMock())


def _make_span():
    span = MagicMock(name="span")
    span.name = "test-span"
    span.instrumentation_scope = None
    return span


class TestSpanFiltering:
    def test_should_export_span_false_drops_span(self, clean_otlp_env):
        from kubit_otel.processor import KubitSpanProcessor

        with _silence_exporter():
            proc = KubitSpanProcessor(
                api_key="rg.v1.x.y",
                should_export_span=lambda _s: False,
            )

        with patch.object(BatchSpanProcessor, "on_end") as super_end:
            proc.on_end(_make_span())

        super_end.assert_not_called()

    def test_should_export_span_true_passes_through(self, clean_otlp_env):
        from kubit_otel.processor import KubitSpanProcessor

        with _silence_exporter():
            proc = KubitSpanProcessor(
                api_key="rg.v1.x.y",
                should_export_span=lambda _s: True,
            )

        with patch.object(BatchSpanProcessor, "on_end") as super_end:
            proc.on_end(_make_span())

        super_end.assert_called_once()

    def test_predicate_exception_drops_span(self, clean_otlp_env):
        from kubit_otel.processor import KubitSpanProcessor

        def boom(_s):
            raise RuntimeError("kaboom")

        with _silence_exporter():
            proc = KubitSpanProcessor(api_key="rg.v1.x.y", should_export_span=boom)

        with patch.object(BatchSpanProcessor, "on_end") as super_end:
            proc.on_end(_make_span())

        super_end.assert_not_called()

    def test_default_filter_used_when_none_provided(self, clean_otlp_env):
        from kubit_otel.processor import KubitSpanProcessor
        from kubit_otel.span_filter import is_default_export_span

        with _silence_exporter():
            proc = KubitSpanProcessor(api_key="rg.v1.x.y")

        # Implementation detail: when no predicate is supplied, the processor
        # falls back to is_default_export_span. Pin that wiring so silent
        # default-changes show up in this test rather than only in production.
        assert proc._should_export_span is is_default_export_span


class TestMaskIntegration:
    """
    Pipeline contract: shouldExportSpan → mask → re-stamp identity → super.on_end.
    These tests assert observable behavior (was super().on_end called? with
    what?), not internal calls into the mask module.
    """

    def test_mask_runs_after_filter_drops_dont_invoke_mask(self, clean_otlp_env):
        from kubit_otel.processor import KubitSpanProcessor

        mask_calls: list = []

        def mask(span):
            mask_calls.append(span)
            return span

        with _silence_exporter():
            proc = KubitSpanProcessor(
                api_key="rg.v1.x.y",
                should_export_span=lambda _s: False,
                mask=mask,
            )

        with patch.object(BatchSpanProcessor, "on_end") as super_end:
            proc.on_end(_make_span())

        super_end.assert_not_called()
        # No filter pass means no mask call — saves cycles on dropped spans.
        assert mask_calls == []

    def test_mask_called_when_filter_keeps_span(self, clean_otlp_env):
        from kubit_otel.processor import KubitSpanProcessor

        mask_calls: list = []

        def mask(span):
            mask_calls.append(span)
            return span

        with _silence_exporter():
            proc = KubitSpanProcessor(
                api_key="rg.v1.x.y",
                should_export_span=lambda _s: True,
                mask=mask,
            )

        span = _make_span()
        with patch.object(BatchSpanProcessor, "on_end") as super_end:
            proc.on_end(span)

        assert mask_calls == [span]
        super_end.assert_called_once()

    def test_mask_exception_tombstones_span_fail_closed(self, clean_otlp_env):
        # Fail-closed semantics: a mask that raises must never leak un-masked
        # data, AND must not break trace structure by dropping the span. The
        # processor emits a payload-free tombstone instead.
        from opentelemetry.trace.status import StatusCode

        from kubit_otel.processor import KubitSpanProcessor

        def boom(_s):
            raise RuntimeError("kaboom")

        with _silence_exporter():
            proc = KubitSpanProcessor(
                api_key="rg.v1.x.y",
                should_export_span=lambda _s: True,
                mask=boom,
            )

        with patch.object(BatchSpanProcessor, "on_end") as super_end:
            # Spy directly on the processor's logger — the `kubit_otel` logger
            # has propagate=False so pytest's caplog doesn't see it.
            with patch("kubit_otel.processor.logger.error") as log_error:
                proc.on_end(_make_span())

        # Tombstone delivered to BatchSpanProcessor, not dropped.
        super_end.assert_called_once()
        tombstone = super_end.call_args.args[0]
        assert tombstone.attributes["kubit.sdk.mask_error"] == "RuntimeError"
        assert tombstone.status.status_code == StatusCode.ERROR
        assert tombstone.status.description == "kubit-otel mask failed"
        # Payload-bearing fields wiped — no events, only the marker + the
        # re-stamped SDK identity (asserted in a dedicated test below).
        assert tuple(tombstone.events) == ()
        # The failure must surface in logs so a buggy mask is visible.
        log_error.assert_called_once()
        msg = log_error.call_args.args[0]
        assert "mask raised" in msg
        rendered = msg % log_error.call_args.args[1:]
        assert "test-span" in rendered
        assert "kaboom" in rendered

    def test_mask_returning_none_tombstones_span(self, clean_otlp_env):
        # None is a contract violation (drop via should_export_span instead).
        # Treat it like the exception path — tombstone rather than drop, so
        # children spans don't end up orphaned.
        from opentelemetry.trace.status import StatusCode

        from kubit_otel.processor import KubitSpanProcessor

        with _silence_exporter():
            proc = KubitSpanProcessor(
                api_key="rg.v1.x.y",
                should_export_span=lambda _s: True,
                mask=lambda _s: None,
            )

        with patch.object(BatchSpanProcessor, "on_end") as super_end:
            with patch("kubit_otel.processor.logger.error") as log_error:
                proc.on_end(_make_span())

        super_end.assert_called_once()
        tombstone = super_end.call_args.args[0]
        assert tombstone.attributes["kubit.sdk.mask_error"] == "returned_none"
        assert tombstone.status.status_code == StatusCode.ERROR
        log_error.assert_called_once()
        assert "mask returned None" in log_error.call_args.args[0]

    def test_tombstone_preserves_structure_and_restamps_sdk_identity(self, clean_otlp_env):
        # End-to-end: a mask failure on a real ReadableSpan must produce a
        # tombstone that (a) keeps name + trace/span IDs so the trace tree is
        # intact, (b) carries the SDK identity stamps via the force=True path,
        # (c) drops payload (events, original user attrs).
        from opentelemetry.sdk.trace import TracerProvider

        from kubit_otel._identity import _SDK_NAME, _sdk_version
        from kubit_otel.processor import KubitSpanProcessor
        from kubit_otel.span_filter import KUBIT_TRACER_NAME

        def boom(_s):
            raise ValueError("oops")

        captured: list = []

        with _silence_exporter():
            proc = KubitSpanProcessor(
                api_key="rg.v1.x.y",
                should_export_span=lambda _s: True,
                mask=boom,
            )

        provider = TracerProvider()
        provider.add_span_processor(proc)
        tracer = provider.get_tracer(KUBIT_TRACER_NAME)

        original_super_on_end = BatchSpanProcessor.on_end

        def capture(self, span):
            captured.append(span)
            return original_super_on_end(self, span)

        with patch.object(BatchSpanProcessor, "on_end", capture):
            with tracer.start_as_current_span("user-op") as s:
                s.set_attribute("gen_ai.prompt", "ssn 111-22-3333")
                s.add_event("gen_ai.user.message", {"content": "secret"})
                trace_id = s.get_span_context().trace_id
                span_id = s.get_span_context().span_id

        assert len(captured) == 1
        tombstone = captured[0]
        # Structure preserved.
        assert tombstone.name == "user-op"
        assert tombstone.context.trace_id == trace_id
        assert tombstone.context.span_id == span_id
        # Payload wiped.
        attrs = dict(tombstone.attributes or {})
        assert "gen_ai.prompt" not in attrs
        assert tuple(tombstone.events) == ()
        # Marker + SDK identity present (re-stamp ran on force=True path).
        assert attrs["kubit.sdk.mask_error"] == "ValueError"
        assert attrs["kubit.sdk.name"] == _SDK_NAME
        assert attrs["kubit.sdk.version"] == _sdk_version()

    def test_masked_span_is_what_super_receives(self, clean_otlp_env):
        from kubit_otel.processor import KubitSpanProcessor

        replacement = MagicMock(name="replacement_span")
        replacement.name = "replaced"
        # Re-stamp helper writes through _attributes; give the mock a dict.
        replacement._attributes = {}

        with _silence_exporter():
            proc = KubitSpanProcessor(
                api_key="rg.v1.x.y",
                should_export_span=lambda _s: True,
                mask=lambda _s: replacement,
            )

        with patch.object(BatchSpanProcessor, "on_end") as super_end:
            proc.on_end(_make_span())

        super_end.assert_called_once_with(replacement)

    def test_no_mask_configured_passes_span_through_unchanged(self, clean_otlp_env):
        # Regression: when mask is None, on_end still delegates to
        # BatchSpanProcessor with the same span identity (the fill-if-missing
        # identity stamp runs but does not replace the span object).
        from kubit_otel.processor import KubitSpanProcessor

        with _silence_exporter():
            proc = KubitSpanProcessor(
                api_key="rg.v1.x.y",
                should_export_span=lambda _s: True,
            )

        span = _make_span()
        with patch.object(BatchSpanProcessor, "on_end") as super_end:
            proc.on_end(span)

        super_end.assert_called_once_with(span)


class TestMaskIdentityReStamp:
    """End-to-end via the real TracerProvider — the only way to exercise the
    full filter → mask → re-stamp → queue path against a real ReadableSpan."""

    def test_overzealous_mask_cannot_strip_kubit_sdk_identity(self, clean_otlp_env):
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider

        from kubit_otel._identity import _SDK_NAME, _sdk_version
        from kubit_otel.mask import delete_attr
        from kubit_otel.processor import KubitSpanProcessor
        from kubit_otel.span_filter import KUBIT_TRACER_NAME

        def mask(span):
            # Simulate an aggressive user mask that deletes everything except
            # what they explicitly allow-list. kubit.sdk.* gets swept up.
            delete_attr(span, "kubit.sdk.name")
            delete_attr(span, "kubit.sdk.version")
            return span

        captured: list = []

        with patch(
            "kubit_otel.processor.KubitExporter",
            return_value=MagicMock(),
        ):
            proc = KubitSpanProcessor(
                api_key="rg.v1.x.y",
                should_export_span=lambda _s: True,
                mask=mask,
            )

        provider = TracerProvider(
            resource=Resource.create({"service.name": "user-app"})
        )
        provider.add_span_processor(proc)

        # Capture what BatchSpanProcessor.on_end actually receives.
        original_super_on_end = BatchSpanProcessor.on_end

        def capture(self, span):
            captured.append(dict(span.attributes or {}))
            return original_super_on_end(self, span)

        tracer = provider.get_tracer(KUBIT_TRACER_NAME)
        with patch.object(BatchSpanProcessor, "on_end", capture):
            with tracer.start_as_current_span("op"):
                pass

        assert len(captured) == 1
        attrs = captured[0]
        # Even though the mask deleted them, Cylon's identification keys must
        # ship — this is the load-bearing invariant the re-stamp protects.
        assert attrs["kubit.sdk.name"] == _SDK_NAME
        assert attrs["kubit.sdk.version"] == _sdk_version()

    def test_mask_can_rewrite_user_attributes_and_they_ship(self, clean_otlp_env):
        from opentelemetry.sdk.trace import TracerProvider

        from kubit_otel.mask import set_attr
        from kubit_otel.processor import KubitSpanProcessor
        from kubit_otel.span_filter import KUBIT_TRACER_NAME

        def mask(span):
            set_attr(span, "gen_ai.prompt", "[REDACTED]")
            return span

        captured: list = []

        with patch(
            "kubit_otel.processor.KubitExporter",
            return_value=MagicMock(),
        ):
            proc = KubitSpanProcessor(
                api_key="rg.v1.x.y",
                should_export_span=lambda _s: True,
                mask=mask,
            )

        provider = TracerProvider()
        provider.add_span_processor(proc)
        tracer = provider.get_tracer(KUBIT_TRACER_NAME)

        original_super_on_end = BatchSpanProcessor.on_end

        def capture(self, span):
            captured.append(dict(span.attributes or {}))
            return original_super_on_end(self, span)

        with patch.object(BatchSpanProcessor, "on_end", capture):
            with tracer.start_as_current_span("op") as s:
                s.set_attribute("gen_ai.prompt", "card 4111-1111-1111-1111")

        assert captured[0]["gen_ai.prompt"] == "[REDACTED]"

    def test_mask_events_drops_event_end_to_end(self, clean_otlp_env):
        # End-to-end coverage for the second OTel-GenAI-v2 redaction shape:
        # prompts/completions live in span *events*, not attributes. Verify
        # that ``mask_events`` removes the targeted event from what reaches
        # ``BatchSpanProcessor.on_end``.
        from opentelemetry.sdk.trace import TracerProvider

        from kubit_otel.mask import mask_events
        from kubit_otel.processor import KubitSpanProcessor
        from kubit_otel.span_filter import KUBIT_TRACER_NAME

        def mask(span):
            mask_events(
                span, lambda e: None if e.name == "gen_ai.user.message" else e,
            )
            return span

        captured: list = []

        with patch(
            "kubit_otel.processor.KubitExporter",
            return_value=MagicMock(),
        ):
            proc = KubitSpanProcessor(
                api_key="rg.v1.x.y",
                should_export_span=lambda _s: True,
                mask=mask,
            )

        provider = TracerProvider()
        provider.add_span_processor(proc)
        tracer = provider.get_tracer(KUBIT_TRACER_NAME)

        original_super_on_end = BatchSpanProcessor.on_end

        def capture(self, span):
            captured.append([e.name for e in (span.events or [])])
            return original_super_on_end(self, span)

        with patch.object(BatchSpanProcessor, "on_end", capture):
            with tracer.start_as_current_span("op") as s:
                s.add_event("gen_ai.user.message", {"content": "ssn 111-22-3333"})
                s.add_event("gen_ai.assistant.message", {"content": "ok"})

        assert captured == [["gen_ai.assistant.message"]]


class TestKubitSdkIdentityStamping:
    def test_on_start_stamps_kubit_sdk_attrs(self, clean_otlp_env):
        # Provider whose Resource intentionally lacks kubit.sdk.* — mirrors a
        # user who assembles their own TracerProvider and just plugs
        # KubitSpanProcessor in via add_span_processor().
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider

        from kubit_otel._identity import _SDK_NAME, _sdk_version
        from kubit_otel.processor import KubitSpanProcessor

        provider = TracerProvider(
            resource=Resource.create({"service.name": "user-app"})
        )
        with _silence_exporter():
            provider.add_span_processor(KubitSpanProcessor(api_key="rg.v1.x.y"))

        tracer = provider.get_tracer("test")
        with tracer.start_as_current_span("op") as span:
            attrs = dict(span.attributes or {})

        assert attrs["kubit.sdk.name"] == _SDK_NAME
        assert attrs["kubit.sdk.version"] == _sdk_version()

    def test_on_end_fills_kubit_sdk_attrs_when_on_start_was_bypassed(
        self, clean_otlp_env,
    ):
        # Mirrors bridge-exporter integrations (e.g. a KubitMastraExporter that
        # synthesizes a ReadableSpan and calls ``on_end`` directly) — the
        # ``on_start`` hook never runs, so attributes must be stamped
        # defensively in ``on_end``.
        from kubit_otel._identity import _SDK_NAME, _sdk_version
        from kubit_otel.processor import KubitSpanProcessor

        with _silence_exporter():
            proc = KubitSpanProcessor(
                api_key="rg.v1.x.y",
                should_export_span=lambda _s: True,
            )

        span = _make_span()
        # Simulate a freshly-synthesized ReadableSpan with no Kubit identity.
        span._attributes = {}

        with patch.object(BatchSpanProcessor, "on_end"):
            proc.on_end(span)

        assert span._attributes["kubit.sdk.name"] == _SDK_NAME
        assert span._attributes["kubit.sdk.version"] == _sdk_version()

    def test_on_end_does_not_overwrite_preset_kubit_sdk_attrs_without_mask(
        self, clean_otlp_env,
    ):
        # Without a mask the no-mask path is fill-if-missing only; a span that
        # already carries explicit values must keep them.
        from kubit_otel.processor import KubitSpanProcessor

        with _silence_exporter():
            proc = KubitSpanProcessor(
                api_key="rg.v1.x.y",
                should_export_span=lambda _s: True,
            )

        span = _make_span()
        span._attributes = {
            "kubit.sdk.name": "preset",
            "kubit.sdk.version": "0.0.0-test",
        }

        with patch.object(BatchSpanProcessor, "on_end"):
            proc.on_end(span)

        assert span._attributes["kubit.sdk.name"] == "preset"
        assert span._attributes["kubit.sdk.version"] == "0.0.0-test"
