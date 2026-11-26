import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, api } from "../../api/client";
import type { TaskChange, WorkChangeApplyResult, WorkChangeProposal, WorkProject } from "../../api/types";
import { newRequestId } from "../../lib/requestId";
import { toApiError } from "../../lib/useWorkspace";
import { PRIORITY_LABEL } from "../../lib/work";
import { ErrorState, Notice } from "../Feedback";
import { SidePanel, useSidePanelMode } from "../shell/SidePanel";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";

/*
 * «Изменения задач» (M7, docs/WORK_CHAT_SKILLS.md): the review of a change-set the assistant PROPOSED for existing
 * tasks (WCP). Every operation shows the task, the field, the value the SERVER read when the proposal was made, the
 * proposed value and — when it differs — the value there now. A person unchecks what they do not want, may re-check
 * the selection on the server («Проверить выбор», writes nothing) and applies it with a separate, explicit button:
 * all chosen changes in ONE server transaction, or none. A stale change-set (the plan or a task changed, a task was
 * archived, a source changed, it expired) cannot be applied — prepare a new one in the chat. The open change-set lives
 * in the URL (`?changes=WCP-…`), so a reload or a link from the chat returns here.
 */

export const CHANGE_STALE_LABEL: Record<string, string> = {
  plan_changed: "задачи проекта изменились после подготовки",
  task_changed: "задача изменена после подготовки",
  task_archived: "задача перенесена в архив",
  task_unavailable: "задача недоступна",
  source_changed: "документ-источник изменился",
  source_unavailable: "документ-источник недоступен",
  expired: "истёк срок действия предложения",
  knowledge_unavailable: "база знаний недоступна — источники не проверить",
};

const OPERATION_STATE: Record<TaskChange["state"], string> = {
  ok: "",
  no_op: "Значение уже такое — менять нечего.",
  task_changed: "Задача изменена после подготовки предложения.",
  task_archived: "Задача в архиве.",
  task_unavailable: "Задача недоступна.",
};

const STATUS_WORD: Record<string, string> = {
  todo: "К выполнению",
  in_progress: "В работе",
  review: "На проверке",
  done: "Готово",
};

function shown(change: TaskChange, value: string | null): string {
  if (value === null) return change.field === "due_date" ? "без срока" : "—";
  if (change.field === "status") return STATUS_WORD[value] ?? value;
  if (change.field === "priority") return PRIORITY_LABEL[value as keyof typeof PRIORITY_LABEL] ?? value;
  if (change.field === "description") return value.length > 160 ? `${value.slice(0, 160)}…` : value || "(пусто)";
  return value;
}

interface WorkChangeSheetProps {
  project: WorkProject;
  canWrite: boolean;
  proposalId: string;
  onClose: () => void;
  onApplied: (result: WorkChangeApplyResult) => void;
}

export function WorkChangeSheet({ project, canWrite, proposalId, onClose, onApplied }: WorkChangeSheetProps) {
  const mode = useSidePanelMode(true);
  return (
    <SidePanel id="work-changes" title="Предложение AI: изменения задач" mode={mode} onClose={onClose} className="work-form work-plan">
      <ChangeReview key={proposalId} project={project} proposalId={proposalId} canWrite={canWrite} onApplied={onApplied} onClose={onClose} />
    </SidePanel>
  );
}

interface ReviewProps {
  project: WorkProject;
  proposalId: string;
  canWrite: boolean;
  onApplied: (result: WorkChangeApplyResult) => void;
  onClose: () => void;
}

function ChangeReview({ project, proposalId, canWrite, onApplied, onClose }: ReviewProps) {
  const id = useId();
  const [proposal, setProposal] = useState<WorkChangeProposal | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [chosen, setChosen] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState<"preview" | "apply" | "reject" | null>(null);
  const [problem, setProblem] = useState<ApiError | null>(null);
  const [checked, setChecked] = useState<string | null>(null);
  // One confirmation = one idempotency key: a double click or a retry after a timeout never writes twice.
  const confirmation = useRef(newRequestId());

  const load = useCallback(() => {
    api
      .workChangeProposal(proposalId)
      .then((p) => {
        setProposal(p);
        setChosen((current) => current ?? new Set(p.changes.filter((c) => c.included && c.state === "ok").map((c) => c.operation_id)));
        setLoadError(null);
      })
      .catch((err: unknown) => setLoadError(toApiError(err)));
  }, [proposalId]);

  useEffect(load, [load]);

  if (loadError) {
    return loadError.status === 404 ? (
      <Notice tone="warning">Предложение не найдено (оно личное и видно только тому, кто его подготовил).</Notice>
    ) : (
      <ErrorState error={loadError} onRetry={load} />
    );
  }
  if (!proposal || !chosen) return <p className="muted">Загружаем предложение…</p>;

  const decided = proposal.status !== "suggested";
  const ready = proposal.state === "ready";
  const selected = proposal.changes.filter((c) => chosen.has(c.operation_id));
  const editable = canWrite && ready && !decided;

  function toggle(operation: string, on: boolean) {
    setChecked(null);
    setChosen((current) => {
      const next = new Set(current);
      if (on) next.add(operation);
      else next.delete(operation);
      return next;
    });
  }

  async function preview() {
    setBusy("preview");
    setProblem(null);
    try {
      const p = await api.workPreviewChanges(proposalId, [...chosen!]);
      setProposal(p);
      const ok = p.changes.filter((c) => c.included && c.state === "ok").length;
      setChecked(`Сервер проверил выбор: применится изменений — ${ok}. Ничего не записано.`);
    } catch (err) {
      setProblem(toApiError(err));
    } finally {
      setBusy(null);
    }
  }

  async function apply() {
    if (!proposal) return;
    setBusy("apply");
    setProblem(null);
    try {
      const result = await api.workApplyChanges(proposalId, {
        operation_ids: [...chosen!],
        expected_plan_revision: proposal.base_plan_revision,
        client_request_id: confirmation.current,
      });
      onApplied(result);
      load(); // read the applied state back from the server, never assume it
    } catch (err) {
      const e = toApiError(err);
      setProblem(e);
      if (e.code === "proposal_stale") load();
    } finally {
      setBusy(null);
    }
  }

  async function reject() {
    setBusy("reject");
    setProblem(null);
    try {
      setProposal(await api.workRejectChanges(proposalId));
    } catch (err) {
      setProblem(toApiError(err));
    } finally {
      setBusy(null);
    }
  }

  const warnings = proposal.issues.filter((i) => i.severity === "warning");
  const infos = proposal.issues.filter((i) => i.severity === "info");
  return (
    <div className="work-plan__review" data-change-proposal-id={proposal.id} data-proposal-state={proposal.state}>
      {decided ? (
        <Notice tone={proposal.status === "applied" ? "success" : "info"}>
          {proposal.status === "applied" ? (
            <>
              Изменения применены (одной операцией): задач — {proposal.applied_task_keys.length}.{" "}
              {proposal.applied_task_keys.map((key) => (
                <Link key={key} to={`/tasks/${encodeURIComponent(key)}`} className="work-plan__key">
                  {key}
                </Link>
              ))}
            </>
          ) : (
            "Предложение отклонено: задачи не менялись."
          )}
        </Notice>
      ) : ready ? (
        <Notice tone="info">
          Это предложение AI. Задачи не изменятся, пока вы не нажмёте «Применить изменения»; слова в чате ничего не применяют.
          «Было» — значение, которое сервер прочитал из задачи.
        </Notice>
      ) : (
        <Notice tone="warning">
          Предложение устарело — подготовьте заново: {proposal.stale_reasons.map((r) => CHANGE_STALE_LABEL[r] ?? r).join("; ")}. Применить его нельзя.
        </Notice>
      )}

      <section className="work-plan__block" aria-labelledby={`${id}-req`}>
        <h3 className="task-section__title" id={`${id}-req`}>
          Запрос
        </h3>
        <p className="work-plan__request-text">{proposal.request}</p>
        {proposal.goal ? <p className="muted">Цель по версии модели: {proposal.goal}</p> : null}
        <p className="muted work-plan__meta">
          Проект {project.key} · провайдер: {proposal.provider} · ревизия плана {proposal.base_plan_revision}
          {proposal.revised_from ? ` · уточнение предложения ${proposal.revised_from}` : ""}
        </p>
      </section>

      <section className="work-plan__block" aria-labelledby={`${id}-ops`}>
        <h3 className="task-section__title" id={`${id}-ops`}>
          Изменения <span className="task-section__count">{selected.length} из {proposal.changes.length}</span>
        </h3>
        <ul className="work-changes" aria-label="Предложенные изменения">
          {proposal.changes.map((change) => {
            const stale = change.state !== "ok";
            const note = OPERATION_STATE[change.state];
            return (
              <li key={change.operation_id} className={`work-change${stale ? " work-change--stale" : ""}`} data-operation={change.operation_id} data-state={change.state}>
                <label className="checkbox work-change__pick">
                  <input
                    type="checkbox"
                    checked={chosen.has(change.operation_id)}
                    disabled={!editable || stale}
                    onChange={(e) => toggle(change.operation_id, e.target.checked)}
                    aria-describedby={`${id}-${change.operation_id}-diff`}
                  />
                  <span className="visually-hidden">
                    Применить: {change.task_key}, {change.field_label}
                  </span>
                </label>
                <div className="work-change__body">
                  <p className="work-change__head">
                    {change.task_id ? (
                      <Link to={`/tasks/${encodeURIComponent(change.task_key)}`} className="task-mini-list__key">
                        {change.task_key}
                      </Link>
                    ) : (
                      <span className="task-mini-list__key">{change.task_key}</span>
                    )}{" "}
                    {change.task_title ?? <span className="muted">задача недоступна</span>}
                  </p>
                  <p className="work-change__diff" id={`${id}-${change.operation_id}-diff`}>
                    <span className="work-change__field">{change.field_label}:</span>{" "}
                    <del aria-label={`было: ${shown(change, change.before)}`}>{shown(change, change.before)}</del>
                    <span className="work-change__arrow" aria-hidden="true">→</span>
                    <ins aria-label={`станет: ${shown(change, change.after)}`}>{shown(change, change.after)}</ins>
                  </p>
                  {change.current !== change.before && change.state !== "task_unavailable" ? (
                    <p className="work-change__note">
                      <Icon name="alert" size={12} /> Сейчас в задаче: {shown(change, change.current)}
                    </p>
                  ) : null}
                  {note ? (
                    <p className="work-change__note">
                      <Icon name="alert" size={12} /> {note}
                    </p>
                  ) : null}
                  {change.reason ? <p className="muted work-change__reason">Объяснение модели (не проверено): {change.reason}</p> : null}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {warnings.length || infos.length ? (
        <section className="work-plan__block" aria-labelledby={`${id}-iss`}>
          <h3 className="task-section__title" id={`${id}-iss`}>
            Проверка сервера <span className="task-section__count">{proposal.issues.length}</span>
          </h3>
          <ul className="work-plan__list work-plan__issues">
            {[...warnings, ...infos].map((i, index) => (
              <li key={`${i.code}-${i.local_id ?? ""}-${index}`} className={`work-plan__issue work-plan__issue--${i.severity}`} data-issue={i.code}>
                <Icon name={i.severity === "warning" ? "alert" : "info"} size={12} />
                {i.local_id ? <strong>{i.local_id}: </strong> : null}
                {i.message}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {proposal.assumptions.length ? (
        <section className="work-plan__block" aria-labelledby={`${id}-ass`}>
          <h3 className="task-section__title" id={`${id}-ass`}>
            Допущения модели
          </h3>
          <ul className="work-plan__list">
            {proposal.assumptions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="muted work-plan__meta">
        Исполнителя, даты плана на диаграмме Ганта и зависимости предложение не меняет — их меняют в карточке задачи и через
        предпросмотр расписания.
      </p>
      {checked ? (
        <p className="muted" role="status">
          {checked}
        </p>
      ) : null}
      {problem ? (
        <Notice tone={problem.code === "proposal_stale" ? "warning" : "danger"}>
          {problem.code === "proposal_stale" ? "Предложение устарело — подготовьте заново. " : ""}
          {problem.message}
        </Notice>
      ) : null}
      <div className="button-row work-plan__actions">
        {canWrite && !decided ? (
          <>
            <Button variant="primary" onClick={() => void apply()} disabled={busy !== null || !proposal.can_apply || selected.length === 0}>
              {busy === "apply" ? "Применяем…" : `Применить изменения (${selected.length})`}
            </Button>
            <Button onClick={() => void preview()} disabled={busy !== null || !ready || selected.length === 0}>
              {busy === "preview" ? "Проверяем…" : "Проверить выбор"}
            </Button>
            <Button onClick={() => void reject()} disabled={busy !== null}>
              Отклонить
            </Button>
          </>
        ) : null}
        <Button variant="quiet" onClick={onClose}>
          Закрыть
        </Button>
      </div>
    </div>
  );
}
