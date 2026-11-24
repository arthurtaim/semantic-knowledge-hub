"""Deterministic offline provider. It never composes claims: it only quotes retrieved sentences."""

from __future__ import annotations

import re
from dataclasses import dataclass

from app.adapters.ai.base import (
    AIMode,
    AIProviderError,
    AnswerOptions,
    AssistRequest,
    AssistResult,
    AuthoringCitation,
    AuthoringDraft,
    AuthoringReference,
    AuthoringRequest,
    CitedEvidence,
    ContextPassage,
    ProviderAnswer,
)
from app.domain.models import Confidence, IntegrationStatus
from app.domain.safety import INJECTION_PLACEHOLDER, looks_like_prompt_injection
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


ATTACHMENTS_HEADER = "Вложения этого диалога (дословно, без выводов):"
MAX_FILE_QUOTES = 3
MIN_FILE_QUOTE_CHARS = 12


def _attachment_quotes(
    files: list[ContextPassage], terms: list[QueryTerm], start: int
) -> tuple[list[str], list[CitedEvidence]]:
    """One verbatim quote per attachment fragment: its first line (extended to the next one when too short)
    plus up to two lines with the question's words. Never a summary, never a comparison."""
    lines: list[str] = []
    evidence: list[CitedEvidence] = []
    for passage in files[:MAX_FILE_QUOTES]:
        rows = [
            r
            for r in passage.text.split("\n")
            if r.strip() and INJECTION_PLACEHOLDER not in r and not looks_like_prompt_injection(r)
        ]
        if not rows:
            continue
        head = [rows[0]]
        if len(rows[0]) < MIN_FILE_QUOTE_CHARS and len(rows) > 1:
            head.append(rows[1])
        matching = [r for r in rows[len(head) :] if any(term_matches_text(t, tokenize(r)) for t in terms)][:2]
        quote = " … ".join([" ".join(head), *matching])
        if len(quote) < MIN_FILE_QUOTE_CHARS:
            continue
        evidence.append(CitedEvidence(cid=passage.cid, quote=quote))
        lines.append(f"{start + len(lines)}. «{quote}» [{passage.cid}]")
    return lines, evidence


PLACEHOLDER = "Требует уточнения"
AUTHORING_DEMO_WARNING = (
    "Демо-режим: черновик собран без языковой модели — это структура шаблона, ссылки на найденные "
    "утверждённые документы и их дословные выдержки. Все разделы требуют заполнения автором."
)
_REFERENCE_SECTIONS = ("связанные документы", "связи", "источники")
_MAX_QUOTE_CHARS = 400


def _heading_key(heading: str) -> str:
    return re.sub(r"[^\w]+", " ", heading.casefold()).strip()


def _headings_match(template_heading: str, source_heading: str) -> bool:
    a, b = _heading_key(template_heading), _heading_key(source_heading)
    return a == b or (len(a) >= 6 and len(b) >= 6 and a[:6] == b[:6])


def _link_title(text: str) -> str:
    return text.replace("[", "(").replace("]", ")").replace("\n", " ").strip()


def _quotable_sentence(text: str) -> str | None:
    for block in text.split("\n"):
        for sentence in split_sentences(block):
            sentence = sentence.strip()
            if (
                20 <= len(sentence) <= _MAX_QUOTE_CHARS
                and not looks_like_prompt_injection(sentence)
                and "[" not in sentence
                and "]" not in sentence
            ):
                return sentence
    return None


def _find_quote(
    heading: str, references: tuple[AuthoringReference, ...]
) -> tuple[AuthoringReference, str, str] | None:
    for ref in references:
        for source_heading, text in ref.sections:
            if _headings_match(heading, source_heading):
                sentence = _quotable_sentence(text)
                if sentence:
                    return ref, source_heading, sentence
    return None


class MockAIProvider:
    mode: AIMode = "mock"
    supports_edit_suggestions = False
    supports_authoring = True

    async def answer(
        self, question: str, passages: list[ContextPassage], options: AnswerOptions
    ) -> ProviderAnswer:
        files = [p for p in passages if p.source_type == "attachment"]
        if not files:
            return self._answer_team(passages, options)
        # Attachments are a SEPARATE evidence group: the team documents are answered as always, the files are
        # only quoted verbatim (the header line and lines with the question's words) — never compared by inference.
        team = [p for p in passages if p.source_type != "attachment"]
        result = (
            self._answer_team(team, options)
            if team
            else insufficient(
                "Недостаточно данных: в документах базы знаний не найдено фрагментов по вопросу."
            )
        )
        lines, evidence = _attachment_quotes(files, options.terms, start=len(result.evidence) + 1)
        if not evidence:
            return result
        if result.confidence == "insufficient_evidence":
            answer = f"{MOCK_PREFIX}\n\nДокументы базы знаний: {result.answer}"
            confidence: Confidence = "partial"
        else:
            answer, confidence = result.answer, result.confidence
        answer += f"\n\n{ATTACHMENTS_HEADER}\n" + "\n".join(lines)
        return ProviderAnswer(
            answer=answer,
            confidence=confidence,
            evidence=[*result.evidence, *evidence],
            warnings=result.warnings,
        )

    def _answer_team(self, passages: list[ContextPassage], options: AnswerOptions) -> ProviderAnswer:
        terms = options.terms
        if not terms:
            return insufficient("Вопрос не содержит значимых слов для поиска. Переформулируйте вопрос.")

        if options.compare_terms:
            # Terms of an attached file: the absent ones are reported with the quotes ("не встречаются: …"),
            # they do not cancel the comparison. Nothing at all in common is still insufficient.
            if len(options.unmatched_terms) == len(terms):
                return insufficient(
                    "Недостаточно данных: в документах базы знаний не встречаются "
                    f"{_format_terms(terms[:12])}. Демо-ассистент не делает предположений о том, чего нет в "
                    "документах."
                )
            return self._quote_team(passages, options)

        missing_entities = [t for t in options.unmatched_terms if t.is_entity_like]
        if missing_entities:
            return insufficient(
                "Недостаточно данных: в доступных источниках нет упоминаний "
                f"{_format_terms(missing_entities)}. Демо-ассистент не делает предположений о том, "
                "чего нет в документах."
            )

        # Half of the question is absent from every allowed document: whatever matched is not an answer.
        missing = options.unmatched_terms
        if len(terms) >= 2 and len(missing) * 2 >= len(terms):
            return insufficient(
                "Недостаточно данных: в доступных источниках не встречаются "
                f"{_format_terms(missing)} — подтверждённого ответа на вопрос нет. Демо-ассистент не делает "
                "предположений о том, чего нет в документах."
            )
        return self._quote_team(passages, options)

    def _quote_team(self, passages: list[ContextPassage], options: AnswerOptions) -> ProviderAnswer:
        terms = options.terms
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

        # Words scattered over different passages are not an answer: one passage must cover half the question.
        per_passage: dict[str, set[str]] = {}
        for sentence in candidates:
            per_passage.setdefault(sentence.cid, set()).update(sentence.matched)
        entity_hit = any(
            t.is_entity_like and t.stem in matched for t in terms for matched in per_passage.values()
        )
        if len(terms) >= 2 and not entity_hit and max(len(m) for m in per_passage.values()) * 2 < len(terms):
            return insufficient(
                "Недостаточно данных: ни один найденный фрагмент не отвечает на вопрос — слова вопроса "
                "встречаются только разрозненно в разных документах.",
                warnings,
            )

        best = max(c.weight for c in candidates)
        threshold = max(1, (best + 1) // 2)
        selected: dict[str, set[int]] = {}
        seeds: dict[str, int] = {}
        rank: dict[str, tuple[int, int, int]] = {}
        total_seeds = 0
        # Context the user chose (a document or a selection) is quoted first whenever it is relevant (contains a
        # question term); without chosen context the order is by weight, as always.
        chosen = {p.cid for p in passages if p.chosen}
        for cand in sorted(
            candidates, key=lambda c: (c.cid not in chosen, -c.weight, c.passage_index, c.position)
        ):
            if total_seeds >= MAX_QUOTES:
                break
            if cand.cid not in chosen and cand.weight < threshold:
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
            rank.setdefault(cand.cid, (int(cand.cid not in chosen), -cand.weight, cand.passage_index))
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

    async def assist(self, request: AssistRequest) -> AssistResult:
        """Deterministic, never inventive: `summarize` quotes the first sentences of the fragment verbatim;
        `improve` only normalizes the layout (spaces, list markers, sentence ends). An injected instruction
        in the fragment is data: it is not followed, only reported."""
        text = request.text.strip()
        warnings = ["Демо-режим: без языковой модели — предложение построено по правилам, проверьте его."]
        if looks_like_prompt_injection(text):
            warnings.append("Во фрагменте есть текст, похожий на инструкцию для ИИ: он не выполнялся.")
        if not text:
            return AssistResult(text="", citations=[], warnings=warnings, insufficient_data=True)
        if request.task == "summarize":
            plain = " ".join(  # headings are structure, not content: never glued into the summary
                line.strip().lstrip(">-*0123456789. ")
                for line in text.splitlines()
                if line.strip() and not line.lstrip().startswith("#")
            )
            sentences = [s for s in split_sentences(plain) if len(s) > 15][:2]
            summary = " ".join(sentences) or plain[:300]
            return AssistResult(
                text=summary.strip(), citations=[], warnings=warnings, insufficient_data=False
            )
        lines = []
        for raw in text.splitlines():
            line = " ".join(raw.split())
            line = line.replace(" ,", ",").replace(" .", ".")
            if line.startswith(("* ", "+ ")):
                line = "- " + line[2:]
            if line and not line.startswith(("#", "-", "|", ">", "`")) and line[-1].isalnum():
                line += "."
            if line and line[0].islower() and not line.startswith(("-", "|", "`")):
                line = line[0].upper() + line[1:]
            lines.append(line)
        improved = "\n".join(lines).strip()
        while "\n\n\n" in improved:
            improved = improved.replace("\n\n\n", "\n\n")
        if improved == text:
            warnings.append("Оформление уже в порядке: изменений нет.")
        return AssistResult(text=improved, citations=[], warnings=warnings, insufficient_data=False)

    async def suggest_edit(self, instruction: str, document_markdown: str) -> str:
        raise AIProviderError(
            "ai_edit_unsupported",
            "В демо-режиме ИИ не генерирует правки. Отредактируйте текст вручную — изменения пройдут ту же проверку.",
        )

    async def draft_document(self, request: AuthoringRequest) -> AuthoringDraft:
        """Template structure + references + verbatim excerpts. Never composes requirements or rules:
        every section keeps a «Требует уточнения» placeholder for the author."""
        lines = [f"# {request.title.strip()}", ""]
        citations: list[AuthoringCitation] = []
        for heading, hint in request.sections:
            lines.append(f"## {heading}")
            if heading.casefold() in _REFERENCE_SECTIONS and request.references:
                lines.append("")
                for ref in request.references:
                    lines.append(
                        f"- [{_link_title(ref.title)}]({ref.document_id}.md) — `{ref.document_id}`, "
                        f"статус {ref.status.value}, ревизия `{ref.revision[:12]}`"
                    )
                lines.append("")
                continue
            lines.append(f"> {PLACEHOLDER}: {hint}" if hint else f"> {PLACEHOLDER}.")
            found = _find_quote(heading, request.references)
            if found:
                ref, source_heading, sentence = found
                citations.append(
                    AuthoringCitation(document_id=ref.document_id, section=source_heading, quote=sentence)
                )
                lines += [
                    "",
                    f"Выдержка из «{_link_title(ref.title)}» ([{ref.document_id}]({ref.document_id}.md), раздел "
                    f"«{_link_title(source_heading)}», ревизия `{ref.revision[:12]}`) — проверьте, применима ли она:",
                    "",
                    f"> «{sentence}»",
                ]
            lines.append("")
        warnings = [AUTHORING_DEMO_WARNING]
        insufficient_data = not request.references
        if insufficient_data:
            warnings.append(
                "Недостаточно данных: в утверждённых документах базы знаний не найдено материалов по запросу. "
                "Разделы оставлены с пометкой «Требует уточнения»."
            )
        elif not citations:
            warnings.append(
                "Найдены связанные документы, но подходящих дословных выдержек для разделов шаблона нет."
            )
        return AuthoringDraft(
            body="\n".join(lines).rstrip() + "\n",
            citations=citations,
            unverified_claims=[],
            warnings=warnings,
            suggested_related_ids=[r.document_id for r in request.references],
            insufficient_data=insufficient_data,
        )

    async def status(self) -> IntegrationStatus:
        return IntegrationStatus(
            name="ai_provider",
            title="AI-провайдер",
            kind="ai",
            state="mock",
            capabilities=["extractive_answers", "template_drafts"],
            human_readable_message=(
                "Демо-режим (mock): детерминированные дословные выдержки из документов, "
                "без языковой модели и без сетевых запросов."
            ),
            details={"provider": "mock"},
        )


class DisabledAIProvider:
    mode: AIMode = "disabled"
    supports_edit_suggestions = False
    supports_authoring = False

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

    async def draft_document(self, request: AuthoringRequest) -> AuthoringDraft:
        raise AIProviderError(
            "assistant_disabled", "Ассистент отключён конфигурацией (AI_PROVIDER=disabled)."
        )

    async def assist(self, request: AssistRequest) -> AssistResult:
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
