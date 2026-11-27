"""Does a chat message ask to create ONE task? (design 2026-11-27 §5.2)

A deterministic rule, no model: it works in mock mode and never costs a call. Precision over recall — a question about
tasks («как создать задачу в Jira?», «какие задачи просрочены») must get a normal answer, so the rule fires only on an
imperative («создай / заведи / добавь / поставь / оформи … задачу») in the first words, or on a text that starts with
«задача:» / «новая задача». Plural («создай задачи») and multi-line lists do not fire: the task card is ONE task, and
the task-plan skill is chosen by the person.
"""

from __future__ import annotations

import re

_VERBS = frozenset(
    {
        "создай",
        "создайте",
        "заведи",
        "заведите",
        "добавь",
        "добавьте",
        "поставь",
        "поставьте",
        "оформи",
        "оформите",
    }
)
# Words allowed between the verb and «задачу» (besides a Latin project key such as «RAG»).
_FILLERS = frozenset(
    {
        "пожалуйста",
        "мне",
        "нам",
        "в",
        "во",
        "на",
        "для",
        "по",
        "новую",
        "ещё",
        "еще",
        "одну",
        "проект",
        "проекте",
        "срочно",
        "быстро",
    }
)
_QUESTION_WORDS = frozenset(
    {"как", "где", "почему", "зачем", "что", "какие", "какая", "какой", "каких", "сколько", "куда", "когда"}
)
_VERB_WINDOW = 6  # the verb must be among the first words
_MAX_FILLERS = 3
_TOKEN_RE = re.compile(r"[А-Яа-яЁёA-Za-z0-9-]+")
_LATIN_RE = re.compile(r"^[A-Za-z][A-Za-z0-9-]*$")
_PREFIX_RE = re.compile(r"^\s*(?:задача\s*:|новая\s+задача(?![а-яё]))\s*[:—–-]?\s*", re.IGNORECASE)


_TASK_KEY_RE = re.compile(r"^[A-Za-z][A-Za-z0-9]{1,9}-\d+$")


def trigger_span(text: str) -> tuple[int, int] | None:
    """(start, end) of the trigger phrase, or None when the text does not ask to create ONE new task."""
    stripped = text.strip()
    if not stripped or stripped.endswith("?"):
        return None
    if len([line for line in stripped.splitlines() if line.strip()]) > 1:
        return None
    if m := _PREFIX_RE.match(text):
        return len(text) - len(text.lstrip()), m.end()
    tokens = list(_TOKEN_RE.finditer(text))
    words = [t[0].lower() for t in tokens]
    if not words or words[0] in _QUESTION_WORDS or words[:2] == ["можно", "ли"]:
        return None
    for i, word in enumerate(words[:_VERB_WINDOW]):
        if word not in _VERBS:
            continue
        for j in range(i + 1, min(len(words), i + 2 + _MAX_FILLERS)):
            if words[j] == "задачу":
                if j + 1 < len(tokens) and _TASK_KEY_RE.match(tokens[j + 1][0]):
                    return None  # «поставь задачу RAG-12 на ревью» is about an EXISTING task
                return tokens[i].start(), tokens[j].end()
            if words[j] not in _FILLERS and not _LATIN_RE.match(tokens[j][0]):
                break
    return None


def looks_like_create_task(question: str) -> bool:
    return trigger_span(question) is not None


def strip_trigger(question: str) -> str:
    """The text after the trigger phrase («Создай задачу: X» → «X»); the whole text when there is no trigger."""
    span = trigger_span(question)
    rest = question if span is None else question[span[1] :]
    return rest.strip().lstrip(":—–-,").strip()
