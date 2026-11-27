"""Minimal GitLab REST v4 client: explicit host, bounded retries, no secrets in errors or logs.

API references (docs/README.md): repository tree/files, commits, branches, merge requests.
"""

from __future__ import annotations

import asyncio
import logging
import ssl
from collections.abc import Awaitable, Callable
from typing import Any
from urllib.parse import quote, urlsplit

import httpx
from pydantic import SecretStr

from app.config import is_loopback_host

logger = logging.getLogger("skh.gitlab")

RETRY_STATUSES = {429, 502, 503, 504}
MAX_RETRY_AFTER_SECONDS = 5.0


class GitLabError(RuntimeError):
    def __init__(self, code: str, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


def validate_gitlab_config(
    base_url: str,
    project_id: str,
    token: SecretStr,
    allow_insecure_http: bool,
    mock_hosts: frozenset[str] = frozenset(),
) -> str | None:
    if not base_url:
        return "GITLAB_URL не задан."
    parts = urlsplit(base_url)
    if parts.scheme not in ("https", "http") or not parts.hostname:
        return "GITLAB_URL должен быть абсолютным https-адресом."
    if parts.scheme == "http" and not allow_insecure_http:
        return "GITLAB_URL использует http; это разрешается только явным GITLAB_ALLOW_INSECURE_HTTP=true."
    if parts.scheme == "http" and not (
        is_loopback_host(parts.hostname) or parts.hostname.lower() in mock_hosts
    ):
        # TLS is never switched off for real servers: plain http is only for a declared test double.
        return "GITLAB_URL с http допустим только для loopback-адреса или объявленного тестового mock."
    if parts.username or parts.password:
        return "GITLAB_URL не должен содержать учётные данные."
    if not project_id:
        return "GITLAB_PROJECT_ID не задан."
    if not token.get_secret_value():
        return "Токен GitLab не передан (GITLAB_TOKEN через хранилище секретов)."
    return None


def json_body(response: httpx.Response) -> Any:
    """Decoded JSON body; a malformed answer becomes a typed error instead of a crash."""
    try:
        return response.json()
    except ValueError as exc:
        raise GitLabError(
            "gitlab_invalid_response", "GitLab вернул некорректный ответ (не JSON).", response.status_code
        ) from exc


def _error_for(response: httpx.Response) -> GitLabError:
    status = response.status_code
    if status == 401:
        return GitLabError(
            "gitlab_auth_failed", "GitLab отклонил авторизацию (401). Проверьте токен.", status
        )
    if status == 403:
        return GitLabError("gitlab_forbidden", "Недостаточно прав в GitLab (403).", status)
    if status == 404:
        return GitLabError("gitlab_not_found", "Объект GitLab не найден или недоступен (404).", status)
    if status == 409:
        return GitLabError("gitlab_conflict", "Конфликт в GitLab (409).", status)
    if status == 429:
        return GitLabError(
            "gitlab_rate_limited", "GitLab ограничил частоту запросов (429). Повторите позже.", status
        )
    if status >= 500:
        return GitLabError("gitlab_unavailable", f"GitLab временно недоступен (HTTP {status}).", status)
    return GitLabError("gitlab_bad_request", f"GitLab отклонил запрос (HTTP {status}).", status)


class GitLabClient:
    def __init__(
        self,
        *,
        base_url: str,
        project_id: str,
        token: SecretStr,
        timeout_seconds: float = 15.0,
        max_retries: int = 2,
        transport: httpx.AsyncBaseTransport | None = None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        verify: ssl.SSLContext | bool = True,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._verify = verify
        self._project = quote(project_id, safe="")
        self._token = token
        self._timeout = timeout_seconds
        self._max_retries = max_retries
        self._transport = transport
        self._sleep = sleep

    @property
    def base_url(self) -> str:
        return self._base_url

    @property
    def host(self) -> str:
        return urlsplit(self._base_url).hostname or ""

    def project_path(self, suffix: str = "") -> str:
        return f"/api/v4/projects/{self._project}{suffix}"

    async def request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json: dict[str, Any] | None = None,
        allowed_statuses: frozenset[int] = frozenset(),
    ) -> httpx.Response:
        attempt = 0
        # Only idempotent reads are retried: a timed-out POST may already have been applied by GitLab.
        retries = self._max_retries if method.upper() in ("GET", "HEAD") else 0
        async with httpx.AsyncClient(
            base_url=self._base_url,
            headers={"PRIVATE-TOKEN": self._token.get_secret_value(), "Accept": "application/json"},
            timeout=httpx.Timeout(self._timeout),
            follow_redirects=False,
            transport=self._transport,
            trust_env=False,
            verify=self._verify,
        ) as client:
            while True:
                try:
                    response = await client.request(method, path, params=params, json=json)
                except httpx.TimeoutException as exc:
                    if attempt < retries:
                        attempt += 1
                        await self._sleep(0.5 * attempt)
                        continue
                    raise GitLabError("gitlab_timeout", "GitLab не ответил за отведённое время.") from exc
                except httpx.HTTPError as exc:
                    raise GitLabError("gitlab_unreachable", "GitLab недоступен (ошибка соединения).") from exc
                if response.status_code in RETRY_STATUSES and attempt < retries:
                    attempt += 1
                    await self._sleep(self._retry_delay(response, attempt))
                    continue
                # Log the endpoint kind only: document paths and bodies stay out of logs.
                endpoint = path.split("?", 1)[0].split("/repository/files/", 1)[0]
                logger.info("gitlab %s %s -> %s", method, endpoint, response.status_code)
                if response.status_code < 300 or response.status_code in allowed_statuses:
                    return response
                raise _error_for(response)

    @staticmethod
    def _retry_delay(response: httpx.Response, attempt: int) -> float:
        header = response.headers.get("Retry-After", "")
        try:
            return min(MAX_RETRY_AFTER_SECONDS, max(0.0, float(header)))
        except ValueError:
            return float(min(MAX_RETRY_AFTER_SECONDS, 0.5 * 2 ** (attempt - 1)))
