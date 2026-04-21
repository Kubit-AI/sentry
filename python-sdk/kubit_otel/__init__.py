"""
kubit-otel — OpenTelemetry exporter for Kubit analytics.

Usage:
    from kubit_otel import configure
    configure(api_key="rg.v1.xxx", service_name="my-app")

Internal SDK log verbosity is controlled by the ``KUBIT_OTEL_LOG_LEVEL``
environment variable (debug | info | warning | error). If unset, the
``kubit_otel`` logger level is left untouched so downstream applications
can configure it themselves via the stdlib ``logging`` module.
"""

import logging
import os


def _install_env_log_level() -> None:
    """If KUBIT_OTEL_LOG_LEVEL is set, apply it to the ``kubit_otel`` logger."""
    level_name = os.environ.get("KUBIT_OTEL_LOG_LEVEL")
    if not level_name:
        return
    try:
        level = getattr(logging, level_name.upper())
    except AttributeError:
        return
    logging.getLogger("kubit_otel").setLevel(level)


_install_env_log_level()

from kubit_otel.exporter import KubitExporter
from kubit_otel.processor import KubitSpanProcessor
from kubit_otel.setup import configure

__all__ = [
    "KubitExporter",
    "KubitSpanProcessor",
    "configure",
]
__version__ = "0.3.0"
