"""Bounded model suggestions for staged files (M8). Every value is verified: a title / summary / owner only with a
verbatim quote of the file (else dropped), a type only from `DocType`, a template only among active templates, tags
only short words of the existing vocabulary or of the file. Suggestions are stored as `origin: model` with the
model's confidence and are NEVER applied by themselves — the person accepts each one (an item decision)."""

from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING, Any

from app.adapters.ai.base import AIProvider, AIProviderError, OnboardingAIProvider, OnboardingSuggestRequest
from app.adapters.ai.onboarding_protocol import OnboardingReply, parse_reply
from app.domain.models import DocType, UserContext
from app.domain.onboarding import Evidence, FieldSuggestion
from app.domain.ru_dates import normalize_quote, quote_in_text

if TYPE_CHECKING:
    from app.services.onboarding.service import OnboardingService

logger = logging.getLogger("skh.onboarding.ai")


def _quoted(value: str | None, quote: str | None, text: str) -> bool:
    return bool(value and quote and quote_in_text(quote, text))


class OnboardingSuggester:
    def __init__(self, provider: AIProvider, registry: Any) -> None:
        self.provider = provider
        self._registry = registry

    @property
    def available(self) -> bool:
        return bool(getattr(self.provider, "supports_onboarding_suggestions", False))

    def _request(self, filename: str, text: str, tags: list[str]) -> OnboardingSuggestRequest:
        active = [t for t in self._registry.active().values() if t.listed and t.status == "active"]
        return OnboardingSuggestRequest(
            filename=filename,
            text=text,
            doc_types=tuple(t.value for t in DocType),
            templates=tuple((t.id, t.title) for t in active),
            tags=tuple(tags),
        )

    def verify(
        self, reply: OnboardingReply, path: str, text: str, vocabulary: set[str]
    ) -> list[FieldSuggestion]:
        model = getattr(self.provider, "model", None) or getattr(self.provider, "mode", "model")
        note = f"предложение модели ({model}), не проверено человеком"
        out: list[FieldSuggestion] = []

        def add(name: str, value: Any, quote: str | None = None, confidence: float | None = None) -> None:
            evidence = [Evidence(file=path, snippet=quote[:160])] if quote else []
            out.append(
                FieldSuggestion(
                    field=name,
                    value=value,
                    origin="model",
                    confidence=confidence,
                    evidence=evidence,
                    note=note,
                )
            )

        if reply.doc_type in {t.value for t in DocType}:
            add("type", reply.doc_type, confidence=reply.confidence)
        if reply.template_id and self._registry.get(reply.template_id) is not None:
            add("template_id", reply.template_id, confidence=reply.confidence)
        for name, value, quote in (
            ("title", reply.title, reply.title_quote),
            ("summary", reply.summary, reply.summary_quote),
            ("owner", reply.owner, reply.owner_quote),
        ):
            if _quoted(value, quote, text):
                add(name, value, quote)
        words = set(normalize_quote(text).split())
        tags = [t for t in reply.tags if t in vocabulary or normalize_quote(t) in words]
        if tags:
            add("tags", tags)
        return out

    async def run(
        self, service: OnboardingService, user: UserContext, batch_id: str, rows: list[Any]
    ) -> tuple[dict[str, str], str | None]:
        provider: OnboardingAIProvider = self.provider  # type: ignore[assignment]  # checked by `available`
        snapshot = await service.knowledge.snapshot(user)
        vocabulary = sorted({tag for d in snapshot.documents.values() for tag in d.tags})
        used = sum(
            1
            for r in service.store.items(batch_id)
            if json.loads(r["ai_json"] or "{}").get("state") in ("done", "failed")
        )
        states: dict[str, str] = {}
        notes: list[str] = []
        for row in rows:
            ai = json.loads(row["ai_json"] or "{}")
            if (
                row["parse_status"] not in ("parsed", "conflict")
                or row["content"] is None
                or row["outcome_json"]
            ):
                states[row["id"]] = "skipped"
                continue
            if ai.get("state") == "done":  # already suggested: not called again
                states[row["id"]] = "done"
                continue
            if used >= service.ai_items:
                states[row["id"]] = "skipped"
                notes.append(f"Лимит подсказок модели на пакет ({service.ai_items}) исчерпан.")
                continue
            used += 1
            request = self._request(row["path"].rsplit("/", 1)[-1], row["content"], vocabulary)
            try:
                reply = parse_reply(await provider.suggest_onboarding(request))
            except AIProviderError as exc:
                states[row["id"]] = "failed"
                service.store.set_ai(
                    batch_id,
                    row["id"],
                    {
                        "state": "failed",
                        "code": exc.code,
                        "note": "Модель не ответила или ответила не по формату — остаются подсказки по правилам.",
                    },
                )
                logger.info("onboarding ai failed batch=%s code=%s", batch_id, exc.code)
                continue
            suggestions = self.verify(reply, row["path"], row["content"], set(vocabulary))
            states[row["id"]] = "done"
            service.store.set_ai(
                batch_id,
                row["id"],
                {
                    "state": "done",
                    "suggestions": [s.model_dump() for s in suggestions],
                    "dropped": max(
                        0,
                        sum(1 for v in (reply.title, reply.summary, reply.owner) if v)
                        - sum(1 for s in suggestions if s.field in ("title", "summary", "owner")),
                    ),
                    "note": f"Подсказки модели: {len(suggestions)}; без опоры в тексте отброшено — см. счётчик.",
                },
            )
        logger.info("onboarding ai batch=%s states=%s", batch_id, ",".join(sorted(set(states.values()))))
        return states, (" ".join(dict.fromkeys(notes)) or None)
