import { useId, useLayoutEffect, useRef, useState, type MouseEvent, type RefObject } from "react";
import { Link } from "react-router-dom";
import type { AskResponse, DocStatus, SystemFact, SystemFactItem, ToolStepInfo } from "../api/types";
import { formatWhen, STATUS_LABEL, TEMPLATE_STATUS_LABEL } from "../lib/labels";
import { factItemOrigin, ORIGIN_GROUP_LABEL, showsSourceOrigins } from "../lib/provenance";
import {
  ATTENTION_REASON_LABEL,
  CHECK_OUTCOME_LABEL,
  factCardId,
  factSourceTitle,
  factValueText,
  filtersText,
  isProposalFact,
  proposalCardId,
} from "../lib/systemFacts";
import { OriginMark } from "./Provenance";
import { StatusMark } from "./ui/StatusMark";

/*
 * M5.7 (docs/AI_NATIVE_TOOLS.md «Evidence»): the system facts an AI-native answer relies on — «По данным реестра
 * SKH …» cards with the authoritative value from the server's observation, the filters really applied, the scope
 * and, quietly, the index generation and time. They are a block of their own, apart from «Источники»: a registry
 * number is not a document quote. `[F1]` in the text becomes a marker «С1» that leads to its card.
 */

const DOC_STATUSES = new Set<string>(["draft", "in_review", "approved", "deprecated"]);

/** `access_scope` is always the request's own visibility; said in words per source. */
const SCOPE_TEXT: Record<string, string> = {
  skh_document_registry: "доступный вам каталог",
  skh_knowledge_graph: "доступные вам документы",
  skh_template_registry: "реестр шаблонов",
  skh_ai_proposals: "ваше предложение",
};
const ITEMS_SHOWN = 8;

/** Keeps a floating card inside the window (a marker near the right edge on a phone). */
export function useFitInWindow(open: boolean, ref: RefObject<HTMLElement | null>): number {
  const [shift, setShift] = useState(0);
  useLayoutEffect(() => {
    if (!open) {
      setShift(0);
      return;
    }
    const card = ref.current;
    if (!card) return;
    const rect = card.getBoundingClientRect();
    const width = document.documentElement.clientWidth;
    const margin = 12;
    let dx = 0;
    if (rect.right > width - margin) dx = width - margin - rect.right;
    if (rect.left + dx < margin) dx = margin - rect.left;
    setShift(dx);
  }, [open, ref]);
  return shift;
}

/** Moves focus to a card of this answer (it scrolls above the pinned field: `scroll-padding-bottom`). */
function focusCard(event: MouseEvent<HTMLAnchorElement>, id: string) {
  const target = document.getElementById(id);
  if (!target) return;
  event.preventDefault();
  target.focus();
}

interface FactMarkerProps {
  fact: SystemFact;
  /** «С1». */
  label: string;
  turnNo: number;
  /** The answer has a proposal card: a proposal fact leads there. */
  hasProposal: boolean;
}

/** `[F1]` in the text: a marker of system data. Hover or focus shows what it stands for; a click goes to its card. */
export function FactMarker({ fact, label, turnNo, hasProposal }: FactMarkerProps) {
  const [open, setOpen] = useState(false);
  const cardId = useId();
  const cardRef = useRef<HTMLSpanElement>(null);
  const shift = useFitInWindow(open, cardRef);
  const target = fact.source === "skh_ai_proposals" && hasProposal ? proposalCardId(turnNo) : factCardId(turnNo, fact.ref);
  const value = factValueText(fact);
  const filters = filtersText(fact);
  return (
    <span className="cite-marker">
      <a
        href={`#${target}`}
        className="fact-ref"
        aria-label={`Данные системы ${label}`}
        aria-describedby={cardId}
        onClick={(event) => focusCard(event, target)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
      >
        {label}
      </a>
      <span id={cardId} ref={cardRef} role="tooltip" className="cite-card" hidden={!open} style={shift ? { translate: `${shift}px 0` } : undefined}>
        <span className="cite-card__head">
          <span className="fact-pill">{label}</span>
          <span className="cite-card__title">{factSourceTitle(fact)}</span>
        </span>
        <span className="fact-tip__value">
          {fact.label}
          {value ? `: ${value}` : ""}
        </span>
        {filters ? <span className="cite-card__meta">{filters}</span> : null}
      </span>
    </span>
  );
}

function ItemStatus({ item }: { item: SystemFactItem }) {
  if (!item.status) return null;
  if (item.kind === "template") {
    return <span className="fact-item__kind">{TEMPLATE_STATUS_LABEL[item.status] ?? item.status}</span>;
  }
  if (DOC_STATUSES.has(item.status)) return <StatusMark status={item.status as DocStatus} />;
  return <span className="fact-item__kind">{STATUS_LABEL[item.status as DocStatus] ?? item.status}</span>;
}

/** `origins`: the answer's sources differ in origin, so each listed document names its own (lib/provenance.ts). */
function FactItems({ fact, compact, origins }: { fact: SystemFact; compact: boolean; origins: boolean }) {
  const [all, setAll] = useState(false);
  const listId = useId();
  const items = fact.items;
  if (items.length === 0) return null;
  const limit = compact ? 5 : ITEMS_SHOWN;
  const shown = all ? items : items.slice(0, limit);
  const hidden = items.length - shown.length;
  return (
    <>
      <ul id={listId} className="fact__items" aria-label={`Объекты: ${fact.label}`}>
        {shown.map((item) => {
          const origin = origins ? factItemOrigin(item) : null;
          return (
            <li key={`${item.kind}:${item.id}`} className="fact-item">
              <span className="fact-item__head">
                {item.app_path ? (
                  <Link to={item.app_path} className="fact-item__title">
                    {item.title}
                  </Link>
                ) : (
                  <span className="fact-item__title">{item.title}</span>
                )}
                <span className="fact-item__id">{item.id}</span>
                <ItemStatus item={item} />
                {origin ? <OriginMark origin={origin} /> : null}
              </span>
              {item.detail ? <span className="fact-item__detail">{item.detail}</span> : null}
            </li>
          );
        })}
      </ul>
      {hidden > 0 || all ? (
        <button type="button" className="link-button fact__toggle" aria-expanded={all} aria-controls={listId} onClick={() => setAll((v) => !v)}>
          {all ? "Свернуть список" : `Показать ещё ${hidden}`}
        </button>
      ) : null}
    </>
  );
}

/** «Показаны первые 5 из 83»: the list is a page, the number above is the full total. */
function truncatedNote(fact: SystemFact): string | null {
  if (!fact.truncated) return null;
  if (fact.value !== null && fact.value > fact.items.length) return `Показаны первые ${fact.items.length} из ${fact.value.toLocaleString("ru-RU")}.`;
  return `Показаны первые ${fact.items.length} — есть ещё.`;
}

const BREAKDOWN_TITLE: Record<string, string> = {
  status: "По статусу",
  type: "По типу",
  owner: "По владельцу",
  tag: "По тегам",
  attention: "По причинам",
  provenance: "По происхождению",
};

function breakdownName(key: string, name: string): string {
  if (key === "status") return (STATUS_LABEL[name as DocStatus] ?? name).toLocaleLowerCase("ru");
  if (key === "attention") return ATTENTION_REASON_LABEL[name] ?? name;
  // «синтетические 83 · без пометки 2»: the server's keys are not words (and never «реальные»).
  if (key === "provenance") return ORIGIN_GROUP_LABEL[name as keyof typeof ORIGIN_GROUP_LABEL] ?? name;
  return name;
}

function Breakdown({ fact }: { fact: SystemFact }) {
  if (!fact.breakdown) return null;
  const rows = Object.entries(fact.breakdown).filter(([, counts]) => Object.keys(counts).length > 0);
  if (rows.length === 0) return null;
  return (
    <dl className="fact__breakdown">
      {rows.map(([key, counts]) => (
        <div key={key}>
          <dt>{BREAKDOWN_TITLE[key] ?? key}</dt>
          <dd>
            {Object.entries(counts)
              .map(([name, n]) => `${breakdownName(key, name)} ${n.toLocaleString("ru-RU")}`)
              .join(" · ")}
          </dd>
        </div>
      ))}
    </dl>
  );
}

interface FactCardProps {
  fact: SystemFact;
  label: string;
  turnNo: number;
  compact: boolean;
  origins: boolean;
}

function FactCard({ fact, label, turnNo, compact, origins }: FactCardProps) {
  const value = factValueText(fact);
  const filters = filtersText(fact);
  const when = formatWhen(fact.as_of);
  const zero = fact.value === 0;
  return (
    <li id={factCardId(turnNo, fact.ref)} className="fact" tabIndex={-1}>
      <span className="fact-pill" aria-hidden="true">
        {label}
      </span>
      <div className="fact__body">
        <p className="fact__source">
          <span className="visually-hidden">{label}. </span>
          {factSourceTitle(fact)} — <span className="fact__label">{fact.label}</span>
        </p>
        {value ? <p className="fact__value">{value}</p> : null}
        {zero ? <p className="fact__zero">Нет совпадений в этой области — это ноль, а не ошибка проверки.</p> : null}
        {filters ? <p className="fact__filters">{filters}</p> : null}
        {fact.definition && !compact ? <p className="fact__definition">{fact.definition}</p> : null}
        <Breakdown fact={fact} />
        <FactItems fact={fact} compact={compact} origins={origins} />
        {truncatedNote(fact) ? <p className="fact__more">{truncatedNote(fact)}</p> : null}
        <p className="fact__meta">
          <span>Область: {SCOPE_TEXT[fact.source] ?? "доступное вам"}</span>
          {fact.generation ? <span>срез {fact.generation}</span> : null}
          <span>
            <time dateTime={fact.as_of} title={when.full}>
              {when.text}
            </time>
          </span>
        </p>
      </div>
    </li>
  );
}

interface SystemFactsProps {
  answer: AskResponse;
  labels: Map<string, string>;
  turnNo: number;
  compact?: boolean;
}

/** «Данные системы SKH»: the facts of one answer (a proposal fact is the proposal card below). */
export function SystemFacts({ answer, labels, turnNo, compact = false }: SystemFactsProps) {
  const facts = (answer.system_facts ?? []).filter((fact) => !isProposalFact(fact, answer));
  if (facts.length === 0) return null;
  const headingId = `facts-title-${turnNo}`;
  const Title = compact ? "h4" : "h3";
  const origins = showsSourceOrigins(answer);
  return (
    <section className={`facts${compact ? " facts--compact" : ""}`} aria-labelledby={headingId}>
      <Title id={headingId} className="facts__title">
        Данные системы SKH
      </Title>
      <p className="facts__note">Значения посчитаны сервером SKH в момент ответа по доступным вам данным — это не цитата из документа.</p>
      <ol className="facts__list">
        {facts.map((fact) => (
          <FactCard key={fact.ref} fact={fact} label={labels.get(fact.ref) ?? fact.ref} turnNo={turnNo} compact={compact} origins={origins} />
        ))}
      </ol>
    </section>
  );
}

/** What could not be checked for an answer that otherwise stands: each with its own outcome and the server's text. */
export function FailedChecks({ steps }: { steps: ToolStepInfo[] }) {
  if (steps.length === 0) return null;
  return (
    <ul className="checks" aria-label="Что не удалось проверить">
      {steps.map((step) => (
        <li key={step.call_id} className={`checks__item checks__item--${step.outcome}`} data-outcome={step.outcome}>
          <span className="checks__outcome">{step.outcome === "ok" ? "" : CHECK_OUTCOME_LABEL[step.outcome]}.</span> {step.message}
        </li>
      ))}
    </ul>
  );
}

/**
 * The answer could not be confirmed and the system checks did not work out: say what could not be checked —
 * never «В базе знаний нет ответа» with lexical near matches for a metric that simply was not available.
 */
export function ChecksInsufficient({ steps, question, compact, onRefine }: { steps: ToolStepInfo[]; question: string; compact: boolean; onRefine: (question: string) => void }) {
  const headingId = useId();
  const Heading = compact ? "h4" : "h3";
  return (
    <section className={`insufficient insufficient--checks${compact ? " insufficient--compact" : ""}`} aria-labelledby={headingId}>
      <Heading id={headingId}>Не удалось проверить данные системы</Heading>
      <p>
        <strong>Ассистент не называет чисел и фактов, которые не смог проверить.</strong> Это не значит, что таких
        документов нет.
      </p>
      <FailedChecks steps={steps} />
      {question ? (
        <button type="button" className="button button--secondary" onClick={() => onRefine(question)}>
          Уточнить вопрос
        </button>
      ) : null}
    </section>
  );
}
