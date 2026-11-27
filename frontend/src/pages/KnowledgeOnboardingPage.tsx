import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ApiError, api } from "../api/client";
import type {
  OnboardingBatch,
  OnboardingBatchListItem,
  OnboardingCapabilities,
  OnboardingConfirmResult,
  OnboardingItem,
  OnboardingPreview,
} from "../api/types";
import { ErrorState, Loading, Notice } from "../components/Feedback";
import { ItemInspector } from "../components/onboarding/ItemInspector";
import { PageToolbar } from "../components/shell/PageToolbar";
import { Button } from "../components/ui/Button";
import { newRequestId } from "../lib/requestId";

/*
 * M8 «Массовый импорт» (docs/KNOWLEDGE_ONBOARDING.md): 1 Загрузка → 2 Анализ → 3 Проверка → 4 Создание черновиков.
 * A ZIP, a folder or several files become a STAGED batch (nothing in the knowledge base, the index or the graph).
 * The person reviews each file, selects files explicitly (nothing is preselected) and creates DRAFTS with a separate
 * action; drafts then go through the ordinary review → GitLab merge request → merge → sync. The batch is in the URL
 * (`?batch=`), so a reload resumes it; a repeated confirm returns the same drafts.
 */

const STATUS_LABEL: Record<string, string> = {
  pending: "Ожидает",
  parsed: "Разобран",
  invalid: "Ошибка",
  unsupported: "Не поддерживается",
  duplicate: "Дубликат",
  conflict: "Конфликт",
  reviewed: "Проверен",
  skipped: "Исключён",
  draft_created: "Черновик создан",
  draft_failed: "Черновик не создан",
};
const OPERATION_LABEL: Record<string, string> = { create: "Новый документ", update: "Изменение существующего", skip: "—" };
const STATE_LABEL: Record<string, string> = {
  uploaded: "загружен",
  parsed: "разобран",
  review: "на проверке",
  confirmed: "черновики созданы",
  partially_confirmed: "черновики созданы частично",
  rejected: "отменён",
  expired: "срок хранения истёк",
};
const STEPS = ["Загрузка", "Анализ", "Проверка", "Создание черновиков"];

function eligible(item: OnboardingItem): boolean {
  return (
    (item.parse_status === "parsed" || item.parse_status === "conflict") &&
    !item.excluded &&
    item.outcome?.state !== "draft_created" &&
    item.proposed_operation !== "skip"
  );
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
}

function Stepper({ step }: { step: number }) {
  return (
    <ol className="onb-steps" aria-label="Шаги импорта">
      {STEPS.map((label, index) => (
        <li key={label} className={`onb-step${index === step ? " onb-step--current" : index < step ? " onb-step--done" : ""}`} aria-current={index === step ? "step" : undefined}>
          <span className="onb-step__no">{index + 1}</span> {label}
        </li>
      ))}
    </ol>
  );
}

function UploadStep({ onBatch }: { onBatch: (batch: OnboardingBatch) => void }) {
  const [caps, setCaps] = useState<OnboardingCapabilities | null>(null);
  const [recent, setRecent] = useState<OnboardingBatchListItem[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [dragging, setDragging] = useState(false);
  const folderRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.onboardingCapabilities().then(setCaps).catch(() => setCaps(null));
    api.onboardingBatches().then(setRecent).catch(() => setRecent([]));
  }, []);
  useEffect(() => {
    folderRef.current?.setAttribute("webkitdirectory", "");  // folder selection (Chromium, Safari, Firefox)
  }, []);

  async function send(files: File[], kind: "zip" | "files" | "folder") {
    if (files.length === 0 || pending) return;
    setPending(true);
    setError(null);
    const sourceKind = kind === "files" && files.length === 1 && files[0]?.name.toLowerCase().endsWith(".zip") ? "zip" : kind;
    try {
      const batch = await api.onboardingUpload(
        files.map((file) => ({ file, path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name })),
        sourceKind,
      );
      onBatch(batch);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "network_error", "Нет связи с сервером.", null));
    } finally {
      setPending(false);
    }
  }

  function pick(event: ChangeEvent<HTMLInputElement>, kind: "files" | "folder") {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    void send(files, kind);
  }

  function drop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    void send(Array.from(event.dataTransfer.files), "files");
  }

  return (
    <section className="onb-upload" aria-labelledby="onb-upload-title">
      <h2 id="onb-upload-title" className="onb-section-title">
        Загрузка
      </h2>
      <div
        className={`onb-drop${dragging ? " onb-drop--over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={drop}
      >
        <p>Перетащите сюда ZIP-архив или файлы — или выберите их:</p>
        <div className="onb-drop__actions">
          <label className="button button--primary" htmlFor="onb-files">
            Выбрать файлы или ZIP
          </label>
          <input id="onb-files" className="visually-hidden" type="file" multiple accept=".zip,.md,.markdown,.txt,.pdf,.docx" disabled={pending} onChange={(e) => pick(e, "files")} />
          <label className="button" htmlFor="onb-folder">
            Выбрать папку
          </label>
          <input id="onb-folder" ref={folderRef} className="visually-hidden" type="file" multiple disabled={pending} onChange={(e) => pick(e, "folder")} />
        </div>
        {caps ? (
          <p className="muted onb-drop__limits">
            Форматы: {caps.formats.join(", ")}. До {caps.max_files} файлов и {caps.upload_mb} МБ за загрузку, файл до {caps.file_mb} МБ. Пакет
            хранится {caps.ttl_hours} ч. {caps.ai_available ? "Подсказки ИИ доступны." : "Языковая модель не подключена: подсказки только по правилам."}
          </p>
        ) : null}
        <p className="muted">Ничего не попадёт в базу знаний на этом шаге: файлы только разбираются и ждут вашей проверки.</p>
      </div>
      {pending ? <Loading label="Загружаю и разбираю файлы…" /> : null}
      {error ? <ErrorState error={error} title="Пакет не загружен" /> : null}
      {recent.length > 0 ? (
        <div className="onb-recent">
          <h3 className="onb-section-title">Недавние пакеты</h3>
          <ul>
            {recent.map((b) => (
              <li key={b.batch_id}>
                <Link to={`?batch=${b.batch_id}`}>
                  {fmtDate(b.created_at)} — {b.file_count} файлов, {STATE_LABEL[b.state] ?? b.state}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

export function KnowledgeOnboardingPage() {
  const [params, setParams] = useSearchParams();
  const batchId = params.get("batch");
  const [batch, setBatch] = useState<OnboardingBatch | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [templates, setTemplates] = useState<{ id: string; title: string }[]>([]);
  const [plan, setPlan] = useState<OnboardingPreview | null>(null);
  const [planKey, setPlanKey] = useState<string>(newRequestId);
  const [result, setResult] = useState<OnboardingConfirmResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const load = useCallback(async () => {
    if (!batchId) return;
    try {
      setBatch(await api.onboardingBatch(batchId));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "network_error", "Нет связи с сервером.", null));
    }
  }, [batchId]);

  useEffect(() => {
    setBatch(null);
    setPlan(null);
    setResult(null);
    setSelected(new Set());
    setOpen(null);
    void load();
  }, [load]);
  useEffect(() => {
    api
      .templates()
      .then((list) => setTemplates(list.map((t) => ({ id: t.id, title: t.title }))))
      .catch(() => setTemplates([]));
  }, []);

  const closed = batch ? batch.state === "rejected" || batch.state === "expired" : false;
  const step = !batchId ? 0 : !batch ? 1 : result || batch.state === "confirmed" || batch.state === "partially_confirmed" ? 3 : 2;

  function toggle(itemId: string, on: boolean) {
    const next = new Set(selected);
    if (on) next.add(itemId);
    else next.delete(itemId);
    setSelected(next);
    setPlan(null);
  }

  async function suggest() {
    if (!batch) return;
    const ids = [...selected];
    setBusy("suggest");
    setStatus(null);
    try {
      let note: string | null = null;
      for (let i = 0; i < ids.length; i += 10) {
        setStatus(`Подсказки ИИ: ${Math.min(i + 10, ids.length)} из ${ids.length}…`);
        const res = await api.onboardingSuggest(batch.batch_id, ids.slice(i, i + 10));
        note = res.note ?? note;
      }
      setStatus(note ?? "Подсказки ИИ готовы: откройте файл, чтобы принять нужные.");
      await load();
    } catch (err) {
      setStatus(err instanceof ApiError ? err.message : "Подсказки ИИ не получены.");
    } finally {
      setBusy(null);
    }
  }

  async function review() {
    if (!batch) return;
    setBusy("preview");
    setStatus(null);
    try {
      setPlan(await api.onboardingPreview(batch.batch_id, [...selected]));
      setPlanKey(newRequestId());
    } catch (err) {
      setStatus(err instanceof ApiError ? err.message : "Проверка выбора не удалась.");
    } finally {
      setBusy(null);
    }
  }

  async function confirm() {
    if (!batch || !plan || busy) return;
    setBusy("confirm");
    setStatus(null);
    try {
      const res = await api.onboardingConfirm(batch.batch_id, {
        expected_revision: plan.revision,
        fingerprint: plan.fingerprint,
        item_ids: [...plan.planned.map((p) => p.item_id)],
        idempotency_key: planKey,
      });
      setResult(res);
      setSelected(new Set());
      setPlan(null);
      await load();
    } catch (err) {
      setStatus(
        err instanceof ApiError && err.status === 409 ? "План устарел: проверьте выбор заново." : err instanceof ApiError ? err.message : "Черновики не созданы.",
      );
      setPlan(null);
    } finally {
      setBusy(null);
    }
  }

  async function cancel() {
    if (!batch) return;
    setBusy("cancel");
    try {
      setBatch(await api.onboardingCancel(batch.batch_id));
      setConfirmCancel(false);
    } catch (err) {
      setStatus(err instanceof ApiError ? err.message : "Пакет не отменён.");
    } finally {
      setBusy(null);
    }
  }

  const items = batch?.items ?? [];
  const ready = items.filter(eligible);
  return (
    <div className="onboarding">
      <PageToolbar
        crumbs={[{ label: "Документы", to: "/documents" }, { label: "Массовый импорт" }]}
        actions={
          batchId ? (
            <Button size="sm" onClick={() => setParams({})}>
              Новый пакет
            </Button>
          ) : null
        }
      />
      <h1 className="onb-title">Массовый импорт</h1>
      <Stepper step={step} />
      {!batchId ? <UploadStep onBatch={(b) => setParams({ batch: b.batch_id })} /> : null}
      {batchId && error ? <ErrorState error={error} title="Пакет не открывается" onRetry={() => void load()} /> : null}
      {batchId && !batch && !error ? <Loading label="Открываю пакет…" /> : null}
      {batch ? (
        <>
          <section className="onb-summary" aria-label="Сводка пакета">
            <p>
              Файлов: <strong>{batch.counts.total}</strong> · разобрано {batch.counts.parsed} · ошибок {batch.counts.invalid} · не поддерживается{" "}
              {batch.counts.unsupported} · дубликатов {batch.counts.duplicate} · конфликтов {batch.counts.conflict} · изменений существующих{" "}
              {batch.counts.updates} · черновиков создано {batch.counts.draft_created}
            </p>
            <p className="muted">
              Пакет {STATE_LABEL[batch.state] ?? batch.state}; хранится до {fmtDate(batch.expires_at)}. База знаний, поиск и граф не меняются: черновики
              пройдут обычное ревью и merge в GitLab.
            </p>
          </section>
          {closed ? <Notice tone="warning">Пакет {STATE_LABEL[batch.state]}: изменить его нельзя.</Notice> : null}
          <div className="onb-bulk" role="group" aria-label="Действия с выбранными файлами">
            <Button size="sm" disabled={closed || ready.length === 0} onClick={() => setSelected(new Set(ready.map((i) => i.item_id)))}>
              Выбрать готовые ({ready.length})
            </Button>
            <Button size="sm" disabled={selected.size === 0} onClick={() => setSelected(new Set())}>
              Снять выбор
            </Button>
            <Button
              size="sm"
              disabled={closed || selected.size === 0 || busy !== null || !batch.ai_available}
              title={batch.ai_available ? undefined : "Языковая модель не подключена"}
              onClick={() => void suggest()}
            >
              Подсказки ИИ для выбранных
            </Button>
            <span className="muted">Выбрано: {selected.size}</span>
          </div>
          {status ? (
            <p className="onb-message" role="status">
              {status}
            </p>
          ) : null}
          <div className={`onb-layout${open ? " onb-layout--open" : ""}`}>
            <div className="onb-table-wrap">
              <table className="onb-table">
                <caption className="visually-hidden">Файлы пакета</caption>
                <thead>
                  <tr>
                    <th scope="col">
                      <span className="visually-hidden">Выбор</span>
                    </th>
                    <th scope="col">Файл</th>
                    <th scope="col">Состояние</th>
                    <th scope="col">Операция</th>
                    <th scope="col">Тип / шаблон</th>
                    <th scope="col">ID</th>
                    <th scope="col">Связи</th>
                    <th scope="col">Замечания</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.item_id} data-item={item.item_id} className={open === item.item_id ? "onb-row--open" : undefined}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Выбрать «${item.display_name}»`}
                          checked={selected.has(item.item_id)}
                          disabled={closed || !eligible(item)}
                          onChange={(e) => toggle(item.item_id, e.target.checked)}
                        />
                      </td>
                      <td>
                        <button type="button" className="link-button onb-file" onClick={() => setOpen(item.item_id)}>
                          {item.display_name}
                        </button>
                        {item.path !== item.display_name ? <span className="muted onb-file__path">{item.path}</span> : null}
                      </td>
                      <td>
                        <span className={`onb-status onb-status--${item.status}`}>{STATUS_LABEL[item.status] ?? item.status}</span>
                        {item.needs_review ? <span className="onb-needs">нужна проверка</span> : null}
                      </td>
                      <td>{OPERATION_LABEL[item.proposed_operation]}</td>
                      <td>{[item.doc_type, item.template_id].filter(Boolean).join(" / ") || "—"}</td>
                      <td>{item.existing_doc?.document_id ?? item.document_id ?? "выделит сервер"}</td>
                      <td>{item.links}</td>
                      <td>
                        {item.errors ? `ошибок ${item.errors}` : ""}
                        {item.errors && item.warnings ? ", " : ""}
                        {item.warnings ? `предупреждений ${item.warnings}` : ""}
                        {item.duplicates.length ? <span className="onb-dup"> {item.duplicates[0]?.message}</span> : null}
                        {!item.errors && !item.warnings && !item.duplicates.length ? "—" : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {open ? (
              <ItemInspector batchId={batch.batch_id} itemId={open} templates={templates} locked={closed} onChanged={() => void load()} onClose={() => setOpen(null)} />
            ) : null}
          </div>

          <section className="onb-confirm" aria-labelledby="onb-confirm-title">
            <h2 id="onb-confirm-title" className="onb-section-title">
              Создание черновиков
            </h2>
            {!plan ? (
              <Button variant="secondary" disabled={closed || selected.size === 0 || busy !== null} onClick={() => void review()}>
                Проверить выбор ({selected.size})
              </Button>
            ) : (
              <div className="onb-plan">
                <p>
                  Будет создано черновиков: <strong>{plan.planned.length}</strong> (новых документов {plan.creates}, изменений существующих {plan.updates}).
                  Не выбрано: {plan.skipped.length}.
                </p>
                {plan.blocked.length > 0 ? (
                  <Notice tone="danger">
                    Нельзя создать как есть:
                    <ul>
                      {plan.blocked.map((b) => (
                        <li key={b.item_id}>
                          {b.path}: {b.errors.map((e) => e.message).join(" ")}
                        </li>
                      ))}
                    </ul>
                  </Notice>
                ) : null}
                <p className="muted">Черновики не утверждаются и не попадают в поиск: дальше — обычное ревью, merge request в GitLab и синхронизация.</p>
                <div className="onb-plan__actions">
                  <Button variant="primary" disabled={plan.blocked.length > 0 || plan.planned.length === 0 || busy !== null} onClick={() => void confirm()}>
                    Создать черновики ({plan.planned.length})
                  </Button>
                  <Button onClick={() => setPlan(null)}>Изменить выбор</Button>
                </div>
              </div>
            )}
            {result ? (
              <div className="onb-result" role="status">
                <p>
                  Создано черновиков: <strong>{result.created}</strong>
                  {result.failed ? `, не создано: ${result.failed}` : ""}.
                </p>
                <ul>
                  {Object.entries(result.outcomes).map(([itemId, outcome]) => {
                    const item = items.find((i) => i.item_id === itemId);
                    return (
                      <li key={itemId}>
                        {item?.display_name ?? itemId}:{" "}
                        {outcome.state === "draft_created" && outcome.proposal_id ? (
                          <Link to={`/proposals/${outcome.proposal_id}`}>черновик {outcome.document_id}</Link>
                        ) : (
                          <span className="onb-fail">не создан — {outcome.message}</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
                <p className="muted">
                  Черновики — в разделе <Link to="/proposals">Предложения</Link>: отправьте их на ревью; в базе знаний они появятся после merge и синхронизации.
                </p>
              </div>
            ) : null}
            {!closed ? (
              confirmCancel ? (
                <div className="onb-cancel">
                  <span>Отменить пакет? Загруженный текст будет удалён; созданные черновики останутся.</span>
                  <Button size="sm" variant="danger" disabled={busy !== null} onClick={() => void cancel()}>
                    Отменить пакет
                  </Button>
                  <Button size="sm" onClick={() => setConfirmCancel(false)}>
                    Не отменять
                  </Button>
                </div>
              ) : (
                <Button size="sm" variant="quiet" onClick={() => setConfirmCancel(true)}>
                  Отменить пакет…
                </Button>
              )
            ) : null}
          </section>
        </>
      ) : null}
    </div>
  );
}
