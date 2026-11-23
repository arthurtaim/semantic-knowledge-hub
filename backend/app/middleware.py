"""HTTP middleware: request IDs, access logging without bodies, host and CSRF guards."""

from __future__ import annotations

import logging
import time
import uuid
from collections.abc import Awaitable, Callable

from fastapi import Request, Response
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import ASGIApp

from app.errors import error_body

logger = logging.getLogger("skh.access")

CLIENT_HEADER = "x-skh-client"
_UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


def _hostname(host_header: str) -> str:
    host = host_header.strip().lower()
    if host.startswith("["):  # IPv6 literal, e.g. [::1]:8000
        return host[1 : host.find("]")] if "]" in host else host
    if host.count(":") == 1:
        return host.split(":", 1)[0]
    return host


class RequestContextMiddleware(BaseHTTPMiddleware):
    """Assigns a request ID and logs method/path/status/duration — never query strings or bodies."""

    async def dispatch(
        self, request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        incoming = request.headers.get("x-request-id", "")
        request_id = incoming if incoming.isalnum() and len(incoming) <= 64 else uuid.uuid4().hex
        request.state.request_id = request_id
        started = time.perf_counter()
        response = await call_next(request)
        elapsed_ms = (time.perf_counter() - started) * 1000
        response.headers["X-Request-ID"] = request_id
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault("Cache-Control", "no-store")
        logger.info(
            "request_id=%s method=%s path=%s status=%s duration_ms=%.1f",
            request_id,
            request.method,
            request.url.path,
            response.status_code,
            elapsed_ms,
        )
        return response


class HostGuardMiddleware(BaseHTTPMiddleware):
    """Rejects requests whose Host header is not allowlisted (DNS rebinding / accidental exposure)."""

    def __init__(self, app: ASGIApp, allowed_hosts: list[str]) -> None:
        super().__init__(app)
        self._allowed = {_hostname(h) for h in allowed_hosts}

    async def dispatch(
        self, request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        if _hostname(request.headers.get("host", "")) not in self._allowed:
            request_id = getattr(request.state, "request_id", "unknown")
            return JSONResponse(
                status_code=400,
                content=error_body(
                    "host_not_allowed",
                    "Хост запроса не разрешён конфигурацией (демо-режим доступен только на localhost).",
                    request_id,
                ),
            )
        return await call_next(request)


class CsrfGuardMiddleware(BaseHTTPMiddleware):
    """State-changing API calls must carry the `X-SKH-Client` header.

    Browsers cannot attach custom headers to cross-site requests without a CORS preflight, which
    this API does not grant to foreign origins, so this blocks drive-by POSTs against localhost.
    """

    async def dispatch(
        self, request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        if (
            request.method in _UNSAFE_METHODS
            and request.url.path.startswith("/api/")
            and not request.headers.get(CLIENT_HEADER)
        ):
            request_id = getattr(request.state, "request_id", "unknown")
            return JSONResponse(
                status_code=403,
                content=error_body(
                    "csrf_header_missing",
                    "Отсутствует обязательный заголовок X-SKH-Client.",
                    request_id,
                ),
            )
        return await call_next(request)
