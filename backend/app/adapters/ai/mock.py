"""Deterministic offline provider. It never composes claims: it only quotes retrieved sentences."""

from __future__ import annotations

from dataclasses import dataclass

from app.adapters.ai.base import (
    AIMode,
    AIProviderError,
    AnswerOptions,
    CitedEvidence,
    ContextPassage,
    ProviderAnswer,
)
from app.domain.models import Confidence, IntegrationStatus
from app.domain.safety import looks_like_prompt_injection
from app.domain.text import QueryTerm, split_sentences, term_matches_text, tokenize

MAX_QUOTES = 4
MAX_QUOTES_PER_PASSAGE = 2
MAX_CHARS_PER_PASSAGE = 700
SUPPORTED_COVERAGE = 0.75

MOCK_PREFIX = (
    "Демо-режим: ответ сформирован без языковой модели — ниже приведены дословные выдержки из найденных "
    "документов. Делайте выводы только после проверки источников."
)


@dataclass(frozen=True)
class _Sentence:
    passage_index: int
    cid: str
    position: int
    block: int
    text: str
    matched: frozenset[str]
    weight: int
    safe: bool


def _term_weight(term: QueryTerm) -> int:
    return 2 if term.is_entity_like else 1


def _format_terms(terms: list[QueryTerm]) -> str:
    return ", ".join(f"«{t.original}»" for t in terms)


def insufficient(message: str, warnings: list[str] | None = None) -> ProviderAnswer:
    return ProviderAnswer(
        answer=message, confidence="insufficient_evidence", evidence=[], warnings=warnings or []
    )


def _sentences(passages: list[ContextPassage], terms: list[QueryTerm]) -> list[_Sentence]:
    result: list[_Sentence] = []
    for p_index, passage in enumerate(passages):
        position = 0
        for b_index, block in enumerate(passage.text.split("\n")):
            for sentence in split_sentences(block):
                words = tokenize(sentence)
                matched = [t for t in terms if term_matches_text(t, words)]
                result.append(
                    _Sentence(
                        passage_index=p_index,
                        cid=passage.cid,
                        position=position,
                        block=b_index,
                        text=sentence,
                        matched=frozenset(t.stem for t in matched),
                        weight=sum(_term_weight(t) for t in matched),
                        safe=not looks_like_prompt_injection(sentence),
                    )
                )
                position += 1
    return result


class MockAIProvider:
    mode: AIMode = "mock"
    supports_edit_suggestions = False

    async def answer(
        self, question: str, passages: list[ContextPassage], options: AnswerOptions
    ) -> ProviderAnswer:
        terms = options.terms
        if not terms:
            return insufficient("Вопрос не содержит значимых слов для поиска. Переформулируйте вопрос.")

        missing_entities = [t for t in options.unmatched_terms if t.is_entity_like]
        if missing_entities:
            return insufficient(
                "Недостаточно данных: в доступных источниках нет упоминаний "
                f"{_format_terms(missing_entities)}. Демо-ассистент не делает предположений о том, "
                "чего нет в документах."
            )

        sentences = _sentences(passages, terms)
        index = {(s.cid, s.position): s for s in sentences}
        warnings: list[str] = []
        if any(not s.safe for s in sentences):
            warnings.append(
                "Часть текста источника похожа на инструкции для ИИ и не использовалась: "
                "содержимое документов рассматривается только как данные."
            )
        candidates = [s for s in sentences if s.safe and s.weight > 0]
        if not candidates:
            return insufficient(
                "Недостаточно данных: в доступных источниках не найдено фрагментов, отвечающих на вопрос.",
                warnings,
            )

        best = max(c.weight for c in candidates)
        threshold = max(1, (best + 1) // 2)
        selected: dict[str, set[int]] = {}
        seeds: dict[str, int] = {}
        rank: dict[str, tuple[int, int]] = {}
        total_seeds = 0
        for cand in sorted(candidates, key=lambda c: (-c.weight, c.passage_index, c.position)):
            if cand.weight < threshold or total_seeds >= MAX_QUOTES:
                break
            positions = selected.setdefault(cand.cid, set())
            following = index.get((cand.cid, cand.position + 1))
            has_following = following is not None and following.safe and following.block == cand.block
            if cand.position in positions:
                # Already quoted as context: extend the quote by one sentence instead of a new excerpt.
                if has_following and following is not None and following.position not in positions:
                    chars = sum(len(index[(cand.cid, p)].text) for p in positions) + len(following.text)
                    if chars <= MAX_CHARS_PER_PASSAGE:
                        positions.add(following.position)
                continue
            if seeds.get(cand.cid, 0) >= MAX_QUOTES_PER_PASSAGE:
                continue
            window = {cand.position}
            if has_following and following is not None:
                window.add(following.position)
            used_chars = sum(len(index[(cand.cid, p)].text) for p in positions | window)
            if used_chars > MAX_CHARS_PER_PASSAGE:
                window = {cand.position}
                if sum(len(index[(cand.cid, p)].text) for p in positions | window) > MAX_CHARS_PER_PASSAGE:
                    continue
            positions |= window
            seeds[cand.cid] = seeds.get(cand.cid, 0) + 1
            rank.setdefault(cand.cid, (-cand.weight, cand.passage_index))
            total_seeds += 1

        covered: set[str] = set()
        best_single = 0.0
        entity_stems = {t.stem for t in terms if t.is_entity_like}
        lines: list[str] = []
        evidence: list[CitedEvidence] = []
        for number, cid in enumerate(sorted(rank, key=lambda c: rank[c]), start=1):
            runs: list[list[str]] = []
            previous: int | None = None
            in_passage: set[str] = set()
            for position in sorted(selected[cid]):
                sentence = index[(cid, position)]
                in_passage |= sentence.matched
                if previous is not None and position == previous + 1:
                    runs[-1].append(sentence.text)
                else:
                    runs.append([sentence.text])
                previous = position
            covered |= in_passage
            if entity_stems <= in_passage:
                best_single = max(best_single, len(in_passage) / len(terms))
            quote = " … ".join(" ".join(run) for run in runs)
            evidence.append(CitedEvidence(cid=cid, quote=quote))
            lines.append(f"{number}. «{quote}» [{cid}]")

        # "supported" only when ONE source covers the question; scattered matches stay "partial".
        confidence: Confidence = "supported" if best_single >= SUPPORTED_COVERAGE else "partial"
        answer = MOCK_PREFIX + "\n\n" + "\n".join(lines)
        not_covered = [t for t in terms if t.stem not in covered]
        if not_covered and confidence == "partial":
            answer += f"\n\nВ процитированных фрагментах не встречаются: {_format_terms(not_covered)}."
        return ProviderAnswer(answer=answer, confidence=confidence, evidence=evidence, warnings=warnings)

    async def suggest_edit(self, instruction: str, document_markdown: str) -> str:
        raise AIProviderError(
            "ai_edit_unsupported",
            "В демо-режиме ИИ не генерирует правки. Отредактируйте текст вручную — изменения пройдут ту же проверку.",
        )

    async def status(self) -> IntegrationStatus:
        return IntegrationStatus(
            name="ai_provider",
            title="AI-провайдер",
            kind="ai",
            state="mock",
            capabilities=["extractive_answers"],
            human_readable_message=(
                "Демо-режим (mock): детерминированные дословные выдержки из документов, "
                "без языковой модели и без сетевых запросов."
            ),
            details={"provider": "mock"},
        )


class DisabledAIProvider:
    mode: AIMode = "disabled"
    supports_edit_suggestions = False

    async def answer(
        self, question: str, passages: list[ContextPassage], options: AnswerOptions
    ) -> ProviderAnswer:
        raise AIProviderError(
            "assistant_disabled", "Ассистент отключён конфигурацией (AI_PROVIDER=disabled)."
        )

    async def suggest_edit(self, instruction: str, document_markdown: str) -> str:
        raise AIProviderError(
            "assistant_disabled", "Ассистент отключён конфигурацией (AI_PROVIDER=disabled)."
        )

    async def status(self) -> IntegrationStatus:
        return IntegrationStatus(
            name="ai_provider",
            title="AI-провайдер",
            kind="ai",
            state="disabled",
            capabilities=[],
            human_readable_message="Ассистент отключён (AI_PROVIDER=disabled). Поиск по документам доступен.",
            details={"provider": "disabled"},
        )
