import { useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ApiError, api } from "../api/client";
import type { AskResponse, Citation, SearchScope } from "../api/types";
import { ErrorState, Notice } from "../components/Feedback";
import { StateBadge } from "../components/StateBadge";
import { StatusStamp } from "../components/StatusStamp";
import { CONFIDENCE_LABEL, SOURCE_LABEL, formatDateTime } from "../lib/labels";
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

/** Turns "[1]" markers in plain answer text into links to the numbered citation list. */
function AnswerText({ text, citations }: { text: string; citations: Citation[] }) {
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
                  <a key={`${lIndex}-${index}`} href={`#cite-${ref}`} className="cite-ref" aria-label={`Источник ${ref}`}>
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

function CitationItem({ citation }: { citation: Citation }) {
  return (
    <li id={`cite-${citation.ref}`} className="citation">
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
    </li>
  );
}

const MODE_LABEL: Record<AskResponse["mode"], string> = {
  mock: "Демо-режим, без языковой модели",
  disabled: "Языковая модель отключена — только выдержки из источников",
  internal_api: "Внутренняя модель, цитаты сверены с источниками",
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

function AnswerView({ answer, asked }: { answer: AskResponse; asked: SearchScope[] }) {
  const insufficient = answer.confidence === "insufficient_evidence";
  return (
    <section className={`answer${insufficient ? " answer--insufficient" : ""}`} aria-labelledby="answer-title">
      <div className="answer__head">
        <h2 id="answer-title">Ответ</h2>
        <span className={`confidence confidence--${answer.confidence}`}>{CONFIDENCE_LABEL[answer.confidence]}</span>
        <span className="answer__mode">{MODE_LABEL[answer.mode]}</span>
      </div>
      <CorporateGap answer={answer} asked={asked} />
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
      <AnswerText text={answer.answer} citations={answer.citations} />

      {answer.warnings.length > 0 ? (
        <Notice tone="warning">
          <ul>
            {answer.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </Notice>
      ) : null}

      {answer.citations.length > 0 ? (
        <section aria-labelledby="sources-title">
          <h3 id="sources-title">Источники</h3>
          <ol className="citations">
            {answer.citations.map((citation) => (
              <CitationItem key={citation.ref} citation={citation} />
            ))}
          </ol>
        </section>
      ) : null}

      {answer.excluded_sources.length > 0 ? (
        <section aria-labelledby="excluded-title" className="excluded">
          <h3 id="excluded-title">Не использованы как доказательство</h3>
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

export function AskPage() {
  const [params] = useSearchParams();
  const session = useSession();
  const about = params.get("about");
  const initial = params.get("q");
  const [question, setQuestion] = useState(about ? `Что известно о «${about}»?` : (initial ?? "").slice(0, 2000));
  const [scope, setScope] = useState("team");
  const [includeDrafts, setIncludeDrafts] = useState(false);
  const [includeDeprecated, setIncludeDeprecated] = useState(false);
  const [result, setResult] = useState<{ answer: AskResponse; asked: SearchScope[] } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const corporateState = session?.features.corporate_search;

  async function ask() {
    if (inFlight.current) return;
    const text = question.trim();
    if (text.length < 3) {
      setError(new ApiError(400, "question_too_short", "Введите вопрос длиной не менее 3 символов.", null));
      return;
    }
    inFlight.current = true;
    setPending(true);
    setError(null);
    const scopes = SCOPES.find((s) => s.value === scope)?.scopes ?? ["team"];
    try {
      const answer = await api.ask({
        question: text,
        sources: scopes,
        include_drafts: includeDrafts,
        include_deprecated: includeDeprecated,
      });
      setResult({ answer, asked: scopes });
    } catch (err) {
      setResult(null);
      setError(err instanceof ApiError ? err : new ApiError(0, "client_error", String(err), null));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void ask();
  }

  function onQuestionKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void ask();
    }
  }

  return (
    <div className="ask">
      <div className="page-head">
        <h1>Спросить базу знаний</h1>
        <p className="lead">
          Ответ строится только по найденным документам. Если подтверждений нет, ассистент прямо скажет, что данных
          недостаточно.
        </p>
      </div>

      <form className="ask__form" onSubmit={submit}>
        <label htmlFor="question">Вопрос</label>
        <textarea
          id="question"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          rows={3}
          maxLength={2000}
          placeholder="Например: где хранится каноническая база знаний команды?"
          aria-describedby="question-hint"
          onKeyDown={onQuestionKeyDown}
        />
        <p id="question-hint" className="field-hint">
          Ctrl+Enter (⌘+Enter на Mac) — отправить вопрос.
        </p>
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
        <button type="submit" className="button button--primary" disabled={pending}>
          {pending ? "Ищем подтверждения…" : "Спросить"}
        </button>
      </form>

      <div aria-live="polite" aria-busy={pending}>
        {error ? (
          <ErrorState
            error={error}
            onRetry={error.code === "question_too_short" ? undefined : () => void ask()}
            retryLabel="Повторить запрос"
          />
        ) : null}
        {result ? <AnswerView answer={result.answer} asked={result.asked} /> : null}
      </div>
    </div>
  );
}
