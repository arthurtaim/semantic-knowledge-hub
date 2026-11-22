"""AIProvider contract. The provider never retrieves, authorizes or writes anything itself:
it only receives already-authorized, delimited context passages and returns an answer that
the AssistantService validates against those passages."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Protocol

from app.domain.models import Confidence, DocStatus, DocType, IntegrationStatus, SourceType
from app.domain.text import QueryTerm

AIMode = Literal["mock", "internal_api", "disabled"]


@dataclass(frozen=True)
class ContextPassage:
    """One retrieved, authorized excerpt. `cid` (C1, C2, …) is the only handle a provider may cite."""

    cid: str
    document_id: str
    title: str
    section: str | None
    section_anchor: str | None
    status: DocStatus | None
    source_type: SourceType
    source_uri: str
    revision: str
    text: str
    is_demo: bool
    suspicious: bool = False  # contains text that looks like instructions to an AI


@dataclass(frozen=True)
class AnswerOptions:
    terms: list[QueryTerm]
    unmatched_terms: list[QueryTerm] = field(default_factory=list)
    language: str = "ru"


@dataclass(frozen=True)
class CitedEvidence:
    cid: str
    quote: str | None = None  # verbatim excerpt claimed to support the answer


@dataclass
class ProviderAnswer:
    answer: str  # may reference passages as [C1], [C2]
    confidence: Confidence
    evidence: list[CitedEvidence]
    warnings: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class AuthoringReference:
    """An authorized, retrieved document offered to the provider as UNTRUSTED material."""

    document_id: str
    title: str
    revision: str
    status: DocStatus
    source_type: SourceType
    sections: tuple[tuple[str, str], ...]  # (heading, prepared text) — injection-redacted
    is_demo: bool


@dataclass(frozen=True)
class AuthoringRequest:
    """Contract of AI-assisted authoring (docs/AI_AUTHORING_CONTRACT.md). The same shape is meant for
    a future agent runtime; the provider never stores, approves, merges or publishes anything."""

    request: str  # what the author asked for (data, not instructions to bypass rules)
    template_id: str
    doc_type: DocType
    title: str
    sections: tuple[tuple[str, str], ...]  # template sections: (heading, placeholder hint)
    references: tuple[AuthoringReference, ...]
    access_scope: str  # e.g. "team": the only scope the references were retrieved from


@dataclass(frozen=True)
class AuthoringCitation:
    document_id: str
    section: str | None
    quote: str  # must be verbatim in the referenced document; verified by AuthoringService


@dataclass
class AuthoringDraft:
    body: str  # Markdown body (no frontmatter): a suggestion for a human to edit
    citations: list[AuthoringCitation]
    unverified_claims: list[str]
    warnings: list[str]
    suggested_related_ids: list[str]
    insufficient_data: bool


class AIProviderError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class AIProvider(Protocol):
    mode: AIMode
    supports_edit_suggestions: bool
    supports_authoring: bool

    async def answer(
        self, question: str, passages: list[ContextPassage], options: AnswerOptions
    ) -> ProviderAnswer: ...

    async def suggest_edit(self, instruction: str, document_markdown: str) -> str:
        """Return a full proposed Markdown document. Raises AIProviderError if unsupported."""
        ...

    async def draft_document(self, request: AuthoringRequest) -> AuthoringDraft:
        """Draft the body of a new document from a template and references. Raises AIProviderError
        if unsupported."""
        ...

    async def status(self) -> IntegrationStatus: ...
