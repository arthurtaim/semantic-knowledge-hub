import type { TemplateComparison } from "../../api/types";
import { METADATA_FIELD_LABEL, TEMPLATE_FIELD_LABEL } from "../../lib/labels";
import { DiffView } from "../DiffView";
import { Notice } from "../Feedback";

function fieldName(field: string): string {
  return METADATA_FIELD_LABEL[field] ? `${METADATA_FIELD_LABEL[field]} (${field})` : field;
}

function ChangeList({ title, items, tone }: { title: string; items: string[]; tone: "add" | "remove" | "neutral" }) {
  if (items.length === 0) return null;
  return (
    <div className="compare__group">
      <h3>{title}</h3>
      <ul className={`compare__list compare__list--${tone}`}>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Two versions of a template (or a version and the open draft): structure, required fields, rules, status, the
 * fields that changed and the line diff of the template source.
 */
export function TemplateComparisonView({ result }: { result: TemplateComparison }) {
  const structural = [
    result.sections_added,
    result.sections_removed,
    result.became_required,
    result.became_optional,
    result.metadata_required_added,
    result.metadata_required_removed,
    result.validation_added,
    result.validation_removed,
  ].every((list) => list.length === 0);
  const empty = structural && !result.status_change;
  const fields = (result.fields_changed ?? []).map((f) => TEMPLATE_FIELD_LABEL[f] ?? f);
  return (
    <div className="compare__result" aria-live="polite">
      <p className="compare__title">
        <strong>
          v{result.from_version} → {result.to_draft ? `черновик (v${result.to_version})` : `v${result.to_version}`}
        </strong>
        {result.breaking ? <span className="breaking-badge">несовместимое изменение</span> : null}
      </p>
      {result.changes ? <p>{result.changes}</p> : null}
      {empty ? <p className="muted">Структура, обязательные поля и правила не различаются.</p> : null}
      <ChangeList title="Добавлены разделы" items={result.sections_added} tone="add" />
      <ChangeList title="Удалены разделы" items={result.sections_removed} tone="remove" />
      <ChangeList title="Стали обязательными" items={result.became_required} tone="add" />
      <ChangeList title="Стали необязательными" items={result.became_optional} tone="neutral" />
      <ChangeList title="Новые обязательные поля" items={result.metadata_required_added.map(fieldName)} tone="add" />
      <ChangeList title="Поля больше не обязательны" items={result.metadata_required_removed.map(fieldName)} tone="remove" />
      <ChangeList title="Новые правила проверки" items={result.validation_added} tone="add" />
      <ChangeList title="Удалённые правила проверки" items={result.validation_removed} tone="remove" />
      {result.status_change ? <p>Статус шаблона: {result.status_change}</p> : null}
      {fields.length > 0 ? (
        <p className="compare__fields">
          Изменённые поля: <span>{fields.join(", ")}</span>
        </p>
      ) : null}
      {result.migration ? (
        <Notice tone="warning">
          <p>
            <strong>Переход на новую версию</strong> — отдельная правка на ревью; существующие документы остаются валидными
            по своей версии.
          </p>
          <p>{result.migration}</p>
        </Notice>
      ) : null}
      {result.source_diff && result.source_diff.changed ? (
        <details className="compare__source">
          <summary>Изменения в тексте шаблона</summary>
          <DiffView diff={result.source_diff} label="Изменения в тексте шаблона" />
        </details>
      ) : null}
    </div>
  );
}
