"""Explicit, typed application configuration.

All settings come from environment variables (optionally a `.env` file). Defaults are the
safe offline demo: local synthetic knowledge, mock AI, every external integration disabled.
"""

from __future__ import annotations

import ipaddress
import os
import re
import ssl
from functools import cached_property
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_DEFAULT_PROJECT_ROOT = Path(__file__).resolve().parents[2]


def _split_csv(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


# Reserved names that can never be corporate hosts (RFC 2606 / RFC 6761).
_RESERVED_SUFFIXES = (".example", ".test", ".invalid", ".localhost")
IntegrationProfile = Literal["offline", "integration_mock", "live_read_only", "live_write_staging"]
TargetKind = Literal["none", "local", "mock", "real"]


def valid_mock_host(host: str) -> bool:
    """A host that may be declared a TEST DOUBLE: loopback, a reserved test domain, or a single-label
    Docker service name ending in `-mock` (resolvable only inside the isolated test network)."""
    candidate = host.strip().lower()
    if is_loopback_host(candidate):
        return True
    if candidate.endswith(_RESERVED_SUFFIXES):
        return True
    return "." not in candidate and candidate.endswith("-mock") and candidate.replace("-", "").isalnum()


def is_loopback_host(host: str) -> bool:
    """True for `localhost` and loopback IP literals (127.0.0.0/8, ::1)."""
    candidate = host.strip().strip("[]").lower()
    if candidate == "localhost":
        return True
    try:
        return ipaddress.ip_address(candidate).is_loopback
    except ValueError:
        return False


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(".env", "../.env"),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # --- runtime -----------------------------------------------------------------------------
    app_env: Literal["local", "test", "development", "staging", "production"] = "local"
    app_host: str = "127.0.0.1"
    app_port: int = Field(default=8000, ge=1, le=65535)
    auth_mode: Literal["local_demo", "sso"] = "local_demo"
    # Set by docker-compose: the process listens on the container interface, while the host
    # port is published on APP_PUBLISHED_HOST only (must be loopback in local_demo mode).
    app_container: bool = False
    app_published_host: str = "127.0.0.1"
    allowed_hosts: str = "localhost,127.0.0.1,::1"
    cors_origins: str = ""
    project_root: Path = _DEFAULT_PROJECT_ROOT
    # Public address of the UI, used only to link a proposal from its GitLab MR description.
    app_public_url: str = ""
    # Run mode (docs/M4_M5_INTEGRATION_READINESS.md): offline (default, no integrations), integration_mock
    # (stateful local test doubles only; writes allowed only to them), live_read_only (test GitLab/MCP,
    # no writes), live_write_staging (separate test project/space, explicitly acknowledged writes).
    integration_profile: IntegrationProfile = "offline"
    # integration_mock: hosts of the local test doubles (loopback, *.example/*.test, or `<name>-mock`).
    mock_service_hosts: str = ""
    log_level: str = "INFO"

    # --- knowledge -----------------------------------------------------------------------------
    knowledge_backend: Literal["local", "gitlab"] = "local"
    local_knowledge_dir: Path = Path("./workspace/knowledge")
    fixtures_dir: Path = Path("./fixtures/knowledge")
    seed_fixtures: bool = True
    local_content_is_demo: bool = True
    max_document_bytes: int = Field(default=512 * 1024, ge=1024, le=10 * 1024 * 1024)
    review_stale_days: int = Field(default=180, ge=1)
    repository_refresh_seconds: float = Field(default=2.0, ge=0.0)
    # Directory with document templates (*.md). Empty: the built-in app/document_templates.
    document_templates_dir: str = ""

    gitlab_url: str = ""
    gitlab_project_id: str = ""
    gitlab_default_branch: str = "main"
    gitlab_token: SecretStr = SecretStr("")
    # Preferred: path to a file with the token (Docker/Kubernetes secret, vault agent). Never in git.
    gitlab_token_file: str = ""
    # PEM bundle with the corporate CA for TLS to GitLab (empty = system trust store).
    gitlab_ca_bundle: str = ""
    gitlab_proposals_enabled: bool = False
    gitlab_timeout_seconds: float = Field(default=15.0, gt=0, le=120)
    gitlab_knowledge_path: str = ""
    gitlab_allow_insecure_http: bool = False
    gitlab_refresh_seconds: float = Field(default=60.0, ge=0)
    gitlab_max_files: int = Field(default=2000, ge=1, le=20000)

    # --- search / derived state ----------------------------------------------------------------
    search_backend: Literal["sqlite_fts"] = "sqlite_fts"
    search_index_path: Path = Path("./workspace/search.sqlite3")
    app_state_path: Path = Path("./workspace/app_state.sqlite3")
    publication_state_path: Path = Path("./workspace/publications.sqlite3")

    # --- AI ----------------------------------------------------------------------------------
    ai_provider: Literal["mock", "internal_api", "disabled"] = "mock"
    ai_base_url: str = ""
    ai_model: str = ""
    ai_api_key: SecretStr = SecretStr("")
    ai_api_key_file: str = ""
    ai_ca_bundle: str = ""
    ai_timeout_seconds: float = Field(default=30.0, gt=0, le=300)
    ai_allowed_hosts: str = ""
    ai_allow_insecure_http: bool = False
    ai_max_context_chars: int = Field(default=12000, ge=1000, le=200_000)
    ai_max_response_bytes: int = Field(default=256 * 1024, ge=1024)

    # --- Confluence ----------------------------------------------------------------------------
    confluence_connector: Literal["disabled", "mock", "mcp"] = "disabled"
    confluence_mcp_url: str = ""
    confluence_mcp_auth_token: SecretStr = SecretStr("")
    confluence_mcp_auth_token_file: str = ""
    confluence_mcp_ca_bundle: str = ""
    # How the MCP server authorizes reads. "service_account": one shared token — per-user Confluence
    # ACLs are NOT enforced, so only a single-user test contour is acceptable. "per_user" needs SSO
    # token propagation, which is not implemented (refused at startup).
    confluence_mcp_auth_model: Literal["service_account", "per_user"] = "service_account"
    confluence_allowlisted_spaces: str = ""
    # JSON mapping business capabilities to discovered MCP tools (never guessed), e.g.
    # {"search": {"tool": "<name>", "query_arg": "query", "limit_arg": "limit", "spaces_arg": "spaces"},
    #  "read": {"tool": "<name>", "id_arg": "page_id"}}
    confluence_mcp_tool_map: str = ""
    confluence_mcp_timeout_seconds: float = Field(default=15.0, gt=0, le=120)
    # How long a successful tools/list discovery and the status are reused (0 = always re-check).
    confluence_mcp_status_ttl_seconds: float = Field(default=60.0, ge=0, le=3600)
    confluence_mcp_allow_insecure_http: bool = False
    confluence_link_hosts: str = ""
    confluence_max_body_chars: int = Field(default=4000, ge=200, le=50_000)
    # Optional JSON overriding where page fields are found in tool results, e.g.
    # {"items": "results", "id": "content.id", "space": "content.space.key", "url": "_links.webui"}
    confluence_mcp_result_map: str = ""
    # Base for relative links returned by Confluence (e.g. /display/TEAM/Page); its host must be in
    # CONFLUENCE_LINK_HOSTS.
    confluence_web_base_url: str = ""
    # --- Confluence Data Center REST publisher (M5; separate from the read-only MCP connector) ---
    # Empty URL: publication disabled. URL without CONFLUENCE_PUBLISH_ENABLED: jobs + dry-run only (reads).
    confluence_publish_enabled: bool = False
    confluence_rest_url: str = ""  # base URL incl. context path, e.g. https://confluence.example/confluence
    confluence_rest_token: SecretStr = SecretStr("")  # dedicated publishing PAT; never the MCP token
    confluence_rest_token_file: str = ""
    confluence_rest_ca_bundle: str = ""
    confluence_rest_timeout_seconds: float = Field(default=15.0, gt=0, le=120)
    confluence_rest_allow_insecure_http: bool = False
    confluence_target_space: str = ""
    confluence_parent_page_id: str = ""
    confluence_publish_statuses: str = "approved"
    # live_write_staging only: must repeat CONFLUENCE_TARGET_SPACE to acknowledge real writes.
    confluence_publish_staging_ack: str = ""

    # --- tasks -----------------------------------------------------------------------------------
    task_system: Literal["disabled"] = "disabled"

    @model_validator(mode="after")
    def _load_secret_files(self) -> Settings:
        """Read `*_FILE` secrets. A value and a file for the same secret are rejected as ambiguous."""
        for name in ("gitlab_token", "ai_api_key", "confluence_mcp_auth_token", "confluence_rest_token"):
            file_value: str = getattr(self, f"{name}_file")
            if not file_value:
                continue
            if getattr(self, name).get_secret_value():
                raise ValueError(f"{name.upper()} и {name.upper()}_FILE заданы одновременно; оставьте один.")
            setattr(self, name, SecretStr(read_secret_file(self.resolve_path(Path(file_value)))))
        return self

    @field_validator("log_level")
    @classmethod
    def _upper_level(cls, value: str) -> str:
        return value.upper()

    # --- derived helpers -----------------------------------------------------------------------
    def resolve_path(self, path: Path) -> Path:
        return path if path.is_absolute() else (self.project_root / path).resolve()

    @cached_property
    def knowledge_root(self) -> Path:
        return self.resolve_path(self.local_knowledge_dir)

    @cached_property
    def fixtures_root(self) -> Path:
        return self.resolve_path(self.fixtures_dir)

    @cached_property
    def search_index_file(self) -> Path:
        return self.resolve_path(self.search_index_path)

    @cached_property
    def app_state_file(self) -> Path:
        return self.resolve_path(self.app_state_path)

    @cached_property
    def publication_state_file(self) -> Path:
        return self.resolve_path(self.publication_state_path)

    @property
    def allowed_host_list(self) -> list[str]:
        return _split_csv(self.allowed_hosts)

    @property
    def cors_origin_list(self) -> list[str]:
        return _split_csv(self.cors_origins)

    @property
    def ai_allowed_host_list(self) -> list[str]:
        return [h.lower() for h in _split_csv(self.ai_allowed_hosts)]

    @property
    def confluence_space_list(self) -> list[str]:
        return _split_csv(self.confluence_allowlisted_spaces)

    @property
    def confluence_link_host_list(self) -> list[str]:
        return [h.lower() for h in _split_csv(self.confluence_link_hosts)]

    @property
    def mock_service_host_list(self) -> list[str]:
        return [h.lower() for h in _split_csv(self.mock_service_hosts)]

    @property
    def confluence_publish_status_list(self) -> list[str]:
        return _split_csv(self.confluence_publish_statuses)

    def target_kind(self, url: str) -> TargetKind:
        """none (not configured) · mock (a declared local TEST DOUBLE) · real (anything else)."""
        if not url:
            return "none"
        host = (urlsplit(url).hostname or "").lower()
        if self.integration_profile == "integration_mock" and (
            is_loopback_host(host) or host in self.mock_service_host_list
        ):
            return "mock"
        return "real"


MAX_SECRET_FILE_BYTES = 16 * 1024


def read_secret_file(path: Path) -> str:
    """Read a secret from a regular file. Errors never include the file content."""
    try:
        if not path.is_file():
            raise ValueError(f"Файл секрета не найден или не является файлом: {path}")
        if path.stat().st_size > MAX_SECRET_FILE_BYTES:
            raise ValueError(f"Файл секрета слишком большой: {path}")
        value = path.read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise ValueError(f"Не удалось прочитать файл секрета: {path}") from exc
    if not value:
        raise ValueError(f"Файл секрета пуст: {path}")
    return value


def tls_verify(settings: Settings, bundle: str) -> ssl.SSLContext | bool:
    """System trust store by default; a corporate CA bundle when configured (fails if unreadable)."""
    if not bundle:
        return True
    path = settings.resolve_path(Path(bundle))
    if not path.is_file():
        raise ValueError(f"Файл CA-сертификатов не найден: {path}")
    return ssl.create_default_context(cafile=str(path))


class InsecureConfigurationError(RuntimeError):
    """Raised at startup when the configuration would expose demo mode or break policy."""


def running_in_container() -> bool:
    """Best-effort detection; APP_CONTAINER is honoured only when this is true."""
    return (
        Path("/.dockerenv").exists()
        or Path("/run/.containerenv").exists()
        or bool(os.environ.get("container"))  # noqa: SIM112 - lowercase is the podman/systemd convention
    )


def security_violations(settings: Settings, *, in_container: bool | None = None) -> list[str]:
    """Return human-readable reasons why this configuration must not start (fail closed)."""
    problems: list[str] = []
    container = running_in_container() if in_container is None else in_container
    if settings.auth_mode == "local_demo":
        if settings.app_env in ("staging", "production"):
            problems.append(f"AUTH_MODE=local_demo is not allowed with APP_ENV={settings.app_env}.")
        if settings.app_container and container:
            if not is_loopback_host(settings.app_published_host):
                problems.append(
                    "AUTH_MODE=local_demo requires the container port to be published on a loopback "
                    f"interface only (APP_PUBLISHED_HOST={settings.app_published_host!r})."
                )
        elif not is_loopback_host(settings.app_host):
            problems.append(f"AUTH_MODE=local_demo requires a loopback APP_HOST (got {settings.app_host!r}).")
        non_local_allowed = [h for h in settings.allowed_host_list if not is_loopback_host(h)]
        if non_local_allowed or "*" in settings.allowed_host_list:
            problems.append(
                "AUTH_MODE=local_demo only accepts loopback ALLOWED_HOSTS "
                f"(got {', '.join(non_local_allowed or ['*'])})."
            )
        for origin in settings.cors_origin_list:
            parsed = urlsplit(origin)
            if (
                origin == "*"
                or parsed.scheme not in ("http", "https")
                or not is_loopback_host(parsed.hostname or "")
            ):
                problems.append(f"AUTH_MODE=local_demo only accepts loopback CORS_ORIGINS (got {origin!r}).")
    if settings.auth_mode == "sso":
        problems.append(
            "AUTH_MODE=sso is not implemented in this MVP; corporate SSO/RBAC must be integrated "
            "and security-reviewed before multiuser deployment."
        )
    if settings.gitlab_proposals_enabled and settings.knowledge_backend != "gitlab":
        problems.append(
            "GITLAB_PROPOSALS_ENABLED=true требует KNOWLEDGE_BACKEND=gitlab: ревизии предложений должны быть "
            "commit SHA из GitLab."
        )
    if settings.confluence_connector == "mcp" and settings.confluence_mcp_auth_model == "per_user":
        problems.append(
            "CONFLUENCE_MCP_AUTH_MODEL=per_user требует SSO и передачи пользовательского токена — не реализовано."
        )
    if settings.confluence_connector == "mcp":
        mcp = urlsplit(settings.confluence_mcp_url)
        if not mcp.hostname or mcp.scheme not in ("https", "http"):
            problems.append("CONFLUENCE_MCP_URL должен быть абсолютным адресом утверждённого MCP-сервера.")
        elif mcp.scheme == "http" and not settings.confluence_mcp_allow_insecure_http:
            problems.append("CONFLUENCE_MCP_URL использует http без CONFLUENCE_MCP_ALLOW_INSECURE_HTTP=true.")
        elif mcp.scheme == "http" and settings.target_kind(settings.confluence_mcp_url) != "mock":
            problems.append(
                "CONFLUENCE_MCP_URL с http допустим только для loopback-адреса или объявленного тестового mock."
            )
        elif mcp.username or mcp.password:
            problems.append("CONFLUENCE_MCP_URL не должен содержать учётные данные.")
    if settings.app_public_url:
        public = urlsplit(settings.app_public_url)
        if (
            public.scheme not in ("http", "https")
            or not public.hostname
            or public.username
            or public.password
        ):
            problems.append("APP_PUBLIC_URL должен быть абсолютным http(s)-адресом без учётных данных.")
        elif settings.auth_mode == "local_demo" and not is_loopback_host(public.hostname):
            problems.append("AUTH_MODE=local_demo допускает только loopback APP_PUBLIC_URL.")
    if settings.confluence_web_base_url:
        base = urlsplit(settings.confluence_web_base_url)
        if base.scheme != "https" or (base.hostname or "").lower() not in settings.confluence_link_host_list:
            problems.append(
                "CONFLUENCE_WEB_BASE_URL должен быть https-адресом с хостом из CONFLUENCE_LINK_HOSTS."
            )
    problems.extend(_profile_violations(settings))
    problems.extend(_publisher_violations(settings))
    # TLS is never switched off for real hosts: plain http is accepted only for declared test doubles.
    for name, url, enabled in (
        ("AI_BASE_URL", settings.ai_base_url, settings.ai_provider == "internal_api"),
        ("GITLAB_URL", settings.gitlab_url, settings.knowledge_backend == "gitlab"),
        ("CONFLUENCE_REST_URL", settings.confluence_rest_url, bool(settings.confluence_rest_url)),
    ):
        parts = urlsplit(url)
        if enabled and parts.scheme == "http" and settings.target_kind(url) != "mock":
            problems.append(
                f"{name} с http допустим только для loopback-адреса или объявленного тестового mock; нужен https."
            )
    if settings.ai_provider == "internal_api" and settings.ai_base_url:
        host = (urlsplit(settings.ai_base_url).hostname or "").lower()
        if host and host not in settings.ai_allowed_host_list:
            problems.append(
                "AI_BASE_URL host is not in AI_ALLOWED_HOSTS; outbound AI traffic must be allowlisted."
            )
    return problems


def _integration_urls(settings: Settings) -> list[tuple[str, str]]:
    urls: list[tuple[str, str]] = []
    if settings.knowledge_backend == "gitlab":
        urls.append(("GITLAB_URL", settings.gitlab_url))
    if settings.confluence_connector == "mcp":
        urls.append(("CONFLUENCE_MCP_URL", settings.confluence_mcp_url))
    if settings.ai_provider == "internal_api":
        urls.append(("AI_BASE_URL", settings.ai_base_url))
    if settings.confluence_rest_url:
        urls.append(("CONFLUENCE_REST_URL", settings.confluence_rest_url))
    return urls


def _profile_violations(settings: Settings) -> list[str]:
    """The run mode bounds what may be addressed and written (docs/M4_M5_INTEGRATION_READINESS.md)."""
    problems: list[str] = []
    profile = settings.integration_profile
    urls = _integration_urls(settings)
    configured = [(n, u) for n, u in urls if u]  # a missing URL is reported by the adapter's own check
    bad_mocks = [h for h in settings.mock_service_host_list if not valid_mock_host(h)]
    if bad_mocks:
        problems.append(
            "MOCK_SERVICE_HOSTS допускает только loopback, домены *.example/*.test/*.invalid или имена "
            f"Docker-сервисов вида <name>-mock (получено: {', '.join(bad_mocks)})."
        )
    if settings.mock_service_host_list and profile != "integration_mock":
        problems.append("MOCK_SERVICE_HOSTS используется только с INTEGRATION_PROFILE=integration_mock.")
    if profile == "offline":
        if urls:
            names = ", ".join(n for n, _ in urls)
            problems.append(
                f"INTEGRATION_PROFILE=offline: интеграции не используются ({names}). Для локальных тестовых "
                "дублей задайте integration_mock, для тестового контура — live_read_only/live_write_staging."
            )
    elif profile == "integration_mock":
        real = [n for n, url in configured if settings.target_kind(url) != "mock"]
        if real:
            problems.append(
                f"INTEGRATION_PROFILE=integration_mock адресует только объявленные тестовые дубли; не mock: "
                f"{', '.join(real)}."
            )
    else:  # live_read_only / live_write_staging: real test systems, https only, no test doubles
        mocks = [n for n, url in configured if urlsplit(url).scheme != "https"]
        if mocks:
            problems.append(f"INTEGRATION_PROFILE={profile} требует https для: {', '.join(mocks)}.")
        if profile == "live_read_only":
            if settings.gitlab_proposals_enabled:
                problems.append("INTEGRATION_PROFILE=live_read_only запрещает GITLAB_PROPOSALS_ENABLED=true.")
            if settings.confluence_publish_enabled:
                problems.append(
                    "INTEGRATION_PROFILE=live_read_only запрещает CONFLUENCE_PUBLISH_ENABLED=true."
                )
    return problems


def _publisher_violations(settings: Settings) -> list[str]:
    problems: list[str] = []
    url = settings.confluence_rest_url
    if settings.confluence_publish_enabled and not url:
        problems.append("CONFLUENCE_PUBLISH_ENABLED=true требует CONFLUENCE_REST_URL тестового Confluence.")
    if not url:
        return problems
    parts = urlsplit(url)
    if parts.scheme not in ("https", "http") or not parts.hostname:
        problems.append("CONFLUENCE_REST_URL должен быть абсолютным https-адресом Confluence Data Center.")
        return problems
    if parts.username or parts.password or parts.query or parts.fragment:
        problems.append("CONFLUENCE_REST_URL не должен содержать учётные данные, query или fragment.")
    if parts.scheme == "http" and not settings.confluence_rest_allow_insecure_http:
        problems.append("CONFLUENCE_REST_URL использует http без CONFLUENCE_REST_ALLOW_INSECURE_HTTP=true.")
    if settings.knowledge_backend != "gitlab":
        problems.append(
            "Публикация в Confluence требует KNOWLEDGE_BACKEND=gitlab: публикуются только подтверждённые "
            "merge-ревизии GitLab."
        )
    if not re.fullmatch(r"[A-Za-z0-9_~]{1,255}", settings.confluence_target_space or ""):
        problems.append("CONFLUENCE_TARGET_SPACE должен быть ключом тестового пространства.")
    if not re.fullmatch(r"\d{1,20}", settings.confluence_parent_page_id or ""):
        problems.append("CONFLUENCE_PARENT_PAGE_ID должен быть числовым ID родительской страницы.")
    if not settings.confluence_rest_token.get_secret_value():
        problems.append("Не задан токен публикации CONFLUENCE_REST_TOKEN(_FILE).")
    elif (
        settings.confluence_rest_token.get_secret_value()
        == settings.confluence_mcp_auth_token.get_secret_value()
    ):
        problems.append("Токен публикации не должен совпадать с токеном MCP: нужны отдельные учётные данные.")
    unknown = [
        s for s in settings.confluence_publish_status_list if s not in ("approved", "in_review", "draft")
    ]
    if unknown or not settings.confluence_publish_status_list:
        problems.append("CONFLUENCE_PUBLISH_STATUSES допускает только approved, in_review, draft.")
    if settings.confluence_publish_enabled:
        profile = settings.integration_profile
        if profile == "integration_mock":
            pass  # the target is a declared local test double (checked by the profile rules)
        elif profile == "live_write_staging":
            if settings.confluence_publish_staging_ack != settings.confluence_target_space:
                problems.append(
                    "Запись в реальный Confluence: CONFLUENCE_PUBLISH_STAGING_ACK должен повторять ключ "
                    "тестового пространства CONFLUENCE_TARGET_SPACE."
                )
            if not settings.confluence_rest_ca_bundle:
                problems.append(
                    "Запись в реальный Confluence требует корпоративный CA (CONFLUENCE_REST_CA_BUNDLE)."
                )
        else:
            problems.append(
                f"CONFLUENCE_PUBLISH_ENABLED=true недопустим при INTEGRATION_PROFILE={profile}: запись разрешена "
                "только в локальный mock (integration_mock) или в согласованный staging (live_write_staging)."
            )
    return problems


def get_settings() -> Settings:
    return Settings()
