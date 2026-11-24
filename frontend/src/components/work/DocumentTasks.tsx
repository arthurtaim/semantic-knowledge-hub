import { useEffect, useId, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, api } from "../../api/client";
import type { DocumentTasks } from "../../api/types";
import { toApiError } from "../../lib/useWorkspace";
import { LINK_RELATION_LABEL, LINK_STATE_LABEL } from "../../lib/work";
import { Notice } from "../Feedback";
import { TaskStatusMark } from "./WorkBits";

/*
 * «Задачи» of a document (M6 Step 4): the back-links of task ↔ document links, `GET /api/documents/{id}/tasks`.
 * Only tasks of projects this reader may view are listed (and counted); each opens its task page (`/tasks/ARIS-5`),
 * and «Задачи проекта по документу» opens the project's views filtered by this document (`?doc=ID`). A task link is
 * not a knowledge-graph relation — it lives in the work module, so it is shown here, next to the document's links.
 * Without the work module (TASK_SYSTEM=disabled) the section is not shown at all.
 */

export function DocumentTasksPanel({ documentId }: { documentId: string }) {
  const [data, setData] = useState<DocumentTasks | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const id = useId();

  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    api
      .workDocumentTasks(documentId)
      .then((result) => {
        if (live) setData(result);
      })
      .catch((err: unknown) => {
        if (live) setError(toApiError(err));
      });
    return () => {
      live = false;
    };
  }, [documentId]);

  if (error && (error.code === "feature_unavailable" || error.status === 404 || error.status === 403)) return null;

  const projects = data ? Array.from(new Map(data.items.map((i) => [i.project_key, i.project_title] as const)).entries()) : [];
  return (
    <section className="links-group doc-tasks" aria-labelledby={id} data-testid="document-tasks">
      <h3 id={id}>
        Задачи {data ? <span className="muted">({data.total})</span> : null}
      </h3>
      {error ? (
        <Notice tone={error.code === "knowledge_unavailable" ? "warning" : "danger"}>
          {error.code === "knowledge_unavailable" ? error.message : `Не удалось загрузить задачи документа: ${error.message}`}
        </Notice>
      ) : !data ? (
        <p className="muted">Загрузка…</p>
      ) : data.items.length === 0 ? (
        <p className="muted">Задач, связанных с этим документом, нет. Связать задачу можно в её карточке (раздел «Документы»).</p>
      ) : (
        <>
          <ul className="link-list">
            {data.items.map((item) => (
              <li key={item.link_id} className="link-row" data-task-key={item.task_key}>
                <p className="link-row__head">
                  <TaskStatusMark status={item.status} className="task-status--compact" />{" "}
                  <Link to={item.app_path}>
                    <span className="task-mini-list__key">{item.task_key}</span> {item.title}
                  </Link>
                </p>
                <p className="link-row__meta">
                  <span className="link-row__relation">{LINK_RELATION_LABEL[item.relation]} этот документ</span>
                  <span className="muted">проект {item.project_title}</span>
                  {item.state === "revision_changed" ? <span className="task-doc__state--changed">{LINK_STATE_LABEL.revision_changed}</span> : null}
                </p>
              </li>
            ))}
          </ul>
          <p className="doc-tasks__projects">
            {projects.map(([key, title]) => (
              <Link key={key} to={`/projects/${encodeURIComponent(key)}?view=list&doc=${encodeURIComponent(data.document_id)}`}>
                Задачи проекта «{title}» по документу
              </Link>
            ))}
          </p>
        </>
      )}
    </section>
  );
}
