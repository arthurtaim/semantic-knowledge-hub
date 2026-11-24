"""Deterministic text analysis shared by search and the mock assistant (RU + EN)."""

from __future__ import annotations

import re
from dataclasses import dataclass

_WORD_RE = re.compile(r"[^\W_]+(?:[-'][^\W_]+)*", re.UNICODE)
# ASCII identifiers with separators (DEMO-INT-002, E-VAL-002, customer_segment_score, SYS-ARIS): one term,
# matched as an exact token sequence, never stemmed or split into unrelated words.
_IDENT_RE = re.compile(r"(?<![\w-])[A-Za-z0-9]+(?:[_.-][A-Za-z0-9]+)+(?![\w-])")
_CYRILLIC_RE = re.compile(r"[а-яё]", re.IGNORECASE)
_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?…])\s+(?=[\"«(\[]?[A-ZА-ЯЁ0-9])|\n+")

MAX_QUERY_TERMS = 12

_RU_STOPWORDS = (
    "а без более бы был была были было быть в вам вас весь во вот все всего всех вы где да даже для до его ее "
    "если есть еще же за здесь и из или им их к как какая какие каким какой какое каких какую каков какова "
    "каковы когда кто ли либо мне может можно мы на над надо наш не него нет ни них но ну о об однако он она "
    "они оно от очень по под при про с так также такой такое такая такие там те тем то того тоже той только "
    "том ты у уже хотя чего чей чем что чтобы чье чья эта эти это этот я сколько зачем почему расскажи скажи "
    "покажи опиши объясни нужно нужен нужна бывают бывает должен должна должно должны обязан обязана обязаны "
    "могут значение значения означает означают"
)
_EN_STOPWORDS = (
    "a an and are as at be been but by can could do does did for from has have how i if in into is it its me "
    "my no not of on or our should so than that the their them then there these they this those to was we "
    "were what when where which who whom why will with would you your about please tell show describe "
    "explain list"
)
STOPWORDS = frozenset((_RU_STOPWORDS + " " + _EN_STOPWORDS).split())

# Function words: prepositions, conjunctions, particles, pronouns and auxiliary verb forms (RU + EN), folded (ё → е).
# Their absence from the evidence says nothing about the topic, so they are never REPORTED as words of a question
# that the sources lack («Не найдено в документах», `AskResponse.unmatched_terms`). A superset of STOPWORDS used
# only for that report: retrieval keeps STOPWORDS (which words become search terms is a retrieval change that needs
# a before/after evaluation, docs/SEARCH_SYNC_TEMPLATES.md).
_RU_FUNCTION_WORDS = (
    # prepositions
    "близ вдоль вместо вне внутри возле вокруг вследствие из-за из-под изо ко кроме между мимо насчет около ото "
    "обо перед передо подо после посреди против ради сверх сквозь со согласно среди через "
    # conjunctions
    "будто ибо зато пока поэтому потому притом причем словно чтоб "
    # particles
    "ведь вон именно лишь неужели нибудь пусть разве уж "
    # pronouns: personal, possessive, reflexive, demonstrative, relative, interrogative, negative, adverbial
    "вся всю всем всеми всей ему ей ими кого кому кем ком чему какого какому каком какими каково который "
    "которая которое которые которого которой которому котором которым которых которыми мой моя мое мои моего "
    "моей моих нас нам ней нем ним ними нею сам сама само сами самого самой самим себя себе собой свой своя "
    "свое свои своего своей своих твой тот та тех теми этого этой этому этим этом этих никто ничто ничего "
    "нечто куда откуда туда сюда тут оттуда отсюда насколько отчего "
    # auxiliary verb forms
    "будет будут буду будем будешь будете являлся является являются являться"
)
_EN_FUNCTION_WORDS = (
    "above after again against all also am any anyone anything before being below between both during each "
    "either every everything few further he her here hers herself him himself his itself just may might more "
    "most must myself neither nor nothing off once only other ourselves out over own per same shall she some "
    "someone something such themselves through too under until up upon us very via whether while whose "
    "within without yourself"
)
# Second parts of Russian hyphenated particles: «кто-то», «что-нибудь», «какой-либо», «всё-таки».
_PARTICLE_SUFFIXES = frozenset(("то", "либо", "нибудь", "таки"))
FUNCTION_WORDS = STOPWORDS | frozenset((_RU_FUNCTION_WORDS + " " + _EN_FUNCTION_WORDS).split())

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
        "ых",
        "их",
        "ым",
        "им",
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


def token_spans(text: str) -> list[tuple[str, int, int]]:
    """The tokens of `tokenize(text)` with their character offsets in `text`: (token, start, end)."""
    return [(fold(m.group(0)), m.start(), m.end()) for m in _WORD_RE.finditer(text)]


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
    # Equivalent spellings from the versioned search dictionary (synonyms, abbreviation expansions):
    # each alternative is a tuple of stems that must ALL match (a multi-word phrase). Empty = none.
    alternatives: tuple[tuple[str, ...], ...] = ()
    expansion: str | None = None  # dictionary entry that produced the alternatives (explainability)
    identifier: bool = False  # an ASCII identifier: matched as an exact phrase of its parts

    def parts(self) -> tuple[str, ...]:
        return tuple(p for p in re.split(r"[^\w]|_", self.token) if p)

    def stem_groups(self) -> tuple[tuple[str, ...], ...]:
        """The term itself plus its alternatives, each as a tuple of stems."""
        own = tuple(p for p in re.sub(r"[^\w]", " ", self.stem).split() if p) or (self.stem,)
        return (own, *self.alternatives)

    @property
    def is_entity_like(self) -> bool:
        """Acronyms, identifiers and proper names: their absence means the topic is unknown."""
        o = self.original
        if self.identifier and ("_" in o or any(ch.isdigit() for ch in o) or o.upper() == o):
            return True
        if any(ch.isdigit() for ch in o) and any(ch.isalpha() for ch in o):
            return True
        letters = [ch for ch in o if ch.isalpha()]
        return bool(len(letters) >= 2 and all(ch.isupper() for ch in letters))


def is_function_word(term: QueryTerm) -> bool:
    """A function word of the question (FUNCTION_WORDS, or «кто-то»-like particles): nothing to report when the
    evidence lacks it. Identifiers, acronyms and names are never function words."""
    if term.identifier or term.is_entity_like:
        return False
    if term.token in FUNCTION_WORDS:
        return True
    head, _, tail = term.token.partition("-")
    return bool(tail) and head in FUNCTION_WORDS and tail in _PARTICLE_SUFFIXES


def reportable_terms(terms: list[QueryTerm]) -> list[QueryTerm]:
    """The terms worth naming as «not found»: every term except function words."""
    return [t for t in terms if not is_function_word(t)]


def analyze_query(text: str, *, keep_stopwords: bool = False) -> list[QueryTerm]:
    terms: list[QueryTerm] = []
    seen: set[str] = set()
    identifiers = {m.start(): m for m in _IDENT_RE.finditer(text)}
    covered_until = -1
    for match in _WORD_RE.finditer(text):
        if match.start() < covered_until:
            continue
        ident = identifiers.get(match.start())
        if ident is not None:
            covered_until = ident.end()
            token = fold(ident.group(0))
            if token not in seen:
                seen.add(token)
                terms.append(QueryTerm(original=ident.group(0), token=token, stem=token, identifier=True))
            if len(terms) >= MAX_QUERY_TERMS:
                break
            continue
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


SHORT_STEM = 3  # stems this short match whole tokens only: «пол»* would also hit «полнота», «пользователь»


def _fts_part(part: str) -> str:
    return f'"{part}"' if len(part) <= SHORT_STEM else f'"{part}"*'


def _fts_group(stems: tuple[str, ...]) -> str:
    parts = [p for stem in stems for p in re.sub(r"[^\w]", " ", stem).split() if p]
    if not parts:
        return ""
    quoted = " AND ".join(_fts_part(p) for p in parts)  # explicit AND: FTS5 rejects implicit AND next to "("
    return f"({quoted})" if len(parts) > 1 else quoted


def fts_term(term: QueryTerm) -> str:
    """Quoted FTS5 prefix query for a single term (OR over its dictionary alternatives).
    User input never reaches FTS syntax unquoted."""
    if term.identifier:
        parts = term.parts()
        return f'"{" ".join(parts)}"' if parts else '""'  # exact phrase: DEMO-INT-002 ≠ DEMO-INT-003
    groups = [g for g in (_fts_group(stems) for stems in term.stem_groups()) if g]
    if len(term.stem) <= SHORT_STEM and term.token != term.stem and term.token.isalpha():
        groups.append(f'"{term.token}"')  # «поле» → stem «пол» (whole token) OR the word itself
    groups = list(dict.fromkeys(groups))
    if not groups:
        return '""'
    return groups[0] if len(groups) == 1 else "(" + " OR ".join(groups) + ")"


def fts_query(terms: list[QueryTerm], *, mode: str = "and") -> str:
    joiner = " AND " if mode == "and" else " OR "
    return joiner.join(fts_term(t) for t in terms)


def _flat_parts(words: list[str]) -> list[str]:
    return [p for w in words for p in re.split(r"[^\w]|_", w) if p]


def term_matches_text(term: QueryTerm, words: list[str]) -> bool:
    if term.identifier:
        parts = list(term.parts())
        flat = _flat_parts(words)
        n = len(parts)
        return bool(n) and any(flat[i : i + n] == parts for i in range(len(flat) - n + 1))
    if any(w.startswith(term.stem) for w in words):
        return True
    return any(
        all(any(w.startswith(p) for w in words) for p in group) for group in term.alternatives if group
    )


def split_sentences(text: str) -> list[str]:
    return [s.strip() for s in _SENTENCE_SPLIT_RE.split(text) if s and s.strip()]


def strip_control(text: str) -> str:
    return "".join(ch for ch in text if ch in "\n\t" or ch >= " ")
