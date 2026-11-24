import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { AskRequest, AskResponse, Citation, Confidence, IntegrationState } from "../api/types";
import { citationGroup, type CitationGroup } from "../lib/assistant";
import { CONFIDENCE_LABEL, shortRevision } from "../lib/labels";
import { useAsync } from "../lib/useAsync";
import { Highlighted } from "./Highlighted";
import { StatusStamp } from "./StatusStamp";
import { buttonClass } from "./ui/Button";
import { Icon, type IconName } from "./ui/Icon";
import { StatusMark } from "./ui/StatusMark";

/*
 * Parts of an assistant answer (docs/ui-v2/specs/02_ASSISTANT.md §2, design-03): the support level, the answer
 * text with citation markers (1 team, К1 corporate, Ф1 attachment) and their cards, what to do next, and the
 * «Недостаточно данных» card. Markers exist only for citations the server verified.
 */

const CONFIDENCE_ICON: Record<Confidence, IconName> = {
  supported: "check",
  partial: "alert",
  insufficient_evidence: "info",
};

/** Support level of an answer: a category with text and an icon, never a percentage. */
export function SupportBadge({ confidence }: { confidence: Confidence }) {
  return (
    <span className={`confidence confidence--${confidence}`}>
      <Icon name={CONFIDENCE_ICON[confidence]} size={14} strokeWidth={2} />
      {CONFIDENCE_LABEL[confidence]}
    </span>
  );
}

/** A Confluence page (external, read through MCP) as opposed to a team document. */
export function isExternal(citation: Citation): boolean {
  return citationGroup(citation) === "corporate";
}

/** Page version of a Confluence citation: the revision, or the last part of `confluence:<space>:<page>:<version>`. */
export function externalVersion(citation: Citation): string {
  return citation.revision || citation.source_id?.split(":").pop() || "—";
}

/** Where a citation opens: the document in the app at the cited section, else its row under «Источники». */
export function citationHref(citation: Citation, turnNo: number): string {
  return citation.app_path ?? `#cite-${turnNo}-${citation.ref}`;
}

/** The name of a source as the reader knows it: a file with the place in it, or the document's title. */
export function citationTitle(citation: Citation): string {
  if (citationGroup(citation) !== "attachment") return citation.title;
  const name = citation.attachment_name ?? citation.title;
  return citation.locator ? `${name}, ${citation.locator}` : name;
}

export const GROUP_LABEL: Record<CitationGroup, string> = {
  team: "Документы команды",
  corporate: "Корпоративные",
  attachment: "Вложение этого диалога",
};

/** Words of the question (stems of 4+ letters) — what the card highlights in the quote. */
function questionStems(question: string): string[] {
  const words = question.toLocaleLowerCase("ru").match(/[\p{L}\p{N}_]{4,}/gu) ?? [];
  return [...new Set(words.map((word) => (/^[\p{L}]+$/u.test(word) ? word.slice(0, 5) : word)))].slice(0, 12);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The quote with the question's words marked (search-style highlighting; the quote itself is verbatim). */
export function HighlightedQuote({ text, question }: { text: string; question: string }) {
  const stems = questionStems(question);
  if (stems.length === 0) return <>{text}</>;
  const pattern = new RegExp(`(${stems.map(escapeRegExp).join("|")})[\\p{L}\\p{N}_]*`, "giu");
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    const before = index === 0 ? "" : text[index - 1] ?? "";
    if (/[\p{L}\p{N}_]/u.test(before)) continue; // only whole words that start with a stem
    parts.push(text.slice(last, index));
    parts.push(<mark key={index}>{match[0]}</mark>);
    last = index + match[0].length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}

interface CitationMarkerProps {
  citation: Citation;
  /** «1», «К1», «Ф1» (lib/assistant.ts `citationLabels`). */
  label: string;
  turnNo: number;
  question: string;
}

/**
 * An inline marker. Hover or focus shows a card: number, source, status, the quote, section, scope and revision;
 * a click opens the document at the cited section (`section_anchor`), or the file's row under «Источники».
 */
export function CitationMarker({ citation, label, turnNo, question }: CitationMarkerProps) {
  const [open, setOpen] = useState(false);
  const [shift, setShift] = useState(0);
  const cardId = useId();
  const cardRef = useRef<HTMLSpanElement>(null);
  const group = citationGroup(citation);
  const href = citationHref(citation, turnNo);

  // Keep the card inside the window (a marker near the right edge on a phone).
  useLayoutEffect(() => {
    if (!open) {
      setShift(0);
      return;
    }
    const card = cardRef.current;
    if (!card) return;
    const rect = card.getBoundingClientRect();
    const width = document.documentElement.clientWidth;
    const margin = 12;
    let dx = 0;
    if (rect.right > width - margin) dx = width - margin - rect.right;
    if (rect.left + dx < margin) dx = margin - rect.left;
    setShift(dx);
  }, [open]);

  const meta: string[] = [];
  if (citation.section) meta.push(`Раздел «${citation.section}»`);
  if (group === "corporate") {
    meta.push(`Корпоративные · Confluence, версия ${externalVersion(citation)}`);
    if (citation.external_status !== "approved") meta.push("статус не подтверждён");
  } else {
    meta.push(GROUP_LABEL[group]);
  }
  if (group === "team") meta.push(`ред. ${shortRevision(citation.revision)}`);
  if (citation.is_demo && group !== "attachment") meta.push("демо");

  const card = (
    <span id={cardId} ref={cardRef} role="tooltip" className="cite-card" hidden={!open} style={shift ? { translate: `${shift}px 0` } : undefined}>
      <span className="cite-card__head">
        <span className={`cite-pill cite-pill--${group}`}>{label}</span>
        <span className="cite-card__title">{citationTitle(citation)}</span>
        {group === "attachment" ? <span className="cite-card__kind">Вложение</span> : <StatusMark status={citation.status} />}
      </span>
      <span className="cite-card__quote">
        «<HighlightedQuote text={citation.excerpt} question={question} />»
      </span>
      <span className="cite-card__meta">
        {meta.map((part) => (
          <span key={part}>{part}</span>
        ))}
      </span>
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
  const className = `cite-ref cite-ref--${group}`;
  const name = `Источник ${label}`;
  return (
    <span className="cite-marker">
      {href.startsWith("/") ? (
        <Link to={href} className={className} aria-label={name} aria-describedby={cardId} {...handlers}>
          {label}
        </Link>
      ) : (
        <a href={href} className={className} aria-label={name} aria-describedby={cardId} {...handlers}>
          {label}
        </a>
      )}
      {card}
    </span>
  );
}

interface TextProps {
  citations: Citation[];
  labels: Map<number, string>;
  turnNo: number;
  question: string;
}

/** A line of answer text with its «[n]» markers turned into citation markers (only for verified citations). */
function MarkedLine({ line, citations, labels, turnNo, question }: TextProps & { line: string }) {
  const byRef = new Map(citations.map((c) => [c.ref, c]));
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of line.matchAll(/\s?\[(\d{1,3})\]/g)) {
    const citation = byRef.get(Number(match[1]));
    const index = match.index ?? 0;
    parts.push(line.slice(last, index));
    parts.push(
      citation ? (
        <CitationMarker key={index} citation={citation} label={labels.get(citation.ref) ?? String(citation.ref)} turnNo={turnNo} question={question} />
      ) : (
        match[0]
      ),
    );
    last = index + match[0].length;
  }
  parts.push(line.slice(last));
  return <>{parts}</>;
}

/** The answer text: paragraphs, lines and citation markers. */
export function AnswerText({ text, ...props }: TextProps & { text: string }) {
  return (
    <div className="answer__text">
      {text.split(/\n{2,}/).map((paragraph, pIndex) => (
        <p key={pIndex}>
          {paragraph.split("\n").map((line, lIndex) => (
            <span key={lIndex} className="answer__line">
              <MarkedLine line={line} {...props} />
            </span>
          ))}
        </p>
      ))}
    </div>
  );
}

const DEMO_FILES_HEADER = /^Вложения этого диалога/;
const EXCLUDED_NOTE = /\n*^Исключены из доказательной базы по статусу: .*$/m;
const NOT_FOUND_NOTE = /\n*^В процитированных фрагментах не встречаются: (.*?)\.?$/m;

/**
 * Notes the server appends to an answer, shown where they belong instead of inside the text: the excluded
 * documents are the «N документов не использованы» line under «Источники»; the words of the question that no
 * quote contains are the amber «Нет подтверждения в источниках» line.
 */
export function splitServerNotes(answer: AskResponse): { text: string; notFound: string | null } {
  let text = answer.answer;
  if (answer.excluded_sources.length > 0) text = text.replace(EXCLUDED_NOTE, "");
  const match = NOT_FOUND_NOTE.exec(text);
  if (match) text = text.replace(NOT_FOUND_NOTE, "");
  return { text: text.trim(), notFound: match?.[1]?.trim() || null };
}

/**
 * What remains of a demo answer once its verbatim excerpts are shown under «Источники»: the demo provider's text
 * is a list of those same quotes, so repeating them here would duplicate every quote. Kept: lines that are not
 * a numbered quote of a verified citation, the demo prefix or the attachments header (e.g. «Недостаточно данных»
 * about the team documents next to quotes from a file).
 */
export function demoRemainder(answer: AskResponse): string[] {
  const known = new Set(answer.citations.map((c) => c.ref));
  return splitServerNotes(answer)
    .text.split("\n")
    .map((line) => line.trim())
    .filter((line) => {
      if (!line || line.startsWith("Демо-режим:") || DEMO_FILES_HEADER.test(line)) return false;
      const refs = [...line.matchAll(/\[(\d{1,3})\]/g)].map((m) => Number(m[1]));
      const quote = /^\d+\.\s*«/.test(line) && refs.length > 0 && refs.every((ref) => known.has(ref));
      return !quote;
    })
    .map((line) => line.replace(/^Документы базы знаний:\s*/, ""));
}

/** A demo answer: no model, no conclusions — which sources hold the quotes, and anything else the server said. */
export function DemoAnswerText({ answer, ...props }: TextProps & { answer: AskResponse }) {
  const rest = demoRemainder(answer);
  const groups: { group: CitationGroup; title: string }[] = [
    { group: "team", title: "документы команды" },
    { group: "corporate", title: "корпоративные страницы" },
    { group: "attachment", title: "вложения этого диалога" },
  ];
  const present = groups
    .map(({ group, title }) => ({ title, items: answer.citations.filter((c) => citationGroup(c) === group) }))
    .filter((entry) => entry.items.length > 0);
  return (
    <div className="answer__text">
      {present.length > 0 ? (
        <p>
          Без языковой модели ассистент не делает выводов: ниже, в «Источниках», — дословные выдержки.{" "}
          {present.map((entry, index) => (
            <span key={entry.title} className="answer__refs">
              {index > 0 ? "; " : ""}
              {entry.title.charAt(0).toLocaleUpperCase("ru") + entry.title.slice(1)}:
              {entry.items.map((citation) => (
                <CitationMarker
                  key={citation.ref}
                  citation={citation}
                  label={props.labels.get(citation.ref) ?? String(citation.ref)}
                  turnNo={props.turnNo}
                  question={props.question}
                />
              ))}
            </span>
          ))}
          .
        </p>
      ) : null}
      {rest.map((line, index) => (
        <p key={index}>
          <MarkedLine line={line} {...props} />
        </p>
      ))}
    </div>
  );
}

/** Plain text of the answer with its sources, for «Копировать с источниками». */
export function answerWithSources(answer: AskResponse, labels: Map<number, string>, demo: boolean): string {
  const relabel = (line: string) => line.replace(/\[(\d{1,3})\]/g, (whole, ref: string) => (labels.has(Number(ref)) ? `[${labels.get(Number(ref))}]` : whole));
  const body = demo ? demoRemainder(answer).map(relabel).join("\n") : relabel(splitServerNotes(answer).text);
  const sources = answer.citations.map((c) => {
    const label = labels.get(c.ref) ?? String(c.ref);
    const group = citationGroup(c);
    const where =
      group === "attachment"
        ? "вложение этого диалога"
        : group === "corporate"
          ? `Confluence, версия ${externalVersion(c)}`
          : `${c.document_id}${c.section ? `, раздел «${c.section}»` : ""}, ред. ${shortRevision(c.revision)}`;
    return `[${label}] ${citationTitle(c)} — ${where}\n«${c.excerpt}»`;
  });
  return [body.trim(), sources.length > 0 ? `Источники:\n${sources.join("\n")}` : ""].filter(Boolean).join("\n\n");
}

interface AnswerActionsProps {
  answer: AskResponse;
  question: string;
  labels: Map<number, string>;
  demo: boolean;
  /** A proposal card above carries the main action. */
  hasProposal: boolean;
  onRefine: (question: string) => void;
}

/**
 * What to do with an answer, one main action chosen by meaning: when the answer is only partly supported, a
 * change proposal for the cited team document (draft → diff → review, nothing applied); when it is supported,
 * opening that document. «Копировать с источниками» and «Уточнить вопрос» always.
 */
export function AnswerActions({ answer, question, labels, demo, hasProposal, onRefine }: AnswerActionsProps) {
  const noteId = useId();
  const [copied, setCopied] = useState<string>("");
  const team = answer.citations.find((c) => citationGroup(c) === "team" && c.app_path);
  const gap = answer.confidence === "partial" || answer.unmatched_terms.length > 0;
  const primary = hasProposal || !team ? null : gap ? "propose" : "open";
  const propose = team ? (
    <Link
      to={`/proposals/new?document=${encodeURIComponent(team.document_id)}`}
      className={buttonClass(primary === "propose" ? "primary" : "secondary")}
      aria-describedby={noteId}
    >
      Предложить правку
    </Link>
  ) : null;

  async function copy() {
    try {
      if (!navigator.clipboard) throw new Error("no clipboard");
      await navigator.clipboard.writeText(answerWithSources(answer, labels, demo));
      setCopied("Ответ скопирован вместе с источниками.");
    } catch {
      setCopied("Не удалось скопировать: буфер обмена недоступен.");
    }
  }

  return (
    <div className="answer__actions" role="group" aria-label="Что дальше">
      {primary === "propose" ? propose : null}
      {team?.app_path ? (
        <Link to={team.app_path} className={buttonClass(primary === "open" ? "primary" : "secondary")}>
          Открыть документ
        </Link>
      ) : null}
      {primary !== "propose" ? propose : null}
      {answer.citations.length > 0 ? (
        <button type="button" className={buttonClass("secondary")} onClick={() => void copy()}>
          Копировать с источниками
        </button>
      ) : null}
      <button type="button" className={buttonClass("quiet")} onClick={() => onRefine(question)}>
        Уточнить вопрос
      </button>
      {team ? (
        <p id={noteId} className="answer__actions-note">
          Правка — в документ «{team.title}»: черновик, diff и ревью; ответ ничего не меняет сам.
        </p>
      ) : null}
      <p className="answer__actions-note" role="status">
        {copied}
      </p>
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
  if ((request.attachment_ids ?? []).length > 0) parts.push("вложения этого диалога");
  return parts.join("; ");
}

/**
 * «Недостаточно данных» as a useful result: what and where was searched, the closest documents by the text
 * of the question (snippets, explicitly not evidence) and three next steps — refine, a SEPARATE labelled
 * corporate search, or a draft that documents the gap.
 */
export function InsufficientEvidence({ question, request, answer, corporateState, onRefine, onAskCorporate }: InsufficientEvidenceProps) {
  const headingId = useId();
  const probe = question.trim();
  const closest = useAsync(
    () => (probe.length >= 2 ? api.documents({ query: probe.slice(0, 200), size: 3 }) : Promise.resolve(null)),
    `closest:${probe}`,
  );
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
        {probe ? `Искали «${probe}» — ` : "Искали — "}
        {searchedWhere(request, answer)}.
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

      {probe.length >= 2 ? (
        <>
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
        </>
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
