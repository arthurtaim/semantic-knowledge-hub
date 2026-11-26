"""AIProvider contract. The provider never retrieves, authorizes or writes anything itself:
it only receives already-authorized, delimited context passages and returns an answer that
the AssistantService validates against those passages."""

from __future__ import annotations

from collections.abc import AsyncGenerator
from dataclasses import dataclass, field
from typing import Literal, Protocol

from app.domain.models import (
    CitationSourceType,
    Confidence,
    DocStatus,
    DocType,
    IntegrationStatus,
    SourceType,
)
from app.domain.text import QueryTerm

# claude_cli: EXPERIMENTAL personal-test provider (Claude Code CLI through an isolated worker,
# docs/CLAUDE_CODE_CLI_INTEGRATION.md). It is not the corporate target runtime (GigaCode).
AIMode = Literal["mock", "internal_api", "claude_cli", "disabled"]


@dataclass(frozen=True)
class ConversationTurn:
    """A previous question and the server-validated answer shown to the user. Sent back by the
    client with a follow-up question; treated as untrusted DATA, never as instructions."""

    question: str
    answer: str


@dataclass(frozen=True)
class ContextPassage:
    """One retrieved, authorized excerpt. `cid` (C1, C2, …) is the only handle a provider may cite."""

    cid: str
    document_id: str
    title: str
    section: str | None
    section_anchor: str | None
    status: DocStatus | None
    source_type: CitationSourceType
    source_uri: str
    revision: str
    text: str
    is_demo: bool
    suspicious: bool = False  # contains text that looks like instructions to an AI
    # External (Confluence MCP) evidence: namespaced source id, authority as the SOURCE states it
    # ("approved" | "draft" | "unknown"), fragment within the retrieved snapshot.
    source_key: str | None = None
    external_status: str | None = None
    fragment_id: str | None = None
    content_hash: str | None = None
    # A file attached to the conversation (source_type "attachment", UI v2): user DATA, never a knowledge-base
    # document. `locators` has one (scope, kind, number) per line of `text`, e.g. ("лист Fields", "row", 12); the
    # server turns the lines a quote covers into «строка 3» / «стр. 2» / «лист Fields, строки 7–9».
    attachment_id: str | None = None
    locators: tuple[tuple[str, str, int], ...] = ()
    locator: str = ""  # the whole fragment («строки 1–40»), shown to a model next to the text
    # Context the user chose explicitly (a document via «@» or a selection): cited first when relevant.
    chosen: bool = False


@dataclass(frozen=True)
class AnswerOptions:
    terms: list[QueryTerm]
    unmatched_terms: list[QueryTerm] = field(default_factory=list)
    language: str = "ru"
    # Earlier turns of the same conversation (oldest first). Providers that do not support
    # conversations ignore it; the server never stores it.
    history: tuple[ConversationTurn, ...] = ()
    # Compare mode (skill compare_with_file): the terms come from an attached file, so terms absent from the
    # knowledge base are a FINDING to report, not a reason to refuse the whole answer.
    compare_terms: bool = False
    # A follow-up: terms that come only from the previous question (the conversation's referent). They help to
    # select passages and sentences, but the user did not ask them now: never reported as missing.
    context_terms: list[QueryTerm] = field(default_factory=list)
    # Adaptive RAG (docs/ADAPTIVE_RAG.md): what the evidence-gap check found NOT stated in the team documents (the
    # model's own short descriptions, ≤ 3). DATA for the answering model — never evidence, never shown as a fact.
    evidence_gap: tuple[str, ...] = ()


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
    # M5.6.3: guidance of the PINNED template version from the registry (data, not a system instruction).
    guidance: str = ""
    template_version: int = 1


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


AssistTask = Literal["improve", "summarize"]


@dataclass(frozen=True)
class AssistRequest:
    """A contextual text task on a document (M5.6.3 AI-first workflows). `text` is the selection or the
    section the user chose; references are authorized, injection-redacted excerpts; `guidance` comes from the
    template registry (pinned version). Everything here is DATA for the model, never instructions."""

    task: AssistTask
    text: str
    title: str
    references: tuple[AuthoringReference, ...] = ()
    guidance: str = ""
    goal: str = ""  # optional wish of the user ("короче", "для аналитика")


@dataclass
class AssistResult:
    text: str  # proposed Markdown (a section or a summary), shown as a diff; applied only on Accept
    citations: list[AuthoringCitation]
    warnings: list[str]
    insufficient_data: bool


@dataclass(frozen=True)
class TemplateCatalogueEntry:
    """An existing active template as DATA for the model (so it can say «похоже на существующий шаблон»)."""

    template_id: str
    title: str
    doc_type: str
    category: str
    description: str
    sections: tuple[str, ...]


@dataclass(frozen=True)
class TemplateDraftRequest:
    """Template Studio «Создать с помощью AI» (docs/AI_WORKFLOWS.md): a PROPOSAL of a template structure. The request
    and the catalogue are DATA; the allowed values come from the backend. The reply is the model's raw text, parsed
    by app/adapters/ai/template_protocol.py — the provider never stores, validates or activates anything."""

    request: str
    catalogue: tuple[TemplateCatalogueEntry, ...]
    doc_types: tuple[str, ...]
    metadata_fields: tuple[str, ...]


class TemplateDraftingAIProvider(Protocol):
    """Optional capability (model-agnostic JSON protocol; any chat model: internal API, a future GigaChat)."""

    supports_template_drafting: bool

    async def draft_template(self, request: TemplateDraftRequest) -> str: ...


@dataclass(frozen=True)
class WorkPlanRequest:
    """M6 «AI план» (docs/WORK_MANAGEMENT.md §11): a PROPOSAL of tasks from authorized, retrieved documents. The request,
    the documents and the project's existing tasks are DATA; the reply is the model's raw text, parsed strictly by
    app/adapters/ai/work_protocol.py and validated by the backend (app/work/ai.py). The provider never creates,
    stores, schedules or assigns anything; dates and assignees are never the model's."""

    project_key: str
    project_title: str
    request: str
    start_date: str | None  # the planned start the user chose (the server computes dates), or None
    existing_tasks: tuple[tuple[str, str], ...]  # (key, title) of active tasks, for de-duplication only
    references: tuple[AuthoringReference, ...]
    max_tasks: int = 20


class WorkPlanningAIProvider(Protocol):
    """Optional capability (model-agnostic JSON protocol; internal OpenAI-compatible API, a future GigaChat endpoint,
    the personal-test Claude CLI worker). A provider without it (mock, disabled) has no AI planning."""

    supports_work_planning: bool

    async def plan_work(self, request: WorkPlanRequest) -> str: ...


@dataclass(frozen=True)
class EvidenceCard:
    """One authorized team passage, shortened for the evidence-gap check. `eid` (E1, E2, …) is the only handle the
    model may name; the server maps it back to the passage it built the card from."""

    eid: str
    document_id: str
    title: str
    section: str | None
    status: DocStatus | None
    excerpt: str  # injection-redacted, bounded


@dataclass(frozen=True)
class GapAssessmentRequest:
    """Adaptive RAG (docs/ADAPTIVE_RAG.md): ONE small classification call of a possibly weak chat model — do these
    team excerpts answer the question, and if not, what is missing and what to search for. Everything here is DATA;
    the reply is parsed strictly by app/adapters/ai/gap_protocol.py and validated by the backend
    (app/services/evidence_gate.py). The model never searches, fetches or authorizes anything."""

    question: str
    cards: tuple[EvidenceCard, ...]
    referent: str = ""  # the previous question of the dialog: context for pronouns, never evidence
    absent_terms: tuple[str, ...] = ()  # words of the question in NO eligible team document (a server fact)
    repair: str = ""  # server note for the single repair attempt after a reply that was not a JSON object
    ask_known: bool = True  # request the optional `known` list (never evidence); EXTERNAL_GATE_REQUEST_KNOWN


class EvidenceGapAIProvider(Protocol):
    """Optional capability over plain chat completion (no native tools, no JSON mode required): internal
    OpenAI-compatible API, the personal-test Claude CLI worker, a future GigaChat endpoint. Returns the raw reply."""

    supports_gap_assessment: bool

    async def assess_evidence_gap(self, request: GapAssessmentRequest, *, max_chars: int) -> str: ...


class AIProviderError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


# The provider cannot serve right now (configuration, reachability, authorization, limits): 503.
AI_UNAVAILABLE_CODES = frozenset(
    {
        "assistant_disabled",
        "ai_misconfigured",
        "ai_unreachable",
        "ai_timeout",
        "ai_rate_limited",
        "ai_auth_failed",
        "ai_cli_unavailable",
    }
)


def ai_error_status(code: str) -> int:
    """HTTP status for an AIProviderError code: 429 busy, 503 unavailable, 502 bad answer/upstream error."""
    if code == "ai_busy":
        return 429
    return 503 if code in AI_UNAVAILABLE_CODES else 502


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

    async def assist(self, request: AssistRequest) -> AssistResult:
        """Improve or summarize a selection. Returns a PROPOSAL; raises AIProviderError (invalid answer,
        unavailable). Never stores or applies anything."""
        ...

    async def status(self) -> IntegrationStatus: ...


@dataclass(frozen=True)
class AnswerDelta:
    """A fragment of the model's PRELIMINARY answer text (not validated yet)."""

    text: str


@dataclass(frozen=True)
class AnswerComplete:
    """The complete provider answer; AssistantService validates it before anyone relies on it."""

    answer: ProviderAnswer


AnswerStreamEvent = AnswerDelta | AnswerComplete


class StreamingAIProvider(Protocol):
    """Optional capability on top of AIProvider: stream preliminary text while the answer is generated.
    The last event is always AnswerComplete; errors are raised as AIProviderError. Cancelling the
    iteration must stop the underlying generation."""

    def stream_answer(
        self, question: str, passages: list[ContextPassage], options: AnswerOptions
    ) -> AsyncGenerator[AnswerStreamEvent, None]: ...


# --- M5.7: one round of the bounded model → tool → model loop (docs/AI_NATIVE_TOOLS.md) -------------------------


@dataclass(frozen=True)
class ToolSpec:
    """An allowlisted SKH tool offered to the model: its name and a compact, trusted description (code)."""

    name: str
    description: str


@dataclass(frozen=True)
class ToolExchangeEntry:
    """One call of an earlier round and the bounded JSON result the BACKEND returned for it."""

    call_id: str
    name: str
    arguments_json: str
    result_json: str


@dataclass(frozen=True)
class ToolExchange:
    round: int
    entries: tuple[ToolExchangeEntry, ...]


@dataclass(frozen=True)
class ToolTurnRequest:
    """Everything one model round sees. Only `tools` (and the protocol in code) are instructions; the question,
    history, previous-turn context, passages and tool results are DATA. An empty `tools` means: answer now."""

    question: str
    passages: tuple[ContextPassage, ...] = ()
    history: tuple[ConversationTurn, ...] = ()
    tools: tuple[ToolSpec, ...] = ()
    exchanges: tuple[ToolExchange, ...] = ()
    context_note: str = ""  # JSON of the previous answer's referent (re-checked IDs), data only
    repair: str = ""  # server note: why the previous reply was rejected (at most one repair per answer)
    max_calls: int = 4
    rounds_left: int = 0
    evidence_gap: tuple[
        str, ...
    ] = ()  # AnswerOptions.evidence_gap: what the team documents do not state (data)


@dataclass(frozen=True)
class ToolTurnReply:
    """The raw text of one model round; the loop parses it (strict envelope, app/adapters/ai/tool_protocol.py)."""

    text: str


ToolTurnEvent = AnswerDelta | ToolTurnReply


class ToolCallingAIProvider(Protocol):
    """Optional capability: one round of the tool loop. The PROVIDER never executes anything — it only returns the
    model's reply; the backend validates and executes allowlisted calls. Preliminary deltas are optional (never
    for a tool request); the last event is ToolTurnReply; errors are AIProviderError; cancelling stops the model."""

    supports_tools: bool

    def tool_turn(self, request: ToolTurnRequest) -> AsyncGenerator[ToolTurnEvent, None]: ...
