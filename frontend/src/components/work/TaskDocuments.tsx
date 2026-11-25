import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { ApiError, api } from "../../api/client";
import type { LinkRelation, LinkSuggestion, TaskLink, TaskLinks, WorkCapabilities, WorkTask } from "../../api/types";
import { STATUS_LABEL } from "../../lib/labels";
import { toApiError } from "../../lib/useWorkspace";
import { LINK_RELATIONS, LINK_RELATION_LABEL, LINK_STATE_LABEL, shortRevision } from "../../lib/work";
import { Notice } from "../Feedback";
import { StatusStamp } from "../StatusStamp";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";

/*
 * «Документы» of a task (M6 Step 4, docs/WORK_MANAGEMENT.md §10): `GET /api/tasks/{id}/links`, read from the reader's
 * CURRENT knowledge snapshot on every request — title, status and revision are never copied into the work database.
 * A link shows how the document stands now: «Документ изменён после связывания» (a person checks it and marks it
 * «Проверено» — never automatic), «Устарел» (deprecated), «Не утверждён» (draft / in review), and a neutral
 * «Документ недоступен — удалён или нет доступа» without any id or title when the reader cannot see it. When the
 * knowledge source is down nothing is shown about documents and nothing can be linked; the task itself keeps working.
 * Writers link a document they can see («Связать с документом», search by ID or title) and remove links.
 * A link is not a knowledge-graph relation: the document is never changed.
 */

export interface TaskDocumentsProps {
  task: WorkTask;
  capabilities: WorkCapabilities | null;
  canWrite: boolean;
  /** Called after a change so the snapshot (counts, the document filter) is re-read. */
  onChanged?: () => void | Promise<void>;
  say?: (tone: "info" | "success" | "warning" | "danger", text: string) => void;
}

export function TaskDocuments({ task, capabilities, canWrite, onChanged, say }: TaskDocumentsProps) {
  const enabled = Boolean(capabilities?.features.document_links);
  const [links, setLinks] = useState<TaskLinks | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [nonce, setNonce] = useState(0);
  const [adding, setAdding] = useState(false);
  const id = useId();

  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    api
      .workTaskLinks(task.id)
      .then((result) => {
        if (live) {
          setLinks(result);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (live) setError(toApiError(err));
      });
    return () => {
      live = false;
    };
  }, [enabled, task.id, nonce]);

  async function changed(text: string) {
    say?.("success", text);
    setNonce((n) => n + 1);
    await onChanged?.();
  }

  async function remove(item: TaskLink) {
    const label = item.document ? item.document.document_id : "недоступный документ";
    try {
      await api.workUnlinkDocument(task.id, item.id);
      await changed(`${task.key}: связь с «${label}» убрана.`);
    } catch (err) {
      say?.("danger", `Не удалось убрать связь: ${toApiError(err).message}`);
      setNonce((n) => n + 1);
    }
  }

  async function acknowledge(item: TaskLink) {
    try {
      await api.workAcknowledgeLink(task.id, item.id);
      await changed(`${item.document?.document_id ?? "Документ"}: отмечено как проверенное — связь записала текущую ревизию.`);
    } catch (err) {
      say?.("danger", `Не удалось отметить: ${toApiError(err).message}`);
      setNonce((n) => n + 1);
    }
  }

  const items = links?.items ?? [];
  const writable = canWrite && enabled && Boolean(links?.knowledge_available);
  return (
    <section className="task-section" aria-labelledby={`${id}-title`} data-testid="task-documents">
      <h3 className="task-section__title" id={`${id}-title`}>
        Документы {links ? <span className="task-section__count">{items.length}</span> : null}
      </h3>
      {!enabled ? (
        <p className="muted">Связи задач с документами базы знаний отключены в этой конфигурации.</p>
      ) : error ? (
        <Notice tone="danger">Не удалось загрузить связанные документы: {error.message}</Notice>
      ) : !links ? (
        <p className="muted">Загрузка…</p>
      ) : (
        <>
          {!links.knowledge_available ? (
            <Notice tone="warning">База знаний сейчас недоступна: связанные документы нельзя проверить, поэтому они не показаны. Задача работает как обычно.</Notice>
          ) : null}
          {items.length ? (
            <ul className="task-docs" aria-label={`Документы задачи ${task.key}`}>
              {items.map((item) => (
                <LinkRow
                  key={item.id}
                  item={item}
                  canWrite={canWrite && enabled}
                  canAcknowledge={writable}
                  onRemove={() => void remove(item)}
                  onAcknowledge={() => void acknowledge(item)}
                />
              ))}
            </ul>
          ) : links.knowledge_available ? (
            <p className="muted">Связанных документов нет.</p>
          ) : null}
          {writable ? (
            adding ? (
              <LinkForm
                task={task}
                onCancel={() => setAdding(false)}
                onLinked={async (item) => {
                  setAdding(false);
                  await changed(`${task.key} связана с ${item.document?.document_id ?? "документом"}.`);
                }}
              />
            ) : (
              <Button size="sm" variant="secondary" icon="plus" className="button--with-icon task-docs__add" onClick={() => setAdding(true)}>
                Связать с документом
              </Button>
            )
          ) : null}
        </>
      )}
    </section>
  );
}

function LinkRow({ item, canWrite, canAcknowledge, onRemove, onAcknowledge }: { item: TaskLink; canWrite: boolean; canAcknowledge: boolean; onRemove: () => void; onAcknowledge: () => void }) {
  const doc = item.document;
  const label = doc ? `${doc.document_id}` : "недоступным документом";
  return (
    <li className={`task-doc task-doc--${item.state}`} data-link-id={item.id} data-link-state={item.state}>
      <span className="task-doc__relation">{LINK_RELATION_LABEL[item.relation]}</span>
      {doc ? (
        <span className="task-doc__main">
          <Link to={doc.app_path} className="task-doc__link">
            <span className="task-mini-list__key">{doc.document_id}</span> {doc.title}
          </Link>
          <StatusStamp status={doc.status} />
          {doc.version ? <span className="muted task-doc__version">v{doc.version}</span> : null}
        </span>
      ) : (
        <span className="task-doc__main task-doc__unavailable">
          <Icon name="alert" size={14} />
          {LINK_STATE_LABEL[item.state]}
        </span>
      )}
      {doc && item.state === "revision_changed" ? (
        <span className="task-doc__state task-doc__state--changed">
          <Icon name="alert" size={12} />
          {LINK_STATE_LABEL.revision_changed}: ревизия {shortRevision(item.revision_at_link)} → {shortRevision(doc.revision)}. Проверьте, не затронута ли задача.
        </span>
      ) : null}
      {doc && item.state === "revision_unknown" ? <span className="task-doc__state muted">{LINK_STATE_LABEL.revision_unknown}.</span> : null}
      {doc && item.deprecated ? <span className="task-doc__state task-doc__state--deprecated">Документ устарел (deprecated) — не опирайтесь на него без проверки.</span> : null}
      {doc && !item.approved && !item.deprecated ? <span className="task-doc__state muted">Не утверждён ({STATUS_LABEL[doc.status].toLowerCase()}) — не авторитетный источник.</span> : null}
      {canWrite ? (
        <span className="task-doc__actions">
          {canAcknowledge && doc && (item.state === "revision_changed" || item.state === "revision_unknown") ? (
            <button type="button" className="link-button" onClick={onAcknowledge} aria-label={`Отметить ${doc.document_id} как проверенный`}>
              Проверено
            </button>
          ) : null}
          <button type="button" className="link-button" onClick={onRemove} aria-label={`Убрать связь с ${label}`}>
            Убрать
          </button>
        </span>
      ) : null}
    </li>
  );
}

function LinkForm({ task, onCancel, onLinked }: { task: WorkTask; onCancel: () => void; onLinked: (item: TaskLink) => void | Promise<void> }) {
  const [text, setText] = useState("");
  const [found, setFound] = useState<LinkSuggestion[]>([]);
  const [chosen, setChosen] = useState<LinkSuggestion | null>(null);
  const [relation, setRelation] = useState<LinkRelation>("implements");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const requestId = useRef(`link-${task.id}-${Date.now().toString(36)}`);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();

  useEffect(() => input.current?.focus(), []);

  useEffect(() => {
    if (chosen) return undefined;
    const query = text.trim();
    if (query.length < 2) {
      setFound([]);
      return undefined;
    }
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      api
        .linkSuggest(query, 8, { signal: abort.signal })
        .then(setFound)
        .catch(() => undefined);
    }, 200);
    return () => {
      window.clearTimeout(timer);
      abort.abort();
    };
  }, [text, chosen]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!chosen) return;
    setBusy(true);
    setProblem(null);
    try {
      const item = await api.workLinkDocument(task.id, { document_id: chosen.document_id, relation, client_request_id: requestId.current });
      await onLinked(item);
    } catch (err) {
      const e = toApiError(err);
      setProblem(e.code === "conflict" && e.details.reason === "link_exists" ? "Такая связь уже есть." : e.message);
      requestId.current = `link-${task.id}-${Date.now().toString(36)}`;
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="task-docs__form" onSubmit={(e) => void submit(e)} aria-label="Связать с документом">
      <div className="field">
        <label htmlFor={`${id}-doc`}>Документ</label>
        {chosen ? (
          <div className="task-docs__chosen">
            <span>
              <span className="task-mini-list__key">{chosen.document_id}</span> {chosen.title}
            </span>
            <button
              type="button"
              className="link-button"
              onClick={() => {
                setChosen(null);
                setText("");
                window.setTimeout(() => input.current?.focus(), 0);
              }}
            >
              Другой
            </button>
          </div>
        ) : (
          <>
            <input
              id={`${id}-doc`}
              ref={input}
              type="search"
              value={text}
              maxLength={120}
              placeholder="ID или название документа"
              autoComplete="off"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") onCancel();
              }}
            />
            {found.length ? (
              <ul className="task-docs__found" aria-label="Найденные документы">
                {found.map((s) => (
                  <li key={s.document_id}>
                    <button type="button" className="task-docs__pick" onClick={() => setChosen(s)}>
                      <span className="task-mini-list__key">{s.document_id}</span> {s.title} <StatusStamp status={s.status} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : text.trim().length >= 2 ? (
              <p className="muted task-docs__hint">Ничего не найдено среди доступных вам документов.</p>
            ) : (
              <p className="muted task-docs__hint">Введите хотя бы два символа.</p>
            )}
          </>
        )}
      </div>
      <div className="field">
        <label htmlFor={`${id}-rel`}>Связь</label>
        <select id={`${id}-rel`} value={relation} onChange={(e) => setRelation(e.target.value as LinkRelation)}>
          {LINK_RELATIONS.map((r) => (
            <option key={r} value={r}>
              {LINK_RELATION_LABEL[r]}
            </option>
          ))}
        </select>
      </div>
      {problem ? (
        <p className="field__issue field__issue--error" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="task-docs__buttons">
        <Button type="submit" size="sm" disabled={!chosen || busy}>
          Связать
        </Button>
        <Button type="button" size="sm" variant="quiet" onClick={onCancel}>
          Отмена
        </Button>
      </div>
    </form>
  );
}
