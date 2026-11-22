"""AIProvider contract. The provider never retrieves, authorizes or writes anything itself:
it only receives already-authorized, delimited context passages and returns an answer that
the AssistantService validates against those passages."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Protocol

from app.domain.models import Confidence, DocStatus, IntegrationStatus, SourceType
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


class AIProviderError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class AIProvider(Protocol):
    mode: AIMode
    supports_edit_suggestions: bool

    async def answer(
        self, question: str, passages: list[ContextPassage], options: AnswerOptions
    ) -> ProviderAnswer: ...

    async def suggest_edit(self, instruction: str, document_markdown: str) -> str:
        """Return a full proposed Markdown document. Raises AIProviderError if unsupported."""
        ...

    async def status(self) -> IntegrationStatus: ...
