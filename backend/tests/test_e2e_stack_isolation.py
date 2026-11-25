"""The GitLab-mock E2E stack (`frontend/e2e/gitlab-stack.sh`, started by `make e2e`) must keep EVERY state file in its
own throw-away directory. A state path it leaves unset falls back to the default `./workspace/…` — the developer's own
local demo state (AGENTS.md: test fixtures never overwrite a developer workspace). The work database is opened,
migrated and seeded with demo projects at start-up, so a missing WORK_STATE_PATH wrote into `workspace/work.sqlite3`."""

from __future__ import annotations

import re

from app.config import Settings
from tests.conftest import PROJECT_ROOT

GITLAB_STACK = PROJECT_ROOT / "frontend" / "e2e" / "gitlab-stack.sh"


def _exported() -> dict[str, str]:
    values: dict[str, str] = {}
    for line in GITLAB_STACK.read_text(encoding="utf-8").splitlines():
        if not line.startswith("export "):
            continue
        for name, value in re.findall(r"([A-Z][A-Z0-9_]*)=(\"[^\"]*\"|'[^']*'|\S+)", line):
            values[name] = value.strip("\"'")
    return values


def test_gitlab_e2e_stack_keeps_every_state_file_in_its_own_directory() -> None:
    exported = _exported()
    state_settings = sorted(
        name.upper()
        for name in Settings.model_fields
        if name.endswith("_state_path") or name == "search_index_path"
    )
    assert "WORK_STATE_PATH" in state_settings
    for name in state_settings:
        assert name in exported, (
            f"{name} is not set in gitlab-stack.sh: it would use the developer's ./workspace"
        )
        assert exported[name].startswith("$STATE/"), (
            f"{name}={exported[name]} is outside the E2E state directory"
        )
