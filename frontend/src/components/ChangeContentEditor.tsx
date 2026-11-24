import { useRef, useState } from "react";
import { frontMatterSummary, splitFrontMatter } from "../lib/frontMatter";
import { pluralRu } from "../lib/labels";
import { MarkdownToolbar } from "./MarkdownToolbar";
import { WikiLinkTextarea } from "./WikiLinkTextarea";

interface Props {
  /** The full document text (front matter + Markdown body): what the proposal stores. */
  value: string;
  onChange: (value: string) => void;
}

/**
 * Editor of a CHANGE proposal without YAML in the way: the author edits the Markdown body (toolbar, `[[`
 * links); the metadata block is kept byte for byte and shown as a read-only summary. Advanced users can
 * switch to the whole source text with the YAML header.
 */
export function ChangeContentEditor({ value, onChange }: Props) {
  const [source, setSource] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const { frontMatter, body } = splitFrontMatter(value);
  const summary = frontMatterSummary(frontMatter);

  return (
    <div className="change-editor">
      <div className="change-editor__head">
        <label htmlFor={source ? "content-source" : "content"}>
          {source ? "Исходный текст с метаданными (YAML)" : "Текст документа"}
        </label>
        {frontMatter ? (
          <button
            type="button"
            className="button button--quiet change-editor__toggle"
            aria-pressed={source}
            onClick={() => setSource((on) => !on)}
          >
            {source ? "Вернуться к тексту без YAML" : "Показать исходный текст с YAML"}
          </button>
        ) : null}
      </div>

      {source ? (
        <>
          <p id="content-source-hint" className="field-hint">
            Для опытных: метаданные в YAML-заголовке меняются здесь. Предложение проверит их перед ревью.
          </p>
          <textarea
            id="content-source"
            className="editor__source"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            rows={22}
            spellCheck={false}
            aria-describedby="content-source-hint"
          />
        </>
      ) : (
        <>
          <p id="content-hint" className="field-hint">
            Markdown без YAML: метаданные документа сохраняются как есть. Ссылка на документ — наберите [[ и часть ID
            или названия.
          </p>
          <MarkdownToolbar textareaRef={bodyRef} value={body} onChange={(next) => onChange(frontMatter + next)} />
          <WikiLinkTextarea
            id="content"
            textareaRef={bodyRef}
            className="editor__source"
            value={body}
            onValueChange={(next) => onChange(frontMatter + next)}
            rows={22}
            spellCheck={false}
            aria-describedby="content-hint"
          />
          {frontMatter ? (
            <details className="change-editor__meta">
              <summary>Метаданные документа</summary>
              {summary.fields.length > 0 ? (
                <dl className="meta-grid">
                  {summary.fields.map((field) => (
                    <div key={field.key}>
                      <dt>{field.label}</dt>
                      <dd>{field.key === "id" ? <code className="doc-id">{field.value}</code> : field.value}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              {summary.other > 0 ? (
                <p className="muted">
                  Ещё {summary.other} {pluralRu(summary.other, "поле", "поля", "полей")} (связи, списки) — в исходном
                  тексте с YAML.
                </p>
              ) : null}
            </details>
          ) : null}
        </>
      )}
    </div>
  );
}
