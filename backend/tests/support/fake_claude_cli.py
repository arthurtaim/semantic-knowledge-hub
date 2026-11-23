"""MOCK Claude Code CLI for tests — NOT Claude. Mimics `claude -p --output-format stream-json --verbose
--include-partial-messages` (event shapes recorded from Claude Code 2.1.318) without any network access.

Usage (the worker appends its own flags after these):
    python fake_claude_cli.py --fake-mode=ok [--fake-record=/path/record.json] [--fake-sleep=SECONDS]

Modes: ok · insufficient · hallucinate · auth_expired · rate_limit · slow · tool_use · unsafe_init · crash ·
garbage · denials · no_marker. `--version` and `auth status --json` are answered like the real CLI.
The record file captures argv, cwd (+ whether it was empty), the environment keys, the token presence, the
stdin prompt and the pid — so tests can assert the isolation rules.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import time

MARKER = "<<<EVIDENCE>>>"
DRAFT_MARKER = "<<<SOURCES>>>"
_PASSAGE_RE = re.compile(r"<<<PASSAGE (C\d+)>>>\n(.*?)\n(.*?)\n<<<END \1>>>", re.S)
_SOURCE_RE = re.compile(r"<<<SOURCE>>>\n(.*?)\n(.*?)\n<<<END SOURCE>>>", re.S)
_TURN_RE = re.compile(r"<<<TURN>>>\n(.*?)\n<<<END TURN>>>", re.S)


def emit(event: dict[str, object]) -> None:
    sys.stdout.write(json.dumps(event, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def init(tools: list[str] | None = None) -> None:
    emit(
        {
            "type": "system",
            "subtype": "init",
            "tools": tools or [],
            "mcp_servers": [],
            "model": "fake-model",
            "session_id": "00000000-0000-0000-0000-000000000000",
            "claude_code_version": "2.1.318",
        }
    )
    emit({"type": "system", "subtype": "status", "status": "requesting"})


def stream_text(text: str, size: int = 7) -> None:
    emit({"type": "stream_event", "event": {"type": "message_start"}})
    emit(
        {
            "type": "stream_event",
            "event": {
                "type": "content_block_start",
                "index": 0,
                "content_block": {"type": "text", "text": ""},
            },
        }
    )
    for i in range(0, len(text), size):
        emit(
            {
                "type": "stream_event",
                "event": {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": {"type": "text_delta", "text": text[i : i + size]},
                },
            }
        )
    emit({"type": "stream_event", "event": {"type": "content_block_stop", "index": 0}})


def finish(
    text: str, *, is_error: bool = False, error: str | None = None, denials: list[object] | None = None
) -> None:
    assistant: dict[str, object] = {
        "type": "assistant",
        "message": {"content": [{"type": "text", "text": text}]},
    }
    if error:
        assistant["error"] = error
    emit(assistant)
    emit(
        {
            "type": "result",
            "subtype": "success",
            "is_error": is_error,
            "result": text,
            "duration_ms": 12,
            "stop_reason": "end_turn",
            "permission_denials": denials or [],
            "usage": {"input_tokens": 100, "output_tokens": 20},
        }
    )


def answer_for(prompt: str, mode: str) -> str:
    turns = _TURN_RE.findall(prompt)
    history_note = ""
    if turns:
        digest = hashlib.sha256("\n".join(turns).encode()).hexdigest()[:8]
        history_note = f" (история: {len(turns)} реплик, {digest})"
    if "Разделы шаблона:" in prompt:  # authoring request
        sources = _SOURCE_RE.findall(prompt)
        title = re.search(r"Название: (.*)", prompt)
        sections = re.findall(r"^- (.+?): ", prompt.split("Разделы шаблона:", 1)[1], re.M)
        citations = []
        body = [f"# {title.group(1).strip() if title else 'Документ'}", ""]
        for i, heading in enumerate(sections):
            body.append(f"## {heading}")
            if i == 0 and sources:
                meta = json.loads(sources[0][0])
                quote = " ".join(sources[0][1].split("\n", 1)[-1].split())[:80].strip()
                body.append(quote)
                citations.append({"document_id": meta["document_id"], "section": heading, "quote": quote})
            else:
                body.append("> Требует уточнения: нет подтверждения в источниках.")
            body.append("")
        meta_json = {"citations": citations, "unverified": ["Срок внедрения не подтверждён источниками."]}
        return "\n".join(body) + f"\n{DRAFT_MARKER}\n" + json.dumps(meta_json, ensure_ascii=False)
    passages = _PASSAGE_RE.findall(prompt)
    if mode == "insufficient" or not passages:
        return f"Недостаточно данных в источниках{history_note}.\n{MARKER}\n" + json.dumps(
            {"confidence": "insufficient_evidence", "citations": []}
        )
    if mode == "hallucinate":
        return f"Интеграция использует шину XYZ и SLA 99,99% [C9]{history_note}.\n{MARKER}\n" + json.dumps(
            {"confidence": "supported", "citations": [{"id": "C9", "quote": "SLA 99,99% по договору"}]},
            ensure_ascii=False,
        )
    cid, _meta, text = passages[0]
    quote = " ".join(text.split())[:70].strip()
    answer = f"Согласно источнику: «{quote}» [{cid}]{history_note}."
    if mode == "no_marker":
        return answer
    return f"{answer}\n{MARKER}\n" + json.dumps(
        {"confidence": "supported", "citations": [{"id": cid, "quote": quote}]}, ensure_ascii=False
    )


def main() -> int:
    own = [a for a in sys.argv[1:] if a.startswith("--fake-")]
    rest = [a for a in sys.argv[1:] if not a.startswith("--fake-")]
    opts = dict(a[len("--fake-") :].split("=", 1) for a in own)
    mode = opts.get("mode", "ok")
    if rest[:1] == ["--version"]:
        print("2.1.318 (Claude Code)")
        return 0
    if rest[:2] == ["auth", "status"]:
        logged = bool(os.environ.get("CLAUDE_CODE_OAUTH_TOKEN"))
        print(
            json.dumps(
                {
                    "loggedIn": logged,
                    "authMethod": "oauth_token" if logged else "none",
                    "email": "owner@example.invalid",
                    "orgName": "Personal",
                }
            )
        )
        return 0
    prompt = sys.stdin.read()
    if "record" in opts:
        cwd = os.getcwd()
        with open(opts["record"], "w", encoding="utf-8") as fh:
            json.dump(
                {
                    "argv": rest,
                    "cwd": cwd,
                    "cwd_empty": os.listdir(cwd) == [],
                    "env_keys": sorted(os.environ),
                    "token": os.environ.get("CLAUDE_CODE_OAUTH_TOKEN"),
                    "prompt": prompt,
                    "pid": os.getpid(),
                },
                fh,
                ensure_ascii=False,
            )
    if mode == "crash":
        sys.stderr.write("fatal: something broke; secret-ish stderr that must never be logged\n")
        return 2
    if mode == "unsafe_init":
        init(tools=["Bash", "Edit"])
        stream_text("I could run commands now.")
        finish("I could run commands now.")
        return 0
    init()
    if mode in ("slow",):
        time.sleep(float(opts.get("sleep", "30")))
    if mode == "auth_expired":
        emit(
            {
                "type": "assistant",
                "message": {"content": [{"type": "text", "text": "Not logged in · Please run /login"}]},
                "error": "authentication_failed",
                "is_api_error_message": True,
            }
        )
        emit(
            {
                "type": "result",
                "subtype": "success",
                "is_error": True,
                "result": "Not logged in · Please run /login",
                "duration_ms": 5,
                "permission_denials": [],
            }
        )
        return 1
    if mode == "rate_limit":
        emit(
            {
                "type": "assistant",
                "message": {"content": [{"type": "text", "text": "Usage limit reached"}]},
                "error": "rate_limit",
            }
        )
        emit(
            {
                "type": "result",
                "subtype": "success",
                "is_error": True,
                "result": "Usage limit reached",
                "duration_ms": 5,
            }
        )
        return 1
    if mode == "tool_use":
        emit(
            {
                "type": "stream_event",
                "event": {
                    "type": "content_block_start",
                    "index": 0,
                    "content_block": {"type": "tool_use", "name": "Bash", "input": {}},
                },
            }
        )
        time.sleep(5)
        return 0
    if mode == "garbage":
        sys.stdout.write("warning: not json at all\n\n{broken json\n")
        sys.stdout.flush()
    text = answer_for(prompt, mode)
    stream_text(text)
    finish(text, denials=[{"tool_name": "Bash"}] if mode == "denials" else None)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
