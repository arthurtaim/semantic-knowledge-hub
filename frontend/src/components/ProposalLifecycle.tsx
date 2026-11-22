import type { ProposalDetail } from "../api/types";

export type StepState = "done" | "current" | "pending" | "failed";

export interface LifecycleStep {
  key: string;
  title: string;
  state: StepState;
  note: string | null;
}

const STEP_TITLES = [
  ["created", "Предложение создано"],
  ["ready", "Проверено («Готово к ревью»)"],
  ["merge_request", "MR в GitLab"],
  ["merge", "Merge ревьюером"],
  ["knowledge_base", "Обновлено в базе знаний"],
] as const;

const STATE_TEXT: Record<StepState, string> = {
  done: "выполнено",
  current: "текущий этап",
  pending: "ожидает",
  failed: "остановлено",
};

const PAST_READY = new Set(["ready_for_review", "submitting", "submitted_to_gitlab", "merged", "submission_failed"]);

/**
 * Derives the lifecycle from server-reported facts only: the local status, the history, whether an MR exists
 * and whether the source document already contains this proposal. Nothing is assumed to have happened in GitLab.
 */
export function lifecycleSteps(p: ProposalDetail): LifecycleStep[] {
  const wasReady =
    PAST_READY.has(p.status) ||
    p.history.some((e) => e.status === "ready_for_review" || e.action === "marked_ready_for_review");
  const hasMergeRequest = p.merge_request !== null;
  // Index of the step the process is at (or stopped at); steps before it are done.
  let at: number;
  let failed = false;
  let note: string | null = null;

  switch (p.status) {
    case "draft":
      at = 1;
      note = "отметьте «Готово к ревью» после проверки diff";
      break;
    case "ready_for_review":
      at = 2;
      note = "предложение ещё не отправлено в GitLab";
      break;
    case "submitting":
      at = 2;
      note = "создаются ветка, коммит и MR";
      break;
    case "submitted_to_gitlab":
      at = 3;
      note = "ожидает ревью и merge в GitLab";
      break;
    case "merged":
      if (p.source_document_state === "updated_by_this_proposal") {
        at = STEP_TITLES.length;
      } else {
        at = 4;
        note = "merge подтверждён GitLab, база знаний ещё не синхронизирована";
      }
      break;
    case "submission_failed":
      at = 2;
      failed = true;
      note = "ошибка отправки";
      break;
    case "conflict":
      at = hasMergeRequest ? 3 : wasReady ? 2 : 1;
      failed = true;
      note = "конфликт версий";
      break;
    case "rejected":
      at = hasMergeRequest ? 3 : wasReady ? 2 : 1;
      failed = true;
      note = hasMergeRequest ? "MR закрыт без merge" : "предложение отклонено";
      break;
  }

  return STEP_TITLES.map(([key, title], index) => {
    let state: StepState = "pending";
    if (index < at) state = "done";
    else if (index === at) state = failed ? "failed" : "current";
    return { key, title, state, note: index === at ? note : null };
  });
}

/** Ordered stepper: numbering is meaningful here because the stages happen strictly in this order. */
export function ProposalLifecycle({ proposal }: { proposal: ProposalDetail }) {
  const steps = lifecycleSteps(proposal);
  return (
    <section className="lifecycle-section" aria-labelledby="lifecycle-title">
      <h2 id="lifecycle-title">Этапы предложения</h2>
      <ol className="lifecycle" aria-labelledby="lifecycle-title">
        {steps.map((step, index) => (
          <li
            key={step.key}
            className={`lifecycle__step lifecycle__step--${step.state}`}
            data-state={step.state}
            aria-current={step.state === "current" || step.state === "failed" ? "step" : undefined}
          >
            <span className="lifecycle__marker" aria-hidden="true">
              {step.state === "done" ? "✓" : step.state === "failed" ? "✕" : index + 1}
            </span>
            <span className="lifecycle__body">
              <span className="lifecycle__title">{step.title}</span>
              <span className="lifecycle__state">
                {STATE_TEXT[step.state]}
                {step.note ? ` — ${step.note}` : ""}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
