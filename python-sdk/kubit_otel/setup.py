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
from opentelemetry.sdk.trace.export import BatchSpanProcessor

from kubit_otel.exporter import KubitExporter
from kubit_otel.credentials import DEFAULT_TOKEN_ENDPOINT

logger = logging.getLogger(__name__)


def configure(
    api_key: str,
    *,
    service_name: str = "default",
    service_version: Optional[str] = None,
    token_endpoint: str = DEFAULT_TOKEN_ENDPOINT,
    resource_attributes: Optional[dict] = None,
) -> TracerProvider:
    """
    Configure OpenTelemetry with the Kubit exporter.

    This is the simplest way to get started::

        from kubit_otel import configure
        configure(api_key="rg.v1.<payload>.<sig>", service_name="my-app")

        # All spans from any tracer now flow to Kubit.

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

    Returns
    -------
    TracerProvider
        The configured provider (also registered as global provider).
    """
    attrs: dict = {"service.name": service_name}

    if service_version:
        attrs["service.version"] = service_version
    if resource_attributes:
        attrs.update(resource_attributes)

    resource = Resource.create(attrs)
    provider = TracerProvider(resource=resource)

    exporter = KubitExporter(
        api_key=api_key,
        token_endpoint=token_endpoint,
    )
    provider.add_span_processor(BatchSpanProcessor(exporter))

    trace.set_tracer_provider(provider)  # type: ignore[arg-type]

    token_host = "<unparseable>"
    try:
        parsed = urlparse(token_endpoint)
        if parsed.scheme and parsed.netloc:
            token_host = f"{parsed.scheme}://{parsed.netloc}"
    except Exception:
        pass

    logger.info(
        "kubit_otel configured  service_name=%s service_version=%s token_host=%s",
        service_name,
        service_version or "-",
        token_host,
    )

    return provider
