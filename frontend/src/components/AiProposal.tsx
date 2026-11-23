import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ApiError, api, isCancelled } from "../api/client";
import type { AiEvidence, AiProposal, AiProposalItem, AiProposalRequest, DocStatus } from "../api/types";
import {
  AI_ERROR_TITLE,
  AI_PROPOSAL_ERROR_TITLE,
  AI_PROPOSAL_KIND_LABEL,
  AI_PROPOSAL_STATUS_LABEL,
  METADATA_FIELD_LABEL,
  shortRevision,
  STATUS_LABEL,
} from "../lib/labels";
import { AI_MODE_LABEL } from "./AiSourcesPanel";
import { ErrorState, Notice } from "./Feedback";
import { StatusStamp } from "./StatusStamp";

const isDocStatus = (value: string): value is DocStatus => value in STATUS_LABEL;

function toApiError(err: unknown): ApiError {
  return err instanceof ApiError ? err : new ApiError(0, "client_error", String(err), null);
}

function asList(value: unknown): string[] | null {
  return Array.isArray(value) ? value.map((v) => String(v)) : null;
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Title of one proposal item, also the accessible name of its checkbox. */
export function itemTitle(item: AiProposalItem): string {
  switch (item.kind) {
    case "metadata":
      return `Поле «${METADATA_FIELD_LABEL[item.field ?? ""] ?? item.field ?? "?"}»`;
    case "section":
      return item.current === null || item.current === undefined
        ? `Добавить раздел «${item.section ?? ""}»`
        : `Раздел «${item.section ?? ""}»`;
    case "link":
      return `Ссылка на ${item.target_id ?? "документ"}`;
    case "template":
      return "Шаблон";
    case "draft":
      return "Черновик документа";
    case "task":
      return `Проверить ${item.target_id ?? "документ"}`;
    default:
      if (item.field) return `Поле «${METADATA_FIELD_LABEL[item.field] ?? item.field}»`;
      if (item.section) return `Раздел «${item.section}»`;
      return "Примечание";
  }
}

// --- field-level diff -----------------------------------------------------------------------------------

function ListDiff({ current, proposed, ids }: { current: string[]; proposed: string[]; ids: boolean }) {
  const before = new Set(current);
  const after = new Set(proposed);
  const rows = [
    ...proposed.map((v) => ({ value: v, state: before.has(v) ? "kept" : "added" })),
    ...current.filter((v) => !after.has(v)).map((v) => ({ value: v, state: "removed" })),
  ];
  if (rows.length === 0) return <p className="muted">Пусто.</p>;
  return (
    <ul className="ai-diff-list" aria-label="Изменение списка">
      {rows.map((row) => (
        <li key={`${row.state}-${row.value}`} className={`ai-diff-list__item ai-diff-list__item--${row.state}`}>
          <span className="ai-diff-list__sign" aria-hidden="true">
            {row.state === "added" ? "+" : row.state === "removed" ? "−" : "·"}
          </span>
          <span className="visually-hidden">
            {row.state === "added" ? "добавится: " : row.state === "removed" ? "уберётся: " : "останется: "}
          </span>
          {ids && row.state !== "removed" ? (
            <Link to={`/documents/${encodeURIComponent(row.value)}`} className="doc-id">
              {row.value}
            </Link>
          ) : (
            <span className={ids ? "doc-id" : undefined}>{row.value}</span>
          )}
          {row.state === "added" && ids ? <span className="suggested-badge">предложено</span> : null}
        </li>
      ))}
    </ul>
  );
}

function TextDiff({ current, proposed, newSection = false }: { current: string; proposed: string; newSection?: boolean }) {
  return (
    <div className="ai-diff">
      <div className="ai-diff__side ai-diff__side--before">
        <p className="ai-diff__label">{newSection ? "Сейчас" : "Было"}</p>
        {current.trim() ? <pre className="ai-diff__text">{current}</pre> : <p className="muted">{newSection ? "Раздела нет." : "Не задано."}</p>}
      </div>
      <div className="ai-diff__side ai-diff__side--after">
        <p className="ai-diff__label">{newSection ? "Добавится" : "Станет"}</p>
        {proposed.trim() ? <pre className="ai-diff__text">{proposed}</pre> : <p className="muted">Пусто.</p>}
      </div>
    </div>
  );
}

function ItemBody({ item }: { item: AiProposalItem }) {
  if (item.kind === "metadata") {
    const current = asList(item.current);
    const proposed = asList(item.proposed);
    if (proposed) return <ListDiff current={current ?? []} proposed={proposed} ids={item.field === "related_ids"} />;
    return <TextDiff current={asText(item.current)} proposed={asText(item.proposed)} />;
  }
  if (item.kind === "section") {
    return <TextDiff current={asText(item.current)} proposed={asText(item.proposed)} newSection={item.current == null} />;
  }
  if (item.kind === "link") {
    return (
      <p className="ai-link-line">
        <span className="ai-link ai-link--suggested">{asText(item.proposed)}</span>
        <span className="suggested-badge">предложено</span>
        <span className="muted">
          {" "}
          — ссылка-упоминание (references), не бизнес-зависимость; добавится в раздел связанных документов.
        </span>
      </p>
    );
  }
  if (item.kind === "template") {
    const proposed = asRecord(item.proposed);
    const alternatives = Array.isArray(asRecord(item.current).alternatives)
      ? (asRecord(item.current).alternatives as unknown[]).map(asRecord)
      : [];
    const id = asText(proposed.template_id);
    return (
      <div className="ai-template">
        <p>
          <Link to={`/templates/${encodeURIComponent(id)}`}>{asText(proposed.title) || id}</Link>{" "}
          <span className="version-badge">v{asText(proposed.version)}</span>
        </p>
        {alternatives.length > 0 ? (
          <p className="muted">
            Другие подходящие:{" "}
            {alternatives.map((a, i) => (
              <span key={asText(a.template_id)}>
                {i > 0 ? ", " : ""}
                <Link to={`/templates/${encodeURIComponent(asText(a.template_id))}`}>{asText(a.title)}</Link>
              </span>
            ))}
          </p>
        ) : null}
      </div>
    );
  }
  if (item.kind === "draft") {
    const draft = asRecord(item.proposed);
    const missing = asList(draft.missing_sections) ?? [];
    return (
      <div className="ai-draft-preview">
        <p>
          <span className="muted">Название: </span>
          <strong>{asText(draft.title)}</strong>
        </p>
        {missing.length > 0 ? (
          <div className="ai-todo">
            <p className="ai-todo__title">Нужно дописать — подтверждённых фактов нет ({missing.length}):</p>
            <ul>
              {missing.map((section) => (
                <li key={section}>
                  <span className="ai-todo__mark">TODO</span> {section}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="success">Все разделы шаблона заполнены по источникам.</p>
        )}
        <details className="ai-draft-preview__body">
          <summary>Текст черновика (Markdown)</summary>
          <pre className="raw-source">
            <code>{asText(draft.body)}</code>
          </pre>
        </details>
      </div>
    );
  }
  if (item.kind === "task" && item.target_id) {
    return (
      <p>
        <Link to={`/documents/${encodeURIComponent(item.target_id)}`}>Открыть {item.target_id}</Link>
      </p>
    );
  }
  return null;
}

function EvidenceList({ evidence }: { evidence: AiEvidence[] }) {
  if (evidence.length === 0) return null;
  return (
    <div className="ai-evidence">
      <p className="ai-evidence__title">Основания ({evidence.length})</p>
      <ul>
        {evidence.map((e, i) => (
          <li key={`${e.document_id}-${i}`}>
            <span className="ai-evidence__head">
              <Link to={`/documents/${encodeURIComponent(e.document_id)}`}>{e.title || e.document_id}</Link>
              <code className="doc-id">{e.document_id}</code>
              {isDocStatus(e.status) ? <StatusStamp status={e.status} /> : null}
              {e.revision ? <code className="doc-id">{shortRevision(e.revision)}</code> : null}
            </span>
            {e.reason ? <span className="ai-evidence__reason">{e.reason}</span> : null}
            {e.quote ? <q className="ai-evidence__quote">{e.quote}</q> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

// --- the proposal card ----------------------------------------------------------------------------------

export interface AiProposalCardProps {
  proposal: AiProposal;
  pending: "accept" | "reject" | null;
  error: ApiError | null;
  onAccept: (itemIds: string[]) => void;
  onReject: () => void;
  /** Offered when the proposal went stale (its base changed): a fresh proposal for the same request. */
  onRegenerate?: () => void;
  /** What happened after an accept (e.g. "the draft was reloaded", a link to the created draft). */
  appliedNote?: ReactNode;
  acceptLabel?: string;
}

/**
 * One AI proposal: status, summary, items with a field-level diff and their evidence, explicit Accept of the
 * chosen items or Reject. Nothing is applied by the card itself; information items have no checkbox.
 */
export function AiProposalCard({
  proposal,
  pending,
  error,
  onAccept,
  onReject,
  onRegenerate,
  appliedNote,
  acceptLabel = "Применить выбранное",
}: AiProposalCardProps) {
  const titleId = useId();
  // A new document needs its draft item: it is pre-selected, every other item starts unchecked.
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(proposal.kind === "draft_from_prompt" ? proposal.items.filter((i) => i.kind === "draft" && i.applicable).map((i) => i.id) : []),
  );
  const open = proposal.status === "suggested";
  const applicable = proposal.items.filter((i) => i.applicable);
  const needsDraft = proposal.kind === "draft_from_prompt" && !proposal.items.some((i) => i.kind === "draft" && selected.has(i.id));
  const busy = pending !== null;

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <section className={`ai-proposal ai-proposal--${proposal.status}`} aria-labelledby={titleId} data-status={proposal.status}>
      <header className="ai-proposal__head">
        <h3 id={titleId}>{AI_PROPOSAL_KIND_LABEL[proposal.kind] ?? proposal.kind}</h3>
        <span className={`ai-status ai-status--${proposal.status}`}>{AI_PROPOSAL_STATUS_LABEL[proposal.status]}</span>
        <span className={`ai-mode ai-mode--${proposal.mode}`}>{AI_MODE_LABEL[proposal.mode] ?? proposal.mode}</span>
      </header>
      {proposal.summary ? <p className="ai-proposal__summary">{proposal.summary}</p> : null}
      {proposal.base.template_id ? (
        <p className="ai-proposal__base muted">
          Шаблон {proposal.base.template_id} v{proposal.base.template_version ?? "?"}
          {proposal.base.edit_version ? ` · версия черновика ${proposal.base.edit_version}` : ""}
          {proposal.base.index_generation ? ` · поколение индекса ${proposal.base.index_generation}` : ""}
        </p>
      ) : null}
      {proposal.insufficient ? (
        <div className="answer__insufficient" role="note">
          <p className="feedback__title">Недостаточно данных</p>
          <p>В доступных утверждённых документах нет подтверждения для части предложения — ничего не придумано.</p>
        </div>
      ) : null}
      {proposal.warnings.length > 0 ? (
        <ul className="ai-proposal__warnings">
          {proposal.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}
      {proposal.status === "invalidated" ? (
        <Notice tone="danger">
          <p>
            <strong>Предложение устарело</strong>: документ, черновик или шаблон изменились после того, как оно было
            сделано. Применять его нельзя — ничего не изменено.
          </p>
          {onRegenerate ? (
            <button type="button" className="button button--secondary" onClick={onRegenerate}>
              Сформировать заново
            </button>
          ) : null}
        </Notice>
      ) : null}
      {proposal.status === "answered" ? (
        <p className="muted ai-proposal__note">Это ответ или план: применять нечего, документ не меняется.</p>
      ) : null}
      {proposal.status === "rejected" ? (
        <p className="muted ai-proposal__note">Предложение отклонено — ничего не изменено.</p>
      ) : null}

      {proposal.items.length > 0 ? (
        <ul className="ai-items">
          {proposal.items.map((item) => {
            const applied = proposal.applied_items.includes(item.id);
            const selectable = open && item.applicable;
            const title = itemTitle(item);
            return (
              <li key={item.id} className={`ai-item ai-item--${item.kind}${applied ? " is-applied" : ""}`} data-item={item.id}>
                <div className="ai-item__head">
                  {selectable ? (
                    <label className="checkbox ai-item__check">
                      <input
                        type="checkbox"
                        checked={selected.has(item.id)}
                        disabled={busy}
                        onChange={() => toggle(item.id)}
                        aria-label={`Принять: ${title}`}
                      />
                      <span className="ai-item__title">{title}</span>
                    </label>
                  ) : (
                    <span className="ai-item__title">{title}</span>
                  )}
                  {applied ? <span className="ai-item__state ai-item__state--applied">применено</span> : null}
                  {!item.applicable ? <span className="ai-item__state">к сведению</span> : null}
                </div>
                <ItemBody item={item} />
                {item.reason ? <p className="ai-item__reason">{item.reason}</p> : null}
                <EvidenceList evidence={item.evidence} />
              </li>
            );
          })}
        </ul>
      ) : null}
      {proposal.graph_link ? (
        <p>
          <Link to={proposal.graph_link} className="text-link">
            Показать на графе
          </Link>
        </p>
      ) : null}
      {error ? <ErrorState error={error} title={AI_PROPOSAL_ERROR_TITLE[error.code] ?? AI_ERROR_TITLE[error.code]} /> : null}
      {open && applicable.length > 0 ? (
        <div className="ai-proposal__decision">
          <div className="button-row">
            <button
              type="button"
              className="button button--primary"
              disabled={busy || selected.size === 0 || needsDraft}
              onClick={() => onAccept([...selected])}
            >
              {pending === "accept" ? "Применяем…" : `${acceptLabel} (${selected.size})`}
            </button>
            <button type="button" className="button button--secondary" disabled={busy} onClick={onReject}>
              {pending === "reject" ? "Отклоняем…" : "Отклонить"}
            </button>
          </div>
          <p className="muted">
            {needsDraft
              ? "Чтобы создать документ, отметьте пункт «Черновик документа»."
              : "Ничего не меняется без вашего подтверждения: применяются только отмеченные пункты, и только в черновик."}
          </p>
        </div>
      ) : null}
      {proposal.status === "applied" || proposal.status === "partially_applied" ? appliedNote : null}
    </section>
  );
}

// --- the lifecycle of one proposal ---------------------------------------------------------------------

export interface AiProposalState {
  proposal: AiProposal | null;
  /** The request being prepared (kind), for the progress text. */
  preparing: AiProposalRequest["kind"] | null;
  decision: "accept" | "reject" | null;
  error: ApiError | null;
  decisionError: ApiError | null;
  run: (request: AiProposalRequest) => Promise<void>;
  accept: (itemIds: string[]) => Promise<AiProposal | null>;
  reject: () => Promise<void>;
  regenerate: () => void;
  cancel: () => void;
  clear: () => void;
}

/** Request → proposal → accept / reject; a stale base (409 `ai_proposal_stale`) marks it invalidated. */
export function useAiProposal(onApplied?: (proposal: AiProposal) => void): AiProposalState {
  const [proposal, setProposal] = useState<AiProposal | null>(null);
  const [preparing, setPreparing] = useState<AiProposalRequest["kind"] | null>(null);
  const [decision, setDecision] = useState<"accept" | "reject" | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [decisionError, setDecisionError] = useState<ApiError | null>(null);
  const lastRequest = useRef<AiProposalRequest | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const onAppliedRef = useRef(onApplied);
  onAppliedRef.current = onApplied;

  useEffect(() => () => abortRef.current?.abort(), []);

  async function run(request: AiProposalRequest) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    lastRequest.current = request;
    setPreparing(request.kind);
    setError(null);
    setDecisionError(null);
    setProposal(null);
    try {
      const result = await api.aiPropose(request, { signal: controller.signal });
      if (!controller.signal.aborted) setProposal(result);
    } catch (err) {
      if (!isCancelled(err)) setError(toApiError(err));
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setPreparing(null);
      }
    }
  }

  async function accept(itemIds: string[]): Promise<AiProposal | null> {
    if (!proposal || decision) return null;
    setDecision("accept");
    setDecisionError(null);
    try {
      const result = await api.aiAccept(proposal.id, itemIds);
      setProposal(result);
      onAppliedRef.current?.(result);
      return result;
    } catch (err) {
      const apiError = toApiError(err);
      if (apiError.code === "ai_proposal_stale") {
        setProposal({ ...proposal, status: "invalidated", warnings: [...proposal.warnings, apiError.message] });
      } else if (apiError.code === "ai_proposal_closed") {
        setDecisionError(apiError);
        api.aiProposal(proposal.id).then(setProposal).catch(() => undefined);
      } else {
        setDecisionError(apiError);
      }
      return null;
    } finally {
      setDecision(null);
    }
  }

  async function reject() {
    if (!proposal || decision) return;
    setDecision("reject");
    setDecisionError(null);
    try {
      setProposal(await api.aiReject(proposal.id));
    } catch (err) {
      setDecisionError(toApiError(err));
    } finally {
      setDecision(null);
    }
  }

  return {
    proposal,
    preparing,
    decision,
    error,
    decisionError,
    run,
    accept,
    reject,
    regenerate: () => {
      if (lastRequest.current) void run(lastRequest.current);
    },
    cancel: () => abortRef.current?.abort(),
    clear: () => {
      abortRef.current?.abort();
      setProposal(null);
      setError(null);
      setDecisionError(null);
    },
  };
}

// --- a panel of contextual AI actions -------------------------------------------------------------------

export interface AiAction {
  key: string;
  label: string;
  /** Null: the action cannot run now (e.g. nothing selected); `hint` explains why. */
  build: () => AiProposalRequest | null;
  disabled?: boolean;
  hint?: string;
}

interface AiAssistPanelProps {
  title: string;
  intro: ReactNode;
  actions: AiAction[];
  state: AiProposalState;
  /** Shown instead of the actions when AI actions are not possible right now. */
  blocked?: ReactNode;
  /** Extra controls next to the buttons (e.g. the section to improve). */
  controls?: ReactNode;
  appliedNote?: (proposal: AiProposal) => ReactNode;
  id?: string;
}

/** Contextual AI actions (document page, draft editor): buttons → one proposal with an explicit decision. */
export function AiAssistPanel({ title, intro, actions, state, blocked, controls, appliedNote, id }: AiAssistPanelProps) {
  const headingId = useId();
  const [actionHint, setActionHint] = useState<string | null>(null);
  const busy = state.preparing !== null;
  return (
    <section className="panel ai-assist" aria-labelledby={headingId} id={id}>
      <h2 id={headingId}>{title}</h2>
      <div className="ai-assist__intro">{intro}</div>
      {blocked ? (
        <Notice tone="info">{blocked}</Notice>
      ) : (
        <>
          {controls ? <div className="ai-assist__controls">{controls}</div> : null}
          <div className="button-row ai-assist__actions" role="group" aria-label="Действия ИИ">
            {actions.map((action) => (
              <button
                key={action.key}
                type="button"
                className="button button--secondary"
                disabled={busy || action.disabled}
                title={action.disabled ? action.hint : undefined}
                onClick={() => {
                  const request = action.build();
                  if (!request) {
                    setActionHint(action.hint ?? null);
                    return;
                  }
                  setActionHint(null);
                  void state.run(request);
                }}
              >
                {action.label}
              </button>
            ))}
          </div>
          {actionHint ? <p className="flag ai-assist__hint">{actionHint}</p> : null}
        </>
      )}
      <div aria-live="polite">
        {busy ? (
          <p className="muted ai-assist__progress">
            Готовим предложение «{AI_PROPOSAL_KIND_LABEL[state.preparing ?? "suggest_metadata"]}»…{" "}
            <button type="button" className="button button--ghost" onClick={state.cancel}>
              Отменить
            </button>
          </p>
        ) : null}
      </div>
      {state.error ? (
        <ErrorState
          error={state.error}
          title={AI_PROPOSAL_ERROR_TITLE[state.error.code] ?? AI_ERROR_TITLE[state.error.code] ?? "Не удалось получить предложение ИИ"}
        />
      ) : null}
      {state.proposal ? (
        <AiProposalCard
          key={state.proposal.id}
          proposal={state.proposal}
          pending={state.decision}
          error={state.decisionError}
          onAccept={(ids) => void state.accept(ids)}
          onReject={() => void state.reject()}
          onRegenerate={state.regenerate}
          appliedNote={appliedNote?.(state.proposal)}
        />
      ) : null}
    </section>
  );
}
