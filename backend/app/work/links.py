"""Task ↔ document links (M6 Step 4): the reader's document scope and the state of a link.

A link stores a STABLE document id and the revision seen when linking (`work_task_links`); title, status, version
and access are read on every request from the READER's current knowledge snapshot (`KnowledgeService.snapshot(user)`
— the repository is the access boundary, exactly as for document links and the graph). Consequences:

- a document the reader cannot see — deleted, renamed away or hidden by ACL — is `unavailable`, and these cases are
  indistinguishable on purpose: no id, title, status, revision or excerpt leaves the server for it;
- when the knowledge source cannot be read at all, every link is `unverified` (nothing is shown about documents,
  nothing is guessed from what the work database remembers);
- a changed revision is reported (`revision_changed`), never silently «re-approved»: only a person acknowledges it.

A link is not a knowledge-graph relation: it never writes a document, never adds YAML relations and never becomes a
typed edge between documents (a task is not a document).
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field

from app.adapters.knowledge.base import KnowledgeSnapshot
from app.domain.models import DocStatus, DocumentRecord
from app.work.models import LinkedDocumentRef, LinkState


@dataclass(frozen=True)
class DocumentScope:
    """The documents THIS reader may see right now (lower-cased id → record), or «the source is unavailable»."""

    available: bool
    documents: Mapping[str, DocumentRecord] = field(default_factory=dict)
    generation: str | None = None

    @classmethod
    def unavailable(cls) -> DocumentScope:
        return cls(available=False)

    @classmethod
    def from_snapshot(cls, snapshot: KnowledgeSnapshot, generation: str | None) -> DocumentScope:
        # An id that resolves to several files is ambiguous: never guessed, treated as not visible.
        docs = {k: v for k, v in snapshot.documents.items() if k not in snapshot.duplicates}
        return cls(available=True, documents=docs, generation=generation)

    def get(self, document_id: str | None) -> DocumentRecord | None:
        if not self.available or not document_id:
            return None
        return self.documents.get(document_id.lower())


def document_ref(doc: DocumentRecord) -> LinkedDocumentRef:
    return LinkedDocumentRef(
        document_id=doc.id,
        title=doc.title,
        type=doc.type.value,
        status=doc.status.value,
        version=doc.version,
        revision=doc.revision,
        is_demo=doc.is_demo,
        app_path=f"/documents/{doc.id}",
    )


def link_state(scope: DocumentScope, document_id: str | None, revision_at_link: str | None) -> LinkState:
    """The state of one link for this reader (see the module docstring)."""
    if not scope.available:
        return "unverified"
    doc = scope.get(document_id)
    if doc is None:
        return "unavailable"
    if revision_at_link is None:
        return "revision_unknown"
    return "current" if doc.revision == revision_at_link else "revision_changed"


def is_deprecated(doc: DocumentRecord | None) -> bool:
    return doc is not None and doc.status == DocStatus.deprecated


def is_approved(doc: DocumentRecord | None) -> bool:
    return doc is not None and doc.status == DocStatus.approved
