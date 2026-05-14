"""
kubit-otel — OpenTelemetry exporter for Kubit analytics.

Usage:
    from kubit_otel import configure
    configure(api_key="rg.v1.xxx", service_name="my-app")

Internal SDK log verbosity is controlled by the ``KUBIT_OTEL_LOG_LEVEL``
environment variable (``debug`` | ``info`` | ``warn`` | ``warning`` |
``error``). Defaults to ``info`` if unset — matching the Node SDK.
Messages are written to ``sys.stderr`` with a ``[kubit-otel <level>]``
prefix by a dedicated handler. The ``kubit_otel`` logger does not
propagate to root, so the SDK never double-logs when an application also
configures root-level logging.
"""

import logging
import os
import sys


_LEVELS = {
    "debug": logging.DEBUG,
    "info": logging.INFO,
    "warn": logging.WARNING,
    "warning": logging.WARNING,
    "error": logging.ERROR,
}

_HANDLER_MARKER = "_kubit_otel_default_handler"


def _resolve_level() -> int:
    raw = (os.environ.get("KUBIT_OTEL_LOG_LEVEL") or "info").lower()
    return _LEVELS.get(raw, logging.INFO)


class _KubitFormatter(logging.Formatter):
    """Render records as ``[kubit-otel <level>] <message>`` (Node parity)."""

    def format(self, record: logging.LogRecord) -> str:
        level = record.levelname.lower()
        if level == "warning":
            level = "warn"
        return f"[kubit-otel {level}] {record.getMessage()}"


def _install_logging() -> None:
    """
    Configure the ``kubit_otel`` logger to mirror the Node SDK:
    default-on ``info`` level, dedicated stderr handler with the
    ``[kubit-otel <level>]`` prefix, no propagation to root. Idempotent.
    """
    logger = logging.getLogger("kubit_otel")
    logger.setLevel(_resolve_level())
    if not any(
        getattr(h, _HANDLER_MARKER, False) for h in logger.handlers
    ):
        handler = logging.StreamHandler(sys.stderr)
        handler.setFormatter(_KubitFormatter())
        setattr(handler, _HANDLER_MARKER, True)
        logger.addHandler(handler)
    logger.propagate = False


_install_logging()

from kubit_otel.exporter import KubitExporter
from kubit_otel.mask import MaskEventFn, MaskSpan
from kubit_otel.processor import KubitSpanProcessor
from kubit_otel.setup import attach, configure
from kubit_otel.span_filter import (
    KNOWN_LLM_INSTRUMENTATION_SCOPE_PREFIXES,
    KUBIT_TRACER_NAME,
    ShouldExportSpan,
    is_default_export_span,
    is_genai_span,
    is_known_llm_instrumentor,
    is_kubit_span,
)

__all__ = [
    "KubitExporter",
    "KubitSpanProcessor",
    "attach",
    "configure",
    "MaskEventFn",
    "MaskSpan",
    "KNOWN_LLM_INSTRUMENTATION_SCOPE_PREFIXES",
    "KUBIT_TRACER_NAME",
    "ShouldExportSpan",
    "is_default_export_span",
    "is_genai_span",
    "is_known_llm_instrumentor",
    "is_kubit_span",
]

try:
    from importlib.metadata import version as _pkg_version

    __version__ = _pkg_version("kubit-otel")
except Exception:
    __version__ = "0.0.0+unknown"
