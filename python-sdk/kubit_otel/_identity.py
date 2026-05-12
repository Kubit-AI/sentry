"""
SDK identity constants shared by :mod:`kubit_otel.setup` and
:mod:`kubit_otel.processor`.

Lives in its own module so the processor can stamp ``kubit.sdk.*`` on every
span without creating a circular import (``setup`` already imports
``processor``).
"""

from __future__ import annotations

_SDK_NAME = "kubit-otel-python"


def _sdk_version() -> str:
    try:
        from importlib.metadata import version as _pkg_version

        return _pkg_version("kubit-otel")
    except Exception:
        return "0.0.0+unknown"
