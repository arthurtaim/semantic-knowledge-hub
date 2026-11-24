import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { ApiError, api } from "../../api/client";
import type { StudioState, TemplateComparison } from "../../api/types";
import { formatDate, formatDateTime, STUDIO_EVENT_LABEL, TEMPLATE_STATUS_LABEL } from "../../lib/labels";
import { ErrorState } from "../Feedback";
import { Button } from "../ui/Button";
import { TemplateComparisonView } from "./TemplateComparisonView";

interface StudioHistoryProps {
  state: StudioState;
  canActivate: boolean;
  /** Ask to make an existing version current (the parent confirms in the activation sheet). */
  onActivateVersion: (version: number, shipped: boolean) => void;
}

function toApiError(err: unknown): ApiError {
  return err instanceof ApiError ? err : new ApiError(0, "client_error", String(err), null);
}

/** Versions (who activated each, how many documents are pinned to it), the event log, and a comparison. */
export function StudioHistory({ state, canActivate, onActivateVersion }: StudioHistoryProps) {
  const versions = [...state.versions].sort((a, b) => a.version - b.version);
  const latest = versions[versions.length - 1]?.version ?? 1;
  const [from, setFrom] = useState<number>(state.current_version ?? latest);
  const [to, setTo] = useState<string>(state.draft ? "draft" : String(latest));
  const [result, setResult] = useState<TemplateComparison | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);
  const same = to === String(from);

  async function compare(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      setResult(await api.studioCompare(state.template_id, from, to === "draft" ? "draft" : Number(to)));
    } catch (err) {
      setError(toApiError(err));
      setResult(null);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="studio-history">
      <section aria-labelledby="studio-versions">
        <h2 id="studio-versions">Версии</h2>
        {versions.length === 0 ? <p className="muted">Версий ещё нет: шаблон станет версией v1 после активации.</p> : null}
        <ol className="template-history studio-versions" reversed>
          {state.draft ? (
            <li className="studio-versions__draft">
              <p className="template-history__head">
                <strong>Черновик</strong>
                <span className="tpl-status tpl-status--draft">не активирован</span>
                <span className="muted">
                  сохранил {state.draft.saved_by}, {formatDateTime(state.draft.saved_at)}
                </span>
              </p>
            </li>
          ) : null}
          {[...versions].reverse().map((v) => (
            <li key={v.version} className={v.current ? "is-current" : undefined}>
              <p className="template-history__head">
                <strong>v{v.version}</strong>
                {v.current ? <span className="tpl-status tpl-status--active">действует</span> : null}
                {v.status !== "active" ? <span className={`tpl-status tpl-status--${v.status}`}>{TEMPLATE_STATUS_LABEL[v.status] ?? v.status}</span> : null}
                {v.breaking ? <span className="breaking-badge">несовместимая</span> : null}
                <span className="muted">{v.source === "studio" ? "из студии" : "из поставки"}</span>
              </p>
              <p className="muted studio-versions__meta">
                {v.activated_by ? `активировал ${v.activated_by}, ${formatDateTime(v.activated_at ?? v.first_seen)}` : `с ${formatDate(v.first_seen)}`}
                {" · "}документов на этой версии: {v.documents}
              </p>
              {v.changes ? <p>{v.changes}</p> : null}
              <p className="studio-versions__actions">
                <Link to={`/templates/${encodeURIComponent(state.template_id)}${v.current ? "" : `?version=${v.version}`}`} className="text-link">
                  Открыть v{v.version}
                </Link>
                {!v.current && canActivate ? (
                  <Button size="sm" variant="quiet" onClick={() => onActivateVersion(v.version, v.version === state.shipped_update)}>
                    Сделать действующей
                  </Button>
                ) : null}
              </p>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="studio-compare">
        <h2 id="studio-compare">Сравнить</h2>
        {versions.length === 0 ? (
          <p className="muted">Сравнивать пока не с чем.</p>
        ) : (
          <form className="compare" onSubmit={compare} aria-label="Сравнение версий шаблона">
            <div className="compare__controls">
              <div className="field">
                <label htmlFor="studio-cmp-from">Было</label>
                <select id="studio-cmp-from" value={from} onChange={(e) => setFrom(Number(e.target.value))}>
                  {versions.map((v) => (
                    <option key={v.version} value={v.version}>
                      v{v.version}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="studio-cmp-to">Стало</label>
                <select id="studio-cmp-to" value={to} onChange={(e) => setTo(e.target.value)}>
                  {state.draft ? <option value="draft">Черновик</option> : null}
                  {versions.map((v) => (
                    <option key={v.version} value={String(v.version)}>
                      v{v.version}
                    </option>
                  ))}
                </select>
              </div>
              <Button type="submit" disabled={pending || same}>
                {pending ? "Сравниваем…" : "Сравнить"}
              </Button>
            </div>
            {same ? <p className="muted">Выберите разные версии.</p> : null}
            {error ? <ErrorState error={error} /> : null}
            {result ? <TemplateComparisonView result={result} /> : null}
          </form>
        )}
      </section>

      <section aria-labelledby="studio-events">
        <h2 id="studio-events">Журнал изменений</h2>
        {state.events.length === 0 ? (
          <p className="muted">Шаблон из поставки ещё не меняли в студии.</p>
        ) : (
          <ol className="studio-events">
            {state.events.map((e) => (
              <li key={`${e.revision}-${e.action}-${e.at}`}>
                <p className="studio-events__head">
                  <strong>{STUDIO_EVENT_LABEL[e.action] ?? e.action}</strong>
                  {e.version ? <span className="version-badge">v{e.version}</span> : null}
                  <span className="muted">
                    {e.actor}, {formatDateTime(e.at)}
                  </span>
                </p>
                <p className="muted">{e.summary}</p>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
