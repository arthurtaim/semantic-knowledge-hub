"""Composition root: selects adapters from configuration. Switching providers never needs code changes."""

from __future__ import annotations

import logging
import ssl
from dataclasses import dataclass

from app.adapters.ai.base import AIProvider
from app.adapters.ai.mock import DisabledAIProvider, MockAIProvider
from app.adapters.ai.openai_compatible import OpenAICompatibleAIProvider
from app.adapters.corporate.base import CorporateKnowledgeConnector
from app.adapters.corporate.confluence_mcp import ConfluenceMCPConnector, parse_result_map, parse_tool_map
from app.adapters.corporate.disabled import DisabledCorporateConnector
from app.adapters.corporate.mcp_client import McpClient
from app.adapters.corporate.mock import MockCorporateConnector
from app.adapters.gitlab.client import GitLabClient, validate_gitlab_config
from app.adapters.gitlab.publisher import GitLabMRPublisher
from app.adapters.gitlab.repository import GitLabKnowledgeRepository
from app.adapters.knowledge.base import KnowledgeRepository
from app.adapters.knowledge.local import LocalKnowledgeRepository, seed_from_fixtures
from app.adapters.publishers.base import ConfluencePublisher, ProposalPublisher
from app.adapters.publishers.disabled import DisabledConfluencePublisher, DisabledProposalPublisher
from app.adapters.search.sqlite_fts import SqliteFtsSearchProvider
from app.adapters.tasks.base import DisabledTaskSystem, TaskSystemAdapter
from app.authz import AuthorizationPolicy, DenyAllPolicy, LocalDemoPolicy
from app.config import Settings, tls_verify
from app.domain.models import UserContext
from app.services.assistant import AssistantService
from app.services.integrations import IntegrationService
from app.services.knowledge import KnowledgeService
from app.services.proposals import ProposalService, ProposalStore
from app.services.search import SearchService

logger = logging.getLogger("skh.container")


class ConfigurationError(RuntimeError):
    pass


@dataclass
class Container:
    settings: Settings
    repository: KnowledgeRepository
    search_provider: SqliteFtsSearchProvider
    ai: AIProvider
    corporate: CorporateKnowledgeConnector
    proposal_publisher: ProposalPublisher
    confluence_publisher: ConfluencePublisher
    tasks: TaskSystemAdapter
    proposal_store: ProposalStore
    knowledge: KnowledgeService
    search: SearchService
    assistant: AssistantService
    proposals: ProposalService
    integrations: IntegrationService
    policy: AuthorizationPolicy

    def demo_user(self) -> UserContext:
        return UserContext(
            user_id="local-demo-user",
            display_name="Демо-пользователь (localhost)",
            roles=["reader", "editor"],
            allowed_spaces=None,
            is_demo=True,
        )

    def close(self) -> None:
        self.search_provider.close()
        self.proposal_store.close()


def build_repository(settings: Settings) -> KnowledgeRepository:
    if settings.knowledge_backend == "local":
        if settings.seed_fixtures:
            seed_from_fixtures(settings.fixtures_root, settings.knowledge_root)
        else:
            settings.knowledge_root.mkdir(parents=True, exist_ok=True)
        return LocalKnowledgeRepository(
            settings.knowledge_root,
            max_document_bytes=settings.max_document_bytes,
            content_is_demo=settings.local_content_is_demo,
            refresh_seconds=settings.repository_refresh_seconds,
        )
    problem = validate_gitlab_config(
        settings.gitlab_url,
        settings.gitlab_project_id,
        settings.gitlab_token,
        settings.gitlab_allow_insecure_http,
    )
    if problem:
        raise ConfigurationError(f"KNOWLEDGE_BACKEND=gitlab: {problem}")
    client = GitLabClient(
        base_url=settings.gitlab_url,
        project_id=settings.gitlab_project_id,
        token=settings.gitlab_token,
        timeout_seconds=settings.gitlab_timeout_seconds,
        verify=_verify(settings, settings.gitlab_ca_bundle),
    )
    return GitLabKnowledgeRepository(
        client,
        project_id=settings.gitlab_project_id,
        branch=settings.gitlab_default_branch,
        knowledge_path=settings.gitlab_knowledge_path,
        max_document_bytes=settings.max_document_bytes,
        max_files=settings.gitlab_max_files,
        refresh_seconds=settings.gitlab_refresh_seconds,
    )


def build_ai(settings: Settings) -> AIProvider:
    if settings.ai_provider == "mock":
        return MockAIProvider()
    if settings.ai_provider == "disabled":
        return DisabledAIProvider()
    return OpenAICompatibleAIProvider(
        base_url=settings.ai_base_url,
        model=settings.ai_model,
        api_key=settings.ai_api_key,
        timeout_seconds=settings.ai_timeout_seconds,
        allowed_hosts=settings.ai_allowed_host_list,
        allow_insecure_http=settings.ai_allow_insecure_http,
        max_context_chars=settings.ai_max_context_chars,
        max_response_bytes=settings.ai_max_response_bytes,
        verify=_verify(settings, settings.ai_ca_bundle),
    )


def _verify(settings: Settings, bundle: str) -> ssl.SSLContext | bool:
    try:
        return tls_verify(settings, bundle)
    except (ValueError, ssl.SSLError) as exc:
        raise ConfigurationError(str(exc)) from exc


def build_corporate(settings: Settings) -> CorporateKnowledgeConnector:
    if settings.confluence_connector == "disabled":
        return DisabledCorporateConnector()
    if settings.confluence_connector == "mock":
        return MockCorporateConnector(settings.confluence_space_list or None)
    result_map = parse_result_map(settings.confluence_mcp_result_map)
    return ConfluenceMCPConnector(
        McpClient(
            url=settings.confluence_mcp_url,
            token=settings.confluence_mcp_auth_token,
            timeout_seconds=settings.confluence_mcp_timeout_seconds,
            verify=_verify(settings, settings.confluence_mcp_ca_bundle),
        ),
        tool_map=parse_tool_map(settings.confluence_mcp_tool_map),
        allowlisted_spaces=settings.confluence_space_list,
        link_hosts=settings.confluence_link_host_list,
        max_body_chars=settings.confluence_max_body_chars,
        result_map=result_map,
        result_map_valid=result_map is not None,
        web_base_url=settings.confluence_web_base_url,
    )


def build_proposal_publisher(settings: Settings, repository: KnowledgeRepository) -> ProposalPublisher:
    if not settings.gitlab_proposals_enabled:
        return DisabledProposalPublisher()
    if not isinstance(repository, GitLabKnowledgeRepository):
        raise ConfigurationError("GITLAB_PROPOSALS_ENABLED=true требует KNOWLEDGE_BACKEND=gitlab.")
    return GitLabMRPublisher(repository)


def build_confluence_publisher(settings: Settings) -> ConfluencePublisher:
    if settings.confluence_publish_enabled:
        raise ConfigurationError("CONFLUENCE_PUBLISH_ENABLED=true: публикация запланирована на этап M5.")
    return DisabledConfluencePublisher()


def build_policy(settings: Settings) -> AuthorizationPolicy:
    # local_demo: one operator on loopback (enforced at startup). Anything else fails closed until a
    # corporate SSO/RBAC policy exists (docs/SSO_RBAC_REQUIREMENTS.md).
    return LocalDemoPolicy() if settings.auth_mode == "local_demo" else DenyAllPolicy()


def build_container(settings: Settings) -> Container:
    repository = build_repository(settings)
    search_provider = SqliteFtsSearchProvider(settings.search_index_file)
    ai = build_ai(settings)
    corporate = build_corporate(settings)
    proposal_publisher = build_proposal_publisher(settings, repository)
    confluence_publisher = build_confluence_publisher(settings)
    tasks = DisabledTaskSystem()
    store = ProposalStore(settings.app_state_file)
    knowledge = KnowledgeService(repository, search_provider, review_stale_days=settings.review_stale_days)
    return Container(
        settings=settings,
        repository=repository,
        search_provider=search_provider,
        ai=ai,
        corporate=corporate,
        proposal_publisher=proposal_publisher,
        confluence_publisher=confluence_publisher,
        tasks=tasks,
        proposal_store=store,
        knowledge=knowledge,
        search=SearchService(knowledge, corporate),
        assistant=AssistantService(knowledge, corporate, ai, max_context_chars=settings.ai_max_context_chars),
        proposals=ProposalService(
            store,
            repository,
            proposal_publisher,
            ai,
            max_document_bytes=settings.max_document_bytes,
            knowledge_prefix=settings.gitlab_knowledge_path if settings.knowledge_backend == "gitlab" else "",
            app_public_url=settings.app_public_url,
            on_merged=lambda: knowledge.refresh(),
        ),
        integrations=IntegrationService(
            settings=settings,
            repository=repository,
            search=search_provider,
            ai=ai,
            corporate=corporate,
            proposal_publisher=proposal_publisher,
            confluence_publisher=confluence_publisher,
            tasks=tasks,
        ),
        policy=build_policy(settings),
    )
