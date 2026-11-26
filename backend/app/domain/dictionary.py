"""Versioned domain search dictionary: RU/EN synonym groups and abbreviations (M5.6.2 §B1).

Expansion is term-level: a query term (or a multi-word phrase in the query) that belongs to a group gets
the other members of that group as alternatives — the FTS query stays an AND of terms, each an OR of its
spellings. Abbreviations with competing meanings are expanded to ALL of them and reported as ambiguous;
the rest of the query disambiguates through ranking, nothing is silently chosen.
"""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass, field, replace
from pathlib import Path

import yaml

from app.domain.text import QueryTerm, analyze_query

logger = logging.getLogger("skh.search.dictionary")

DEFAULT_DICTIONARY = Path(__file__).resolve().parents[1] / "search_dictionary" / "dictionary.yaml"
MAX_ALTERNATIVES = 8


def _stems(text: str) -> tuple[str, ...]:
    return tuple(t.stem for t in analyze_query(text, keep_stopwords=True))


@dataclass(frozen=True)
class Abbreviation:
    abbr: str
    meanings: tuple[tuple[str, ...], ...]
    ambiguous_with: tuple[tuple[str, ...], ...]
    labels: tuple[str, ...]  # human-readable meanings, for the ambiguity note


@dataclass(frozen=True)
class SearchDictionary:
    version: str
    digest: str
    members: dict[tuple[str, ...], str] = field(default_factory=dict)  # stem tuple -> group id
    groups: dict[str, tuple[tuple[str, ...], ...]] = field(default_factory=dict)
    abbreviations: dict[str, Abbreviation] = field(default_factory=dict)  # lower-cased abbr

    @property
    def label(self) -> str:
        return f"v{self.version}:{self.digest}"

    def expand(self, terms: list[QueryTerm]) -> tuple[list[QueryTerm], list[str]]:
        """Return expanded terms and notes (e.g. ambiguous abbreviations)."""
        notes: list[str] = []
        merged = self._merge_phrases(terms)
        result: list[QueryTerm] = []
        for term in merged:
            abbreviation = self.abbreviations.get(term.token)
            if abbreviation is not None and term.original.upper() == term.original:
                alternatives = (*abbreviation.meanings, *abbreviation.ambiguous_with)[:MAX_ALTERNATIVES]
                result.append(replace(term, alternatives=alternatives, expansion=f"abbr:{abbreviation.abbr}"))
                if abbreviation.ambiguous_with:
                    notes.append(
                        f"Аббревиатура {abbreviation.abbr} неоднозначна: {' / '.join(abbreviation.labels)}. "
                        "Уточните вопрос, если найдено не то значение."
                    )
                continue
            own = term.stem_groups()[0]
            group = self.members.get(own)
            if group is None:
                result.append(term)
                continue
            # Morphological alternatives of the word itself (text.fleeting_vowel_stem) come first and are kept.
            synonyms = tuple(m for m in self.groups[group] if m != own)
            alternatives = tuple(dict.fromkeys((*term.alternatives, *synonyms)))[:MAX_ALTERNATIVES]
            result.append(replace(term, alternatives=alternatives, expansion=f"synonym:{group}"))
        return result, notes

    def _merge_phrases(self, terms: list[QueryTerm]) -> list[QueryTerm]:
        """Join consecutive query terms that together spell a multi-word dictionary member."""
        phrases = sorted((m for m in self.members if len(m) > 1), key=len, reverse=True)
        out: list[QueryTerm] = []
        i = 0
        while i < len(terms):
            for phrase in phrases:
                window = terms[i : i + len(phrase)]
                if len(window) == len(phrase) and tuple(t.stem for t in window) == phrase:
                    out.append(
                        QueryTerm(
                            original=" ".join(t.original for t in window),
                            token=" ".join(t.token for t in window),
                            stem=" ".join(phrase),
                        )
                    )
                    i += len(phrase)
                    break
            else:
                out.append(terms[i])
                i += 1
        return out


def load_dictionary(path: Path = DEFAULT_DICTIONARY) -> SearchDictionary:
    try:
        raw = path.read_bytes()
        data = yaml.safe_load(raw) or {}
    except (OSError, yaml.YAMLError) as exc:
        logger.error("search dictionary not loaded (%s): synonym expansion disabled", type(exc).__name__)
        return SearchDictionary(version="none", digest="-")
    members: dict[tuple[str, ...], str] = {}
    groups: dict[str, tuple[tuple[str, ...], ...]] = {}
    for entry in data.get("groups") or []:
        group_id = str(entry["id"])
        stems = tuple(dict.fromkeys(s for s in (_stems(str(t)) for t in entry.get("terms") or []) if s))
        groups[group_id] = stems
        for member in stems:
            members.setdefault(member, group_id)  # first group wins: groups never overlap silently
    abbreviations: dict[str, Abbreviation] = {}
    for entry in data.get("abbreviations") or []:
        abbr = str(entry["abbr"]).strip()
        meanings = [str(m) for m in entry.get("meanings") or []]
        ambiguous = [str(m) for m in entry.get("ambiguous_with") or []]
        abbreviations[abbr.lower()] = Abbreviation(
            abbr=abbr,
            meanings=tuple(s for s in (_stems(m) for m in meanings) if s),
            ambiguous_with=tuple(s for s in (_stems(m) for m in ambiguous) if s),
            labels=tuple(meanings + ambiguous),
        )
    return SearchDictionary(
        version=str(data.get("version", "0")),
        digest=hashlib.sha256(raw).hexdigest()[:10],
        members=members,
        groups=groups,
        abbreviations=abbreviations,
    )
