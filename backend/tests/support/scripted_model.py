"""SCRIPTED MODEL — a TEST DOUBLE, not a model (M5.7). Synthetic data only, loopback only.

It answers the REAL M5.7 tool protocol (app/adapters/ai/tool_protocol.py) with scripted tool requests and final
answers, keyed by keywords of the question. Keyword logic is acceptable ONLY here: the product has no intent
router; this double stands in for the model that chooses tools. Final answers repeat values from the tool results
it received (it never knows the numbers in advance), so a test can compare them with an independent oracle.

Two wire shapes of the same script:
- OpenAI-compatible (`AI_PROVIDER=internal_api`): GET /models, POST /chat/completions;
- Claude worker (`AI_PROVIDER=claude_cli`): GET /v1/health, POST /v1/run (NDJSON: status, delta…, result).

In pytest: `openai_transport()` / `claude_transport()` give an httpx.MockTransport (no sockets). For E2E, start a
loopback server (from `backend/`):

    ../.venv/bin/python -m tests.support.scripted_model --port 8023

and point a backend at it (docs/AI_NATIVE_TOOLS.md §Scripted model). Scenarios (RU/EN, case-insensitive):

| question contains | script |
|---|---|
| «сколько документов» / «how many documents» | catalog_query count → «В доступном вам каталоге SKH — N …» |
| «из них» + «утвержд» / «of them» + «approved» | count with the previous referent's filters + status approved |
| «последние пять» / «last five» | catalog_query list, sort updated, limit 5 (previous filters kept) |
| «сколько» + «aris» | two counts in one round: tag `aris` and text «ARIS», both labelled |
| «внимани» / «need(s) attention» | count `needs_attention` (the tree's rule); + «в базе»: all + attention |
| «внимани» + «какие» / «почему» | catalog_query list `needs_attention` with the reasons (`attention`) |
| «ассистент» + «цитир» | count eligible_for_answers |
| «без владельца» | catalog_query list tags aris + owner_missing |
| «ссылается на <ID>» | graph_inspect links direction in |
| «почему <A> связан с <B>» | graph_inspect path |
| «шаблон» | templates_inspect list (doc_type integration when «интеграц») |
| «утвержд» + «aris» + «пробел» | composite: count + knowledge_search in one round, then a cited analysis |
| «черновик» | drafts_propose draft_from_prompt (proposal only) |
| «метаданные <ID>» | catalog_query get_metadata |
| «что такое rag» / «what is rag» | general knowledge, no tools |
| «confluence» | no tool: says a Confluence total is not available |
| «задач» | no tool: says tasks are not available |
| «сломанный формат» | malformed reply first, valid after the server's repair note |
| «всегда мусор» | malformed replies forever |
| «неизвестный инструмент» | requests `sql_query` (rejected), then answers |
| «бесконечн» | requests a tool in every round (loop limit) |
| «упади» | provider error after the first tool round |
| anything else | cites the first passage verbatim (content answer), or «insufficient» without passages |
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections.abc import Callable
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Literal

import httpx

Transport = Literal["openai", "claude"]
MARKER = "<<<EVIDENCE>>>"
DRAFT_MARKER = "<<<SOURCES>>>"
_QUESTION_RE = re.compile(r"Вопрос пользователя:\n(.*?)\n\n", re.S)
_PASSAGE_RE = re.compile(r"<<<PASSAGE (C\d+)>>>\n(.*?)\n(.*?)\n<<<END \1>>>", re.S)
_RESULT_RE = re.compile(
    r"<<<TOOL CALL (T\d+) (\S+)>>>\n(.*?)\n<<<TOOL RESULT \1>>>\n(.*?)\n<<<END \1>>>", re.S
)
_CONTEXT_RE = re.compile(r"<<<CONTEXT>>>\n(.*?)\n<<<END CONTEXT>>>", re.S)
_TURN_RE = re.compile(r"<<<TURN>>>\n(.*?)\n<<<END TURN>>>", re.S)
_ID_RE = re.compile(r"\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d{3}\b")
_SOURCE_RE = re.compile(r"<<<SOURCE>>>\n(.*?)\n(.*?)\n<<<END SOURCE>>>", re.S)


class ScriptedFailure(Exception):
    """The double simulates an unavailable model (HTTP 500 / an `error` event)."""


@dataclass
class Round:
    system: str
    prompt: str
    question: str
    passages: list[tuple[str, str, str]]
    results: list[tuple[str, str, dict[str, Any], dict[str, Any]]]  # call_id, tool, args, result
    context: list[dict[str, Any]] = field(default_factory=list)
    history: list[dict[str, Any]] = field(default_factory=list)

    @property
    def tools_offered(self) -> bool:
        return "### catalog_query" in self.system

    @property
    def repair(self) -> bool:
        return "Сообщение сервера: предыдущий ответ отклонён" in self.prompt

    def facts(self, tool: str | None = None) -> list[dict[str, Any]]:
        return [r for _, name, _, r in self.results if "fact_id" in r and (tool is None or name == tool)]


def parse_round(system: str, prompt: str) -> Round:
    question = _QUESTION_RE.search(prompt)
    results = []
    for call_id, name, args, result in _RESULT_RE.findall(prompt):
        try:
            results.append((call_id, name, json.loads(args), json.loads(result)))
        except ValueError:
            results.append((call_id, name, {}, {"error": {"code": "unparsed"}}))
    context: list[dict[str, Any]] = []
    if match := _CONTEXT_RE.search(prompt):
        try:
            context = json.loads(match.group(1))
        except ValueError:
            context = []
    history = []
    for turn in _TURN_RE.findall(prompt):
        try:
            history.append(json.loads(turn))
        except ValueError:
            continue
    return Round(
        system=system,
        prompt=prompt,
        question=(question.group(1) if question else "").strip(),
        passages=_PASSAGE_RE.findall(prompt),
        results=results,
        context=context,
        history=history,
    )


def tool_request(*calls: tuple[str, dict[str, Any]]) -> str:
    return json.dumps(
        {"kind": "tool_request", "calls": [{"name": n, "arguments": a} for n, a in calls]}, ensure_ascii=False
    )


def final(
    text: str,
    *,
    facts: list[str] | None = None,
    citations: list[dict[str, str]] | None = None,
    confidence: str = "supported",
    general: bool = False,
) -> str:
    meta = {
        "confidence": confidence,
        "citations": citations or [],
        "facts": facts or [],
        "general_knowledge": general,
    }
    return f"{text}\n{MARKER}\n" + json.dumps(meta, ensure_ascii=False)


def _verbatim(passage_text: str, chars: int = 70) -> str:
    return " ".join(passage_text.split())[:chars].strip()


def _previous_filters(r: Round) -> dict[str, Any]:
    for item in r.context:
        if item.get("tool") == "catalog_query" and isinstance(item.get("filters"), dict):
            return {k: v for k, v in item["filters"].items() if k not in ("sort", "document_ids")}
    return {}


def _count_answer(r: Round, fact: dict[str, Any], english: bool) -> str:
    if english:
        return final(
            f"The SKH catalog available to you has {fact['count']} unique documents [{fact['fact_id']}]. "
            "Versions, search fragments and Confluence pages are not counted.",
            facts=[fact["fact_id"]],
        )
    return final(
        f"В доступном вам каталоге SKH — {fact['count']} уникальных документов [{fact['fact_id']}]. В это число не "
        "входят версии, фрагменты поиска и внешние страницы Confluence.",
        facts=[fact["fact_id"]],
    )


def tool_script(r: Round) -> str:
    q = r.question.casefold()
    ids = _ID_RE.findall(r.question)
    facts = r.facts()

    if "всегда мусор" in q:
        return "Это не JSON и без маркера доказательств."
    if "сломанный формат" in q and not r.repair:
        return "Сейчас посчитаю документы {не json"
    if "бесконечн" in q:
        return tool_request(("catalog_query", {"operation": "count"}))
    if "упади" in q:
        if r.results:
            raise ScriptedFailure("scripted model failure")
        return tool_request(("catalog_query", {"operation": "count"}))
    if "неизвестный инструмент" in q:
        if not r.results:
            return tool_request(("sql_query", {"sql": "SELECT count(*) FROM docs"}))
        error = r.results[0][3].get("error", {})
        return final(
            f"Такого инструмента нет ({error.get('code')}), проверить так нельзя.",
            confidence="insufficient_evidence",
        )
    if "что такое rag" in q or "what is rag" in q:
        return final(
            "RAG (retrieval-augmented generation) — подход, при котором модель отвечает, опираясь на найденные "
            "фрагменты документов, а не только на свою память.",
            confidence="partial",
            general=True,
        )
    if "confluence" in q:
        return final(
            "Общее количество страниц Confluence ассистенту недоступно: частичный поиск не даёт полного числа.",
            confidence="insufficient_evidence",
        )
    if "задач" in q:
        return final(
            "Инструмента для задач в SKH нет — проверить нельзя.", confidence="insufficient_evidence"
        )
    if r.results and not facts and not _searched_ids(r):
        errors = [res.get("error", {}).get("message", "ошибка") for _, _, _, res in r.results]
        return final(f"Не удалось проверить: {'; '.join(errors)}", confidence="insufficient_evidence")
    if not r.tools_offered and not facts:
        return final("Данных недостаточно.", confidence="insufficient_evidence")

    # composite: registry count + content evidence in ONE round, then a cited analysis
    if "утвержд" in q and "aris" in q and ("пробел" in q or "gap" in q):
        if not r.results:
            return tool_request(
                (
                    "catalog_query",
                    {"operation": "count", "filters": {"status": ["approved"], "tags": ["aris"]}},
                ),
                ("knowledge_search", {"operation": "search", "query": "ARIS"}),
            )
        count = r.facts("catalog_query")[0]
        cites = []
        found = [p for p in r.passages if p[0] in _searched_ids(r)]
        text = f"Утверждённых документов с тегом aris в доступном вам каталоге — {count['count']} [{count['fact_id']}]."
        if found:
            cid, _meta, body = found[0]
            quote = _verbatim(body)
            cites.append({"id": cid, "quote": quote})
            text += f" Документы описывают: «{quote}» [{cid}]."
        text += " Возможный пробел (вывод, не факт): нет утверждённых правил частоты выгрузки."
        return final(text, facts=[count["fact_id"]], citations=cites)

    if "черновик" in q or "draft" in q:
        if not r.results:
            return tool_request(("drafts_propose", {"kind": "draft_from_prompt", "prompt": r.question[:500]}))
        fact = (r.facts("drafts_propose") or [None])[0]
        if fact is None:
            return final("Предложение создать не удалось.", confidence="insufficient_evidence")
        return final(
            f"Подготовлено предложение {fact['proposal_id']} [{fact['fact_id']}]: ничего не применено, откройте его, "
            "чтобы принять или отклонить пункты.",
            facts=[fact["fact_id"]],
        )

    if ("из них" in q and "утвержд" in q) or ("of them" in q and "approved" in q):
        if not r.results:
            filters = {**_previous_filters(r), "status": ["approved"]}
            return tool_request(("catalog_query", {"operation": "count", "filters": filters}))
        fact = facts[0]
        return final(
            f"Из них {fact['count']} утверждены [{fact['fact_id']}]. Фильтр: status=approved; источник: реестр SKH.",
            facts=[fact["fact_id"]],
        )
    if "последние пять" in q or "last five" in q:
        if not r.results:
            args = {"operation": "list", "filters": _previous_filters(r), "sort": "updated", "limit": 5}
            return tool_request(("catalog_query", args))
        fact = facts[0]
        listed = ", ".join(i["id"] for i in fact["items"])
        return final(f"Последние обновлённые: {listed} [{fact['fact_id']}].", facts=[fact["fact_id"]])
    if "без владельца" in q:
        if not r.results:
            filters = {"tags": ["aris"], "owner_missing": True}
            return tool_request(("catalog_query", {"operation": "list", "filters": filters, "sort": "id"}))
        fact = facts[0]
        listed = ", ".join(i["id"] for i in fact["items"]) or "таких нет"
        return final(
            f"ARIS-документы без владельца (owner: unassigned): {listed} [{fact['fact_id']}].",
            facts=[fact["fact_id"]],
        )
    if "ассистент" in q and "цитир" in q:
        if not r.results:
            return tool_request(
                ("catalog_query", {"operation": "count", "filters": {"eligible_for_answers": True}})
            )
        fact = facts[0]
        return final(
            f"Ассистент может цитировать {fact['count']} документов [{fact['fact_id']}] (только утверждённые).",
            facts=[fact["fact_id"]],
        )
    if "внимани" in q or "need attention" in q or "needs attention" in q:
        return _attention_script(r, q, facts)
    if "сколько" in q and "aris" in q:
        if not r.results:
            return tool_request(
                ("catalog_query", {"operation": "count", "filters": {"tags": ["aris"]}}),
                ("catalog_query", {"operation": "count", "filters": {"text": "ARIS"}}),
            )
        tagged = facts[0]
        if (
            len(facts) < 2
        ):  # the second call was refused (e.g. a per-round limit): answer with what was verified
            return final(
                f"С тегом aris — {tagged['count']} [{tagged['fact_id']}].", facts=[tagged["fact_id"]]
            )
        text = facts[1]
        return final(
            f"С тегом aris — {tagged['count']} [{tagged['fact_id']}]; упоминают ARIS в тексте — {text['count']} "
            f"[{text['fact_id']}] (это совпадение текста, а не системный тег).",
            facts=[tagged["fact_id"], text["fact_id"]],
        )
    if "сколько документов" in q or "how many documents" in q:
        if not r.results:
            return tool_request(("catalog_query", {"operation": "count"}))
        return _count_answer(r, facts[0], english="how many" in q)
    if "ссылается на" in q and ids:
        if not r.results:
            return tool_request(
                ("graph_inspect", {"operation": "links", "document_id": ids[0], "direction": "in"})
            )
        fact = facts[0]
        listed = ", ".join(f"{link['from']} ({link['relation']})" for link in fact["links"]) or "ничего"
        return final(f"На {ids[0]} ссылаются: {listed} [{fact['fact_id']}].", facts=[fact["fact_id"]])
    if "почему" in q and len(ids) >= 2:
        if not r.results:
            return tool_request(
                ("graph_inspect", {"operation": "path", "document_id": ids[0], "target_id": ids[1]})
            )
        fact = facts[0]
        if not fact.get("edges"):
            return final(
                f"Связь между {ids[0]} и {ids[1]} не найдена [{fact['fact_id']}].", facts=[fact["fact_id"]]
            )
        edge = fact["edges"][0]
        how = (
            "через WikiLink; это не подтверждённая зависимость данных"
            if edge["relation"] == "references"
            else ("в метаданных документа")
        )
        return final(
            f"Связь {edge['from']} → {edge['to']} указана как `{edge['relation']}` {how} [{fact['fact_id']}].",
            facts=[fact["fact_id"]],
        )
    if "метаданные" in q and ids:
        if not r.results:
            return tool_request(("catalog_query", {"operation": "get_metadata", "document_ids": ids[:5]}))
        fact = facts[0]
        found = ", ".join(d["id"] for d in fact["documents"]) or "не найдены"
        return final(f"Метаданные: {found} [{fact['fact_id']}].", facts=[fact["fact_id"]])
    if "шаблон" in q or "template" in q:
        if not r.results:
            args: dict[str, Any] = {"operation": "list"}
            if "интеграц" in q:
                args["doc_type"] = "integration"
            return tool_request(("templates_inspect", args))
        fact = facts[0]
        listed = ", ".join(f"{t['template_id']} v{t['current_version']}" for t in fact["templates"])
        return final(f"Действующие шаблоны: {listed} [{fact['fact_id']}].", facts=[fact["fact_id"]])

    # default: a content answer from the first passage, exactly like the fake CLI
    if r.passages:
        cid, _meta, body = r.passages[0]
        quote = _verbatim(body)
        return final(f"Согласно источнику: «{quote}» [{cid}].", citations=[{"id": cid, "quote": quote}])
    return final("Данных недостаточно.", confidence="insufficient_evidence")


def _attention_script(r: Round, q: str, facts: list[dict[str, Any]]) -> str:
    """«Требуют внимания»: the model uses the `needs_attention` filter and repeats the rule from the result."""
    attention = {"needs_attention": True}
    if "какие" in q or "почему" in q or "which" in q:
        if not r.results:
            args = {"operation": "list", "filters": attention, "sort": "id", "limit": 50}
            return tool_request(("catalog_query", args))
        fact = facts[0]
        listed = "; ".join(f"{i['id']}: {', '.join(i['attention'])}" for i in fact["items"]) or "таких нет"
        return final(
            f"Требуют внимания {fact['total']} документов [{fact['fact_id']}] — {listed}. {fact['definition']}",
            facts=[fact["fact_id"]],
        )
    if "в базе" in q or "всего" in q or "in total" in q:
        if not r.results:
            return tool_request(
                ("catalog_query", {"operation": "count"}),
                ("catalog_query", {"operation": "count", "filters": attention}),
            )
        if len(facts) < 2:  # one of the two counts was refused: answer with what was verified
            return final(
                f"Проверено: {facts[0]['count']} [{facts[0]['fact_id']}].", facts=[facts[0]["fact_id"]]
            )
        total, flagged = facts[0], facts[1]
        return final(
            f"В доступном вам каталоге SKH — {total['count']} документов [{total['fact_id']}]; требуют внимания — "
            f"{flagged['count']} [{flagged['fact_id']}]. {flagged['definition']}",
            facts=[total["fact_id"], flagged["fact_id"]],
        )
    if not r.results:
        return tool_request(("catalog_query", {"operation": "count", "filters": attention}))
    fact = facts[0]
    return final(
        f"Требуют внимания {fact['count']} документов [{fact['fact_id']}]. {fact['definition']}",
        facts=[fact["fact_id"]],
    )


def _searched_ids(r: Round) -> set[str]:
    out: set[str] = set()
    for _, name, _, result in r.results:
        if name == "knowledge_search":
            out |= {p["id"] for p in result.get("passages", [])}
    return out


def legacy_script(system: str, prompt: str, transport: Transport) -> str:
    """The content-only protocols (answer / assist / authoring / edit), for the rest of the app."""
    if "Разделы шаблона:" in prompt:  # authoring draft
        title = re.search(r"Название: (.*)", prompt)
        sections = re.findall(r"^- (.+?): ", prompt.split("Разделы шаблона:", 1)[1], re.M)
        body = [f"# {title.group(1).strip() if title else 'Документ'}", ""]
        for heading in sections:
            body += [f"## {heading}", "> Требует уточнения: нет подтверждения в источниках.", ""]
        meta = {"citations": [], "unverified": []}
        if transport == "claude":
            return "\n".join(body) + f"\n{DRAFT_MARKER}\n" + json.dumps(meta)
        return json.dumps({"body": "\n".join(body), **meta}, ensure_ascii=False)
    if "task=" in prompt and "<<<FRAGMENT>>>" in prompt:  # assist
        fragment = prompt.split("<<<FRAGMENT>>>\n", 1)[1].split("\n<<<END FRAGMENT>>>", 1)[0]
        return json.dumps({"text": fragment.strip(), "citations": [], "warnings": [], "insufficient": False})
    if "<<<DOCUMENT>>>" in prompt:  # edit suggestion
        return prompt.split("<<<DOCUMENT>>>\n", 1)[1].split("\n<<<END DOCUMENT>>>", 1)[0]
    passages = _PASSAGE_RE.findall(prompt)
    if not passages:
        return json.dumps(
            {"answer": "Данных недостаточно.", "confidence": "insufficient_evidence", "citations": []}
        )
    cid, _meta, body = passages[0]
    quote = _verbatim(body)
    return json.dumps(
        {
            "answer": f"Согласно источнику: «{quote}» [{cid}].",
            "confidence": "supported",
            "citations": [{"id": cid, "quote": quote}],
        },
        ensure_ascii=False,
    )


def reply(system: str, prompt: str, transport: Transport = "openai") -> str:
    """One model round. Raises ScriptedFailure to simulate an unavailable model."""
    if "Режим системных инструментов SKH" in system:
        return tool_script(parse_round(system, prompt))
    return legacy_script(system, prompt, transport)


# --- wire shapes ---------------------------------------------------------------------------------------------------
@dataclass
class Recorder:
    """What the backend sent (system prompts and user messages), for assertions."""

    calls: list[tuple[str, str]] = field(default_factory=list)


def _openai_response(system: str, prompt: str, recorder: Recorder | None) -> tuple[int, dict[str, Any]]:
    if recorder is not None:
        recorder.calls.append((system, prompt))
    try:
        text = reply(system, prompt, "openai")
    except ScriptedFailure:
        return 500, {"error": "scripted failure"}
    return 200, {"choices": [{"message": {"role": "assistant", "content": text}}]}


def _claude_events(system: str, prompt: str, recorder: Recorder | None) -> list[dict[str, Any]]:
    if recorder is not None:
        recorder.calls.append((system, prompt))
    try:
        text = reply(system, prompt, "claude")
    except ScriptedFailure:
        return [{"type": "error", "code": "ai_upstream_error", "message": "Скриптовая модель недоступна."}]
    events: list[dict[str, Any]] = [{"type": "status", "state": "started"}]
    events += [{"type": "delta", "text": text[i : i + 9]} for i in range(0, len(text), 9)]
    events.append({"type": "result", "text": text})
    return events


HEALTH = {
    "cli_available": True,
    "cli_version": "scripted-double",
    "auth_source": "token_file",
    "logged_in": True,
    "tools": "disabled",
    "last_run": {"ok": True},
}


def openai_transport(recorder: Recorder | None = None) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET" and request.url.path.endswith("/models"):
            return httpx.Response(200, json={"data": [{"id": "scripted"}]})
        body = json.loads(request.content)
        messages = body["messages"]
        status, payload = _openai_response(messages[0]["content"], messages[-1]["content"], recorder)
        return httpx.Response(status, json=payload)

    return httpx.MockTransport(handler)


def claude_transport(recorder: Recorder | None = None) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/health":
            return httpx.Response(200, json=HEALTH)
        body = json.loads(request.content)
        events = _claude_events(body["system_prompt"], body["prompt"], recorder)
        content = "".join(json.dumps(e, ensure_ascii=False) + "\n" for e in events)
        return httpx.Response(200, content=content.encode(), headers={"content-type": "application/x-ndjson"})

    return httpx.MockTransport(handler)


class _Handler(BaseHTTPRequestHandler):
    server_version = "SKHScriptedModel/1"

    def _send(self, status: int, payload: Any, content_type: str = "application/json") -> None:
        data = payload if isinstance(payload, bytes) else json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        if self.path.rstrip("/").endswith("/models"):
            self._send(200, {"data": [{"id": "scripted"}]})
        elif self.path == "/v1/health":
            self._send(200, HEALTH)
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        if length > 4 * 1024 * 1024:
            self._send(413, {"error": "too large"})
            return
        body = json.loads(self.rfile.read(length) or b"{}")
        if self.path.rstrip("/").endswith("/chat/completions"):
            messages = body.get("messages") or [{"content": ""}]
            status, payload = _openai_response(messages[0]["content"], messages[-1]["content"], None)
            self._send(status, payload)
        elif self.path == "/v1/run":
            events = _claude_events(body.get("system_prompt", ""), body.get("prompt", ""), None)
            data = "".join(json.dumps(e, ensure_ascii=False) + "\n" for e in events).encode()
            self._send(200, data, "application/x-ndjson")
        else:
            self._send(404, {"error": "not found"})

    def log_message(self, format: str, *args: Any) -> None:
        return


def serve(port: int, host: str = "127.0.0.1", ready: Callable[[], None] | None = None) -> None:
    if host not in ("127.0.0.1", "::1", "localhost"):
        raise SystemExit("the scripted model listens on loopback only")
    server = ThreadingHTTPServer((host, port), _Handler)
    if ready is not None:
        ready()
    print(f"scripted model (TEST DOUBLE) on http://{host}:{port}", file=sys.stderr, flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


def main() -> None:
    parser = argparse.ArgumentParser(description="SKH scripted model test double (loopback, synthetic only)")
    parser.add_argument("--port", type=int, default=8023)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()
    serve(args.port, args.host)


if __name__ == "__main__":
    main()
