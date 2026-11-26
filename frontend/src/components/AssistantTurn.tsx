import { useMemo } from "react";
import { Link } from "react-router-dom";
import type { ApiError } from "../api/client";
import type {
  AiMode,
  AskRequest,
  AskResponse,
  AskSkillRef,
  ExternalRetrievalSummary,
  SearchScope,
  StoredTurn,
  StoredTurnRequest,
  WorkProposalRef,
} from "../api/types";
import { ASK_ERROR_TITLE, citationLabels, isConflict, scopeLabel, scopeOfSources } from "../lib/assistant";
import { pluralRu } from "../lib/labels";
import { showsSourceOrigins } from "../lib/provenance";
import { useSession } from "../lib/session";
import { failedChecks, proposalCardId, toolChecksFailed } from "../lib/systemFacts";
import { AnswerMarkdown } from "./AnswerMarkdown";
import { AnswerActions, AnswerText, DemoAnswerText, factRefsOf, InsufficientEvidence, splitServerNotes, SupportBadge } from "./AnswerParts";
import { AnswerSources } from "./AnswerSources";
import { AskProposal } from "./AskProposal";
import { AskWorkProposal } from "./AskWorkProposal";
import { ProvenanceLine } from "./Provenance";
import { ErrorState, Notice } from "./Feedback";
import { ChecksInsufficient, FailedChecks, SystemFacts } from "./SystemFacts";
import { Chip } from "./ui/Chip";

/*
 * One message of an assistant conversation and what became of it (docs/ui-v2/specs/02_ASSISTANT.md §2): the
 * user's bubble with what was attached, the streaming stages, the answer with citation markers and one list of
 * sources, an error with a retry, a conflict. Shared by the dialog (/ask, design-03) and — `compact` — by the
 * assistant panel of a document (design-04), so both show answers by the same rules.
 */

/** `interrupted`: a stored turn that never completed (the page was reloaded or closed mid-answer). */
export type TurnPhase = "retrieving" | "generating" | "validating" | "done" | "error" | "cancelled" | "interrupted";

/** What the user attached to a message — shown as chips above it. Names only, never contents. */
export interface TurnDisplay {
  skill: AskSkillRef | null;
  files: { id: string; name: string }[];
  documents: { id: string; title: string }[];
  selection: string | null;
  /** What the user did when there is no question (a quick action: «Объяснить раздел»); shown as the bubble. */
  action?: string | null;
}

export const NOTHING_ATTACHED: TurnDisplay = { skill: null, files: [], documents: [], selection: null };

/** What the chat history says about a stored turn (docs/API_CONTRACTS.md v0.7). */
export interface StoredTurnInfo {
  seq: number;
  status: StoredTurn["status"];
  /** Neutral server notes: the index generation changed, a file is gone, why the answer is hidden. */
  notes: string[];
  withheld: StoredTurn["withheld"];
  /** The request can be sent again as it was (not for a selection: only its reference is stored). */
  resendable: boolean;
  request: StoredTurnRequest;
}

/**
 * One message of the dialog and what became of it. While the app is open it lives in the conversation store
 * (lib/conversationStore.ts); completed turns are also in the server's chat history (`stored` when loaded from it).
 */
export interface Turn {
  id: number;
  request: AskRequest;
  display: TurnDisplay;
  phase: TurnPhase;
  passages: number | null;
  provider: AiMode | null;
  /** PRELIMINARY model text (not validated); shown only while the turn runs. */
  preliminary: string;
  /** M5.7: what the backend is checking for the model right now («Проверяю каталог…»), until the next round. */
  activity?: string | null;
  response: AskResponse | null;
  error: ApiError | null;
  stored?: StoredTurnInfo;
}

export const isRunning = (turn: Turn) =>
  turn.phase === "retrieving" || turn.phase === "generating" || turn.phase === "validating";

/** The stages of an answer as the stream reports them (status events: retrieving → generating → validating). */
const STAGES: { phase: TurnPhase; label: string }[] = [
  { phase: "retrieving", label: "Ищу источники" },
  { phase: "generating", label: "Формулирую ответ" },
  { phase: "validating", label: "Проверяю цитаты" },
];

function statusText(turn: Turn): string {
  if (turn.phase === "generating" && turn.activity) return turn.activity;
  if (turn.phase === "generating") {
    const action = turn.provider === "claude_cli" ? "Формулирую ответ с Claude Code CLI…" : "Формулирую ответ…";
    if (turn.passages === null) return action;
    const n = turn.passages;
    return `${action} (${pluralRu(n, "найден", "найдено", "найдено")} ${n} ${pluralRu(n, "фрагмент", "фрагмента", "фрагментов")})`;
  }
  if (turn.phase === "validating") return "Проверяю цитаты…";
  if (turn.phase === "retrieving" && turn.activity) return turn.activity;
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
  no_single_local_source: "ни один документ команды не отвечает на вопрос целиком",
  specific_terms_not_covered: "в документах команды нет ключевого слова вопроса",
  external_scope_selected: "выбран поиск по корпоративным источникам",
  explicit_request: "запрошено явно",
  evidence_gap: "в документах команды не хватает части сведений",
  model_uncertain: "полнота документов команды не ясна",
  decision_invalid: "проверить полноту не удалось, решило резервное правило",
};

/** What the external search could honestly establish (AskResponse.external.outcome). */
const OUTCOME_LABEL: Record<string, string> = {
  no_match: "подходящих доступных страниц не найдено",
  insufficient_evidence: "недостающее не подтверждено",
  denied: "найденные страницы недоступны",
};

function externalSummary(ext: ExternalRetrievalSummary): string {
  const reason = ext.trigger ? (TRIGGER_LABEL[ext.trigger] ?? ext.trigger) : null;
  const parts = [
    `Внешний источник: запрос к Confluence${reason ? ` (причина: ${reason})` : ""}`,
    `загружено ${ext.fetched} стр.`,
    `из кэша ${ext.cache_hits}`,
  ];
  if (ext.rejected.length > 0) parts.push(`отклонено ${ext.rejected.length}`);
  const outcome = ext.outcome ? OUTCOME_LABEL[ext.outcome] : undefined;
  if (outcome) parts.push(outcome);
  return parts.join(", ") + (ext.degraded ? " — внешний источник ответил не полностью" : "");
}

const MODE_LABEL: Record<AskResponse["mode"], string> = {
  mock: "Без языковой модели: дословные выдержки",
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

/** «Недостаточно данных» in a narrow panel: what was missing and how to go on — no list of near matches. */
function CompactInsufficient({ answer, question, onRefine }: { answer: AskResponse; question: string; onRefine: (question: string) => void }) {
  return (
    <div className="insufficient insufficient--compact">
      <p>
        <strong>В базе знаний нет ответа.</strong> Подтверждений в доступных источниках не найдено — ассистент не
        делает выводов без доказательств.
      </p>
      {answer.unmatched_terms.length > 0 ? (
        <p>Не найдено в источниках: {answer.unmatched_terms.map((term) => `«${term}»`).join(", ")}</p>
      ) : null}
      {question ? (
        <button type="button" className="button button--secondary button--sm" onClick={() => onRefine(question)}>
          Уточнить вопрос
        </button>
      ) : null}
    </div>
  );
}

interface AnswerViewProps {
  answer: AskResponse;
  request: AskRequest;
  turnNo: number;
  onRefine: (question: string) => void;
  /** A separate, labelled corporate-only request for the same question. */
  onAskCorporate: (request: AskRequest) => void;
  /** The document panel: the same rules in less room — no next-step actions, sources without the extras. */
  compact?: boolean;
  /** M7: refine a work proposal in the chat (a NEW proposal); absent — the card only links to the review. */
  onRefineWork?: (reference: WorkProposalRef) => void;
}

/**
 * The assistant's answer: who answers and how well it is supported (a category, never a percentage), where its
 * sources come from (one quiet line, lib/provenance.ts — metadata, not a warning), the text with citation markers,
 * terms without support, the proposal of a skill (nothing applied), what to do next and one list of sources — team,
 * corporate and attachments apart. Generated text is labelled «ИИ», the extractive mode «без языковой модели» (a
 * mode, not the content: synthetic sources are said by the provenance line).
 */
export function AnswerView({ answer, request, turnNo, onRefine, onAskCorporate, compact = false, onRefineWork }: AnswerViewProps) {
  const session = useSession();
  const question = request.question;
  const insufficient = answer.confidence === "insufficient_evidence";
  const traceId = answer.retrieval_trace_id ?? null;
  // Stable per answer: the Markdown of the text is parsed again only when the answer itself changes.
  const labels = useMemo(() => citationLabels(answer.citations), [answer.citations]);
  const generated = answer.mode === "internal_api" || answer.mode === "claude_cli";
  // A server-composed work summary (M7, mock mode) carries system facts, not demo excerpts.
  const demoExcerpts = answer.mode === "mock" && !answer.proposal && !(answer.system_facts && answer.system_facts.length > 0);
  const facts = useMemo(() => factRefsOf(answer), [answer]);
  const textProps = { citations: answer.citations, labels, turnNo, question, facts, compact, origins: showsSourceOrigins(answer) };
  const showText = !insufficient || Boolean(answer.proposal);
  // M5.7: system tools were used and some did not work out — an answer that could not be confirmed says what could
  // not be checked instead of «В базе знаний нет ответа» with near matches (a metric is not a document).
  const checksFailedOnly = insufficient && toolChecksFailed(answer);
  const failed = insufficient ? [] : failedChecks(answer);
  const { text, notFound } = splitServerNotes(answer);
  const unsupported = notFound ?? (answer.unmatched_terms.length > 0 ? answer.unmatched_terms.map((term) => `«${term}»`).join(", ") : null);
  const Heading = compact ? "h3" : "h2";
  const modeLabel = answer.mode === "mock" && answer.proposal ? "Без языковой модели: предложение по правилам" : (MODE_LABEL[answer.mode] ?? answer.mode);
  return (
    <section
      className={`answer${insufficient ? " answer--insufficient" : ""}${compact ? " answer--compact" : ""}`}
      aria-labelledby={`answer-title-${turnNo}`}
    >
      <div className="answer__head">
        <Heading id={`answer-title-${turnNo}`} className="answer__who">
          Ассистент
        </Heading>
        <SupportBadge confidence={answer.confidence} />
        {answer.general_knowledge ? (
          <span className="answer__general" title="Объяснение модели из общих знаний: это не документы и не данные SKH">
            Общие знания, не данные SKH
          </span>
        ) : null}
        {generated ? (
          <span className="ai-label" title="Текст сформирован языковой моделью; цитаты сверены сервером">
            ИИ
          </span>
        ) : null}
        {compact && answer.mode === "mock" ? (
          <span className="mode-tag" title={modeLabel}>
            Без модели
          </span>
        ) : (
          <span className="answer__mode">{modeLabel}</span>
        )}
        {traceId ? (
          <Link to={`/graph?trace=${encodeURIComponent(traceId)}`} className="answer__graph">
            Граф ответа
          </Link>
        ) : null}
        <ProvenanceLine provenance={answer.provenance} />
      </div>
      <CorporateGap answer={answer} asked={request.sources} />
      {answer.external?.called ? <p className="answer__external">{externalSummary(answer.external)}</p> : null}
      {checksFailedOnly ? (
        <ChecksInsufficient steps={failedChecks(answer, true)} question={question} compact={compact} onRefine={onRefine} />
      ) : insufficient ? (
        compact ? (
          <CompactInsufficient answer={answer} question={question} onRefine={onRefine} />
        ) : (
          <InsufficientEvidence
            question={question}
            request={request}
            answer={answer}
            corporateState={session?.features.corporate_search}
            onRefine={onRefine}
            onAskCorporate={() => onAskCorporate({ ...request, sources: ["corporate"], search_external: true, history: [] })}
          />
        )
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
          <span className="answer__unsupported-label">Не найдено в документах:</span> {unsupported}
        </p>
      ) : null}

      <SystemFacts answer={answer} labels={facts.labels} turnNo={turnNo} compact={compact} />
      <FailedChecks steps={failed} />

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
        <AskProposal
          reference={answer.proposal}
          mode={answer.mode}
          primary={answer.proposal.status === "suggested"}
          compact={compact}
          anchorId={proposalCardId(turnNo)}
        />
      ) : null}
      {answer.work_proposal ? <AskWorkProposal reference={answer.work_proposal} compact={compact} onRefine={onRefineWork} /> : null}

      {insufficient || compact ? null : (
        <AnswerActions
          answer={answer}
          question={question}
          labels={labels}
          demo={demoExcerpts}
          hasProposal={Boolean(answer.proposal)}
          onRefine={onRefine}
        />
      )}

      <AnswerSources answer={answer} labels={labels} turnNo={turnNo} compact={compact} />
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

/** What the reader can do about an input error (the server's own message comes first). */
const ERROR_HINT: Record<string, string> = {
  selection_not_found:
    "Сервер сверяет выделение с текстом документа дословно. Обновите страницу, если документ мог измениться, или выделите фрагмент внутри одного раздела.",
};

function TurnError({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  const retry = NOT_RETRYABLE.has(error.code) ? undefined : onRetry;
  const hint = ERROR_HINT[error.code];
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
  return (
    <>
      <ErrorState error={error} title={ASK_ERROR_TITLE[error.code]} onRetry={retry} retryLabel="Повторить запрос" />
      {hint ? <p className="turn__hint">{hint}</p> : null}
    </>
  );
}

/**
 * A stored turn without a shown answer (docs/API_CONTRACTS.md v0.7): it never completed (the page was reloaded or
 * closed mid-answer — it is never re-run by itself), or its answer is withheld (its sources are no longer visible
 * to the reader, or it was too large to keep). The server's notes say why; asking again is the reader's choice.
 */
function StoredGap({ turn, onResend }: { turn: Turn; onResend?: () => void }) {
  const stored = turn.stored;
  const interrupted = turn.phase === "interrupted";
  const text = interrupted
    ? stored?.status === "pending"
      ? "Ответ ещё не получен: он формируется в другой вкладке или был прерван."
      : "Ответ не был получен: запрос прервался до конца (страница была закрыта или обновлена)."
    : null;
  return (
    <div className="turn__gap" role="status">
      {text ? <p className="turn__status turn__status--stopped">{text}</p> : null}
      {stored?.withheld
        ? stored.notes.map((note) => (
            <p key={note} className="turn__gap-note">
              {note}
            </p>
          ))
        : null}
      {onResend ? (
        <button type="button" className="button button--secondary button--sm" onClick={onResend}>
          {interrupted ? "Повторить запрос" : "Задать вопрос заново"}
        </button>
      ) : null}
    </div>
  );
}

interface TurnViewProps {
  turn: Turn;
  turnNo: number;
  onRefine: (question: string) => void;
  onAskCorporate: (request: AskRequest, display: TurnDisplay) => void;
  /** Only the last failed turn offers a retry (a new question replaces it). */
  onRetry?: () => void;
  /** A stored turn without an answer (interrupted, withheld): ask the same again — only on the reader's click. */
  onResend?: () => void;
  compact?: boolean;
  /** M7: «Уточнить» on a work proposal card. */
  onRefineWork?: (reference: WorkProposalRef) => void;
}

export function TurnView({ turn, turnNo, onRetry, onResend, onRefine, onAskCorporate, compact = false, onRefineWork }: TurnViewProps) {
  const running = isRunning(turn);
  const { display } = turn;
  // A quick action names itself in the bubble; its skill chip would only repeat it.
  const skillChip = display.skill && !(display.action && !turn.request.question) ? display.skill : null;
  const work = turn.request.work_context ?? null;
  const attached = skillChip || work || display.files.length > 0 || display.documents.length > 0 || display.selection;
  const scope = scopeSummary(turn.request);
  const Heading = compact ? "h3" : "h2";
  return (
    <article className={`turn${compact ? " turn--compact" : ""}`} aria-busy={running}>
      <div className="turn__user">
        <Heading className="visually-hidden">Вы</Heading>
        {attached ? (
          <ul className="turn__chips" aria-label="Приложено к сообщению">
            {skillChip ? (
              <li>
                <Chip tone="skill" icon="skill">
                  {skillChip.name}
                </Chip>
              </li>
            ) : null}
            {work ? (
              <li>
                <Chip tone="document" icon="projects" title="Проект навыка (проверяется сервером при каждом сообщении)">
                  {work.project_key}
                  {work.task_keys && work.task_keys.length > 0 ? `: ${work.task_keys.join(", ")}` : ""}
                  {work.proposal_id ? ` · уточнение ${work.proposal_id}` : ""}
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
          {turn.request.question ||
            display.action || <span className="turn__bubble-empty">Без вопроса: навык «{display.skill?.name ?? "—"}»</span>}
        </p>
        {scope ? <p className="turn__scope">{scope}</p> : null}
      </div>

      {running ? (
        <div className="turn__progress">
          {compact ? null : <StageTrack phase={turn.phase} />}
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
          <div className="answer-preliminary__text answer-md">
            <AnswerMarkdown text={turn.preliminary} markers={null} headingLevel={compact ? 3 : 2} />
          </div>
        </section>
      ) : null}

      {turn.phase === "cancelled" ? (
        <p className="turn__status turn__status--stopped" role="status">
          {turn.request.question ? "Запрос отменён. Вопрос возвращён в поле ввода." : "Запрос отменён."}
        </p>
      ) : null}
      {turn.phase === "error" && turn.error ? <TurnError error={turn.error} onRetry={onRetry} /> : null}
      {turn.phase === "interrupted" || (turn.phase === "done" && !turn.response && turn.stored) ? (
        <StoredGap turn={turn} onResend={onResend} />
      ) : null}
      {turn.response && turn.stored && turn.stored.notes.length > 0 ? (
        <ul className="turn__notes" aria-label="Об ответе из истории">
          {turn.stored.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
      {turn.response ? (
        <AnswerView
          answer={turn.response}
          request={turn.request}
          turnNo={turnNo}
          onRefine={onRefine}
          onAskCorporate={(request) => onAskCorporate(request, turn.display)}
          compact={compact}
          onRefineWork={onRefineWork}
        />
      ) : null}
    </article>
  );
}
