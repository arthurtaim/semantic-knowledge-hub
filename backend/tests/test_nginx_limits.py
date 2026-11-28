"""The UI container's nginx (frontend/nginx.conf, also the stand) must let a bulk import through: the M8 upload
route needs the app's own upload limit, while every other route keeps the small default body size."""

from __future__ import annotations

import re
from pathlib import Path

from app.config import Settings

NGINX = Path(__file__).resolve().parents[2] / "frontend" / "nginx.conf"


def _mb(value: str) -> float:
    number, unit = re.fullmatch(r"(\d+)([kKmM]?)", value).groups()  # type: ignore[union-attr]
    return int(number) / 1024 if unit in ("k", "K") else float(number)


def test_the_bulk_import_upload_fits_through_nginx_and_nothing_else_grows() -> None:
    text = NGINX.read_text(encoding="utf-8")
    block = re.search(r"location = /api/onboarding/batches \{(.*?)\n    \}", text, re.S)
    assert block, "an exact location for the M8 upload route"
    body = block.group(1)
    limit = re.search(r"client_max_body_size (\w+);", body)
    assert limit and _mb(limit.group(1)) > Settings().onboarding_upload_mb  # + multipart overhead
    assert "proxy_pass http://backend:8000;" in body and "proxy_set_header Host $host;" in body
    server_default = re.search(r"\n    client_max_body_size (\w+);", text)
    assert server_default and _mb(server_default.group(1)) <= 1
