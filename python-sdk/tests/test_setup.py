"""Tests for :func:`kubit_otel.configure` and :func:`kubit_otel.attach`."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider


@pytest.fixture(autouse=True)
def _reset_global_tracer_provider():
    """
    The global TracerProvider is process-wide and latches on first set via
    ``_TRACER_PROVIDER_SET_ONCE``. Reset both the provider and the latch
    between tests so ordering doesn't leak state across cases.
    """
    import opentelemetry.trace as trace_mod

    original_provider = trace_mod._TRACER_PROVIDER  # type: ignore[attr-defined]
    original_once = trace_mod._TRACER_PROVIDER_SET_ONCE  # type: ignore[attr-defined]
    trace_mod._TRACER_PROVIDER = None  # type: ignore[attr-defined]
    trace_mod._TRACER_PROVIDER_SET_ONCE = trace_mod.Once()  # type: ignore[attr-defined]
    try:
        yield
    finally:
        trace_mod._TRACER_PROVIDER = original_provider  # type: ignore[attr-defined]
        trace_mod._TRACER_PROVIDER_SET_ONCE = original_once  # type: ignore[attr-defined]


def _silence_exporter():
    """Patch the exporter so configure() runs without instantiating an OTLP client."""
    return patch("kubit_otel.processor.KubitExporter", return_value=MagicMock())


class TestConfigureRegisterPath:
    """When no real provider is installed, configure() creates + registers one."""

    def test_registers_new_provider_when_none_present(self):
        from kubit_otel import configure

        with _silence_exporter():
            provider = configure(api_key="rg.v1.x.y", service_name="my-app")

        assert isinstance(provider, TracerProvider)
        assert trace.get_tracer_provider() is provider

    def test_registers_over_proxy_tracer_provider(self):
        from kubit_otel import configure

        assert isinstance(trace.get_tracer_provider(), trace.ProxyTracerProvider)

        with _silence_exporter():
            provider = configure(api_key="rg.v1.x.y", service_name="my-app")

        assert isinstance(provider, TracerProvider)
        assert trace.get_tracer_provider() is provider

    def test_new_provider_has_service_name_resource_attr(self):
        from kubit_otel import configure

        with _silence_exporter():
            provider = configure(
                api_key="rg.v1.x.y",
                service_name="my-app",
                service_version="1.2.3",
                resource_attributes={"deployment.environment": "prod"},
            )

        attrs = provider.resource.attributes  # type: ignore[union-attr]
        assert attrs["service.name"] == "my-app"
        assert attrs["service.version"] == "1.2.3"
        assert attrs["deployment.environment"] == "prod"

    def test_new_provider_stamps_kubit_sdk_identity(self):
        import kubit_otel
        from kubit_otel import configure

        with _silence_exporter():
            provider = configure(api_key="rg.v1.x.y", service_name="my-app")

        attrs = provider.resource.attributes  # type: ignore[union-attr]
        assert attrs["kubit.sdk.name"] == "kubit-otel-python"
        assert attrs["kubit.sdk.version"] == kubit_otel.__version__

    def test_user_resource_attributes_cannot_override_kubit_sdk_identity(self):
        import kubit_otel
        from kubit_otel import configure

        with _silence_exporter():
            provider = configure(
                api_key="rg.v1.x.y",
                service_name="my-app",
                resource_attributes={
                    "kubit.sdk.name": "evil-spoof",
                    "kubit.sdk.version": "999.0.0",
                },
            )

        attrs = provider.resource.attributes  # type: ignore[union-attr]
        assert attrs["kubit.sdk.name"] == "kubit-otel-python"
        assert attrs["kubit.sdk.version"] == kubit_otel.__version__


class TestConfigureAttachPath:
    """When a real provider is already installed, configure() attaches to it."""

    def test_reuses_existing_provider(self):
        from kubit_otel import configure

        existing = TracerProvider(resource=Resource.create({"service.name": "host-app"}))
        trace.set_tracer_provider(existing)

        with _silence_exporter():
            provider = configure(api_key="rg.v1.x.y", service_name="my-app")

        assert provider is existing
        assert trace.get_tracer_provider() is existing

    def test_does_not_replace_global_provider(self):
        from kubit_otel import configure

        existing = TracerProvider()
        trace.set_tracer_provider(existing)

        with _silence_exporter():
            configure(api_key="rg.v1.x.y", service_name="my-app")

        # Same instance, not a replacement.
        assert trace.get_tracer_provider() is existing

    def test_attaches_kubit_span_processor_to_existing(self):
        from kubit_otel import configure
        from kubit_otel.processor import KubitSpanProcessor

        existing = TracerProvider()
        trace.set_tracer_provider(existing)

        with _silence_exporter():
            configure(api_key="rg.v1.x.y", service_name="my-app")

        # Walk the processor chain — one KubitSpanProcessor should be attached.
        active = existing._active_span_processor  # type: ignore[attr-defined]
        span_procs = getattr(active, "_span_processors", [active])
        assert any(isinstance(p, KubitSpanProcessor) for p in span_procs)

    def test_resource_merge_our_attrs_win_on_collision(self):
        from kubit_otel import configure

        existing = TracerProvider(
            resource=Resource.create(
                {"service.name": "host-app", "deployment.environment": "dev"}
            )
        )
        trace.set_tracer_provider(existing)

        with _silence_exporter():
            configure(
                api_key="rg.v1.x.y",
                service_name="my-app",
                resource_attributes={"deployment.environment": "prod"},
            )

        attrs = existing.resource.attributes
        # Our attrs win on collision.
        assert attrs["service.name"] == "my-app"
        assert attrs["deployment.environment"] == "prod"

    def test_resource_merge_preserves_existing_keys(self):
        from kubit_otel import configure

        existing = TracerProvider(
            resource=Resource.create(
                {"host.name": "node-17", "telemetry.sdk.language": "python"}
            )
        )
        trace.set_tracer_provider(existing)

        with _silence_exporter():
            configure(api_key="rg.v1.x.y", service_name="my-app")

        attrs = existing.resource.attributes
        assert attrs["host.name"] == "node-17"
        assert attrs["telemetry.sdk.language"] == "python"
        assert attrs["service.name"] == "my-app"

    def test_resource_merge_stamps_kubit_sdk_identity(self):
        import kubit_otel
        from kubit_otel import configure

        existing = TracerProvider(
            resource=Resource.create({"service.name": "host-app"})
        )
        trace.set_tracer_provider(existing)

        with _silence_exporter():
            configure(api_key="rg.v1.x.y", service_name="my-app")

        attrs = existing.resource.attributes
        assert attrs["kubit.sdk.name"] == "kubit-otel-python"
        assert attrs["kubit.sdk.version"] == kubit_otel.__version__


class TestAttach:
    """attach() never registers — it only adds to an existing real provider."""

    def test_attach_adds_processor_to_existing_provider(self):
        from kubit_otel import attach
        from kubit_otel.processor import KubitSpanProcessor

        existing = TracerProvider()
        trace.set_tracer_provider(existing)

        with _silence_exporter():
            returned = attach(api_key="rg.v1.x.y")

        assert returned is existing
        active = existing._active_span_processor  # type: ignore[attr-defined]
        span_procs = getattr(active, "_span_processors", [active])
        assert any(isinstance(p, KubitSpanProcessor) for p in span_procs)

    def test_attach_raises_when_no_provider_present(self):
        from kubit_otel import attach

        assert isinstance(trace.get_tracer_provider(), trace.ProxyTracerProvider)

        with _silence_exporter():
            with pytest.raises(RuntimeError, match="already registered"):
                attach(api_key="rg.v1.x.y")


class TestMaskThreading:
    """The mask kwarg must reach the underlying KubitSpanProcessor on both code
    paths (register-fresh and attach-to-existing)."""

    def test_configure_threads_mask_into_processor(self):
        from kubit_otel import configure
        from kubit_otel.processor import KubitSpanProcessor

        def my_mask(span):
            return span

        with _silence_exporter():
            provider = configure(api_key="rg.v1.x.y", service_name="x", mask=my_mask)

        active = provider._active_span_processor  # type: ignore[attr-defined]
        span_procs = getattr(active, "_span_processors", [active])
        kubit_procs = [p for p in span_procs if isinstance(p, KubitSpanProcessor)]
        assert len(kubit_procs) == 1
        assert kubit_procs[0]._mask is my_mask  # type: ignore[attr-defined]

    def test_configure_default_mask_is_none(self):
        from kubit_otel import configure
        from kubit_otel.processor import KubitSpanProcessor

        with _silence_exporter():
            provider = configure(api_key="rg.v1.x.y")

        active = provider._active_span_processor  # type: ignore[attr-defined]
        span_procs = getattr(active, "_span_processors", [active])
        kubit_procs = [p for p in span_procs if isinstance(p, KubitSpanProcessor)]
        assert kubit_procs[0]._mask is None  # type: ignore[attr-defined]

    def test_attach_threads_mask_into_processor(self):
        from kubit_otel import attach
        from kubit_otel.processor import KubitSpanProcessor

        def my_mask(span):
            return span

        existing = TracerProvider()
        trace.set_tracer_provider(existing)

        with _silence_exporter():
            attach(api_key="rg.v1.x.y", mask=my_mask)

        active = existing._active_span_processor  # type: ignore[attr-defined]
        span_procs = getattr(active, "_span_processors", [active])
        kubit_procs = [p for p in span_procs if isinstance(p, KubitSpanProcessor)]
        assert kubit_procs[-1]._mask is my_mask  # type: ignore[attr-defined]
