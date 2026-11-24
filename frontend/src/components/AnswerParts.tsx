import { useId, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { AskRequest, AskResponse, Citation, Confidence, IntegrationState, ProvenanceOrigin, SystemFact } from "../api/types";
import { answerPlainText } from "../lib/answerMarkdown";
import { citationGroup, type CitationGroup } from "../lib/assistant";
import { CONFIDENCE_LABEL, shortRevision } from "../lib/labels";
import { citationOrigin, ORIGIN_LABEL, provenanceCopyLine, showsSourceOrigins } from "../lib/provenance";
import { factLabels, factPlainText } from "../lib/systemFacts";
import { useAsync } from "../lib/useAsync";
import { AnswerMarkdown, type AnswerMarkers } from "./AnswerMarkdown";
import { CardExcerpt, excerptText } from "./CitationExcerpt";
import { Highlighted } from "./Highlighted";
import { OriginMark } from "./Provenance";
import { StatusStamp } from "./StatusStamp";
import { FactMarker, useFitInWindow } from "./SystemFacts";
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

interface CitationMarkerProps {
  citation: Citation;
  /** «1», «К1», «Ф1» (lib/assistant.ts `citationLabels`). */
  label: string;
  turnNo: number;
  question: string;
  /** The source's origin when the answer's sources differ (lib/provenance.ts `showsSourceOrigins`); else none. */
  origin?: ProvenanceOrigin | null;
}

/**
 * An inline marker. Hover or focus shows a card: number, source, status, the quote, section, scope and revision;
 * a click opens the document at the cited section (`section_anchor`), or the file's row under «Источники».
 */
export function CitationMarker({ citation, label, turnNo, question, origin = null }: CitationMarkerProps) {
  const [open, setOpen] = useState(false);
  const cardId = useId();
  const cardRef = useRef<HTMLSpanElement>(null);
  const group = citationGroup(citation);
  const href = citationHref(citation, turnNo);
  // Keep the card inside the window (a marker near the right edge on a phone).
  const shift = useFitInWindow(open, cardRef);

  const meta: string[] = [];
  if (citation.section) meta.push(`Раздел «${citation.section}»`);
  if (group === "corporate") {
    meta.push(`Корпоративные · Confluence, версия ${externalVersion(citation)}`);
    if (citation.external_status !== "approved") meta.push("статус не подтверждён");
  } else {
    meta.push(GROUP_LABEL[group]);
  }
  if (group === "team") meta.push(`ред. ${shortRevision(citation.revision)}`);

  const card = (
    <span id={cardId} ref={cardRef} role="tooltip" className="cite-card" hidden={!open} style={shift ? { translate: `${shift}px 0` } : undefined}>
      <span className="cite-card__head">
        <span className={`cite-pill cite-pill--${group}`}>{label}</span>
        <span className="cite-card__title">{citationTitle(citation)}</span>
        {group === "attachment" ? <span className="cite-card__kind">Вложение</span> : <StatusMark status={citation.status} />}
      </span>
      <CardExcerpt citation={citation} question={question} />
      <span className="cite-card__meta">
        {meta.map((part) => (
          <span key={part}>{part}</span>
        ))}
        {origin ? <OriginMark origin={origin} /> : null}
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

/** M5.7: the system facts of an answer — `[F1]` markers in its text become «С1» markers leading to their cards. */
export interface FactRefs {
  facts: SystemFact[];
  /** «F1» → «С1» (lib/systemFacts.ts `factLabels`). */
  labels: Map<string, string>;
  /** The answer shows a proposal card: a proposal fact's marker leads there. */
  hasProposal: boolean;
}

export const NO_FACTS: FactRefs = { facts: [], labels: new Map(), hasProposal: false };

export function factRefsOf(answer: AskResponse): FactRefs {
  const facts = answer.system_facts ?? [];
  return { facts, labels: factLabels(facts), hasProposal: Boolean(answer.proposal) };
}

interface TextProps {
  citations: Citation[];
  labels: Map<number, string>;
  turnNo: number;
  question: string;
  facts?: FactRefs;
  /** The document panel: its answer heading is an h3, so Markdown headings start one level lower. */
  compact?: boolean;
  /** The answer's sources differ in origin: each citation card names its own (lib/provenance.ts). */
  origins?: boolean;
}

/**
 * The markers of a validated answer: `[n]` becomes a citation marker only for a citation the server verified,
 * `[F1]` a marker of system data only for a fact the server produced (lib/answerMarkdown.ts finds them in the
 * Markdown text nodes; code, link text and URLs are never searched).
 */
function useMarkers({ citations, labels, turnNo, question, facts = NO_FACTS, origins = false }: TextProps): AnswerMarkers {
  return useMemo(() => {
    const byRef = new Map(citations.map((c) => [c.ref, c]));
    const factByRef = new Map(facts.facts.map((f) => [f.ref, f]));
    return {
      known: { citations: new Set(byRef.keys()), facts: new Set(factByRef.keys()) },
      render: (kind, ref) => {
        if (kind === "fact") {
          const fact = factByRef.get(ref);
          return fact ? <FactMarker fact={fact} label={facts.labels.get(ref) ?? ref} turnNo={turnNo} hasProposal={facts.hasProposal} /> : null;
        }
        const citation = byRef.get(Number(ref));
        return citation ? (
          <CitationMarker
            citation={citation}
            label={labels.get(citation.ref) ?? String(citation.ref)}
            turnNo={turnNo}
            question={question}
            origin={origins ? citationOrigin(citation) : null}
          />
        ) : null;
      },
    };
  }, [citations, labels, turnNo, question, facts, origins]);
}

/** The answer text: Markdown with citation and system-data markers (components/AnswerMarkdown.tsx). */
export function AnswerText({ text, ...props }: TextProps & { text: string }) {
  const markers = useMarkers(props);
  return (
    <div className="answer__text answer-md">
      <AnswerMarkdown text={text} markers={markers} headingLevel={props.compact ? 3 : 2} />
    </div>
  );
}

const DEMO_FILES_HEADER = /^Вложения этого диалога/;
const EXCLUDED_NOTE = /\n*^Исключены из доказательной базы по статусу: .*$/m;
const NOT_FOUND_NOTE = /\n*^В процитированных фрагментах не встречаются: (.*?)\.?$/m;

/**
 * Notes the server appends to an answer, shown where they belong instead of inside the text: the excluded
 * documents are the «N документов не использованы» line under «Источники»; the words of the question that no
 * quote contains are the amber «Не найдено в документах» line (the server never lists function words there).
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
  const markers = useMarkers(props);
  const groups: { group: CitationGroup; title: string }[] = [
    { group: "team", title: "документы команды" },
    { group: "corporate", title: "корпоративные страницы" },
    { group: "attachment", title: "вложения этого диалога" },
  ];
  const present = groups
    .map(({ group, title }) => ({ title, items: answer.citations.filter((c) => citationGroup(c) === group) }))
    .filter((entry) => entry.items.length > 0);
  return (
    <div className="answer__text answer-md">
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
                  origin={props.origins ? citationOrigin(citation) : null}
                />
              ))}
            </span>
          ))}
          .
        </p>
      ) : null}
      {rest.length > 0 ? <AnswerMarkdown text={rest.join("\n\n")} markers={markers} headingLevel={props.compact ? 3 : 2} /> : null}
    </div>
  );
}

/** Plain text of the answer with its sources, for «Копировать с источниками»: readable text, not Markdown syntax. */
export function answerWithSources(answer: AskResponse, labels: Map<number, string>, demo: boolean): string {
  const facts = answer.system_facts ?? [];
  const factLabel = factLabels(facts);
  const known = { citations: new Set(answer.citations.map((c) => c.ref)), facts: new Set(facts.map((f) => f.ref)) };
  const markdown = demo ? demoRemainder(answer).join("\n\n") : splitServerNotes(answer).text;
  const body = answerPlainText(markdown, known, { citation: (ref) => labels.get(ref), fact: (ref) => factLabel.get(ref) });
  const origins = showsSourceOrigins(answer);
  const sources = answer.citations.map((c) => {
    const label = labels.get(c.ref) ?? String(c.ref);
    const group = citationGroup(c);
    const where =
      group === "attachment"
        ? "вложение этого диалога"
        : group === "corporate"
          ? `Confluence, версия ${externalVersion(c)}`
          : `${c.document_id}${c.section ? `, раздел «${c.section}»` : ""}, ред. ${shortRevision(c.revision)}`;
    const origin = origins ? ` · ${ORIGIN_LABEL[citationOrigin(c)]}` : "";
    return `[${label}] ${citationTitle(c)} — ${where}${origin}\n«${excerptText(c)}»`;
  });
  const system = facts.map((fact) => factPlainText(fact, factLabel.get(fact.ref) ?? fact.ref));
  // Copied text leaves the app: where its sources come from goes with it (a quiet line on screen, said here in words).
  const provenance = provenanceCopyLine(answer.provenance);
  return [
    body.trim(),
    system.length > 0 ? `Данные системы SKH:\n${system.join("\n")}` : "",
    sources.length > 0 ? `Источники:\n${sources.join("\n")}` : "",
    provenance ?? "",
  ]
    .filter(Boolean)
    .join("\n\n");
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
      {answer.citations.length > 0 || (answer.system_facts ?? []).length > 0 ? (
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
