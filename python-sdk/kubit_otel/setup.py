"""
Convenience setup — one-liner to configure OTel with Kubit exporter.
"""

from __future__ import annotations

import logging
from typing import Optional
from urllib.parse import urlparse

from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider

from kubit_otel.credentials import DEFAULT_TOKEN_ENDPOINT
from kubit_otel.processor import KubitSpanProcessor
from kubit_otel.span_filter import ShouldExportSpan

logger = logging.getLogger(__name__)


def _build_resource(
    service_name: str,
    service_version: Optional[str],
    resource_attributes: Optional[dict],
) -> Resource:
    attrs: dict = {"service.name": service_name}
    if service_version:
        attrs["service.version"] = service_version
    if resource_attributes:
        attrs.update(resource_attributes)
    return Resource.create(attrs)


def _is_real_provider(provider: object) -> bool:
    """
    Whether ``provider`` is an SDK ``TracerProvider`` we can attach to.

    The OTel API's default global is ``ProxyTracerProvider``; libraries that
    haven't installed their own provider fall through to it. Duck-typing on
    ``add_span_processor`` covers ``ProxyTracerProvider``, ``NoopTracerProvider``,
    and any future shapes that aren't a real SDK provider.
    """
    return not isinstance(provider, trace.ProxyTracerProvider) and hasattr(
        provider, "add_span_processor"
    )


def _merge_resource_into_provider(
    provider: TracerProvider, our_resource: Resource
) -> None:
    """
    Merge our resource attrs into an existing provider's resource.

    ``TracerProvider`` has no public API to amend its resource post-construction;
    ``_resource`` is the de-facto stable attribute used by Langfuse, OpenLLMetry,
    and Arize for exactly this. On key collision, our attrs win (``merge(other)``
    lets ``other`` take precedence).
    """
    existing: Resource = getattr(provider, "_resource", None) or Resource.create({})
    provider._resource = existing.merge(our_resource)  # type: ignore[attr-defined]


def _log_token_host(token_endpoint: str) -> str:
    try:
        parsed = urlparse(token_endpoint)
        if parsed.scheme and parsed.netloc:
            return f"{parsed.scheme}://{parsed.netloc}"
    except Exception:
        pass
    return "<unparseable>"


def configure(
    api_key: str,
    *,
    service_name: str = "default",
    service_version: Optional[str] = None,
    token_endpoint: str = DEFAULT_TOKEN_ENDPOINT,
    resource_attributes: Optional[dict] = None,
    should_export_span: Optional[ShouldExportSpan] = None,
) -> TracerProvider:
    """
    Configure OpenTelemetry with the Kubit exporter.

    This is the simplest way to get started::

        from kubit_otel import configure
        configure(api_key="rg.v1.<payload>.<sig>", service_name="my-app")

        # All LLM-relevant spans now flow to Kubit.

    If another library (e.g. Langfuse) has already installed a real
    ``TracerProvider`` as global, this function attaches ``KubitSpanProcessor``
    to that provider and merges the supplied resource attributes into it — no
    replacement, so both SDKs coexist regardless of import order. Otherwise it
    creates a new provider and registers it as the global provider.

    Parameters
    ----------
    api_key : str
        Kubit API key (``rg.v1.<payload>.<sig>``).
    service_name : str
        Name of the service (maps to ``service.name`` resource attribute).
    service_version : str, optional
        Version of the service.
    token_endpoint : str
        URL of the credential endpoint.
    resource_attributes : dict, optional
        Additional OTel resource attributes to include.
    should_export_span : callable, optional
        Predicate deciding which spans are forwarded to Kubit. See
        :mod:`kubit_otel.span_filter`. Defaults to LLM-only filtering.

    Returns
    -------
    TracerProvider
        The provider now driving Kubit export — either the freshly-registered
        one or the pre-existing one we attached to.
    """
    our_resource = _build_resource(service_name, service_version, resource_attributes)
    processor = KubitSpanProcessor(
        api_key=api_key,
        token_endpoint=token_endpoint,
        should_export_span=should_export_span,
    )

    existing = trace.get_tracer_provider()
    if _is_real_provider(existing):
        provider: TracerProvider = existing  # type: ignore[assignment]
        _merge_resource_into_provider(provider, our_resource)
        provider.add_span_processor(processor)
        branch = "attached"
    else:
        provider = TracerProvider(resource=our_resource)
        provider.add_span_processor(processor)
        trace.set_tracer_provider(provider)  # type: ignore[arg-type]
        branch = "registered"

    logger.info(
        "kubit_otel configured  mode=%s service_name=%s service_version=%s token_host=%s",
        branch,
        service_name,
        service_version or "-",
        _log_token_host(token_endpoint),
    )

    return provider


def attach(
    api_key: str,
    *,
    token_endpoint: str = DEFAULT_TOKEN_ENDPOINT,
    should_export_span: Optional[ShouldExportSpan] = None,
) -> TracerProvider:
    """
    Attach ``KubitSpanProcessor`` to the currently-registered global provider.

    Unlike :func:`configure`, this never registers a new provider — it raises
    ``RuntimeError`` if no real SDK provider is in place yet. Intended for
    apps that let another library (Langfuse, OpenLLMetry, an OTel-distro, …)
    own provider setup and just want to add Kubit as another sink.

    Parameters
    ----------
    api_key : str
        Kubit API key (``rg.v1.<payload>.<sig>``).
    token_endpoint : str
        URL of the credential endpoint.
    should_export_span : callable, optional
        Predicate deciding which spans are forwarded to Kubit.

    Returns
    -------
    TracerProvider
        The existing global provider, with ``KubitSpanProcessor`` now attached.
    """
    existing = trace.get_tracer_provider()
    if not _is_real_provider(existing):
        raise RuntimeError(
            "kubit_otel.attach() requires a TracerProvider already registered "
            "as the global OTel provider. Call kubit_otel.configure() instead, "
            "or install a provider first (e.g. via Langfuse or opentelemetry-sdk)."
        )

    provider: TracerProvider = existing  # type: ignore[assignment]
    provider.add_span_processor(
        KubitSpanProcessor(
            api_key=api_key,
            token_endpoint=token_endpoint,
            should_export_span=should_export_span,
        )
    )
    logger.info(
        "kubit_otel attached  token_host=%s", _log_token_host(token_endpoint)
    )
    return provider
