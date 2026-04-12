"""
kubit-otel — OpenTelemetry exporter for Kubit analytics.

Usage:
    from kubit_otel import configure
    configure(api_key="rg.v1.xxx", service_name="my-app")
"""

from kubit_otel.exporter import KubitExporter
from kubit_otel.processor import KubitSpanProcessor
from kubit_otel.setup import configure

__all__ = ["KubitExporter", "KubitSpanProcessor", "configure"]
__version__ = "0.1.0"
