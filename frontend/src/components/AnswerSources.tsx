import { useId, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError, api } from "../api/client";
import type { AskResponse, Citation, DiscoveryVerdict, DocStatus, ExcludedSource } from "../api/types";
import { citationGroup, type CitationGroup } from "../lib/assistant";
import { pluralRu, shortRevision, SOURCE_LABEL } from "../lib/labels";
import { citationTitle, externalVersion } from "./AnswerParts";
import { buttonClass } from "./ui/Button";
import { StatusMark } from "./ui/StatusMark";

/*
 * «Источники» under an answer (docs/ui-v2/specs/02_ASSISTANT.md §2, design-03): one block, three groups that are
 * never mixed — «Документы команды», «Корпоративные», «Вложения этого диалога». Each row: the marker, the source,
 * its status, the quote. Documents that matched but may not answer (drafts, deprecated) are folded into one line.
 */

function toApiError(err: unknown): ApiError {
  return err instanceof ApiError ? err : new ApiError(0, "client_error", String(err), null);
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
    <div className="source__feedback" role="group" aria-label={`Оценка источника «${title}»`}>
      <span className="source__feedback-label">Источник подошёл?</span>
      <button
        type="button"
        className={buttonClass("secondary", "sm", "toggle-button")}
        aria-pressed={verdict === "relevant"}
        disabled={pending !== null}
        onClick={() => void rate("relevant")}
      >
        Подошёл
      </button>
      <button
        type="button"
        className={buttonClass("secondary", "sm", "toggle-button")}
        aria-pressed={verdict === "irrelevant"}
        disabled={pending !== null}
        onClick={() => void rate("irrelevant")}
      >
        Не подошёл
      </button>
      <button type="button" className={buttonClass("quiet", "sm")} disabled={pending !== null} onClick={() => void propose()}>
        {pending === "propose" ? "Создаём черновик…" : "Предложить в базу"}
      </button>
      <p className={`source__note${note?.error ? " source__note--error" : ""}`} role="status">
        {note?.text ?? ""}
      </p>
    </div>
  );
}

function SourceTitle({ citation }: { citation: Citation }) {
  const title = citationTitle(citation);
  if (citation.app_path) {
    return (
      <Link to={citation.app_path} className="source__title">
        {title}
      </Link>
    );
  }
  if (citation.source_uri.startsWith("https://")) {
    // Server-validated link to the authorized source (allowlisted host only).
    return (
      <a href={citation.source_uri} className="source__title" target="_blank" rel="noopener noreferrer nofollow">
        {title}
      </a>
    );
  }
  return <span className="source__title">{title}</span>;
}

interface SourceRowProps {
  citation: Citation;
  label: string;
  turnNo: number;
  /** Trace of the answer: feedback controls for the first citation of each Confluence page. */
  actionsTrace: string | null;
  /** The document panel: the section only (the revision and the store are on the document itself). */
  compact: boolean;
}

function SourceRow({ citation, label, turnNo, actionsTrace, compact }: SourceRowProps) {
  const group = citationGroup(citation);
  const meta: string[] = [];
  if (group === "team" && compact) {
    if (citation.section) meta.push(`раздел «${citation.section}»`);
  } else if (group === "team") {
    meta.push(citation.document_id);
    if (citation.section) meta.push(`раздел «${citation.section}»`);
    meta.push(`ред. ${shortRevision(citation.revision)}`);
    meta.push(SOURCE_LABEL[citation.source_type]);
  } else if (group === "corporate") {
    meta.push(`Confluence · версия ${externalVersion(citation)}`);
    if (citation.section) meta.push(`раздел «${citation.section}»`);
  }
  return (
    <li id={`cite-${turnNo}-${citation.ref}`} className="source">
      <span className={`cite-pill cite-pill--${group}`}>
        <span className="visually-hidden">Источник </span>
        {label}
      </span>
      <div className="source__body">
        <div className="source__head">
          <SourceTitle citation={citation} />
          {group === "attachment" ? (
            <span className="source__kind">Вложение</span>
          ) : group === "corporate" && citation.external_status !== "approved" ? (
            <span className="source__kind source__kind--unconfirmed">статус не подтверждён</span>
          ) : (
            <StatusMark status={citation.status} />
          )}
        </div>
        <q className="source__quote">{citation.excerpt}</q>
        {meta.length > 0 ? (
          <p className="source__meta">
            {meta.map((part) => (
              <span key={part}>{part}</span>
            ))}
            {citation.is_demo && group !== "attachment" ? <span>демо</span> : null}
          </p>
        ) : null}
        {group === "corporate" && actionsTrace && citation.source_id ? (
          <ExternalSourceActions traceId={actionsTrace} sourceId={citation.source_id} title={citation.title} />
        ) : null}
      </div>
    </li>
  );
}

const GROUPS: { group: CitationGroup; title: string; note?: string }[] = [
  { group: "team", title: "Документы команды" },
  {
    group: "corporate",
    title: "Корпоративные",
    note: "Страницы Confluence: статус и версия — как указаны на странице; это не утверждённые документы команды.",
  },
  { group: "attachment", title: "Вложения этого диалога", note: "Файл виден только в этом диалоге и не попадает в базу знаний." },
];

const EXCLUDED_KIND: Record<DocStatus, [string, string]> = {
  draft: ["черновик", "черновики"],
  in_review: ["на ревью", "на ревью"],
  deprecated: ["устаревший", "устаревшие"],
  approved: ["утверждённый", "утверждённые"],
};

/** «5 документов не использованы: черновики и устаревшие». */
export function excludedSummary(excluded: ExcludedSource[]): string {
  const n = excluded.length;
  const kinds = (["draft", "in_review", "deprecated", "approved"] as DocStatus[])
    .map((status) => {
      const count = excluded.filter((item) => item.status === status).length;
      // A category word: singular only when it is the one excluded document.
      return count === 0 ? null : EXCLUDED_KIND[status][n === 1 ? 0 : 1];
    })
    .filter((kind): kind is string => kind !== null);
  const verb = n % 10 === 1 && n % 100 !== 11 ? "не использован" : "не использованы";
  const list = kinds.length > 1 ? `${kinds.slice(0, -1).join(", ")} и ${kinds[kinds.length - 1]}` : (kinds[0] ?? "");
  return `${n} ${pluralRu(n, "документ", "документа", "документов")} ${verb}${list ? `: ${list}` : ""}`;
}

function ExcludedLine({ excluded, open, listId, onToggle }: { excluded: ExcludedSource[]; open: boolean; listId: string; onToggle: () => void }) {
  return (
    <p className="excluded__line">
      <span>{excludedSummary(excluded)}.</span>{" "}
      <button type="button" className="excluded__toggle" aria-expanded={open} aria-controls={listId} onClick={onToggle}>
        {open ? "Скрыть" : "Показать"}
      </button>
    </p>
  );
}

function ExcludedList({ excluded, open, id }: { excluded: ExcludedSource[]; open: boolean; id: string }) {
  return (
    <ul id={id} className="excluded__list" hidden={!open} aria-label="Не использованы как доказательство">
      {excluded.map((source) => (
        <li key={source.document_id}>
          <Link to={`/documents/${encodeURIComponent(source.document_id)}`}>{source.title}</Link>{" "}
          <StatusMark status={source.status} />
          <span className="excluded__reason"> {source.reason}</span>
        </li>
      ))}
    </ul>
  );
}

interface AnswerSourcesProps {
  answer: AskResponse;
  labels: Map<number, string>;
  turnNo: number;
  /** The document panel: compact rows and one heading level deeper (the answer there is an h3). */
  compact?: boolean;
}

export function AnswerSources({ answer, labels, turnNo, compact = false }: AnswerSourcesProps) {
  const headingId = `sources-title-${turnNo}`;
  const excludedId = useId();
  const [excludedOpen, setExcludedOpen] = useState(false);
  const excluded = answer.excluded_sources;
  const toggle = () => setExcludedOpen((value) => !value);
  const traceId = answer.retrieval_trace_id ?? null;
  // Several citations may quote one Confluence page: its feedback controls appear once, at the first of them.
  const withActions = new Set<number>();
  const seen = new Set<string>();
  for (const citation of answer.citations) {
    if (citationGroup(citation) === "corporate" && citation.source_id && !seen.has(citation.source_id)) {
      seen.add(citation.source_id);
      withActions.add(citation.ref);
    }
  }
  if (answer.citations.length === 0) {
    return excluded.length > 0 ? (
      <div className="excluded excluded--standalone">
        <ExcludedLine excluded={excluded} open={excludedOpen} listId={excludedId} onToggle={toggle} />
        <ExcludedList excluded={excluded} open={excludedOpen} id={excludedId} />
      </div>
    ) : null;
  }
  const Title = compact ? "h4" : "h3";
  const GroupTitle = compact ? "h5" : "h4";
  return (
    <section className={`sources${compact ? " sources--compact" : ""}`} aria-labelledby={headingId}>
      <div className="sources__head">
        <Title id={headingId}>Источники</Title>
        {excluded.length > 0 ? <ExcludedLine excluded={excluded} open={excludedOpen} listId={excludedId} onToggle={toggle} /> : null}
      </div>
      {excluded.length > 0 ? <ExcludedList excluded={excluded} open={excludedOpen} id={excludedId} /> : null}
      {GROUPS.map(({ group, title, note }) => {
        const items = answer.citations.filter((c) => citationGroup(c) === group);
        if (items.length === 0) return null;
        const groupId = `${group}-sources-${turnNo}`;
        return (
          <section key={group} className={`sources__group sources__group--${group}`} aria-labelledby={groupId}>
            <GroupTitle id={groupId} className="sources__title">
              {title}
            </GroupTitle>
            <ol className="sources__list">
              {items.map((citation) => (
                <SourceRow
                  key={citation.ref}
                  citation={citation}
                  label={labels.get(citation.ref) ?? String(citation.ref)}
                  turnNo={turnNo}
                  actionsTrace={withActions.has(citation.ref) ? traceId : null}
                  compact={compact}
                />
              ))}
            </ol>
            {note ? <p className="sources__note">{note}</p> : null}
          </section>
        );
      })}
    </section>
  );
}
