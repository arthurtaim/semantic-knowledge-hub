"""Content safety heuristics: secrets, personal identifiers and prompt-injection markers.

These are defence-in-depth checks for synthetic/demo content and proposals. They do not replace
organisational DLP controls.
"""

from __future__ import annotations

import re

from app.domain.text import split_sentences

_TOKEN_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("private_key", re.compile(r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----")),
    ("gitlab_token", re.compile(r"\bglpat-[0-9A-Za-z_-]{20,}")),
    ("github_token", re.compile(r"\bgh[pousr]_[0-9A-Za-z]{30,}")),
    ("aws_access_key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("slack_token", re.compile(r"\bxox[abprs]-[0-9A-Za-z-]{10,}")),
    ("jwt", re.compile(r"\beyJ[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}")),
]
# Heuristic, for prose/config content (not source code where `api_key=settings.x` is normal).
_ASSIGNMENT_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    (
        "credential_assignment",
        re.compile(
            r"(?i)\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|пароль)"
            r"\s*[:=]\s*(?![<$\{\[\"']?(?:placeholder|changeme|example|\*+|x+)\b)[^\s<>${}\[\]]{8,}"
        ),
    ),
]

_SNILS_RE = re.compile(r"\b\d{3}-\d{3}-\d{3}[ -]\d{2}\b")
_CARD_CANDIDATE_RE = re.compile(r"\b(?:\d[ -]?){13,19}\b")

_INJECTION_PATTERNS: list[re.Pattern[str]] = [
    re.compile(p, re.IGNORECASE)
    for p in (
        r"ignore (?:all |any )?(?:previous|prior|above|earlier) (?:instructions|prompts|rules)",
        r"disregard (?:all |any )?(?:previous|prior|above|the) (?:instructions|rules|system prompt)",
        r"\byou are now\b",
        r"\bsystem prompt\b",
        r"\b(?:developer|system) (?:message|instructions?)\s*:",
        r"\bact as (?:an? )?(?:admin|administrator|system|developer)\b",
        r"(?:call|invoke|use|run) (?:the )?(?:tool|function|publish|merge|shell|command)",
        r"(?:set|change|mark) (?:the )?(?:status|document)s? (?:to |as )?approved",
        r"\b(?:exfiltrate|send (?:all |the )?(?:data|documents|secrets|tokens) to)\b",
        r"игнорир\w* (?:все |всех )?(?:предыдущ|прошл|выше)\w* (?:инструкц|указан|правил)\w*",
        r"забудь\w* (?:все )?(?:инструкц|правил)\w*",
        r"ты теперь\b",
        r"системн\w+ (?:промпт|инструкц)\w*",
        r"(?:смени|измени|установи|поставь)\w* статус\w* (?:на |в )?approved",
        r"(?:вызови|запусти|выполни)\w* (?:инструмент|команд|публикац)\w*",
    )
]


def _luhn_ok(digits: str) -> bool:
    total = 0
    for i, ch in enumerate(reversed(digits)):
        n = int(ch)
        if i % 2 == 1:
            n *= 2
            if n > 9:
                n -= 9
        total += n
    return total % 10 == 0


def find_secrets(text: str, *, heuristic: bool = True) -> list[str]:
    """Return the kinds of likely secrets found (never the matched values).

    `heuristic=False` keeps only high-confidence token formats (used for scanning source code).
    """
    patterns = _TOKEN_PATTERNS + (_ASSIGNMENT_PATTERNS if heuristic else [])
    return sorted({kind for kind, pattern in patterns if pattern.search(text)})


def find_personal_identifiers(text: str) -> list[str]:
    kinds: set[str] = set()
    if _SNILS_RE.search(text):
        kinds.add("snils")
    for match in _CARD_CANDIDATE_RE.finditer(text):
        digits = re.sub(r"\D", "", match.group(0))
        if 13 <= len(digits) <= 19 and len(set(digits)) > 1 and _luhn_ok(digits):
            kinds.add("payment_card")
            break
    return sorted(kinds)


def looks_like_prompt_injection(text: str) -> bool:
    return any(p.search(text) for p in _INJECTION_PATTERNS)


INJECTION_PLACEHOLDER = "[фрагмент скрыт: похож на инструкцию для ИИ]"
_CITATION_MARKER_RE = re.compile(r"\[(C?\d{1,3})\]")


def neutralize_citation_markers(text: str) -> str:
    """`[C2]` / `[2]` inside source text must never be mistaken for the assistant's own citations."""
    return _CITATION_MARKER_RE.sub(r"(\1)", text)


def redact_prompt_injection(text: str) -> tuple[str, bool]:
    """Replace sentences that look like instructions to an AI with a visible placeholder."""
    changed = False
    lines: list[str] = []
    for line in text.split("\n"):
        sentences = split_sentences(line)
        if not any(looks_like_prompt_injection(s) for s in sentences) and not looks_like_prompt_injection(
            line
        ):
            lines.append(line)
            continue
        changed = True
        kept: list[str] = []
        for sentence in sentences or [line]:
            item = INJECTION_PLACEHOLDER if looks_like_prompt_injection(sentence) else sentence
            if not (item == INJECTION_PLACEHOLDER and kept and kept[-1] == INJECTION_PLACEHOLDER):
                kept.append(item)
        if looks_like_prompt_injection(" ".join(kept)):  # pattern spanning sentence boundaries
            kept = [INJECTION_PLACEHOLDER]
        lines.append(" ".join(kept))
    return "\n".join(lines), changed
