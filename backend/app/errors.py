"""Structured API errors: every error response is `{code, message, request_id}`."""

from __future__ import annotations

import logging
import sqlite3
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

logger = logging.getLogger("skh.errors")


class ApiError(Exception):
    """Domain error mapped to a structured HTTP response. Messages must never contain secrets."""

    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.details = details or {}


# SQLite result codes of «another connection holds the lock» (extended codes keep them in the low byte).
_BUSY_CODES = frozenset({sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED})
_BUSY_TEXTS = ("database is locked", "database table is locked", "database is busy")
STORAGE_RETRY_AFTER_SECONDS = 2


def is_storage_busy(exc: BaseException) -> bool:
    """True only for SQLITE_BUSY / SQLITE_LOCKED — a transient lock, never a schema, disk or integrity error."""
    if not isinstance(exc, sqlite3.OperationalError):
        return False
    code = getattr(exc, "sqlite_errorcode", None)
    if isinstance(code, int):
        return (code & 0xFF) in _BUSY_CODES
    text = str(exc).lower()
    return any(marker in text for marker in _BUSY_TEXTS)


def not_found(code: str, message: str) -> ApiError:
    return ApiError(404, code, message)


def request_id_of(request: Request) -> str:
    return str(getattr(request.state, "request_id", "unknown"))


def error_body(
    code: str, message: str, request_id: str, details: dict[str, Any] | None = None
) -> dict[str, Any]:
    body: dict[str, Any] = {"code": code, "message": message, "request_id": request_id}
    if details:
        body["details"] = details
    return body


_HTTP_CODES = {
    400: "bad_request",
    401: "unauthenticated",
    403: "forbidden",
    404: "not_found",
    405: "method_not_allowed",
    409: "conflict",
    413: "payload_too_large",
    415: "unsupported_media_type",
    422: "invalid_request",
    429: "rate_limited",
    503: "unavailable",
}


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(request: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content=error_body(exc.code, exc.message, request_id_of(request), exc.details),
        )

    @app.exception_handler(RequestValidationError)
    async def _validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        # Do not echo submitted values back (may contain document bodies); report locations only.
        fields = [
            {"loc": [str(p) for p in err.get("loc", ())], "type": err.get("type", "invalid")}
            for err in exc.errors()
        ]
        return JSONResponse(
            status_code=422,
            content=error_body(
                "invalid_request",
                "Некорректные параметры запроса.",
                request_id_of(request),
                {"fields": fields},
            ),
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = _HTTP_CODES.get(exc.status_code, "http_error")
        message = exc.detail if isinstance(exc.detail, str) else "Ошибка запроса."
        return JSONResponse(
            status_code=exc.status_code, content=error_body(code, message, request_id_of(request))
        )

    @app.exception_handler(sqlite3.OperationalError)
    async def _storage(request: Request, exc: sqlite3.OperationalError) -> JSONResponse:
        # audit SYS-006: a lock held past busy_timeout (a backup, another process) is transient and retryable. The
        # unit of work was rolled back (WorkDatabase.write / a closed connection), so a retry with the same
        # idempotency key runs once. Any other SQLite error is NOT masked: it goes on to the 500 handler below.
        if not is_storage_busy(exc):
            raise exc
        logger.warning("storage busy request_id=%s path=%s", request_id_of(request), request.url.path)
        return JSONResponse(
            status_code=503,
            content=error_body(
                "storage_busy",
                "Хранилище занято другой операцией (например, резервным копированием) — изменения не сохранены. "
                "Повторите через несколько секунд.",
                request_id_of(request),
                {"retryable": True},
            ),
            headers={"Retry-After": str(STORAGE_RETRY_AFTER_SECONDS)},
        )

    @app.exception_handler(Exception)
    async def _unexpected(request: Request, exc: Exception) -> JSONResponse:
        logger.exception("unhandled error request_id=%s path=%s", request_id_of(request), request.url.path)
        return JSONResponse(
            status_code=500,
            content=error_body("internal_error", "Внутренняя ошибка сервера.", request_id_of(request)),
        )
