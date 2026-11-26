import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, api } from "../api/client";
import type { WorkChangeProposal, WorkProposal, WorkProposalRef } from "../api/types";
import { CHANGE_STALE_LABEL } from "./work/WorkChanges";
import { Icon } from "./ui/Icon";

/*
 * M7 (docs/WORK_CHAT_SKILLS.md): the card of a WORK proposal a chat skill stored — a task plan (WAP) or a change-set of
 * existing tasks (WCP). It is NOT a document AI proposal: it is never fetched from /api/ai/proposals and never applied
 * here. On every render of a turn (also a reopened dialog) it re-reads the CURRENT state from the work API — the
 * snapshot in the stored answer may be old — and links to the review where a person applies it explicitly.
 */

type Current = { kind: "task_plan"; data: WorkProposal } | { kind: "task_changes"; data: WorkChangeProposal };

const STATE_TEXT: Record<string, string> = {
  ready: "готово к проверке",
  stale: "устарело",
  applied: "применено",
  rejected: "отклонено",
};

const PLAN_STALE: Record<string, string> = {
  plan_changed: "план проекта изменился",
  source_changed: "документ-источник изменился",
  source_unavailable: "документ-источник недоступен",
  expired: "истёк срок действия",
  knowledge_unavailable: "база знаний недоступна",
};

interface AskWorkProposalProps {
  reference: WorkProposalRef;
  compact?: boolean;
  /** Refine it in the chat: a NEW proposal is prepared (this one stays unchanged). Absent: no refine button. */
  onRefine?: (reference: WorkProposalRef) => void;
}

export function AskWorkProposal({ reference, compact = false, onRefine }: AskWorkProposalProps) {
  const [current, setCurrent] = useState<Current | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    let alive = true;
    const load =
      reference.kind === "task_plan"
        ? api.workProposal(reference.id).then((data): Current => ({ kind: "task_plan", data }))
        : api.workChangeProposal(reference.id).then((data): Current => ({ kind: "task_changes", data }));
    load
      .then((value) => alive && setCurrent(value))
      .catch((err: unknown) => alive && setError(err instanceof ApiError ? err : new ApiError(0, "network_error", "Нет связи с сервером.", null)));
    return () => {
      alive = false;
    };
  }, [reference.kind, reference.id]);

  const plan = reference.kind === "task_plan";
  const state = current?.data.state ?? null;
  const reasons = current?.data.stale_reasons ?? [];
  const reasonText = reasons.map((r) => (plan ? PLAN_STALE[r] : CHANGE_STALE_LABEL[r]) ?? r).join("; ");
  const counts = plan
    ? `задач ${reference.task_count} · зависимостей ${reference.dependency_count}`
    : `изменений ${reference.change_count}`;
  const headline = plan ? `План задач для ${reference.project_key}` : `Изменения задач ${reference.project_key}`;
  const action = plan ? "Проверить план" : "Проверить изменения";
  const unavailable = error !== null;
  return (
    <section
      className={`ask-proposal ask-work-proposal${compact ? " ask-proposal--compact" : ""}`}
      aria-label={`${headline}: предложение ${reference.id}`}
      data-work-proposal={reference.id}
      data-work-kind={reference.kind}
      data-work-state={state ?? (unavailable ? "unavailable" : "loading")}
    >
      <p className="ask-proposal__title">
        <Icon name="projects" size={14} /> {headline}
      </p>
      <p className="ask-proposal__meta">
        Предложение {reference.id} · {counts}
        {reference.revised_from ? ` · уточняет ${reference.revised_from} (оно не изменено)` : ""}
      </p>
      <p className="ask-proposal__state" role="status">
        {unavailable ? (
          <>
            <Icon name="alert" size={12} />{" "}
            {error.status === 404 ? "Предложение недоступно (нет доступа или удалено)." : `Состояние не проверить: ${error.message}`}
          </>
        ) : state === null ? (
          "Проверяем состояние…"
        ) : state === "stale" ? (
          <>
            <Icon name="alert" size={12} /> Устарело — подготовьте заново: {reasonText}.
          </>
        ) : state === "applied" ? (
          <>
            <Icon name="check" size={12} /> Применено после вашего подтверждения.
          </>
        ) : (
          <>Состояние: {STATE_TEXT[state] ?? state}. В задачах ничего не изменено до подтверждения.</>
        )}
      </p>
      {unavailable ? null : (
        <div className="ask-proposal__actions">
          <Link className="button button--primary button--sm" to={reference.app_path}>
            {action}
          </Link>
          {onRefine && state === "ready" ? (
            <button type="button" className="button button--secondary button--sm" onClick={() => onRefine(reference)}>
              Уточнить
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}
