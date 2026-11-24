import type { WorkCapabilities, WorkTask } from "../../api/types";

/*
 * «Документы» of a task — the seam for M6 Step 4 (task ↔ document links, docs/WORK_MANAGEMENT.md §8).
 *
 * Step 4 replaces the body of this component: `GET /api/tasks/{id}/links` through the reader's knowledge snapshot
 * (title, status and revision read from the current snapshot, never copied; no title or count for a document the
 * reader cannot see), «Связать с документом» (POST) and «Убрать связь» (DELETE) when `canWrite`, the
 * revision-changed / dangling marks, and the link to the document page. Turn it on with
 * `capabilities.features.document_links`. The props stay as they are so the panel and the task page need no change.
 *
 * Until then it says honestly that links are not connected yet — no fake list, no dead buttons.
 */

export interface TaskDocumentsProps {
  task: WorkTask;
  capabilities: WorkCapabilities | null;
  canWrite: boolean;
}

export function TaskDocuments({ task, capabilities }: TaskDocumentsProps) {
  const enabled = Boolean(capabilities?.features.document_links);
  return (
    <section className="task-section" aria-labelledby={`task-docs-${task.id}`} data-step4-seam="task-documents">
      <h3 className="task-section__title" id={`task-docs-${task.id}`}>
        Документы
      </h3>
      {enabled ? (
        <p className="muted">Связанных документов: {task.link_count}.</p>
      ) : (
        <p className="muted">Связи задач с документами базы знаний ещё не подключены в этой версии.</p>
      )}
    </section>
  );
}
