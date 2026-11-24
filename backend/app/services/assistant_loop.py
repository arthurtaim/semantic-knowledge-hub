"""The bounded model → tool → model loop of the assistant (M5.7, docs/AI_NATIVE_TOOLS.md).

This is NOT a planner agent and NOT a user-intent state machine: there is no classifier, no keyword routing and
no predetermined chain. The model decides in each round whether to call allowlisted tools or to answer; the
backend validates every call (allowlist + strict schema), executes it with the server identity and hands back a
bounded, typed result. Hard limits keep it finite: rounds, calls per round and in total, a per-call timeout, a
total time budget, result sizes and ONE repair request for a malformed reply. When a limit is hit the loop stops
and reports it; the assistant then answers honestly with what was verified (never invented facts).

Events (for /ask/stream): `status` generating (per round), `delta` (preliminary prose of a final answer only),
`tool_call`, `tool_result`; the last item is a LoopOutcome.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from collections.abc import AsyncGenerator, Callable
from dataclasses import dataclass, field
from typing import Any, Literal

from app.adapters.ai.base import (
    AIProviderError,
    AnswerDelta,
    ContextPassage,
    ConversationTurn,
    ToolCallingAIProvider,
    ToolExchange,
    ToolExchangeEntry,
    ToolSpec,
    ToolTurnReply,
    ToolTurnRequest,
)
from app.adapters.ai.tool_protocol import ParsedFinal, ToolProtocolError, parse_tool_reply
from app.domain.assistant_tools import TOOL_DESCRIPTIONS, ToolArgumentError, validate_call
from app.domain.models import ProposalRef, SystemFact, ToolStepInfo
from app.services.assistant_tools import (
    SystemToolExecutor,
    ToolContext,
    ToolFailure,
    ToolResult,
    failure_result,
)

logger = logging.getLogger("skh.assistant.tools")

LimitReason = Literal["round_limit", "budget", "invalid_model_response", "provider_error"]
MAX_ARGUMENTS_ECHO = 1000


@dataclass(frozen=True)
class ToolLoopLimits:
    max_rounds: int = 4  # model rounds, the final answer included
    max_calls_per_round: int = 4
    max_calls_total: int = 10
    max_proposals: int = 1  # drafts_propose per answer
    tool_timeout_seconds: float = 10.0
    proposal_timeout_seconds: float = 300.0  # drafts_propose calls the model itself (existing workflow)
    budget_seconds: float = 300.0  # the whole loop, model rounds included
    result_chars: int = 4000  # one tool result as the model sees it
    transcript_chars: int = 24000  # all tool results of one answer; beyond it no more tools are offered


@dataclass
class LoopOutcome:
    final: ParsedFinal | None
    passages: list[ContextPassage]
    facts: dict[str, SystemFact] = field(default_factory=dict)
    steps: list[ToolStepInfo] = field(default_factory=list)
    proposal: ProposalRef | None = None
    limit: LimitReason | None = None
    rounds: int = 0
    error_code: str | None = None


def bounded_json(payload: dict[str, Any], limit: int) -> str:
    """JSON of a tool result within `limit` characters: the longest lists are halved (and `truncated` set) until it
    fits — the model always gets valid JSON, never a cut-off string."""
    data = dict(payload)
    text = json.dumps(data, ensure_ascii=False, default=str)
    while len(text) > limit:
        lists = [(k, v) for k, v in data.items() if isinstance(v, list) and v]
        if not lists:
            break
        key, value = max(lists, key=lambda kv: len(json.dumps(kv[1], ensure_ascii=False, default=str)))
        data[key] = value[: len(value) // 2]
        data["truncated"] = True
        text = json.dumps(data, ensure_ascii=False, default=str)
    if len(text) > limit:
        text = json.dumps(
            {"error": {"code": "result_too_large", "message": "Результат слишком большой: сузьте запрос."}},
            ensure_ascii=False,
        )
    return text


def _operation_hint(arguments: Any) -> str | None:
    if not isinstance(arguments, dict):
        return None
    value = arguments.get("operation") or arguments.get("kind")
    return value[:40] if isinstance(value, str) else None


class ToolLoop:
    def __init__(
        self,
        executor: SystemToolExecutor,
        limits: ToolLoopLimits | None = None,
        *,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._executor = executor
        self.limits = limits or ToolLoopLimits()
        self._clock = clock

    @property
    def executor(self) -> SystemToolExecutor:
        return self._executor

    async def run(
        self,
        provider: ToolCallingAIProvider,
        ctx: ToolContext,
        *,
        question: str,
        passages: list[ContextPassage],
        history: tuple[ConversationTurn, ...] = (),
        context_note: str = "",
        mode: str = "-",
    ) -> AsyncGenerator[dict[str, Any] | LoopOutcome, None]:
        limits = self.limits
        available = self._executor.available(ctx)
        specs = tuple(ToolSpec(name=name, description=TOOL_DESCRIPTIONS[name]) for name in available)
        outcome = LoopOutcome(final=None, passages=list(passages))
        exchanges: list[ToolExchange] = []
        repair, repaired = "", False
        calls_total = proposals = transcript = 0
        deadline = self._clock() + limits.budget_seconds

        for round_no in range(1, limits.max_rounds + 1):
            remaining = deadline - self._clock()
            if remaining <= 0:
                outcome.limit = "budget"
                break
            offer = (
                specs
                if round_no < limits.max_rounds
                and calls_total < limits.max_calls_total
                and transcript < limits.transcript_chars
                else ()
            )
            request = ToolTurnRequest(
                question=question,
                passages=tuple(outcome.passages),
                history=history,
                tools=offer,
                exchanges=tuple(exchanges),
                context_note=context_note,
                repair=repair,
                max_calls=limits.max_calls_per_round,
                rounds_left=limits.max_rounds - round_no,
            )
            yield {
                "type": "status",
                "stage": "generating",
                "round": round_no,
                "passages": len(outcome.passages),
                "provider": mode,
            }
            raw: str | None = None
            try:
                async with (
                    asyncio.timeout(remaining),
                    contextlib.aclosing(provider.tool_turn(request)) as events,
                ):
                    async for event in events:
                        if isinstance(event, AnswerDelta):
                            yield {"type": "delta", "text": event.text}
                        elif isinstance(event, ToolTurnReply):
                            raw = event.text
            except TimeoutError:
                outcome.limit = "budget"
                break
            except AIProviderError as exc:
                if not outcome.steps:
                    raise  # nothing verified yet: the ordinary provider error (HTTP error / `error` event)
                outcome.limit, outcome.error_code = "provider_error", exc.code
                break
            outcome.rounds = round_no
            if raw is None:
                raise AIProviderError("ai_invalid_response", "Провайдер не вернул ответ.")
            try:
                parsed = parse_tool_reply(raw)
            except ToolProtocolError as exc:
                logger.info("tool loop: malformed model reply round=%d repaired=%s", round_no, repaired)
                if repaired:
                    outcome.limit = "invalid_model_response"
                    break
                repaired, repair = True, exc.message
                continue
            repair = ""
            if isinstance(parsed, ParsedFinal):
                outcome.final = parsed
                break
            if not offer:  # a tool request although no tools were offered in this round
                outcome.limit = "round_limit"
                break
            entries: list[ToolExchangeEntry] = []
            for index, (name, arguments) in enumerate(parsed.calls):
                call_id = f"T{len(outcome.steps) + 1}"
                operation = _operation_hint(arguments)
                started = self._clock()
                if index >= limits.max_calls_per_round or calls_total >= limits.max_calls_total:
                    result = failure_result(
                        name[:64],
                        operation or "-",
                        ToolFailure(
                            "invalid", "call_limit", "Превышен лимит вызовов инструментов: вызов не выполнен."
                        ),
                    )
                else:
                    calls_total += 1
                    yield {
                        "type": "tool_call",
                        "call_id": call_id,
                        "round": round_no,
                        "tool": name[:64],
                        "operation": operation,
                    }
                    result = await self._call(ctx, name, arguments, outcome, deadline, proposals)
                    if result.tool == "drafts_propose" and result.outcome == "ok":
                        proposals += 1
                step = self._record(outcome, result, call_id, round_no, started)
                yield {"type": "tool_result", "call_id": call_id, "step": step.model_dump(mode="json")}
                result_json = bounded_json(result.payload, limits.result_chars)
                transcript += len(result_json)
                entries.append(
                    ToolExchangeEntry(
                        call_id=call_id,
                        name=name[:64],
                        arguments_json=json.dumps(arguments, ensure_ascii=False, default=str)[
                            :MAX_ARGUMENTS_ECHO
                        ],
                        result_json=result_json,
                    )
                )
            exchanges.append(ToolExchange(round=round_no, entries=tuple(entries)))
        else:
            outcome.limit = outcome.limit or "round_limit"
        if outcome.final is None and outcome.limit is None:
            outcome.limit = "round_limit"
        logger.info(
            "tool loop done mode=%s rounds=%d steps=%d facts=%d limit=%s",
            mode,
            outcome.rounds,
            len(outcome.steps),
            len(outcome.facts),
            outcome.limit or "-",
        )
        yield outcome

    async def _call(
        self,
        ctx: ToolContext,
        name: str,
        arguments: Any,
        outcome: LoopOutcome,
        deadline: float,
        proposals: int,
    ) -> ToolResult:
        operation = _operation_hint(arguments) or "-"
        try:
            tool, args = validate_call(name, arguments, self._executor.available(ctx))
        except ToolArgumentError as exc:
            return failure_result(name[:64], operation, ToolFailure(exc.code, exc.code, exc.message))
        if tool == "drafts_propose" and proposals >= self.limits.max_proposals:
            return failure_result(
                tool,
                operation,
                ToolFailure("invalid", "call_limit", "Предложение в этом ответе уже создано."),
            )
        per_call = (
            self.limits.proposal_timeout_seconds
            if tool == "drafts_propose"
            else self.limits.tool_timeout_seconds
        )
        timeout = max(min(per_call, deadline - self._clock()), 0.001)
        try:
            return await asyncio.wait_for(
                self._executor.execute(
                    ctx,
                    tool,
                    args,
                    fact_ref=f"F{len(outcome.facts) + 1}",
                    cid_start=len(outcome.passages) + 1,
                ),
                timeout,
            )
        except TimeoutError:
            return failure_result(
                tool,
                operation,
                ToolFailure("timeout", "timeout", "Инструмент не ответил вовремя: проверить не удалось."),
            )
        except Exception as exc:  # never a payload or a traceback in logs or answers
            logger.error("tool %s failed: %s", tool, type(exc).__name__)
            return failure_result(
                tool, operation, ToolFailure("error", "internal_error", "Внутренняя ошибка инструмента.")
            )

    def _record(
        self, outcome: LoopOutcome, result: ToolResult, call_id: str, round_no: int, started: float
    ) -> ToolStepInfo:
        if result.outcome == "ok":
            if result.fact is not None:
                outcome.facts[result.fact.ref] = result.fact
            outcome.passages.extend(result.passages)
            outcome.proposal = result.proposal or outcome.proposal
        step = ToolStepInfo(
            call_id=call_id,
            round=round_no,
            tool=result.tool,
            operation=result.operation if result.operation != "-" else None,
            outcome=result.outcome,
            duration_ms=max(0, round((self._clock() - started) * 1000)),
            result_count=result.result_count,
            fact_ref=result.fact.ref if result.outcome == "ok" and result.fact is not None else None,
            error_code=result.error_code,
            message=result.message,
        )
        outcome.steps.append(step)
        logger.info(
            "tool=%s op=%s outcome=%s ms=%d count=%s gen=%s round=%d",
            step.tool,
            step.operation or "-",
            step.outcome,
            step.duration_ms,
            "-" if step.result_count is None else step.result_count,
            (result.fact.generation if result.fact else None) or "-",
            round_no,
        )
        return step
