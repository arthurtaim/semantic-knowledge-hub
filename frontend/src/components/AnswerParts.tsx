import { useId, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { AskRequest, AskResponse, Citation, Confidence, IntegrationState } from "../api/types";
import { CONFIDENCE_LABEL, shortRevision } from "../lib/labels";
import { useAsync } from "../lib/useAsync";
import { Highlighted } from "./Highlighted";
import { StatusStamp } from "./StatusStamp";

/** Support level of an answer: a category with text and shape, never a percentage. */
export function SupportBadge({ confidence }: { confidence: Confidence }) {
  return <span className={`confidence confidence--${confidence}`}>{CONFIDENCE_LABEL[confidence]}</span>;
}

/** A Confluence page (external, read through MCP) as opposed to a team document. */
export function isExternal(citation: Citation): boolean {
  return citation.source_kind === "confluence_mcp" || citation.source_type === "confluence";
}

/** Page version of a Confluence citation: the revision, or the last part of `confluence:<space>:<page>:<version>`. */
export function externalVersion(citation: Citation): string {
  return citation.revision || citation.source_id?.split(":").pop() || "—";
}

/** Where a citation opens: the document in the app at the cited section, else the evidence list entry. */
export function citationHref(citation: Citation, turnNo: number): string {
  return citation.app_path ?? `#cite-${turnNo}-${citation.ref}`;
}

/**
 * An inline [n] marker. Hover or focus shows the cited passage with its document, source, status and
 * revision; a click opens the document at the cited section (`section_anchor`).
 */
export function CitationMarker({ citation, turnNo }: { citation: Citation; turnNo: number }) {
  const [open, setOpen] = useState(false);
  const cardId = useId();
  const external = isExternal(citation);
  const href = citationHref(citation, turnNo);
  const label = `Источник ${citation.ref}`;
  const card = (
    <span id={cardId} role="tooltip" className="cite-card" hidden={!open}>
      <span className="cite-card__title">{citation.title}</span>
      <span className="cite-card__meta">
        <span className={`source-badge source-badge--${external ? "corporate" : "team"}`}>
          {external ? `Confluence · версия ${externalVersion(citation)}` : "Документ команды"}
        </span>
        {external ? null : <StatusStamp status={citation.status} />}
        <span>
          ревизия <code className="doc-id">{external ? externalVersion(citation) : shortRevision(citation.revision)}</code>
        </span>
        {citation.section ? <span>раздел «{citation.section}»</span> : null}
      </span>
      <q className="cite-card__quote">{citation.excerpt}</q>
    </span>
  );
  const handlers = {
    onMouseEnter: () => setOpen(true),
    onMouseLeave: () => setOpen(false),
    onFocus: () => setOpen(true),
    onBlur: () => setOpen(false),
    onKeyDown: (event: { key: string }) => {
      if (event.key === "Escape") setOpen(false);
    },
  };
  return (
    <span className="cite-marker">
      {href.startsWith("/") ? (
        <Link to={href} className="cite-ref" aria-label={label} aria-describedby={cardId} {...handlers}>
          [{citation.ref}]
        </Link>
      ) : (
        <a href={href} className="cite-ref" aria-label={label} aria-describedby={cardId} {...handlers}>
          [{citation.ref}]
        </a>
      )}
      {card}
    </span>
  );
}

/** Turns "[1]" markers in plain answer text into citation markers of the same turn. */
export function AnswerText({ text, citations, turnNo }: { text: string; citations: Citation[]; turnNo: number }) {
  const byRef = new Map(citations.map((c) => [c.ref, c]));
  return (
    <div className="answer__text">
      {text.split(/\n{2,}/).map((paragraph, pIndex) => (
        <p key={pIndex}>
          {paragraph.split("\n").map((line, lIndex) => {
            const parts: ReactNode[] = [];
            let last = 0;
            for (const match of line.matchAll(/\[(\d{1,3})\]/g)) {
              const citation = byRef.get(Number(match[1]));
              const index = match.index ?? 0;
              parts.push(line.slice(last, index));
              parts.push(
                citation ? <CitationMarker key={`${lIndex}-${index}`} citation={citation} turnNo={turnNo} /> : match[0],
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

interface NextActionsProps {
  citations: Citation[];
  question: string;
  onRefine: (question: string) => void;
}

/**
 * What to do with an answer. Each action exists only when it can work: the first cited TEAM document opens
 * and can get a change proposal (a draft → diff → review, nothing is applied); «Уточнить вопрос» always.
 */
export function NextActions({ citations, question, onRefine }: NextActionsProps) {
  const noteId = useId();
  const team = citations.find((c) => !isExternal(c) && c.app_path);
  return (
    <div className="answer__next" role="group" aria-label="Что дальше">
      {team?.app_path ? (
        <Link to={team.app_path} className="button button--secondary">
          Открыть документ
        </Link>
      ) : null}
      {team ? (
        <Link
          to={`/proposals/new?document=${encodeURIComponent(team.document_id)}`}
          className="button button--secondary"
          aria-describedby={noteId}
        >
          Предложить правку по этому ответу
        </Link>
      ) : null}
      <button type="button" className="button button--quiet" onClick={() => onRefine(question)}>
        Уточнить вопрос
      </button>
      {team ? (
        <p id={noteId} className="answer__next-note">
          Правка — в документ «{team.title}»: черновик, diff и ревью; ответ ничего не меняет сам.
        </p>
      ) : null}
    </div>
  );
}

interface InsufficientEvidenceProps {
  question: string;
  request: AskRequest;
  answer: AskResponse;
  corporateState: IntegrationState | undefined;
  onRefine: (question: string) => void;
  onAskCorporate: () => void;
}

/** Where the question was looked up, in words. */
function searchedWhere(request: AskRequest, answer: AskResponse): string {
  const parts: string[] = [];
  if (request.sources.includes("team")) {
    const extra = [request.include_drafts ? "черновики и документы на ревью" : null, request.include_deprecated ? "устаревшие" : null]
      .filter(Boolean)
      .join(" и ");
    parts.push(`документы команды — утверждённые${extra ? `, а также ${extra}` : ""}`);
  }
  if (request.sources.includes("corporate")) {
    const state = answer.scopes.find((s) => s.scope === "corporate")?.state;
    parts.push(
      state === "connected"
        ? "корпоративные источники (Confluence)"
        : state === "mock"
          ? "корпоративные источники (mock-коннектор с синтетическими страницами)"
          : "корпоративные источники — не подключены, не проверялись",
    );
  }
  return parts.join("; ");
}

/**
 * «Недостаточно данных» as a useful result: what and where was searched, the closest documents by the text
 * of the question (snippets, explicitly not evidence) and three next steps — refine, a SEPARATE labelled
 * corporate search, or a draft that documents the gap.
 */
export function InsufficientEvidence({ question, request, answer, corporateState, onRefine, onAskCorporate }: InsufficientEvidenceProps) {
  const headingId = useId();
  const closest = useAsync(() => api.documents({ query: question.slice(0, 200), size: 3 }), `closest:${question}`);
  const askedCorporate = request.sources.includes("corporate");
  const corporateAvailable = corporateState === "connected" || corporateState === "mock";
  const items = closest.data?.items ?? [];
  return (
    <section className="insufficient" aria-labelledby={headingId}>
      <h3 id={headingId}>В базе знаний нет ответа на этот вопрос</h3>
      <p>
        <strong>Подтверждений в доступных источниках не найдено.</strong> Ассистент не делает выводов без
        доказательств.
      </p>
      <p className="insufficient__searched">
        Искали «{question}» — {searchedWhere(request, answer)}.
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

      <h4 className="insufficient__title">Ближайшие совпадения</h4>
      <p className="insufficient__note">Документы, похожие по тексту вопроса, — это не подтверждение ответа.</p>
      {closest.loading && !closest.data ? <p className="muted">Ищу похожие документы…</p> : null}
      {closest.error ? <p className="muted">Не удалось найти похожие документы.</p> : null}
      {closest.data && items.length === 0 ? <p className="muted">Похожих документов не найдено.</p> : null}
      {items.length > 0 ? (
        <ul className="partial-matches">
          {items.map((doc) => (
            <li key={doc.id}>
              <span className="partial-matches__head">
                <Link to={`/documents/${encodeURIComponent(doc.id)}`}>{doc.title}</Link>
                <StatusStamp status={doc.status} />
              </span>
              {doc.highlights && doc.highlights.length > 0 ? (
                <q className="partial-matches__quote">
                  <Highlighted segments={doc.highlights} />
                </q>
              ) : doc.excerpt ? (
                <q className="partial-matches__quote">{doc.excerpt}</q>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      <h4 className="insufficient__title">Что можно сделать</h4>
      <ol className="insufficient__steps">
        <li>
          <button type="button" className="button button--secondary" onClick={() => onRefine(question)}>
            Уточнить вопрос
          </button>{" "}
          <span>Добавьте название системы, ID документа или точный термин.</span>
        </li>
        <li>
          {askedCorporate ? (
            <span>Корпоративные источники уже были в этом запросе.</span>
          ) : corporateAvailable ? (
            <>
              <button type="button" className="button button--secondary" onClick={onAskCorporate}>
                Искать в корпоративных источниках
              </button>{" "}
              <span>
                Отдельный запрос к Confluence{corporateState === "mock" ? " (mock-коннектор)" : ""}: ответ будет помечен
                как внешний и не смешается с документами команды.
              </span>
            </>
          ) : (
            <span>Поиск по корпоративным источникам недоступен: Confluence Data Center не подключён.</span>
          )}
        </li>
        <li>
          <Link to="/documents/new" className="button button--secondary">
            Создать черновик документа
          </Link>{" "}
          <span>Опишите недостающее знание — документ пройдёт ревью, прежде чем станет частью базы.</span>
        </li>
      </ol>
    </section>
  );
}
