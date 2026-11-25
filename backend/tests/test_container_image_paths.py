"""The backend image runs with a READ-ONLY root filesystem (docker-compose.yml `read_only: true`); only the workspace
volume (/data/workspace) is writable. Every state file the app writes must therefore point into it in the image —
a default relative path (./workspace/…) would resolve under /app and fail at start-up in the container."""

from __future__ import annotations

import re
from pathlib import Path

from app.config import Settings

DOCKERFILE = Path(__file__).resolve().parents[1] / "Dockerfile"


def _image_env() -> dict[str, str]:
    text = DOCKERFILE.read_text(encoding="utf-8")
    return dict(re.findall(r"^\s*([A-Z][A-Z0-9_]*)=(\S+?)\s*\\?$", text, flags=re.M))


def test_every_state_path_points_into_the_workspace_volume() -> None:
    env = _image_env()
    state_settings = sorted(
        name.upper()
        for name in Settings.model_fields
        if name.endswith("_state_path") or name == "search_index_path"
    )
    assert "WORK_STATE_PATH" in state_settings and "APP_STATE_PATH" in state_settings
    for name in state_settings:
        assert name in env, f"{name} is not set in backend/Dockerfile"
        assert env[name].startswith("/data/workspace/"), f"{name}={env[name]} is outside the writable volume"
