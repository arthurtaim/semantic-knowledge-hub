"""`python -m app` — validates configuration, then serves the API with uvicorn."""

from __future__ import annotations

import sys

import uvicorn

from app.config import get_settings, security_violations
from app.container import ConfigurationError
from app.main import configure_logging, create_app


def main() -> int:
    settings = get_settings()
    configure_logging(settings.log_level)
    problems = security_violations(settings)
    if problems:
        for problem in problems:
            print(f"[skh] insecure configuration: {problem}", file=sys.stderr)
        return 2
    try:
        app = create_app(settings)
    except ConfigurationError as exc:  # e.g. plain http to a non-loopback GitLab, publication flag
        print(f"[skh] invalid configuration: {exc}", file=sys.stderr)
        return 2
    uvicorn.run(
        app,
        host=settings.app_host,
        port=settings.app_port,
        log_level=settings.log_level.lower(),
        access_log=False,  # our middleware logs without query strings
        server_header=False,
        proxy_headers=False,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
