"""Neutral replies of a TEST model to the auxiliary Adaptive-RAG prompts (docs/ADAPTIVE_RAG.md), so that tests about
the ANSWER keep seeing only the answer / tool-loop calls: a query rewrite gets «no phrasing» (the search runs as
before), an evidence-gap check gets «uncertain». The auxiliary calls are still recorded, separately."""

from __future__ import annotations

import json

from app.adapters.ai.gap_protocol import GAP_MARKER
from app.adapters.ai.rewrite_protocol import REWRITE_MARKER


def aux_reply(system_prompt: str) -> str | None:
    """The neutral raw reply for an auxiliary prompt, or None for any other (answer, tools, workflows) prompt."""
    if system_prompt.startswith(REWRITE_MARKER):
        return json.dumps({"queries": []})
    if system_prompt.startswith(GAP_MARKER):
        return json.dumps({"decision": "uncertain"})
    return None
