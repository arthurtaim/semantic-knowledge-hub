"""FastAPI application factory."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app import __version__
from app.adapters.knowledge.base import RepositoryUnavailableError
from app.api import (
    ai,
    assistant,
    authoring,
    discovery,
    drafts,
    graph,
    knowledge,
    links,
    metadata,
    publications,
    system,
    template_apply,
    template_studio,
    templates,
)
from app.config import InsecureConfigurationError, Settings, get_settings, security_violations
from app.container import build_container
from app.errors import error_body, install_error_handlers, request_id_of
from app.middleware import CsrfGuardMiddleware, HostGuardMiddleware, RequestContextMiddleware

logger = logging.getLogger("skh")


def quiet_http_client_logs() -> None:
    # httpx/httpcore log full request URLs (document paths, queries) at INFO: keep them out of logs.
    for name in ("httpx", "httpcore"):
        logging.getLogger(name).setLevel(logging.WARNING)


def configure_logging(level: str) -> None:
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    quiet_http_client_logs()


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    quiet_http_client_logs()
    problems = security_violations(settings)
    if problems:
        # Fail closed: refuse to start with a configuration that would expose demo mode.
        raise InsecureConfigurationError("; ".join(problems))

    container = build_container(settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        user = container.demo_user()
        try:
            snapshot = await container.knowledge.snapshot(user)
            counts = f"documents={len(snapshot.documents)} issues={len(snapshot.issues)}"
        except RepositoryUnavailableError as exc:  # remote store down: start degraded, report via status
            counts = f"knowledge_unavailable={exc.code}"
        logger.info(
            "started env=%s auth=%s knowledge=%s ai=%s corporate=%s %s",
            settings.app_env,
            settings.auth_mode,
            settings.knowledge_backend,
            settings.ai_provider,
            settings.confluence_connector,
            counts,
        )
        yield
        container.close()

    app = FastAPI(
        title="Semantic Knowledge Hub API",
        version=__version__,
        lifespan=lifespan,
        # Swagger UI would load scripts from a public CDN; keep the browser offline. Schema stays available.
        docs_url=None,
        redoc_url=None,
        openapi_url="/api/openapi.json",
    )
    app.state.container = container
    install_error_handlers(app)

    @app.exception_handler(RepositoryUnavailableError)
    async def _repository_unavailable(request: Request, exc: RepositoryUnavailableError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code, content=error_body(exc.code, exc.message, request_id_of(request))
        )

    if settings.cors_origin_list:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origin_list,
            allow_methods=["GET", "POST", "PUT", "DELETE"],
            allow_headers=["Content-Type", "X-SKH-Client", "X-SKH-Browser"],
        )
    app.add_middleware(CsrfGuardMiddleware)
    app.add_middleware(HostGuardMiddleware, allowed_hosts=settings.allowed_host_list)
    app.add_middleware(RequestContextMiddleware)  # outermost: request id for every response

    for router in (
        system.router,
        knowledge.router,
        assistant.router,
        drafts.router,
        authoring.router,
        publications.router,
        graph.router,
        discovery.router,
        links.router,
        metadata.router,
        template_studio.router,  # before templates.router: `/api/templates/studio/...` is not a template id
        templates.router,
        template_apply.router,
        ai.router,
    ):
        app.include_router(router)
    return app
