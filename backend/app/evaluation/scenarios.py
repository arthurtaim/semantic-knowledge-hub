"""Lifecycle evaluation scenarios (add / update / delete / rename / templates) for knowledge_eval.

Each scenario runs on its own copy of a snapshot from backend/tests/fixtures/knowledge_updates and is
registered in `knowledge_eval.SCENARIO_METHODS` under the case `method` name.
"""

from __future__ import annotations
