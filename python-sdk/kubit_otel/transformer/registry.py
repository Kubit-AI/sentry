"""Registry of framework adapters in attribute-priority order.

Each adapter contributes its own alias tuples; ``core`` concatenates them at
import time to build the canonical ``MODEL_ATTRS``, ``INPUT_ATTRS``, … tuples.
The order here determines cross-framework priority when multiple emitters
set the same canonical field.

Currently shipped set (see ``docs/otel-mapping/README.md`` and the sibling
``frameworks/_disabled/`` directory for adapters kept in the repo but excluded
from the published wheel/sdist):

1. ``otel_genai`` — the standard. Most specific, most authoritative.
2. ``generic`` — short-name catch-alls (``model``, ``input``, ``output``).
3. ``langfuse`` — ``langfuse.*`` + usage/cost/params JSON blobs.
"""

from __future__ import annotations

from .frameworks import generic, langfuse, otel_genai

FRAMEWORKS = (
    otel_genai,
    generic,
    langfuse,
)
