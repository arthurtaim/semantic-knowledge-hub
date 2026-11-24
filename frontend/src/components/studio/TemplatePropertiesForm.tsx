import { useEffect, useState, type ReactNode } from "react";
import type { DocType, StudioIssue, StudioOptions, TemplateSpec } from "../../api/types";
import { METADATA_FIELD_LABEL, TEMPLATE_STATUS_LABEL, TYPE_LABEL } from "../../lib/labels";
import { controlId, issuesFor, issuesUnder, listToText, textToList } from "../../lib/templateSpec";
import { Button, IconButton } from "../ui/Button";
import { describedBy, FieldIssues, hasError } from "./FieldIssues";

interface FormProps {
  spec: TemplateSpec;
  onChange: (change: Partial<TemplateSpec>) => void;
  issues: StudioIssue[];
  options: StudioOptions;
  /** The ID is chosen once, when the template is created. */
  idEditable: boolean;
  readOnly?: boolean;
}

interface TextFieldProps {
  field: keyof TemplateSpec;
  label: string;
  value: string;
  onChange: (value: string) => void;
  issues: StudioIssue[];
  required?: boolean;
  hint?: ReactNode;
  multiline?: number;
  maxLength: number;
  mono?: boolean;
  readOnly?: boolean;
  wide?: boolean;
  placeholder?: string;
}

function TextField({ field, label, value, onChange, issues, required, hint, multiline, maxLength, mono, readOnly, wide, placeholder }: TextFieldProps) {
  const id = controlId(field);
  const own = issuesFor(issues, field);
  const common = {
    id,
    value,
    maxLength,
    readOnly,
    placeholder,
    required,
    "aria-invalid": hasError(own) || undefined,
    "aria-describedby": describedBy(id, own, Boolean(hint)),
  };
  return (
    <div className={`field${wide ? " field--wide" : ""}`}>
      <label htmlFor={id}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>
      {multiline ? (
        <textarea {...common} rows={multiline} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input {...common} className={mono ? "field__mono" : undefined} spellCheck={mono ? false : undefined} onChange={(e) => onChange(e.target.value)} />
      )}
      {hint ? (
        <p id={`${id}-hint`} className="field__hint">
          {hint}
        </p>
      ) : null}
      <FieldIssues id={id} issues={own} />
    </div>
  );
}

/** A comma-separated list (labels, tags): the text is kept while typing, the list is what the spec stores. */
function ListField({ field, label, values, onChange, issues, hint, readOnly }: {
  field: "labels" | "default_tags";
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  issues: StudioIssue[];
  hint: string;
  readOnly?: boolean;
}) {
  const [text, setText] = useState(listToText(values));
  useEffect(() => {
    setText((current) => (JSON.stringify(textToList(current)) === JSON.stringify(values) ? current : listToText(values)));
  }, [values]);
  const id = controlId(field);
  const own = issuesFor(issues, field);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        value={text}
        readOnly={readOnly}
        onChange={(e) => {
          setText(e.target.value);
          onChange(textToList(e.target.value));
        }}
        aria-invalid={hasError(own) || undefined}
        aria-describedby={describedBy(id, own, true)}
      />
      <p id={`${id}-hint`} className="field__hint">
        {hint}
      </p>
      <FieldIssues id={id} issues={own} />
    </div>
  );
}

type Usage = "required" | "optional" | "unused";

/**
 * The properties of a template: catalogue fields (corrected in place, no new version) and schema fields (a new
 * version on activation). Errors of the server check are shown under each field.
 */
export function TemplatePropertiesForm({ spec, onChange, issues, options, idEditable, readOnly = false }: FormProps) {
  const prefixOwner = options.prefixes[spec.id_prefix.trim().toUpperCase()];
  const fields = ["title", "owner", ...options.metadata_fields.filter((f) => f !== "title" && f !== "owner")];
  const usage = (f: string): Usage =>
    spec.required_metadata.includes(f) ? "required" : spec.optional_metadata.includes(f) ? "optional" : "unused";

  function setUsage(f: string, value: Usage) {
    const required = spec.required_metadata.filter((x) => x !== f);
    const optional = spec.optional_metadata.filter((x) => x !== f);
    if (value === "required") required.push(f);
    if (value === "optional") optional.push(f);
    onChange({ required_metadata: required, optional_metadata: optional });
  }

  const metadataIssues = [...issuesFor(issues, "required_metadata"), ...issuesFor(issues, "optional_metadata")];
  const ruleIssues = issuesUnder(issues, "validation");
  const typeId = controlId("doc_type");
  const typeIssues = issuesFor(issues, "doc_type");
  const statusId = controlId("status");

  return (
    <div className="studio-form">
      <section className="studio-form__group" aria-labelledby="tpl-group-main">
        <h2 id="tpl-group-main">Основное</h2>
        <div className="authoring__grid">
          <TextField field="title" label="Название" required value={spec.title} onChange={(title) => onChange({ title })} issues={issues} maxLength={200} readOnly={readOnly} />
          <TextField
            field="template_id"
            label="ID шаблона"
            required
            mono
            value={spec.template_id}
            onChange={(template_id) => onChange({ template_id: template_id.trim() })}
            issues={issues}
            maxLength={41}
            readOnly={readOnly || !idEditable}
            hint={idEditable ? "Латиница, цифры и «_»; не меняется после создания." : "ID шаблона не меняется."}
          />
          <div className="field">
            <label htmlFor={typeId}>
              Тип документа<span aria-hidden="true"> *</span>
            </label>
            <select
              id={typeId}
              value={spec.doc_type}
              disabled={readOnly}
              onChange={(e) => onChange({ doc_type: e.target.value })}
              aria-invalid={hasError(typeIssues) || undefined}
              aria-describedby={describedBy(typeId, typeIssues, true)}
            >
              {options.doc_types.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t as DocType] ?? t}
                </option>
              ))}
            </select>
            <p id={`${typeId}-hint`} className="field__hint">
              Раздел каталога, в который попадут документы.
            </p>
            <FieldIssues id={typeId} issues={typeIssues} />
          </div>
          <TextField
            field="id_prefix"
            label="Префикс ID документов"
            required
            mono
            value={spec.id_prefix}
            onChange={(id_prefix) => onChange({ id_prefix: id_prefix.toUpperCase() })}
            issues={issues}
            maxLength={40}
            readOnly={readOnly}
            placeholder="SEM-XXX"
            hint={
              prefixOwner && prefixOwner !== spec.template_id
                ? `Префикс уже у шаблона «${prefixOwner}».`
                : `Документы получат ID вида ${spec.id_prefix.trim() || "SEM-XXX"}-001.`
            }
          />
          <TextField field="category" label="Категория" value={spec.category} onChange={(category) => onChange({ category })} issues={issues} maxLength={80} readOnly={readOnly} placeholder="Например: Интеграции" />
          <TextField field="owner" label="Владелец шаблона" value={spec.owner} onChange={(owner) => onChange({ owner })} issues={issues} maxLength={80} readOnly={readOnly} placeholder="команда или роль" />
          <TextField field="description" label="Описание" value={spec.description} onChange={(description) => onChange({ description })} issues={issues} maxLength={600} multiline={2} wide readOnly={readOnly} />
          <ListField field="labels" label="Метки шаблона" values={spec.labels} onChange={(labels) => onChange({ labels })} issues={issues} hint="Через запятую: по ним шаблон находят в каталоге." readOnly={readOnly} />
          <ListField field="default_tags" label="Теги новых документов" values={spec.default_tags} onChange={(default_tags) => onChange({ default_tags })} issues={issues} hint="Через запятую: документ получит их при создании." readOnly={readOnly} />
          <div className="field">
            <label htmlFor={statusId}>Статус версии</label>
            <select id={statusId} value={spec.status} disabled={readOnly} onChange={(e) => onChange({ status: e.target.value as TemplateSpec["status"] })} aria-describedby={`${statusId}-hint`}>
              {options.statuses.map((s) => (
                <option key={s} value={s}>
                  {TEMPLATE_STATUS_LABEL[s] ?? s}
                </option>
              ))}
            </select>
            <p id={`${statusId}-hint`} className="field__hint">
              «Устарел» и «В архиве» — новые документы по шаблону не создаются.
            </p>
          </div>
        </div>
      </section>

      <section className="studio-form__group" aria-labelledby="tpl-group-fields">
        <h2 id="tpl-group-fields">Поля метаданных</h2>
        <p className="muted">ID, статус, раздел, шаблон и его версию выставляет сервер. Здесь — что автор обязан заполнить.</p>
        <div id={controlId("required_metadata")} tabIndex={-1}>
          <FieldIssues id={controlId("required_metadata")} issues={metadataIssues} />
        </div>
        <ul className="studio-metadata" aria-label="Поля метаданных документа">
          {fields.map((f) => {
            const id = `tpl-meta-${f}`;
            return (
              <li key={f} className="studio-metadata__row">
                <label htmlFor={id}>
                  {METADATA_FIELD_LABEL[f] ?? f} <code className="doc-id">{f}</code>
                </label>
                <select id={id} value={usage(f)} disabled={readOnly || f === "title"} onChange={(e) => setUsage(f, e.target.value as Usage)}>
                  <option value="required">Обязательное</option>
                  <option value="optional">Необязательное</option>
                  <option value="unused">Не используется</option>
                </select>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="studio-form__group" aria-labelledby="tpl-group-rules">
        <h2 id="tpl-group-rules">Правила проверки полноты</h2>
        <p className="muted">Короткие проверяемые утверждения: их видят автор, ревьюер и ИИ («Указана частота обмена»).</p>
        <div id={controlId("validation")} tabIndex={-1}>
          <FieldIssues id={controlId("validation")} issues={issuesFor(issues, "validation")} />
        </div>
        <ol className="studio-rules">
          {spec.validation.map((rule, index) => {
            const field = `validation.${index}`;
            const id = controlId(field);
            const own = ruleIssues.filter((i) => i.field === field);
            return (
              <li key={index} className="studio-rules__row">
                <div className="field">
                  <label htmlFor={id} className="visually-hidden">
                    Правило {index + 1}
                  </label>
                  <input
                    id={id}
                    value={rule}
                    maxLength={300}
                    readOnly={readOnly}
                    onChange={(e) => onChange({ validation: spec.validation.map((r, i) => (i === index ? e.target.value : r)) })}
                    aria-invalid={hasError(own) || undefined}
                    aria-describedby={describedBy(id, own)}
                  />
                  <FieldIssues id={id} issues={own} />
                </div>
                {readOnly ? null : (
                  <IconButton icon="close" size="sm" label={`Удалить правило ${index + 1}`} onClick={() => onChange({ validation: spec.validation.filter((_, i) => i !== index) })} />
                )}
              </li>
            );
          })}
        </ol>
        {readOnly ? null : (
          <Button icon="plus" size="sm" onClick={() => onChange({ validation: [...spec.validation, ""] })} disabled={spec.validation.length >= 30}>
            Добавить правило
          </Button>
        )}
      </section>

      <section className="studio-form__group" aria-labelledby="tpl-group-guide">
        <h2 id="tpl-group-guide">Указания и пример</h2>
        <div className="authoring__grid">
          <TextField field="instructions" label="Инструкции для автора" value={spec.instructions} onChange={(instructions) => onChange({ instructions })} issues={issues} maxLength={2000} multiline={3} wide readOnly={readOnly} />
          <TextField
            field="ai_guidance"
            label="Указания для ИИ"
            value={spec.ai_guidance}
            onChange={(ai_guidance) => onChange({ ai_guidance })}
            issues={issues}
            maxLength={2000}
            multiline={3}
            wide
            readOnly={readOnly}
            hint="ИИ получает их как данные шаблона, не как системную инструкцию."
          />
          <TextField field="example" label="Пример заполненного документа (Markdown, синтетический)" value={spec.example} onChange={(example) => onChange({ example })} issues={issues} maxLength={3000} multiline={5} wide readOnly={readOnly} />
        </div>
      </section>

      <section className="studio-form__group" aria-labelledby="tpl-group-version">
        <h2 id="tpl-group-version">Эта версия</h2>
        <div className="authoring__grid">
          <TextField field="changes" label="Что изменилось" value={spec.changes} onChange={(changes) => onChange({ changes })} issues={issues} maxLength={800} multiline={2} wide readOnly={readOnly} hint="Видно в истории версий и при сравнении." />
          <div className="field field--wide">
            <label className="studio-check">
              <input id={controlId("breaking")} type="checkbox" checked={spec.breaking} disabled={readOnly} onChange={(e) => onChange({ breaking: e.target.checked })} />
              Несовместимая версия: документам по прошлой версии нужен ручной переход
            </label>
          </div>
          {spec.breaking || spec.migration ? (
            <TextField field="migration" label="Как перевести документ на эту версию" required={spec.breaking} value={spec.migration} onChange={(migration) => onChange({ migration })} issues={issues} maxLength={1500} multiline={3} wide readOnly={readOnly} />
          ) : null}
        </div>
      </section>
    </div>
  );
}
