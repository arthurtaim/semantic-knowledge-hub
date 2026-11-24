import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ApiError, api, isCancelled } from "../api/client";
import type {
  AiMode,
  AskRequest,
  AskResponse,
  AskSkillRef,
  AskStreamEvent,
  ConversationTurn,
  ExternalRetrievalSummary,
  SearchScope,
} from "../api/types";
import {
  AnswerActions,
  AnswerText,
  DemoAnswerText,
  InsufficientEvidence,
  splitServerNotes,
  SupportBadge,
} from "../components/AnswerParts";
import { AnswerSources } from "../components/AnswerSources";
import { AskProposal } from "../components/AskProposal";
import { Composer } from "../components/Composer";
import { ErrorState, Notice } from "../components/Feedback";
import { PageToolbar } from "../components/shell/PageToolbar";
import { Button } from "../components/ui/Button";
import { Chip } from "../components/ui/Chip";
import { canAsk } from "../lib/aiMode";
import { ASK_ERROR_TITLE, citationLabels, isConflict, scopeFromParam, scopeOfSources, scopeLabel, scopeSources } from "../lib/assistant";
import { clearHandOff, peekHandOff, restoreConversation, saveConversation } from "../lib/conversation";
import { pluralRu } from "../lib/labels";
import { noteDialogSources, rememberDialog } from "../lib/recentQuestions";
import { useSession } from "../lib/session";
import { toAskRequest, useComposer, type ComposerMessage } from "../lib/useComposer";
import { useSkills } from "../lib/useSkills";
import type { HomeHandOff } from "./HomePage";

/*
 * /ask is a dialog (docs/ui-v2/specs/02_ASSISTANT.md §2, design-03): the user's messages on the right with what
 * was attached, the assistant's answers with citation markers and one list of sources each, the field pinned at
 * the bottom. Streaming stages, «Недостаточно данных», errors with a retry and conflicts are states of a turn.
 */

const EXAMPLES = [
  "Где хранится каноническая база знаний команды?",
  "Какие ограничения у интеграции ARIS?",
  "What layers does the demonstration architecture have?",
  "Какой SLA у интеграции с ЦФТ?",
];

/** Limits of POST /api/assistant/ask(/stream) `history` (backend AskRequest). */
const MAX_HISTORY_TURNS = 6;
const MAX_HISTORY_ANSWER_CHARS = 4000;

type TurnPhase = "retrieving" | "generating" | "validating" | "done" | "error" | "cancelled";

/** What the user attached to a message — shown as chips above it. Names only, never contents. */
interface TurnDisplay {
  skill: AskSkillRef | null;
  files: { id: string; name: string }[];
  documents: { id: string; title: string }[];
  selection: string | null;
}

const NOTHING_ATTACHED: TurnDisplay = { skill: null, files: [], documents: [], selection: null };

/** One message of the dialog and what became of it. Lives in memory only (never stored). */
interface Turn {
  id: number;
  request: AskRequest;
  display: TurnDisplay;
  phase: TurnPhase;
  passages: number | null;
  provider: AiMode | null;
  /** PRELIMINARY model text (not validated); shown only while the turn runs. */
  preliminary: string;
  response: AskResponse | null;
  error: ApiError | null;
}

const isRunning = (turn: Turn) =>
  turn.phase === "retrieving" || turn.phase === "generating" || turn.phase === "validating";

/** Cuts by code points (as the backend counts), never splitting a surrogate pair. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return Array.from(text).slice(0, max).join("");
}

/** Context for a follow-up: the last completed turns with a question and a validated answer, oldest first. */
function historyFrom(turns: Turn[]): ConversationTurn[] {
  return turns
    .filter((turn) => turn.response !== null && turn.request.question.trim().length > 0)
    .slice(-MAX_HISTORY_TURNS)
    .map((turn) => ({
      question: turn.request.question,
      answer: truncate(turn.response?.answer ?? "", MAX_HISTORY_ANSWER_CHARS),
    }));
}

function toApiError(err: unknown): ApiError {
  return err instanceof ApiError ? err : new ApiError(0, "client_error", String(err), null);
}

function displayOf(message: ComposerMessage): TurnDisplay {
  return {
    skill: message.skill ? { id: message.skill.id, name: message.skill.name, access: message.skill.access } : null,
    files: message.attachments.map((file) => ({ id: file.id, name: file.name })),
    documents: message.documents.map((document) => ({ id: document.id, title: document.title })),
    selection: message.selection?.label ?? null,
  };
}

/** The stages of an answer as the stream reports them (status events: retrieving → generating → validating). */
const STAGES: { phase: TurnPhase; label: string }[] = [
  { phase: "retrieving", label: "Ищу источники" },
  { phase: "generating", label: "Формулирую ответ" },
  { phase: "validating", label: "Проверяю цитаты" },
];

function statusText(turn: Turn): string {
  if (turn.phase === "generating") {
    const action = turn.provider === "claude_cli" ? "Формулирую ответ с Claude Code CLI…" : "Формулирую ответ…";
    if (turn.passages === null) return action;
    const n = turn.passages;
    return `${action} (${pluralRu(n, "найден", "найдено", "найдено")} ${n} ${pluralRu(n, "фрагмент", "фрагмента", "фрагментов")})`;
  }
  if (turn.phase === "validating") return "Проверяю цитаты…";
  return "Ищу источники…";
}

/** «Ищу источники → Формулирую ответ → Проверяю цитаты»: done, current, pending — by text and shape. */
function StageTrack({ phase }: { phase: TurnPhase }) {
  const current = STAGES.findIndex((stage) => stage.phase === phase);
  return (
    <ol className="stages" aria-label="Этапы ответа">
      {STAGES.map((stage, index) => (
        <li
          key={stage.phase}
          className={`stages__step${index < current ? " stages__step--done" : ""}${index === current ? " stages__step--current" : ""}`}
          aria-current={index === current ? "step" : undefined}
        >
          {stage.label}
        </li>
      ))}
    </ol>
  );
}

/** «Где искать: Оба · с черновиками» — only when it differs from the default (team, approved only). */
function scopeSummary(request: AskRequest): string | null {
  const scope = scopeOfSources(request.sources);
  if (scope === "team" && !request.include_drafts && !request.include_deprecated) return null;
  const parts = [`Где искать: ${scopeLabel(scope)}`];
  if (request.include_drafts) parts.push("с черновиками");
  if (request.include_deprecated) parts.push("с устаревшими");
  return parts.join(" · ");
}

/** Why the server consulted Confluence (AskResponse.external.trigger). */
const TRIGGER_LABEL: Record<string, string> = {
  no_local_passages: "в документах команды ничего не найдено",
  unmatched_entities: "в документах команды не найдены упомянутые термины",
  low_term_coverage: "недостаточно данных в документах команды",
  external_scope_selected: "выбран поиск по корпоративным источникам",
  explicit_request: "запрошено явно",
};

function externalSummary(ext: ExternalRetrievalSummary): string {
  const reason = ext.trigger ? (TRIGGER_LABEL[ext.trigger] ?? ext.trigger) : null;
  const parts = [
    `Внешний источник: запрос к Confluence${reason ? ` (причина: ${reason})` : ""}`,
    `загружено ${ext.fetched} стр.`,
    `из кэша ${ext.cache_hits}`,
  ];
  if (ext.rejected.length > 0) parts.push(`отклонено ${ext.rejected.length}`);
  return parts.join(", ") + (ext.degraded ? " — внешний источник ответил не полностью" : "");
}

const MODE_LABEL: Record<AskResponse["mode"], string> = {
  mock: "Демо-режим: выдержки без языковой модели",
  disabled: "Языковая модель отключена — только выдержки из источников",
  internal_api: "Внутренняя модель, цитаты сверены с источниками",
  claude_cli: "Claude Code CLI (личный тест), цитаты сверены с источниками",
};

/** Corporate scope the user asked for but which did not answer as a connected source. */
function CorporateGap({ answer, asked }: { answer: AskResponse; asked: SearchScope[] }) {
  if (!asked.includes("corporate")) return null;
  const corporate = answer.scopes.find((s) => s.scope === "corporate");
  if (corporate?.state === "connected") return null;
  if (corporate?.state === "mock") {
    return (
      <Notice tone="info">
        Корпоративные источники представлены mock-коннектором с синтетическими страницами — это не Confluence.
      </Notice>
    );
  }
  const onlyCorporate = !asked.includes("team");
  const reason =
    corporate?.state === "error"
      ? "Confluence Data Center сейчас недоступен (ошибка подключения к MCP)"
      : "Confluence Data Center не подключён";
  return (
    <Notice tone="warning" className="answer__scope-gap">
      <p>
        <strong>Корпоративные источники не использованы.</strong>{" "}
        {onlyCorporate
          ? `${reason} — корпоративных данных в ответе нет.`
          : `${reason} — ответ построен только по документам команды.`}
      </p>
    </Notice>
  );
}

interface AnswerViewProps {
  answer: AskResponse;
  request: AskRequest;
  turnNo: number;
  onRefine: (question: string) => void;
  /** A separate, labelled corporate-only request for the same question. */
  onAskCorporate: (request: AskRequest) => void;
}

/**
 * The assistant's answer: who answers and how well it is supported (a category, never a percentage), the text
 * with citation markers, terms without support, the proposal of a skill (nothing applied), what to do next and
 * one list of sources — team, corporate and attachments apart. Generated text is labelled «ИИ», demo «Демо».
 */
function AnswerView({ answer, request, turnNo, onRefine, onAskCorporate }: AnswerViewProps) {
  const session = useSession();
  const question = request.question;
  const insufficient = answer.confidence === "insufficient_evidence";
  const traceId = answer.retrieval_trace_id ?? null;
  const labels = citationLabels(answer.citations);
  const generated = answer.mode === "internal_api" || answer.mode === "claude_cli";
  const demoExcerpts = answer.mode === "mock" && !answer.proposal;
  const textProps = { citations: answer.citations, labels, turnNo, question };
  const showText = !insufficient || Boolean(answer.proposal);
  const { text, notFound } = splitServerNotes(answer);
  const unsupported = notFound ?? (answer.unmatched_terms.length > 0 ? answer.unmatched_terms.map((term) => `«${term}»`).join(", ") : null);
  return (
    <section className={`answer${insufficient ? " answer--insufficient" : ""}`} aria-labelledby={`answer-title-${turnNo}`}>
      <div className="answer__head">
        <h2 id={`answer-title-${turnNo}`} className="answer__who">
          Ассистент
        </h2>
        <SupportBadge confidence={answer.confidence} />
        {generated ? (
          <span className="ai-label" title="Текст сформирован языковой моделью; цитаты сверены сервером">
            ИИ
          </span>
        ) : null}
        <span className="answer__mode">
          {answer.mode === "mock" && answer.proposal ? "Демо-режим: предложение по правилам, без языковой модели" : (MODE_LABEL[answer.mode] ?? answer.mode)}
        </span>
        {traceId ? (
          <Link to={`/graph?trace=${encodeURIComponent(traceId)}`} className="answer__graph">
            Граф ответа
          </Link>
        ) : null}
      </div>
      <CorporateGap answer={answer} asked={request.sources} />
      {answer.external?.called ? <p className="answer__external">{externalSummary(answer.external)}</p> : null}
      {insufficient ? (
        <InsufficientEvidence
          question={question}
          request={request}
          answer={answer}
          corporateState={session?.features.corporate_search}
          onRefine={onRefine}
          onAskCorporate={() => onAskCorporate({ ...request, sources: ["corporate"], search_external: true, history: [] })}
        />
      ) : null}

      {showText ? (
        demoExcerpts ? (
          <DemoAnswerText answer={answer} {...textProps} />
        ) : (
          <AnswerText text={text} {...textProps} />
        )
      ) : null}

      {!insufficient && unsupported ? (
        <p className="answer__unsupported">
          <span className="answer__unsupported-label">Нет подтверждения в источниках:</span> {unsupported}
        </p>
      ) : null}

      {answer.warnings.length > 0 ? (
        <Notice tone="warning">
          <ul>
            {answer.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </Notice>
      ) : null}

      {answer.proposal ? (
        <AskProposal reference={answer.proposal} mode={answer.mode} primary={answer.proposal.status === "suggested"} />
      ) : null}

      {insufficient ? null : (
        <AnswerActions
          answer={answer}
          question={question}
          labels={labels}
          demo={demoExcerpts}
          hasProposal={Boolean(answer.proposal)}
          onRefine={onRefine}
        />
      )}

      <AnswerSources answer={answer} labels={labels} turnNo={turnNo} />
    </section>
  );
}

/** Input errors of a skill or a file: repeating the same request would fail the same way. */
const NOT_RETRYABLE = new Set([
  "skill_unknown",
  "skill_unavailable",
  "skill_input_missing",
  "attachment_not_found",
  "selection_not_found",
  "document_not_found",
  "invalid_request",
]);

function TurnError({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  const retry = NOT_RETRYABLE.has(error.code) ? undefined : onRetry;
  if (isConflict(error.code, error.status)) {
    return (
      <div className="turn__conflict" role="alert">
        <p className="feedback__title">{ASK_ERROR_TITLE[error.code] ?? "Конфликт с текущим состоянием"}</p>
        <p>{error.message}</p>
        {retry ? (
          <button type="button" className="button button--secondary" onClick={retry}>
            Повторить запрос
          </button>
        ) : null}
      </div>
    );
  }
  return <ErrorState error={error} title={ASK_ERROR_TITLE[error.code]} onRetry={retry} retryLabel="Повторить запрос" />;
}

interface TurnViewProps {
  turn: Turn;
  turnNo: number;
  onRefine: (question: string) => void;
  onAskCorporate: (request: AskRequest, display: TurnDisplay) => void;
  /** Only the last failed turn offers a retry (a new question replaces it). */
  onRetry?: () => void;
}

function TurnView({ turn, turnNo, onRetry, onRefine, onAskCorporate }: TurnViewProps) {
  const running = isRunning(turn);
  const { display } = turn;
  const attached = display.skill || display.files.length > 0 || display.documents.length > 0 || display.selection;
  const scope = scopeSummary(turn.request);
  return (
    <article className="turn" aria-busy={running}>
      <div className="turn__user">
        <h2 className="visually-hidden">Вы</h2>
        {attached ? (
          <ul className="turn__chips" aria-label="Приложено к сообщению">
            {display.skill ? (
              <li>
                <Chip tone="skill" icon="skill">
                  {display.skill.name}
                </Chip>
              </li>
            ) : null}
            {display.files.map((file) => (
              <li key={file.id}>
                <Chip tone="file" icon="file-text">
                  {file.name}
                </Chip>
              </li>
            ))}
            {display.documents.map((document) => (
              <li key={document.id}>
                <Chip tone="document" icon="documents">
                  {document.title}
                </Chip>
              </li>
            ))}
            {display.selection ? (
              <li>
                <Chip tone="document" icon="edit">
                  {display.selection}
                </Chip>
              </li>
            ) : null}
          </ul>
        ) : null}
        <p className="turn__bubble">
          {turn.request.question || <span className="turn__bubble-empty">Без вопроса: навык «{display.skill?.name ?? "—"}»</span>}
        </p>
        {scope ? <p className="turn__scope">{scope}</p> : null}
      </div>

      {running ? (
        <div className="turn__progress">
          <StageTrack phase={turn.phase} />
          <p className="turn__status" role="status">
            {statusText(turn)}
          </p>
        </div>
      ) : null}
      {running && turn.preliminary ? (
        <section className="answer-preliminary" aria-live="polite" aria-labelledby={`preliminary-title-${turnNo}`}>
          <p className="answer-preliminary__label" id={`preliminary-title-${turnNo}`}>
            Предварительный текст модели — цитаты ещё не проверены
          </p>
          <div className="answer-preliminary__text">{turn.preliminary}</div>
        </section>
      ) : null}

      {turn.phase === "cancelled" ? (
        <p className="turn__status turn__status--stopped" role="status">
          Запрос отменён. Вопрос возвращён в поле ввода.
        </p>
      ) : null}
      {turn.phase === "error" && turn.error ? <TurnError error={turn.error} onRetry={onRetry} /> : null}
      {turn.response ? (
        <AnswerView
          answer={turn.response}
          request={turn.request}
          turnNo={turnNo}
          onRefine={onRefine}
          onAskCorporate={(request) => onAskCorporate(request, turn.display)}
        />
      ) : null}
    </article>
  );
}

/** The ask page without an AI provider: what is off, and the search that still works. */
function AskUnavailable({ initial }: { initial: string }) {
  const composer = useComposer({ defaults: { text: initial } });
  return (
    <div className="dialog dialog--search">
      <div className="dialog__intro">
        <h1>Спросить базу знаний</h1>
        <p className="dialog__lead">ИИ в этой установке отключён — ответы ассистента недоступны. Поиск по документам работает полностью.</p>
      </div>
      <Composer variant="home" composer={composer} onSend={() => undefined} inputId="ask-search-input" />
      <p className="dialog__links">
        <Link to="/documents">Открыть каталог документов</Link>
      </p>
    </div>
  );
}

export function AskPage() {
  const [params, setParams] = useSearchParams();
  const session = useSession();
  const aiMode = session?.features.ai_mode;
  const userId = session?.user.user_id;
  const about = params.get("about");
  const initialQuestion = params.get("q");
  // `?run=1` (from «Спросить или найти»): ask at once. The flag is removed from the URL first, so a reload or a
  // second effect run (React StrictMode) never asks twice.
  const runRequested = params.get("run") === "1";
  // A message sent from the home page: it starts a new dialog here with its chips (lib/conversation.ts).
  const [handed] = useState(() => peekHandOff<HomeHandOff>());
  const composer = useComposer({
    persistKey: "dialog",
    initial: handed ? { conversationId: handed.conversationId, draft: handed.draft } : null,
  });
  const skills = useSkills(aiMode);
  // Completed turns survive a visit to a cited document (memory only; see lib/conversation.ts).
  const [turns, setTurns] = useState<Turn[]>(() => (handed ? [] : restoreConversation<Turn>()));
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const nextId = useRef(turns.reduce((max, turn) => Math.max(max, turn.id), 0));
  const abortRef = useRef<AbortController | null>(null);
  const context = historyFrom(turns);

  // Leaving the page cancels a running generation on the server.
  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => saveConversation(turns.filter((turn) => turn.phase === "done")), [turns]);

  // `?q=` / `?about=` fill the field and `?scope=` the scope (unless a message is about to run).
  useEffect(() => {
    if (handed || runRequested) return;
    if (about) composer.setText(`Что известно о «${about}»?`);
    else if (initialQuestion) composer.setText(initialQuestion.slice(0, 2000));
    if (params.get("scope")) composer.setScope(scopeFromParam(params.get("scope")));
    // Read once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function dropRunFlag() {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete("run");
        return next;
      },
      { replace: true },
    );
  }

  // The hand-off from the home page runs once (the timer survives StrictMode's double effects).
  useEffect(() => {
    if (!handed || !canAsk(aiMode)) return undefined;
    const timer = window.setTimeout(() => {
      clearHandOff();
      if (runRequested) dropRunFlag();
      setTurns([]);
      void run(toAskRequest(handed.message), displayOf(handed.message));
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handed, aiMode]);

  useEffect(() => {
    if (handed || !runRequested || !canAsk(aiMode)) return undefined;
    const timer = window.setTimeout(() => {
      const text = (params.get("q") ?? "").trim().slice(0, 2000);
      const scope = scopeFromParam(params.get("scope"));
      dropRunFlag();
      if (text.length < 3) return;
      // A question from «Спросить или найти» starts a new dialog (no earlier answers, files or skill).
      setTurns([]);
      const conversationId = composer.reset();
      composer.setScope(scope);
      void run(
        {
          question: text,
          sources: scopeSources(scope),
          include_drafts: false,
          include_deprecated: false,
          history: [],
          conversation_id: conversationId,
        },
        NOTHING_ATTACHED,
      );
    }, 0);
    return () => window.clearTimeout(timer);
    // run/params are read at the moment of the request; the effect reacts to the flag only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runRequested, aiMode]);

  function patchTurn(id: number, patch: Partial<Turn> | ((turn: Turn) => Partial<Turn>)) {
    setTurns((list) =>
      list.map((turn) => (turn.id === id ? { ...turn, ...(typeof patch === "function" ? patch(turn) : patch) } : turn)),
    );
  }

  function onStreamEvent(id: number, event: AskStreamEvent) {
    if (event.type === "status") {
      patchTurn(
        id,
        event.stage === "generating"
          ? { phase: "generating", passages: event.passages ?? null, provider: event.provider ?? null }
          : { phase: event.stage },
      );
    } else if (event.type === "delta") {
      patchTurn(id, (turn) => ({ preliminary: turn.preliminary + event.text }));
    }
  }

  /** Runs one request as a new turn; a failed or cancelled last turn is replaced by it. */
  async function run(request: AskRequest, display: TurnDisplay) {
    if (inFlight.current) return;
    inFlight.current = true;
    rememberDialog(userId, {
      question: request.question,
      skill: display.skill?.name,
      context: display.files[0]?.name ?? display.documents[0]?.title ?? null,
    });
    const id = ++nextId.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setPending(true);
    setTurns((list) => [
      ...list.filter((turn) => turn.phase === "done"),
      { id, request, display, phase: "retrieving", passages: null, provider: null, preliminary: "", response: null, error: null },
    ]);
    try {
      const response = await api.askStream(request, {
        signal: controller.signal,
        onEvent: (event) => onStreamEvent(id, event),
      });
      // The validated answer replaces the preliminary text.
      patchTurn(id, { phase: "done", response, preliminary: "" });
      noteDialogSources(userId, request.question, display.skill?.name ?? null, response.citations.length);
      // Clear the field only if it still holds this question (the next one may already be typed there).
      if (composer.message().question === request.question) composer.setText("");
    } catch (err) {
      const error = toApiError(err);
      const cancelled = isCancelled(error);
      patchTurn(id, cancelled ? { phase: "cancelled", preliminary: "" } : { phase: "error", error, preliminary: "" });
      // The question is never lost: put it back unless something else has been typed meanwhile.
      const current = composer.message().question;
      if (current === "" || current === request.question) composer.setText(request.question);
      if (cancelled) composer.focus();
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      inFlight.current = false;
      setPending(false);
    }
  }

  function send(message: ComposerMessage) {
    if (inFlight.current) return;
    void run(toAskRequest(message, context), displayOf(message));
  }

  function newConversation() {
    if (inFlight.current) return;
    setTurns([]);
    composer.reset();
    composer.focus();
  }

  function refine(question: string) {
    composer.setText(question);
    composer.focus();
  }

  const lastTurn = turns[turns.length - 1];
  const first = turns[0];

  // AI_PROVIDER=disabled: no question form with a button that can only fail — the page says so and searches.
  if (aiMode === "disabled") return <AskUnavailable initial={about ?? initialQuestion ?? ""} />;

  return (
    <div className="dialog">
      <PageToolbar
        crumbs={
          first
            ? [{ label: "Ассистент", to: "/" }, { label: first.request.question || first.display.skill?.name || "Диалог" }]
            : [{ label: "Ассистент" }]
        }
        actions={
          <Button icon="plus" onClick={newConversation} disabled={pending}>
            Новый диалог
          </Button>
        }
      />
      {turns.length > 0 ? (
        <>
          <h1 className="visually-hidden">Диалог с ассистентом</h1>
          <section className="conversation" aria-label="Диалог">
            {turns.map((turn, index) => (
              <TurnView
                key={turn.id}
                turn={turn}
                turnNo={index + 1}
                onRetry={turn === lastTurn && turn.phase === "error" ? () => void run(turn.request, turn.display) : undefined}
                onRefine={refine}
                onAskCorporate={(request, display) => void run(request, display)}
              />
            ))}
          </section>
        </>
      ) : (
        <div className="dialog__intro">
          <h1>Спросить базу знаний</h1>
          <p className="dialog__lead">
            Ответ строится только по найденным документам. Если подтверждений нет, ассистент прямо скажет, что данных
            недостаточно.
          </p>
          <div className="dialog__examples" role="group" aria-label="Примеры">
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                className="dialog__example"
                onClick={() => {
                  composer.setText(example);
                  composer.focus();
                }}
              >
                {example}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="dialog__composer">
        <Composer
          variant="dialog"
          composer={composer}
          skills={skills}
          onSend={send}
          pending={pending}
          onCancel={() => abortRef.current?.abort()}
          inputId="question"
          placeholder={turns.length > 0 && !composer.draft.skill ? "Уточните вопрос или попросите черновик правки" : undefined}
          note={
            context.length > 0
              ? `С учётом ${context.length} ${pluralRu(context.length, "предыдущего ответа", "предыдущих ответов", "предыдущих ответов")} этого диалога (не более ${MAX_HISTORY_TURNS}) — только как контекст; доказательства — найденные источники.`
              : undefined
          }
        />
      </div>
    </div>
  );
}
