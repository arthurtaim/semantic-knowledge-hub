"""Deterministic text analysis shared by search and the mock assistant (RU + EN)."""

from __future__ import annotations

import re
from dataclasses import dataclass

_WORD_RE = re.compile(r"[^\W_]+(?:[-'][^\W_]+)*", re.UNICODE)
_CYRILLIC_RE = re.compile(r"[а-яё]", re.IGNORECASE)
_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?…])\s+(?=[\"«(\[]?[A-ZА-ЯЁ0-9])|\n+")

MAX_QUERY_TERMS = 12

_RU_STOPWORDS = (
    "а без более бы был была были было быть в вам вас весь во вот все всего всех вы где да даже для до его ее "
    "если есть еще же за здесь и из или им их к как какая какие каким какой какое каких какую каков какова "
    "каковы когда кто ли либо мне может можно мы на над надо наш не него нет ни них но ну о об однако он она "
    "они оно от очень по под при про с так также такой такое такая такие там те тем то того тоже той только "
    "том ты у уже хотя чего чей чем что чтобы чье чья эта эти это этот я сколько зачем почему расскажи скажи "
    "покажи опиши объясни нужно нужен нужна бывают бывает"
)
_EN_STOPWORDS = (
    "a an and are as at be been but by can could do does did for from has have how i if in into is it its me "
    "my no not of on or our should so than that the their them then there these they this those to was we "
    "were what when where which who whom why will with would you your about please tell show describe "
    "explain list"
)
STOPWORDS = frozenset((_RU_STOPWORDS + " " + _EN_STOPWORDS).split())

# Longest endings first; a stem keeps at least 4 letters (3 for short words).
_RU_ENDINGS = sorted(
    [
        "иями",
        "ями",
        "ами",
        "ией",
        "ием",
        "ого",
        "его",
        "ому",
        "ему",
        "ыми",
        "ими",
        "ая",
        "яя",
        "ое",
        "ее",
        "ые",
        "ие",
        "ой",
        "ей",
        "ий",
        "ый",
        "ую",
        "юю",
        "ам",
        "ям",
        "ах",
        "ях",
        "ом",
        "ем",
        "ов",
        "ев",
        "ию",
        "ия",
        "ии",
        "ть",
        "ет",
        "ют",
        "ут",
        "ит",
        "ат",
        "ят",
        "ешь",
        "ете",
        "а",
        "я",
        "о",
        "е",
        "ы",
        "и",
        "у",
        "ю",
        "ь",
        "й",
    ],
    key=len,
    reverse=True,
)
_RU_REFLEXIVE = ("ся", "сь")


def fold(text: str) -> str:
    """Lower-case and fold `ё` → `е` (matches the FTS5 `remove_diacritics` behaviour)."""
    return text.lower().replace("ё", "е")


def tokenize(text: str) -> list[str]:
    return [fold(m.group(0)) for m in _WORD_RE.finditer(text)]


def stem(term: str) -> str:
    """Light, deterministic suffix stripping; the result is used as an FTS prefix."""
    word = fold(term)
    if _CYRILLIC_RE.search(word):
        if word.endswith(_RU_REFLEXIVE) and len(word) >= 7:
            word = word[:-2]
        min_stem = 3 if len(word) <= 5 else 4
        for ending in _RU_ENDINGS:
            if word.endswith(ending) and len(word) - len(ending) >= min_stem:
                return word[: -len(ending)]
        return word
    if len(word) > 4 and word.endswith("ies"):
        return word[:-3] + "y"
    if len(word) > 4 and word.endswith("es") and not word.endswith("ses"):
        return word[:-2]
    if len(word) > 4 and word.endswith("s") and not word.endswith("ss"):
        return word[:-1]
    return word


@dataclass(frozen=True)
class QueryTerm:
    original: str  # as written by the user
    token: str  # lower-cased token
    stem: str  # prefix used for matching

    @property
    def is_entity_like(self) -> bool:
        """Acronyms, identifiers and proper names: their absence means the topic is unknown."""
        o = self.original
        if any(ch.isdigit() for ch in o) and any(ch.isalpha() for ch in o):
            return True
        letters = [ch for ch in o if ch.isalpha()]
        return bool(len(letters) >= 2 and all(ch.isupper() for ch in letters))


def analyze_query(text: str, *, keep_stopwords: bool = False) -> list[QueryTerm]:
    terms: list[QueryTerm] = []
    seen: set[str] = set()
    for match in _WORD_RE.finditer(text):
        original = match.group(0)
        token = fold(original)
        if len(token) < 2 and not token.isdigit():
            continue
        if not keep_stopwords and token in STOPWORDS:
            continue
        stemmed = stem(token)
        if stemmed in seen:
            continue
        seen.add(stemmed)
        terms.append(QueryTerm(original=original, token=token, stem=stemmed))
        if len(terms) >= MAX_QUERY_TERMS:
            break
    return terms


def fts_term(term: QueryTerm) -> str:
    """Quoted FTS5 prefix query for a single term. User input never reaches FTS syntax unquoted."""
    parts = [p for p in re.sub(r"[^\w]", " ", term.stem).split() if p]
    if not parts:
        return '""'
    quoted = " ".join(f'"{p}"*' for p in parts)
    return f"({quoted})" if len(parts) > 1 else quoted


def fts_query(terms: list[QueryTerm], *, mode: str = "and") -> str:
    joiner = " " if mode == "and" else " OR "
    return joiner.join(fts_term(t) for t in terms)


def term_matches_text(term: QueryTerm, words: list[str]) -> bool:
    return any(w.startswith(term.stem) for w in words)


def split_sentences(text: str) -> list[str]:
    return [s.strip() for s in _SENTENCE_SPLIT_RE.split(text) if s and s.strip()]


def strip_control(text: str) -> str:
    return "".join(ch for ch in text if ch in "\n\t" or ch >= " ")
