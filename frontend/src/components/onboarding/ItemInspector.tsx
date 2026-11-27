import { useEffect, useId, useState } from "react";
import { ApiError, api } from "../../api/client";
import type { DocType, OnboardingField, OnboardingItemDetail, OnboardingItemPatch } from "../../api/types";
import { TYPE_LABEL } from "../../lib/labels";
import { DiffView } from "../DiffView";
import { ErrorState, Loading, Notice } from "../Feedback";
import { SafeHtml } from "../SafeHtml";
import { Button } from "../ui/Button";

/*
 * M8 (docs/KNOWLEDGE_ONBOARDING.md): one staged file — diagnostics, the sanitized preview (raw bytes are never
 * rendered), every suggestion with its origin and evidence, relation candidates (unchecked unless the author declared
 * them in YAML), and the person's decisions saved with the item revision (a stale edit is refused, nothing is lost).
 * Model suggestions are never applied by themselves: «Принять» turns one into the person's value.
 */

export const ORIGIN_LABEL: Record<string, string> = {
  frontmatter: "из YAML файла",
  parser: "из текста",
  heuristic: "по правилам",
  model: "предложение ИИ",
  user: "изменено вами",
  system: "выделит сервер",
};
const RESOLVE_LABEL: Record<string, string> = {
  resolved: "найден в базе",
  in_batch: "в этом пакете",
  missing: "не найден",
  ambiguous: "неоднозначно",
};
const KIND_LABEL: Record<string, string> = {
  wikilink: "ссылка [[…]]",
  related_id: "related_ids в YAML",
  mention: "упоминание ID",
  similar: "похожий документ",
};
const EDITABLE = ["title", "type", "owner", "tags", "summary", "template_id"] as const;
type Editable = (typeof EDITABLE)[number];
const FIELD_LABEL: Record<Editable, string> = {
  title: "Название",
  type: "Тип",
  owner: "Владелец",
  tags: "Теги",
  summary: "Краткое описание",
  template_id: "Шаблон",
};

function asText(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(", ");
  return value === null || value === undefined ? "" : String(value);
}

function current(fields: OnboardingField[], name: string): OnboardingField | undefined {
  return fields.find((f) => f.field === name && f.origin === "user") ?? fields.find((f) => f.field === name && f.origin !== "model");
}

interface Props {
  batchId: string;
  itemId: string;
  templates: { id: string; title: string }[];
  locked: boolean;
  onChanged: () => void;
  onClose: () => void;
}

export function ItemInspector({ batchId, itemId, templates, locked, onChanged, onClose }: Props) {
  const id = useId();
  const [detail, setDetail] = useState<OnboardingItemDetail | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [links, setLinks] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function adopt(item: OnboardingItemDetail) {
    setDetail(item);
    setDraft(Object.fromEntries(EDITABLE.map((name) => [name, asText(current(item.fields, name)?.value)])));
    setLinks(new Set(item.candidate_links.filter((l) => l.selected_by_user).map((l) => l.link_id)));
  }

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setError(null);
    setMessage(null);
    api
      .onboardingItem(batchId, itemId)
      .then((item) => alive && adopt(item))
      .catch((err: unknown) => alive && setError(err instanceof ApiError ? err : new ApiError(0, "network_error", "Нет связи с сервером.", null)));
    return () => {
      alive = false;
    };
  }, [batchId, itemId]);

  async function save(patch: Omit<OnboardingItemPatch, "expected_revision">, note: string) {
    if (!detail || saving) return;
    setSaving(true);
    setMessage(null);
    try {
      const next = await api.onboardingPatchItem(batchId, itemId, { expected_revision: detail.revision, ...patch });
      adopt(next);
      setMessage(note);
      onChanged();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setMessage("Файл уже изменили в другой вкладке: обновите страницу, ваши правки не сохранены.");
      else setMessage(err instanceof ApiError ? err.message : "Не удалось сохранить.");
    } finally {
      setSaving(false);
    }
  }

  function saveFields() {
    if (!detail) return;
    const fields: Record<string, unknown> = {};
    for (const name of EDITABLE) {
      const before = asText(current(detail.fields, name)?.value);
      const value = draft[name] ?? "";
      if (value === before) continue;
      fields[name] = name === "tags" ? value.split(",").map((t) => t.trim()).filter(Boolean) : value || null;
    }
    const selected = [...links];
    void save({ fields, selected_links: selected, reviewed: true }, "Решения сохранены, файл отмечен как проверенный.");
  }

  if (error) return <ErrorState error={error} title="Файл не открывается" />;
  if (!detail) return <Loading label="Открываю файл…" />;
  const update = detail.proposed_operation === "update";
  const importable = detail.parse_status !== "invalid" && detail.parse_status !== "unsupported";
  const editable = importable && !locked && !detail.outcome;
  const modelFields = detail.fields.filter((f) => f.origin === "model");

  return (
    <section className="onb-inspector" aria-label={`Файл ${detail.path}`}>
      <div className="onb-inspector__head">
        <h2 className="onb-inspector__title">{detail.display_name}</h2>
        <Button size="sm" onClick={onClose}>
          Закрыть
        </Button>
      </div>
      <p className="muted onb-inspector__path">
        {detail.path} · {detail.parser} · {Math.max(1, Math.round(detail.size / 1024))} КБ
      </p>
      {detail.diagnostics.length > 0 ? (
        <ul className="onb-diagnostics" aria-label="Диагностика">
          {detail.diagnostics.map((d, n) => (
            <li key={`${d.code}-${n}`} className={`onb-diag onb-diag--${d.severity}`}>
              <strong>{d.severity === "error" ? "Ошибка" : d.severity === "warning" ? "Внимание" : "Сведения"}:</strong> {d.message}
            </li>
          ))}
        </ul>
      ) : null}
      {detail.duplicates.map((dup, n) => (
        <Notice key={`${dup.kind}-${n}`} tone="warning">
          {dup.message}
        </Notice>
      ))}
      {update && detail.existing_doc ? (
        <Notice tone="info">
          Изменение существующего документа {detail.existing_doc.document_id} «{detail.existing_doc.title}»: черновик пройдёт обычное
          ревью изменения, документ не заменяется. Поля правятся в черновике после создания.
        </Notice>
      ) : null}
      {detail.outcome ? (
        <Notice tone={detail.outcome.state === "draft_created" ? "success" : "danger"}>
          {detail.outcome.state === "draft_created" ? `Черновик создан: ${detail.outcome.document_id ?? ""}` : `Черновик не создан: ${detail.outcome.message ?? ""}`}
        </Notice>
      ) : null}

      {importable ? (
        <>
          <h3 className="onb-inspector__sub">Метаданные</h3>
          <div className="onb-fields">
            {EDITABLE.map((name) => {
              const suggestion = current(detail.fields, name);
              const inputId = `${id}-${name}`;
              return (
                <div key={name} className="field onb-field">
                  <label htmlFor={inputId}>{FIELD_LABEL[name]}</label>
                  {name === "type" ? (
                    <select id={inputId} value={draft[name] ?? ""} disabled={!editable || update} onChange={(e) => setDraft({ ...draft, [name]: e.target.value })}>
                      <option value="">— по шаблону —</option>
                      {(Object.keys(TYPE_LABEL) as DocType[]).map((t) => (
                        <option key={t} value={t}>
                          {TYPE_LABEL[t]}
                        </option>
                      ))}
                    </select>
                  ) : name === "template_id" ? (
                    <select id={inputId} value={draft[name] ?? ""} disabled={!editable || update} onChange={(e) => setDraft({ ...draft, [name]: e.target.value })}>
                      <option value="">Без шаблона</option>
                      {templates.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.title}
                        </option>
                      ))}
                    </select>
                  ) : name === "summary" ? (
                    <textarea id={inputId} rows={2} value={draft[name] ?? ""} disabled={!editable || update} onChange={(e) => setDraft({ ...draft, [name]: e.target.value })} />
                  ) : (
                    <input id={inputId} value={draft[name] ?? ""} disabled={!editable || update} onChange={(e) => setDraft({ ...draft, [name]: e.target.value })} />
                  )}
                  {suggestion ? (
                    <span className="onb-origin">
                      {ORIGIN_LABEL[suggestion.origin] ?? suggestion.origin}
                      {suggestion.evidence[0]?.snippet && suggestion.evidence[0].snippet !== ORIGIN_LABEL[suggestion.origin]
                        ? ` · «${suggestion.evidence[0].snippet}»`
                        : ""}
                    </span>
                  ) : (
                    <span className="onb-origin onb-origin--missing">не определено</span>
                  )}
                </div>
              );
            })}
          </div>
          {modelFields.length > 0 ? (
            <div className="onb-model">
              <h3 className="onb-inspector__sub">Предложения ИИ (не проверены)</h3>
              <ul>
                {modelFields.map((f) => (
                  <li key={`${f.field}-${asText(f.value)}`}>
                    <span>
                      {FIELD_LABEL[f.field as Editable] ?? f.field}: <strong>{asText(f.value)}</strong>
                      {f.confidence !== null ? ` · уверенность ${Math.round(f.confidence * 100)}%` : ""}
                      {f.evidence[0]?.snippet ? ` · опора: «${f.evidence[0].snippet}»` : ""}
                    </span>
                    {editable && !update && (EDITABLE as readonly string[]).includes(f.field) ? (
                      <Button size="sm" onClick={() => setDraft({ ...draft, [f.field]: asText(f.value) })}>
                        Принять
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {detail.ai_note ? <p className="muted">{detail.ai_note}</p> : null}

          <h3 className="onb-inspector__sub">Кандидаты связей</h3>
          {detail.candidate_links.length === 0 ? (
            <p className="muted">Связей в тексте не найдено.</p>
          ) : (
            <ul className="onb-links" aria-label="Кандидаты связей">
              {detail.candidate_links.map((link) => {
                const selectable = link.resolve_state === "resolved" || link.resolve_state === "in_batch";
                return (
                  <li key={link.link_id}>
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        checked={links.has(link.link_id)}
                        disabled={!editable || update || !selectable}
                        onChange={(e) => {
                          const next = new Set(links);
                          if (e.target.checked) next.add(link.link_id);
                          else next.delete(link.link_id);
                          setLinks(next);
                        }}
                      />{" "}
                      {link.target_document_id}
                      {link.target_title ? ` «${link.target_title}»` : ""} — {KIND_LABEL[link.link_kind]}, {RESOLVE_LABEL[link.resolve_state]}
                    </label>
                    <span className="onb-evidence">
                      {link.evidence.line ? `строка ${link.evidence.line}: ` : ""}«{link.evidence.snippet}»
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="muted onb-links__note">Связь — только кандидат: в графе она появится после ревью, merge и синхронизации документа.</p>

          {editable ? (
            <div className="onb-inspector__actions">
              {!update ? (
                <Button variant="primary" onClick={saveFields} disabled={saving}>
                  Сохранить решения
                </Button>
              ) : (
                <Button variant="primary" onClick={() => void save({ reviewed: true }, "Файл отмечен как проверенный.")} disabled={saving}>
                  Отметить проверенным
                </Button>
              )}
              <Button onClick={() => void save({ excluded: !detail.excluded }, detail.excluded ? "Файл возвращён в импорт." : "Файл исключён из импорта.")} disabled={saving}>
                {detail.excluded ? "Вернуть в импорт" : "Исключить из импорта"}
              </Button>
            </div>
          ) : null}
          {message ? (
            <p className="onb-message" role="status">
              {message}
            </p>
          ) : null}

          <h3 className="onb-inspector__sub">{update ? "Изменения относительно текущей версии" : "Предпросмотр"}</h3>
          {update && detail.diff ? (
            <DiffView
              diff={{ unified: "", lines: detail.diff, additions: detail.diff_stats?.additions ?? 0, deletions: detail.diff_stats?.deletions ?? 0, changed: true }}
              label="Изменения файла относительно текущей версии"
            />
          ) : detail.preview_html ? (
            <SafeHtml html={detail.preview_html} className="prose onb-preview" />
          ) : (
            <pre className="onb-preview onb-preview--plain">{detail.body_preview}</pre>
          )}
        </>
      ) : null}
    </section>
  );
}
