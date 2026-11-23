import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ApiError, api, isCancelled } from "../api/client";
import type {
  AiMode,
  AskRequest,
  AskResponse,
  AskStreamEvent,
  Citation,
  ConversationTurn,
  DiscoveryVerdict,
  ExternalRetrievalSummary,
  SearchScope,
} from "../api/types";
import { ErrorState, Notice } from "../components/Feedback";
import { StateBadge } from "../components/StateBadge";
import { StatusStamp } from "../components/StatusStamp";
import { AI_ERROR_TITLE, CONFIDENCE_LABEL, SOURCE_LABEL, formatDateTime, pluralRu } from "../lib/labels";
import { useSession } from "../lib/session";

const SCOPES: { value: string; label: string; scopes: SearchScope[] }[] = [
  { value: "team", label: "Команда", scopes: ["team"] },
  { value: "corporate", label: "Корпоративные", scopes: ["corporate"] },
  { value: "both", label: "Оба", scopes: ["team", "corporate"] },
];

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

/** One question of the conversation and what became of it. Lives in React state only (never stored). */
interface Turn {
  id: number;
  request: AskRequest;
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

/** Context for a follow-up: the last completed turns (with a validated answer), oldest first. */
function historyFrom(turns: Turn[]): ConversationTurn[] {
  return turns
    .filter((turn) => turn.response !== null)
    .slice(-MAX_HISTORY_TURNS)
    .map((turn) => ({
      question: turn.request.question,
      answer: truncate(turn.response?.answer ?? "", MAX_HISTORY_ANSWER_CHARS),
    }));
}

function toApiError(err: unknown): ApiError {
  return err instanceof ApiError ? err : new ApiError(0, "client_error", String(err), null);
}

function statusText(turn: Turn): string {
  if (turn.phase === "generating") {
    const action = turn.provider === "claude_cli" ? "Claude формирует ответ…" : "Формируем ответ…";
    if (turn.passages === null) return action;
    const n = turn.passages;
    return `${action} (${pluralRu(n, "найден", "найдено", "найдено")} ${n} ${pluralRu(n, "фрагмент", "фрагмента", "фрагментов")})`;
  }
  if (turn.phase === "validating") return "Проверяем цитаты…";
  return "Ищем источники…";
}

function scopeSummary(request: AskRequest): string {
  const scope = SCOPES.find((s) => s.scopes.join() === request.sources.join())?.label ?? request.sources.join(", ");
  const parts = [`Где искать: ${scope}`];
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

/** Page version of a Confluence citation: the revision, or the last part of `confluence:<space>:<page>:<version>`. */
function externalVersion(citation: Citation): string {
  return citation.revision || citation.source_id?.split(":").pop() || "—";
}

/**
 * Optional relevance feedback and «Предложить в базу» for ONE Confluence source of ONE answer. Never blocks the
 * answer; it changes neither the status nor the access of anything.
 */
function ExternalSourceActions({ traceId, sourceId, title }: { traceId: string; sourceId: string; title: string }) {
  const navigate = useNavigate();
  const [verdict, setVerdict] = useState<DiscoveryVerdict | null>(null);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const [pending, setPending] = useState<"feedback" | "propose" | null>(null);

  async function rate(next: DiscoveryVerdict) {
    if (pending || verdict === next) return;
    setPending("feedback");
    try {
      const result = await api.discoveryFeedback({ trace_id: traceId, source_id: sourceId, verdict: next });
      setVerdict(next);
      setNote({ text: result.note, error: false });
    } catch (err) {
      setNote({ text: `Отзыв не сохранён: ${toApiError(err).message}`, error: true });
    } finally {
      setPending(null);
    }
  }

  async function propose() {
    if (pending) return;
    setPending("propose");
    try {
      const draft = await api.discoveryPropose({ trace_id: traceId, source_id: sourceId });
      navigate(`/proposals/${encodeURIComponent(draft.id)}`);
    } catch (err) {
      setNote({ text: `Предложение не создано: ${toApiError(err).message}`, error: true });
      setPending(null);
    }
  }

  return (
    <div className="citation__feedback" role="group" aria-label={`Оценка источника «${title}»`}>
      <span className="citation__feedback-label">Источник подошёл?</span>
      <button
        type="button"
        className="toggle-button"
        aria-pressed={verdict === "relevant"}
        disabled={pending !== null}
        onClick={() => void rate("relevant")}
      >
        Подошёл
      </button>
      <button
        type="button"
        className="toggle-button"
        aria-pressed={verdict === "irrelevant"}
        disabled={pending !== null}
        onClick={() => void rate("irrelevant")}
      >
        Не подошёл
      </button>
      <button type="button" className="button button--quiet" disabled={pending !== null} onClick={() => void propose()}>
        {pending === "propose" ? "Создаём черновик…" : "Предложить в базу"}
      </button>
      <p className={`citation__note${note?.error ? " citation__note--error" : ""}`} role="status">
        {note?.text ?? ""}
      </p>
    </div>
  );
}

/** Turns "[1]" markers in plain answer text into links to the numbered citation list of the same turn. */
function AnswerText({ text, citations, turnNo }: { text: string; citations: Citation[]; turnNo: number }) {
  const refs = new Set(citations.map((c) => c.ref));
  return (
    <div className="answer__text">
      {text.split(/\n{2,}/).map((paragraph, pIndex) => (
        <p key={pIndex}>
          {paragraph.split("\n").map((line, lIndex) => {
            const parts: ReactNode[] = [];
            let last = 0;
            for (const match of line.matchAll(/\[(\d{1,3})\]/g)) {
              const ref = Number(match[1]);
              const index = match.index ?? 0;
              parts.push(line.slice(last, index));
              parts.push(
                refs.has(ref) ? (
                  <a
                    key={`${lIndex}-${index}`}
                    href={`#cite-${turnNo}-${ref}`}
                    className="cite-ref"
                    aria-label={`Источник ${ref}`}
                  >
                    [{ref}]
                  </a>
                ) : (
                  match[0]
                ),
              );
              last = index + match[0].length;
            }
            parts.push(line.slice(last));
            return (
              <span key={lIndex} className="answer__line">
                {parts}
              </span>
            );
          })}
        </p>
      ))}
    </div>
  );
}

interface CitationItemProps {
  citation: Citation;
  turnNo: number;
  /** Trace of the answer: feedback and «Предложить в базу» for the first citation of each Confluence page. */
  actionsTrace: string | null;
}

function CitationItem({ citation, turnNo, actionsTrace }: CitationItemProps) {
  const external = citation.source_kind === "confluence_mcp";
  return (
    <li id={`cite-${turnNo}-${citation.ref}`} className="citation">
      <div className="citation__head">
        <span className="citation__ref" aria-hidden="true">
          {citation.ref}
        </span>
        <div>
          {citation.app_path ? (
            <Link to={citation.app_path} className="citation__title">
              {citation.title}
            </Link>
          ) : citation.source_uri.startsWith("https://") ? (
            // Server-validated link to the authorized source (allowlisted host only).
            <a href={citation.source_uri} className="citation__title" target="_blank" rel="noopener noreferrer nofollow">
              {citation.title}
            </a>
          ) : (
            <span className="citation__title">{citation.title}</span>
          )}
          {citation.section ? <span className="citation__section">раздел «{citation.section}»</span> : null}
          {external ? (
            <span className="citation__origin">
              <span>Confluence · версия {externalVersion(citation)}</span>
              {citation.external_status !== "approved" ? (
                <span className="graph-unconfirmed">статус не подтверждён</span>
              ) : null}
            </span>
          ) : null}
        </div>
        <StatusStamp status={citation.status} />
      </div>
      <blockquote className="citation__excerpt">{citation.excerpt}</blockquote>
      <dl className="citation__meta">
        <div>
          <dt>Источник</dt>
          <dd>
            {SOURCE_LABEL[citation.source_type]}
            {citation.is_demo ? " (демо)" : ""}
          </dd>
        </div>
        <div>
          <dt>ID</dt>
          <dd>
            <code className="doc-id">{citation.document_id}</code>
          </dd>
        </div>
        <div>
          <dt>Ревизия</dt>
          <dd>
            <code className="doc-id">{citation.revision}</code>
          </dd>
        </div>
        <div>
          <dt>Получено</dt>
          <dd>{formatDateTime(citation.retrieved_at)}</dd>
        </div>
      </dl>
      {external && actionsTrace && citation.source_id ? (
        <ExternalSourceActions traceId={actionsTrace} sourceId={citation.source_id} title={citation.title} />
      ) : null}
    </li>
  );
}

const MODE_LABEL: Record<AskResponse["mode"], string> = {
  mock: "Демо-режим, без языковой модели",
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

function AnswerView({ answer, asked, turnNo }: { answer: AskResponse; asked: SearchScope[]; turnNo: number }) {
  const insufficient = answer.confidence === "insufficient_evidence";
  const traceId = answer.retrieval_trace_id ?? null;
  // Several citations may quote one Confluence page: its feedback controls appear once, at the first of them.
  const withActions = new Set<number>();
  const seenSources = new Set<string>();
  for (const citation of answer.citations) {
    if (citation.source_kind === "confluence_mcp" && citation.source_id && !seenSources.has(citation.source_id)) {
      seenSources.add(citation.source_id);
      withActions.add(citation.ref);
    }
  }
  return (
    <section className={`answer${insufficient ? " answer--insufficient" : ""}`} aria-labelledby={`answer-title-${turnNo}`}>
      {/* ≥ 1200 px: the answer on the left (68ch), its sources in a column on the right. */}
      <div className="answer__body">
        <div className="answer__head">
          <h2 id={`answer-title-${turnNo}`}>Ответ</h2>
          <span className={`confidence confidence--${answer.confidence}`}>{CONFIDENCE_LABEL[answer.confidence]}</span>
          <span className="answer__mode">{MODE_LABEL[answer.mode] ?? answer.mode}</span>
          {traceId ? (
            <Link to={`/graph?trace=${encodeURIComponent(traceId)}`} className="answer__graph">
              Граф ответа
            </Link>
          ) : null}
        </div>
        <CorporateGap answer={answer} asked={asked} />
        {answer.external?.called ? <p className="answer__external">{externalSummary(answer.external)}</p> : null}
        {insufficient ? (
          <div className="answer__insufficient">
            <p>
              <strong>Подтверждений в доступных источниках не найдено.</strong> Ассистент не делает выводов без
              доказательств — уточните вопрос, включите черновики или проверьте документы вручную.
            </p>
            {answer.unmatched_terms.length > 0 ? (
              <p>
                Не найдено в источниках:{" "}
                {answer.unmatched_terms.map((term, index) => (
                  <span key={term}>
                    {index > 0 ? ", " : ""}«{term}»
                  </span>
                ))}
              </p>
            ) : null}
          </div>
        ) : null}
        <AnswerText text={answer.answer} citations={answer.citations} turnNo={turnNo} />

        {answer.warnings.length > 0 ? (
          <Notice tone="warning">
            <ul>
              {answer.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </Notice>
        ) : null}
      </div>

      {answer.citations.length > 0 ? (
        <section className="answer__sources" aria-labelledby={`sources-title-${turnNo}`}>
          <h3 id={`sources-title-${turnNo}`}>Источники</h3>
          <ol className="citations">
            {answer.citations.map((citation) => (
              <CitationItem
                key={citation.ref}
                citation={citation}
                turnNo={turnNo}
                actionsTrace={withActions.has(citation.ref) ? traceId : null}
              />
            ))}
          </ol>
        </section>
      ) : null}

      {answer.excluded_sources.length > 0 ? (
        <section aria-labelledby={`excluded-title-${turnNo}`} className="excluded">
          <h3 id={`excluded-title-${turnNo}`}>Не использованы как доказательство</h3>
          <ul>
            {answer.excluded_sources.map((source) => (
              <li key={source.document_id}>
                <Link to={`/documents/${source.document_id}`}>{source.title}</Link> <StatusStamp status={source.status} />
                <span className="muted"> {source.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <dl className="scope-status">
        {answer.scopes.map((scope) => (
          <div key={scope.scope}>
            <dt>{scope.scope === "team" ? "Документы команды" : "Корпоративные источники"}</dt>
            <dd>
              <StateBadge state={scope.state} /> <span className="muted">{scope.message}</span>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

interface TurnViewProps {
  turn: Turn;
  turnNo: number;
  /** Only the last failed turn offers a retry (a new question replaces it). */
  onRetry?: () => void;
}

function TurnView({ turn, turnNo, onRetry }: TurnViewProps) {
  const running = isRunning(turn);
  return (
    <article className="turn" aria-busy={running}>
      <div className="turn__question">
        <p className="turn__meta">
          <span className="turn__who">Вы спросили</span> <span className="muted">{scopeSummary(turn.request)}</span>
        </p>
        <p className="turn__question-text">{turn.request.question}</p>
      </div>

      {running ? (
        <p className="turn__status" role="status">
          {statusText(turn)}
        </p>
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
      {turn.phase === "error" && turn.error ? (
        <ErrorState
          error={turn.error}
          title={AI_ERROR_TITLE[turn.error.code]}
          onRetry={onRetry}
          retryLabel="Повторить запрос"
        />
      ) : null}
      {turn.response ? <AnswerView answer={turn.response} asked={turn.request.sources} turnNo={turnNo} /> : null}
    </article>
  );
}

export function AskPage() {
  const [params] = useSearchParams();
  const session = useSession();
  const about = params.get("about");
  const initial = params.get("q");
  const [question, setQuestion] = useState(about ? `Что известно о «${about}»?` : (initial ?? "").slice(0, 2000));
  const [scope, setScope] = useState("team");
  const [includeDrafts, setIncludeDrafts] = useState(false);
  const [includeDeprecated, setIncludeDeprecated] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [formError, setFormError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const nextId = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const questionRef = useRef<HTMLTextAreaElement>(null);
  const corporateState = session?.features.corporate_search;
  const context = historyFrom(turns);

  // Leaving the page cancels a running generation on the server.
  useEffect(() => () => abortRef.current?.abort(), []);

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
  async function run(request: AskRequest) {
    if (inFlight.current) return;
    inFlight.current = true;
    const id = ++nextId.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setPending(true);
    setFormError(null);
    setTurns((list) => [
      ...list.filter((turn) => turn.phase === "done"),
      { id, request, phase: "retrieving", passages: null, provider: null, preliminary: "", response: null, error: null },
    ]);
    try {
      const response = await api.askStream(request, {
        signal: controller.signal,
        onEvent: (event) => onStreamEvent(id, event),
      });
      // The validated answer replaces the preliminary text.
      patchTurn(id, { phase: "done", response, preliminary: "" });
      // Clear the field only if it still holds this question (the next one may already be typed there).
      setQuestion((current) => (current.trim() === request.question ? "" : current));
    } catch (err) {
      const error = toApiError(err);
      const cancelled = isCancelled(error);
      patchTurn(id, cancelled ? { phase: "cancelled", preliminary: "" } : { phase: "error", error, preliminary: "" });
      // The question is never lost: put it back unless something else has been typed meanwhile.
      setQuestion((current) => (current.trim() === "" || current.trim() === request.question ? request.question : current));
      if (cancelled) questionRef.current?.focus();
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      inFlight.current = false;
      setPending(false);
    }
  }

  function ask() {
    if (inFlight.current) return;
    const text = question.trim();
    if (text.length < 3) {
      setFormError(new ApiError(400, "question_too_short", "Введите вопрос длиной не менее 3 символов.", null));
      return;
    }
    void run({
      question: text,
      sources: SCOPES.find((s) => s.value === scope)?.scopes ?? ["team"],
      include_drafts: includeDrafts,
      include_deprecated: includeDeprecated,
      history: context,
    });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    ask();
  }

  function onQuestionKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      ask();
    }
  }

  function newConversation() {
    if (inFlight.current) return;
    setTurns([]);
    setFormError(null);
    questionRef.current?.focus();
  }

  const lastTurn = turns[turns.length - 1];

  return (
    <div className="ask">
      <div className="page-head">
        <h1>Спросить базу знаний</h1>
        <p className="lead">
          Ответ строится только по найденным документам. Если подтверждений нет, ассистент прямо скажет, что данных
          недостаточно.
        </p>
      </div>

      {turns.length > 0 ? (
        <section className="conversation" aria-label="Диалог">
          {turns.map((turn, index) => (
            <TurnView
              key={turn.id}
              turn={turn}
              turnNo={index + 1}
              onRetry={turn === lastTurn && turn.phase === "error" ? () => void run(turn.request) : undefined}
            />
          ))}
        </section>
      ) : null}

      <form className="ask__form" onSubmit={submit}>
        <label htmlFor="question">Вопрос</label>
        <textarea
          id="question"
          ref={questionRef}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          rows={3}
          maxLength={2000}
          placeholder={
            context.length > 0
              ? "Уточняющий вопрос — например: а какие у неё ограничения?"
              : "Например: где хранится каноническая база знаний команды?"
          }
          aria-describedby={context.length > 0 ? "question-hint question-context" : "question-hint"}
          onKeyDown={onQuestionKeyDown}
        />
        <p id="question-hint" className="field-hint">
          Ctrl+Enter (⌘+Enter на Mac) — отправить вопрос.
        </p>
        {context.length > 0 ? (
          <p id="question-context" className="field-hint">
            Следующий вопрос будет задан с учётом {context.length}{" "}
            {pluralRu(context.length, "предыдущего ответа", "предыдущих ответов", "предыдущих ответов")} этого диалога (не
            более {MAX_HISTORY_TURNS}) — только как контекст, доказательствами остаются найденные источники. Диалог не
            сохраняется: после перезагрузки страницы он исчезнет.
          </p>
        ) : null}
        <div className="ask__examples">
          <span className="muted">Примеры:</span>
          {EXAMPLES.map((example) => (
            <button key={example} type="button" className="chip" onClick={() => setQuestion(example)}>
              {example}
            </button>
          ))}
        </div>
        <fieldset className="segmented">
          <legend>Где искать</legend>
          {SCOPES.map((option) => (
            <label key={option.value} className="segmented__option">
              <input
                type="radio"
                name="scope"
                value={option.value}
                checked={scope === option.value}
                onChange={() => setScope(option.value)}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </fieldset>
        {scope !== "team" && corporateState === "disabled" ? (
          <Notice tone="info">
            Корпоративные источники (Confluence Data Center) не подключены — поиск выполнится только по документам
            команды.
          </Notice>
        ) : null}
        {scope !== "team" && corporateState === "mock" ? (
          <Notice tone="info">Корпоративный поиск работает через mock-коннектор с синтетическими страницами.</Notice>
        ) : null}
        <div className="ask__options">
          <label className="checkbox">
            <input type="checkbox" checked={includeDrafts} onChange={(e) => setIncludeDrafts(e.target.checked)} />
            Учитывать черновики и документы на ревью
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={includeDeprecated}
              onChange={(e) => setIncludeDeprecated(e.target.checked)}
            />
            Учитывать устаревшие документы
          </label>
        </div>
        {formError ? <ErrorState error={formError} /> : null}
        <div className="ask__actions">
          <button type="submit" className="button button--primary" disabled={pending}>
            {pending ? "Ищем подтверждения…" : "Спросить"}
          </button>
          {pending ? (
            <button type="button" className="button button--secondary" onClick={() => abortRef.current?.abort()}>
              Отменить
            </button>
          ) : null}
          {turns.length > 0 ? (
            <button
              type="button"
              className="button button--ghost ask__new"
              onClick={newConversation}
              disabled={pending}
            >
              Новый диалог
            </button>
          ) : null}
        </div>
      </form>
    </div>
  );
}
