"""Composition root: selects adapters from configuration. Switching providers never needs code changes."""

from __future__ import annotations

import logging
import ssl
from dataclasses import dataclass
from pathlib import Path

from app.adapters.ai.base import AIProvider
from app.adapters.ai.claude_cli import ClaudeCodeCLIProvider
from app.adapters.ai.mock import DisabledAIProvider, MockAIProvider
from app.adapters.ai.openai_compatible import OpenAICompatibleAIProvider
from app.adapters.confluence_rest.client import ConfluenceDCClient
from app.adapters.confluence_rest.publisher import ConfluenceRESTPublisher
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
from app.domain.instructions import DEFAULT_INSTRUCTIONS_DIR, RuntimeInstructions, load_instructions
from app.domain.models import UserContext
from app.domain.template_registry import TemplateRegistry
from app.domain.templates import DEFAULT_TEMPLATES_DIR
from app.services.ai_workflows import AiProposalStore, AiWorkflowService
from app.services.assistant import AssistantService
from app.services.authoring import AuthoringService
from app.services.discovery import DiscoveryStore
from app.services.external import ExternalEvidenceService, ExternalLimits
from app.services.graph import GraphService
from app.services.integrations import IntegrationService
from app.services.knowledge import KnowledgeService
from app.services.links import LinkService
from app.services.metadata import MetadataService
from app.services.proposals import ProposalService, ProposalStore
from app.services.publications import PublicationService, PublicationStore
from app.services.search import SearchService
from app.services.template_hub import TemplateHubService

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
    authoring: AuthoringService
    integrations: IntegrationService
    policy: AuthorizationPolicy
    publication_store: PublicationStore
    publications: PublicationService
    graph: GraphService
    links: LinkService
    metadata: MetadataService
    template_hub: TemplateHubService
    ai_workflows: AiWorkflowService
    discovery: DiscoveryStore | None = None
    external: ExternalEvidenceService | None = None
    instructions: RuntimeInstructions | None = None

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
        self.publication_store.close()


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
        frozenset(settings.mock_service_host_list)
        if settings.integration_profile == "integration_mock"
        else frozenset(),
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


def build_ai(settings: Settings, instructions: RuntimeInstructions | None = None) -> AIProvider:
    if settings.ai_provider == "mock":
        return MockAIProvider()
    if settings.ai_provider == "disabled":
        return DisabledAIProvider()
    if settings.ai_provider == "claude_cli":
        return ClaudeCodeCLIProvider(
            worker_url=settings.claude_cli_worker_url,
            timeout_seconds=settings.claude_cli_timeout_seconds,
            draft_timeout_seconds=settings.claude_cli_draft_timeout_seconds,
            max_context_chars=settings.ai_max_context_chars,
            instructions=instructions,
        )
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
        instructions=instructions,
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
        return MockCorporateConnector(
            settings.confluence_space_list or None,
            corpus_path=settings.confluence_mock_pages_file,
            state_path=settings.confluence_mock_state_file,
        )
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
        status_ttl_seconds=settings.confluence_mcp_status_ttl_seconds,
    )


def build_proposal_publisher(settings: Settings, repository: KnowledgeRepository) -> ProposalPublisher:
    if not settings.gitlab_proposals_enabled:
        return DisabledProposalPublisher()
    if not isinstance(repository, GitLabKnowledgeRepository):
        raise ConfigurationError("GITLAB_PROPOSALS_ENABLED=true требует KNOWLEDGE_BACKEND=gitlab.")
    return GitLabMRPublisher(repository)


def build_confluence_publisher(settings: Settings) -> ConfluencePublisher:
    """disabled (no REST URL) · dry_run_only (URL, write off) · write (only where the profile allows it;
    `security_violations` has already refused every other combination at startup)."""
    if not settings.confluence_rest_url:
        return DisabledConfluencePublisher()
    client = ConfluenceDCClient(
        base_url=settings.confluence_rest_url,
        token=settings.confluence_rest_token,
        timeout_seconds=settings.confluence_rest_timeout_seconds,
        verify=_verify(settings, settings.confluence_rest_ca_bundle),
    )
    target = settings.target_kind(settings.confluence_rest_url)
    write = settings.confluence_publish_enabled and (
        (settings.integration_profile == "integration_mock" and target == "mock")
        or settings.integration_profile == "live_write_staging"
    )
    return ConfluenceRESTPublisher(
        client,
        space_key=settings.confluence_target_space,
        parent_id=settings.confluence_parent_page_id,
        write_enabled=write,
        target_kind=target,
    )


def build_policy(settings: Settings) -> AuthorizationPolicy:
    # local_demo: one operator on loopback (enforced at startup). Anything else fails closed until a
    # corporate SSO/RBAC policy exists (docs/SSO_RBAC_REQUIREMENTS.md).
    return LocalDemoPolicy() if settings.auth_mode == "local_demo" else DenyAllPolicy()


def build_container(settings: Settings) -> Container:
    repository = build_repository(settings)
    search_provider = SqliteFtsSearchProvider(settings.search_index_file)
    instructions = load_instructions(
        settings.resolve_path(Path(settings.assistant_instructions_dir))
        if settings.assistant_instructions_dir
        else DEFAULT_INSTRUCTIONS_DIR
    )
    ai = build_ai(settings, instructions)
    corporate = build_corporate(settings)
    proposal_publisher = build_proposal_publisher(settings, repository)
    confluence_publisher = build_confluence_publisher(settings)
    tasks = DisabledTaskSystem()
    store = ProposalStore(settings.app_state_file)
    discovery = (
        DiscoveryStore(
            settings.app_state_file,
            retention_hours=settings.discovery_retention_hours,
            store_query_text=settings.discovery_store_query_text,
            key_file=(
                settings.resolve_path(Path(settings.discovery_hmac_key_file))
                if settings.discovery_hmac_key_file
                else settings.app_state_file.parent / "discovery.key"
            ),
        )
        if settings.discovery_enabled
        else None
    )
    external = (
        ExternalEvidenceService(
            corporate,
            discovery,
            ExternalLimits(
                candidates=settings.external_candidates,
                fetches=settings.external_fetches,
                fragments=settings.external_fragments,
                context_chars=settings.external_context_chars,
                cache_pages=settings.external_cache_pages,
                cache_ttl_seconds=settings.external_cache_ttl_seconds,
                concurrency=settings.external_concurrency,
                timeout_seconds=settings.external_timeout_seconds,
                deadline_seconds=settings.external_deadline_seconds,
                breaker_failures=settings.external_breaker_failures,
                breaker_reset_seconds=settings.external_breaker_reset_seconds,
            ),
        )
        if corporate.enabled
        else None
    )
    knowledge = KnowledgeService(repository, search_provider, review_stale_days=settings.review_stale_days)
    knowledge_prefix = settings.gitlab_knowledge_path if settings.knowledge_backend == "gitlab" else ""
    templates_dir = (
        settings.resolve_path(Path(settings.document_templates_dir))
        if settings.document_templates_dir
        else DEFAULT_TEMPLATES_DIR
    )
    publication_store = PublicationStore(settings.publication_state_file)
    publications = PublicationService(
        store=publication_store,
        publisher=confluence_publisher,
        repository=repository,
        knowledge=knowledge,
        merge_evidence=repository.merged_merge_request
        if isinstance(repository, GitLabKnowledgeRepository)
        else None,
        project_id=settings.gitlab_project_id if settings.knowledge_backend == "gitlab" else "local",
        publish_statuses=settings.confluence_publish_status_list,
    )
    publications.recover()
    templates = TemplateRegistry(templates_dir, settings.app_state_file)
    knowledge.on_refresh(lambda: templates.reload())
    knowledge.template_registry_label = lambda: templates.label
    authoring = AuthoringService(
        templates=templates,
        repository=repository,
        knowledge=knowledge,
        store=store,
        ai=ai,
        knowledge_prefix=knowledge_prefix,
        max_document_bytes=settings.max_document_bytes,
    )
    assistant_service = AssistantService(
        knowledge,
        corporate,
        ai,
        max_context_chars=settings.ai_max_context_chars,
        external=external,
        discovery=discovery,
        instructions_version=lambda: instructions.version,
    )
    proposal_service = ProposalService(
        store,
        repository,
        proposal_publisher,
        ai,
        max_document_bytes=settings.max_document_bytes,
        knowledge_prefix=knowledge_prefix,
        app_public_url=settings.app_public_url,
        on_merged=lambda: knowledge.refresh(),
        authoring=authoring,
        after_sync=publications.on_document_merged,
    )
    graph_service = GraphService(knowledge, templates.graph_entries)
    link_service = LinkService(knowledge)
    metadata_service = MetadataService(knowledge, authoring, repository)
    ai_workflows = AiWorkflowService(
        store=AiProposalStore(settings.app_state_file),
        ai=ai,
        knowledge=knowledge,
        authoring=authoring,
        proposals=proposal_service,
        metadata=metadata_service,
        links=link_service,
        graph=graph_service,
        assistant=assistant_service,
    )
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
        assistant=assistant_service,
        proposals=proposal_service,
        authoring=authoring,
        publication_store=publication_store,
        publications=publications,
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
        graph=graph_service,
        links=link_service,
        metadata=metadata_service,
        ai_workflows=ai_workflows,
        template_hub=TemplateHubService(authoring, knowledge),
        discovery=discovery,
        external=external,
        instructions=instructions,
    )
