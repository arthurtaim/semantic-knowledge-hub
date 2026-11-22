"""Explicit, typed application configuration.

All settings come from environment variables (optionally a `.env` file). Defaults are the
safe offline demo: local synthetic knowledge, mock AI, every external integration disabled.
"""

from __future__ import annotations

import ipaddress
import os
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
    confluence_allowlisted_spaces: str = ""
    # JSON mapping business capabilities to discovered MCP tools (never guessed), e.g.
    # {"search": {"tool": "<name>", "query_arg": "query", "limit_arg": "limit", "spaces_arg": "spaces"},
    #  "read": {"tool": "<name>", "id_arg": "page_id"}}
    confluence_mcp_tool_map: str = ""
    confluence_mcp_timeout_seconds: float = Field(default=15.0, gt=0, le=120)
    confluence_mcp_allow_insecure_http: bool = False
    confluence_link_hosts: str = ""
    confluence_max_body_chars: int = Field(default=4000, ge=200, le=50_000)
    # Optional JSON overriding where page fields are found in tool results, e.g.
    # {"items": "results", "id": "content.id", "space": "content.space.key", "url": "_links.webui"}
    confluence_mcp_result_map: str = ""
    # Base for relative links returned by Confluence (e.g. /display/TEAM/Page); its host must be in
    # CONFLUENCE_LINK_HOSTS.
    confluence_web_base_url: str = ""
    confluence_publish_enabled: bool = False
    confluence_rest_url: str = ""
    confluence_target_space: str = ""

    # --- tasks -----------------------------------------------------------------------------------
    task_system: Literal["disabled"] = "disabled"

    @model_validator(mode="after")
    def _load_secret_files(self) -> Settings:
        """Read `*_FILE` secrets. A value and a file for the same secret are rejected as ambiguous."""
        for name in ("gitlab_token", "ai_api_key", "confluence_mcp_auth_token"):
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
    if settings.confluence_connector == "mcp":
        mcp = urlsplit(settings.confluence_mcp_url)
        if not mcp.hostname or mcp.scheme not in ("https", "http"):
            problems.append("CONFLUENCE_MCP_URL должен быть абсолютным адресом утверждённого MCP-сервера.")
        elif mcp.scheme == "http" and not settings.confluence_mcp_allow_insecure_http:
            problems.append("CONFLUENCE_MCP_URL использует http без CONFLUENCE_MCP_ALLOW_INSECURE_HTTP=true.")
        elif mcp.username or mcp.password:
            problems.append("CONFLUENCE_MCP_URL не должен содержать учётные данные.")
    if settings.confluence_web_base_url:
        base = urlsplit(settings.confluence_web_base_url)
        if base.scheme != "https" or (base.hostname or "").lower() not in settings.confluence_link_host_list:
            problems.append(
                "CONFLUENCE_WEB_BASE_URL должен быть https-адресом с хостом из CONFLUENCE_LINK_HOSTS."
            )
    if settings.ai_provider == "internal_api" and settings.ai_base_url:
        host = (urlsplit(settings.ai_base_url).hostname or "").lower()
        if host and host not in settings.ai_allowed_host_list:
            problems.append(
                "AI_BASE_URL host is not in AI_ALLOWED_HOSTS; outbound AI traffic must be allowlisted."
            )
    return problems


def get_settings() -> Settings:
    return Settings()
