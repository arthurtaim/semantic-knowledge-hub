import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../../api/client";
import type { ScheduleApplyResult, ScheduleInterval, ScheduleMode, SchedulePreview, SchedulePreviewRequest, TaskDateChange } from "../../api/types";
import { newRequestId } from "../../lib/requestId";
import { toApiError } from "../../lib/useWorkspace";
import { CONFLICT_LABEL, formatDay, pluralWorkdays, SCHEDULE_MODE_LABEL, STALE_REASON_LABEL } from "../../lib/work";
import { Notice } from "../Feedback";
import { SidePanel, useSidePanelMode } from "../shell/SidePanel";
import { Button } from "../ui/Button";
import { SegmentedControl } from "../ui/SegmentedControl";

/*
 * The schedule preview (M6, docs/WORK_MANAGEMENT.md «Планирование»): what a drag, resize, date form or new dependency
 * would change BEFORE anything is written — the requested task, every dependant the server shifts (before → after,
 * by how many working days and because of which task), conflicts (apply impossible), warnings (a deadline would be
 * exceeded: apply only after an explicit tick) and tasks the calculation skipped (no dates).
 *
 * «Применить» sends the preview id, its base plan revision and ONE idempotency key per confirmation: a retry of the
 * same confirmation (lost answer, a second click) reuses it and the server replays the first result. A
 * `409 stale_schedule` (the plan changed meanwhile, the preview expired) re-reads the plan and computes the preview
 * again — nothing is applied to a state the user did not see. «Отмена» writes nothing.
 */

export interface ScheduleRequest {
  /** The task the change started from (its key names the dialog). */
  taskKey: string;
  changes: TaskDateChange[];
  addDependencies?: SchedulePreviewRequest["add_dependencies"];
  mode?: Exclude<ScheduleMode, "resolve_violations">;
}

interface SchedulePreviewDialogProps {
  projectRef: string;
  request: ScheduleRequest;
  onClose: () => void;
  onApplied: (result: ScheduleApplyResult) => void;
  /** Re-read the plan (after a stale apply) before the preview is computed again. */
  onRefresh: () => Promise<void>;
  /** The current preview (null while computing or on an error), for the ghosts on the Gantt. */
  onPreview?: (preview: SchedulePreview | null) => void;
  today: string;
}

function interval(value: ScheduleInterval, today: string): string {
  if (!value.start_date) return "без дат";
  if (value.start_date === value.end_exclusive) return `${formatDay(value.start_date, today)} (веха)`;
  const days = value.duration_workdays ? `, ${pluralWorkdays(value.duration_workdays)}` : "";
  return value.last_day && value.last_day !== value.start_date
    ? `${formatDay(value.start_date, today)} – ${formatDay(value.last_day, today)}${days}`
    : `${formatDay(value.start_date, today)}${days}`;
}

interface PreviewState {
  mode: Exclude<ScheduleMode, "resolve_violations">;
  setMode: (mode: Exclude<ScheduleMode, "resolve_violations">) => void;
  preview: SchedulePreview | null;
  loading: boolean;
  applying: boolean;
  error: ApiError | null;
  stale: string | null;
  accepted: boolean;
  setAccepted: (value: boolean) => void;
  recompute: () => void;
  apply: () => Promise<void>;
  canApply: boolean;
  nothingChanges: boolean;
}

/** The preview / apply state machine shared by the dialog (Gantt, List) and the inline form (task panel). */
function useSchedulePreview({ projectRef, request, onApplied, onRefresh, onPreview }: Omit<SchedulePreviewDialogProps, "onClose" | "today">): PreviewState {
  const [mode, setMode] = useState<Exclude<ScheduleMode, "resolve_violations">>(request.mode ?? "shift_successors");
  const [preview, setPreview] = useState<SchedulePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [stale, setStale] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [round, setRound] = useState(0);
  /** One idempotency key per preview: a retry of the same «Применить» sends the same key. */
  const requestId = useRef<string>(newRequestId());
  const onPreviewRef = useRef(onPreview);
  onPreviewRef.current = onPreview;

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    setAccepted(false);
    onPreviewRef.current?.(null);
    api
      .workSchedulePreview(projectRef, {
        mode,
        changes: request.changes,
        add_dependencies: request.addDependencies,
      })
      .then((result) => {
        if (!live) return;
        requestId.current = newRequestId();
        setPreview(result);
        onPreviewRef.current?.(result);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setPreview(null);
        setError(toApiError(err));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [projectRef, request, mode, round]);

  useEffect(() => () => onPreviewRef.current?.(null), []);

  const apply = useCallback(async () => {
    if (!preview) return;
    setApplying(true);
    setError(null);
    try {
      const result = await api.workScheduleApply(projectRef, {
        preview_id: preview.preview_id,
        expected_plan_revision: preview.base_plan_revision,
        client_request_id: requestId.current,
        accept_warnings: preview.warnings.length > 0 ? accepted : undefined,
      });
      onApplied(result);
    } catch (err) {
      const apiError = toApiError(err);
      if (apiError.status === 409 && apiError.code === "stale_schedule") {
        const reason = typeof apiError.details.reason === "string" ? apiError.details.reason : "";
        setStale(STALE_REASON_LABEL[reason] ?? "план изменился");
        await onRefresh();
        setRound((n) => n + 1); // a new preview on the current plan
      } else {
        setError(apiError);
      }
    } finally {
      setApplying(false);
    }
  }, [preview, projectRef, accepted, onApplied, onRefresh]);

  const needsAcceptance = Boolean(preview && preview.warnings.length > 0);
  const nothingChanges = Boolean(preview && preview.operations.length === 0 && preview.added_dependencies.length === 0);
  return {
    mode,
    setMode,
    preview,
    loading,
    applying,
    error,
    stale,
    accepted,
    setAccepted,
    recompute: () => setRound((n) => n + 1),
    apply,
    canApply: Boolean(preview?.can_apply) && !loading && !applying && (!needsAcceptance || accepted) && !nothingChanges,
    nothingChanges,
  };
}

export function SchedulePreviewDialog(props: SchedulePreviewDialogProps) {
  const sheet = useSidePanelMode(true);
  const state = useSchedulePreview(props);
  const onlyDependencies = props.request.changes.length === 0;
  return (
    <SidePanel
      id="schedule-preview"
      title={onlyDependencies ? "Зависимость: последствия" : `Изменение сроков ${props.request.taskKey}`}
      mode={sheet}
      onClose={props.onClose}
      className="schedule-preview"
      footer={<PreviewActions state={state} onCancel={props.onClose} />}
    >
      <PreviewBody state={state} request={props.request} today={props.today} />
    </SidePanel>
  );
}

/** The same preview inside the task panel (no second modal layer). */
export function SchedulePreviewInline(props: SchedulePreviewDialogProps) {
  const state = useSchedulePreview(props);
  return (
    <section className="schedule-preview schedule-preview--inline" aria-label="Последствия изменения сроков">
      <PreviewBody state={state} request={props.request} today={props.today} />
      <PreviewActions state={state} onCancel={props.onClose} />
    </section>
  );
}

function PreviewActions({ state, onCancel }: { state: PreviewState; onCancel: () => void }) {
  return (
    <div className="button-row">
      <Button variant="primary" onClick={() => void state.apply()} disabled={!state.canApply}>
        {state.applying ? "Применяем…" : "Применить"}
      </Button>
      <Button onClick={onCancel}>Отмена</Button>
    </div>
  );
}

function PreviewBody({ state, request, today }: { state: PreviewState; request: ScheduleRequest; today: string }) {
  const { mode, setMode, preview, loading, applying, error, stale, accepted, setAccepted, nothingChanges } = state;
  const onlyDependencies = request.changes.length === 0;
  const requested = preview?.operations.filter((op) => op.change === "requested") ?? [];
  const shifted = preview?.operations.filter((op) => op.change === "shifted") ?? [];
  const keyOf = (id: string) => preview?.operations.find((op) => op.task_id === id)?.key ?? id;

  return (
    <>
      <p className="muted schedule-preview__lead">
        Ничего не изменится, пока вы не нажмёте «Применить». Расчёт — на сервере по календарю Пн–Пт; последний день
        задачи показан включительно.
      </p>
      {!onlyDependencies ? (
        <SegmentedControl
          label="Что сделать с зависимыми задачами"
          className="schedule-preview__mode"
          options={(["shift_successors", "only_this_task"] as const).map((value) => ({ value, label: SCHEDULE_MODE_LABEL[value] }))}
          value={mode}
          onChange={setMode}
        />
      ) : null}
      {stale ? (
        <Notice tone="warning">
          Пока вы смотрели предпросмотр, {stale}. Данные обновлены, последствия пересчитаны — проверьте их и примените
          снова.
        </Notice>
      ) : null}
      {loading ? (
        <p className="feedback feedback--loading" role="status">
          Считаем последствия…
        </p>
      ) : null}
      {error ? (
        <Notice tone="danger">
          <p className="schedule-preview__error-title">{error.status === 422 ? "Изменение не проходит проверку" : "Не удалось выполнить запрос"}</p>
          <p>{error.message}</p>
          {Array.isArray(error.details.cycle_keys) ? <p>Цикл: {(error.details.cycle_keys as string[]).join(" → ")}</p> : null}
          {applying ? null : (
            <Button size="sm" onClick={state.recompute}>
              Пересчитать
            </Button>
          )}
        </Notice>
      ) : null}
      {preview && !loading ? (
        <div className="schedule-preview__body" aria-live="polite">
          {nothingChanges ? <Notice tone="info">Даты не меняются: задача уже стоит здесь.</Notice> : null}
          {requested.length ? (
            <section aria-labelledby="sp-requested">
              <h3 id="sp-requested" className="schedule-preview__heading">
                Запрошено
              </h3>
              <ul className="schedule-ops">
                {requested.map((op) => (
                  <li key={op.task_id} className="schedule-op schedule-op--requested" data-task-key={op.key}>
                    <span className="schedule-op__task">
                      <span className="schedule-op__key">{op.key}</span> {op.title}
                    </span>
                    <span className="schedule-op__change">
                      <del>{interval(op.before, today)}</del>
                      <span aria-hidden="true"> → </span>
                      <span className="visually-hidden"> станет </span>
                      <ins>{interval(op.after, today)}</ins>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {preview.added_dependencies.length ? (
            <section aria-labelledby="sp-deps">
              <h3 id="sp-deps" className="schedule-preview__heading">
                Новые зависимости
              </h3>
              <ul className="schedule-ops">
                {preview.added_dependencies.map((dep) => (
                  <li key={`${dep.predecessor_task_id}-${dep.successor_task_id}`} className="schedule-op">
                    {keyOf(dep.predecessor_task_id)} → {keyOf(dep.successor_task_id)} (окончание → начало)
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <section aria-labelledby="sp-shifted">
            <h3 id="sp-shifted" className="schedule-preview__heading">
              Сдвинутся зависимые: {shifted.length}
            </h3>
            {shifted.length === 0 ? (
              <p className="muted">
                {mode === "only_this_task" ? "В этом режиме другие задачи не двигаются." : "Зависимые задачи не затронуты."}
              </p>
            ) : (
              <ul className="schedule-ops">
                {shifted.map((op) => (
                  <li key={op.task_id} className="schedule-op schedule-op--shifted" data-task-key={op.key}>
                    <span className="schedule-op__task">
                      <span className="schedule-op__key">{op.key}</span> {op.title}
                    </span>
                    <span className="schedule-op__change">
                      <del>{interval(op.before, today)}</del>
                      <span aria-hidden="true"> → </span>
                      <span className="visually-hidden"> станет </span>
                      <ins>{interval(op.after, today)}</ins>
                    </span>
                    <span className="schedule-op__why muted">
                      {op.shift_workdays > 0 ? `+${pluralWorkdays(op.shift_workdays)}` : pluralWorkdays(op.shift_workdays)} · после{" "}
                      {op.because_of.map(keyOf).join(", ")}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {preview.conflicts.length ? (
            <section aria-labelledby="sp-conflicts" className="schedule-preview__conflicts">
              <h3 id="sp-conflicts" className="schedule-preview__heading">
                Конфликты — применить нельзя
              </h3>
              <ul className="schedule-ops">
                {preview.conflicts.map((conflict, index) => (
                  <li key={`${conflict.code}-${conflict.task_id}-${index}`} className="schedule-op schedule-op--conflict" data-task-key={conflict.key}>
                    <span className="schedule-op__key">{conflict.key}</span> {CONFLICT_LABEL[conflict.code] ?? conflict.code}
                    <span className="schedule-op__why muted">{conflict.message}</span>
                  </li>
                ))}
              </ul>
              {mode === "only_this_task" && preview.conflicts.some((c) => c.code === "successor_violation") ? (
                <p className="muted">Выберите «Сдвинуть зависимые» — тогда последователи сдвинутся вместе с задачей.</p>
              ) : null}
            </section>
          ) : null}
          {preview.warnings.length ? (
            <section aria-labelledby="sp-warnings" className="schedule-preview__warnings">
              <h3 id="sp-warnings" className="schedule-preview__heading">
                Предупреждения
              </h3>
              <ul className="schedule-ops">
                {preview.warnings.map((warning, index) => (
                  <li key={`${warning.code}-${warning.task_id}-${index}`} className="schedule-op schedule-op--warning">
                    <span className="schedule-op__key">{warning.key}</span>{" "}
                    {warning.code === "due_date_exceeded"
                      ? `закончится ${formatDay(warning.last_day, today)} — позже срока ${formatDay(warning.due_date, today)}`
                      : warning.message}
                  </li>
                ))}
              </ul>
              <label className="checkbox">
                <input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} />
                Понимаю: срок будет превышен, сам срок не меняется
              </label>
            </section>
          ) : null}
          {preview.blocked_tasks.length ? (
            <section aria-labelledby="sp-blocked">
              <h3 id="sp-blocked" className="schedule-preview__heading">
                Не рассчитаны: {preview.blocked_tasks.length}
              </h3>
              <ul className="schedule-ops">
                {preview.blocked_tasks.map((item) => (
                  <li key={item.task_id} className="schedule-op">
                    <span className="schedule-op__key">{item.key}</span> {item.reason === "unscheduled" ? "без дат — расчёт для неё остановлен" : item.message}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <p className="muted schedule-preview__meta">
            Не меняются: {preview.unchanged.length}. План проекта: ревизия {preview.base_plan_revision}. Предпросмотр действует до{" "}
            {new Date(preview.expires_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}.
          </p>
        </div>
      ) : null}
    </>
  );
}
