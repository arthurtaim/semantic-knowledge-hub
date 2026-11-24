import { useEffect, useState, type KeyboardEvent } from "react";
import type { StudioIssue, TemplateSectionSpec } from "../../api/types";
import { controlId, emptySection, issuesFor, moveItem } from "../../lib/templateSpec";
import { Button, IconButton } from "../ui/Button";
import { describedBy, FieldIssues, hasError } from "./FieldIssues";

type Control = "title" | "required" | "hint" | "content" | "up" | "down" | "remove";

interface SectionBuilderProps {
  sections: TemplateSectionSpec[];
  onChange: (sections: TemplateSectionSpec[]) => void;
  issues: StudioIssue[];
  maxSections: number;
  readOnly?: boolean;
}

const rowControl = (index: number, control: Control) => `${controlId(`sections.${index}`)}-${control}`;

/**
 * The visual section builder: add, remove and reorder sections (buttons, and Alt+↑ / Alt+↓ inside a section), mark
 * them required or optional, give the author a hint. It edits the same `sections` the Markdown editor shows.
 */
export function SectionBuilder({ sections, onChange, issues, maxSections, readOnly = false }: SectionBuilderProps) {
  const [focus, setFocus] = useState<{ index: number; control: Control } | null>(null);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    if (!focus) return;
    const id = focus.control === "title" ? controlId(`sections.${focus.index}.title`) : rowControl(focus.index, focus.control);
    const target = document.getElementById(id);
    // A move button at the edge is disabled: keep the focus in the section on its title.
    if (target && !(target as HTMLButtonElement).disabled) target.focus();
    else document.getElementById(controlId(`sections.${focus.index}.title`))?.focus();
    setFocus(null);
  }, [focus]);

  const name = (s: TemplateSectionSpec, i: number) => (s.title.trim() ? `«${s.title.trim()}»` : `№${i + 1}`);

  function update(index: number, change: Partial<TemplateSectionSpec>) {
    onChange(sections.map((s, i) => (i === index ? { ...s, ...change } : s)));
  }

  function move(index: number, to: number, control: Control) {
    if (to < 0 || to >= sections.length) return;
    const section = sections[index];
    onChange(moveItem(sections, index, to));
    setFocus({ index: to, control });
    if (section) setAnnouncement(`Раздел ${name(section, index)} перемещён: позиция ${to + 1} из ${sections.length}.`);
  }

  function remove(index: number) {
    const section = sections[index];
    onChange(sections.filter((_, i) => i !== index));
    if (section) setAnnouncement(`Раздел ${name(section, index)} удалён.`);
    if (sections.length > 1) setFocus({ index: Math.min(index, sections.length - 2), control: "title" });
    else document.getElementById("tpl-add-section")?.focus();
  }

  function add() {
    onChange([...sections, emptySection()]);
    setFocus({ index: sections.length, control: "title" });
    setAnnouncement(`Добавлен раздел ${sections.length + 1}.`);
  }

  function onKeyDown(event: KeyboardEvent<HTMLLIElement>, index: number) {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown") || readOnly) return;
    event.preventDefault();
    const control = ((event.target as HTMLElement).dataset.control as Control | undefined) ?? "title";
    move(index, event.key === "ArrowUp" ? index - 1 : index + 1, control);
  }

  const groupIssues = issuesFor(issues, "sections");
  return (
    <div className="studio-builder">
      <p className="muted studio-builder__note" id="tpl-builder-note">
        Порядок разделов — порядок в документе. Переставить раздел: кнопки справа или Alt+↑ / Alt+↓ внутри раздела.
        Обязательный раздел проверяется при сохранении документа; необязательный можно не заполнять.
      </p>
      <div id={controlId("sections")} tabIndex={-1}>
        <FieldIssues id={controlId("sections")} issues={groupIssues} />
      </div>
      <ol className="studio-sections" aria-label="Разделы шаблона" aria-describedby="tpl-builder-note">
        {sections.map((section, index) => {
          const titleIssues = issuesFor(issues, `sections.${index}.title`);
          const hintIssues = issuesFor(issues, `sections.${index}.hint`);
          const contentIssues = issuesFor(issues, `sections.${index}.content`);
          const titleId = controlId(`sections.${index}.title`);
          const hintId = controlId(`sections.${index}.hint`);
          const contentId = controlId(`sections.${index}.content`);
          const label = name(section, index);
          return (
            <li
              key={index}
              className={`studio-section${section.required ? "" : " studio-section--optional"}`}
              onKeyDown={(event) => onKeyDown(event, index)}
              aria-label={`Раздел ${index + 1}: ${section.title.trim() || "без названия"}`}
            >
              <div className="studio-section__head">
                <span className="studio-section__no" aria-hidden="true">
                  {index + 1}
                </span>
                <div className="field studio-section__title">
                  <label htmlFor={titleId}>Название раздела</label>
                  <input
                    id={titleId}
                    data-control="title"
                    value={section.title}
                    onChange={(e) => update(index, { title: e.target.value })}
                    maxLength={200}
                    readOnly={readOnly}
                    aria-invalid={hasError(titleIssues) || undefined}
                    aria-describedby={describedBy(titleId, titleIssues)}
                  />
                  <FieldIssues id={titleId} issues={titleIssues} />
                </div>
                <label className="studio-section__required">
                  <input
                    id={rowControl(index, "required")}
                    data-control="required"
                    type="checkbox"
                    checked={section.required}
                    disabled={readOnly}
                    onChange={(e) => update(index, { required: e.target.checked })}
                  />
                  Обязательный
                </label>
                <div className="studio-section__actions">
                  <IconButton
                    id={rowControl(index, "up")}
                    data-control="up"
                    icon="chevron"
                    className="studio-section__move-up"
                    label={`Поднять раздел ${label}`}
                    size="sm"
                    disabled={readOnly || index === 0}
                    onClick={() => move(index, index - 1, "up")}
                  />
                  <IconButton
                    id={rowControl(index, "down")}
                    data-control="down"
                    icon="chevron"
                    label={`Опустить раздел ${label}`}
                    size="sm"
                    disabled={readOnly || index === sections.length - 1}
                    onClick={() => move(index, index + 1, "down")}
                  />
                  <IconButton
                    id={rowControl(index, "remove")}
                    data-control="remove"
                    icon="close"
                    label={`Удалить раздел ${label}`}
                    size="sm"
                    disabled={readOnly}
                    onClick={() => remove(index)}
                  />
                </div>
              </div>
              <div className="field studio-section__hint">
                <label htmlFor={hintId}>Подсказка автору</label>
                <input
                  id={hintId}
                  data-control="hint"
                  value={section.hint}
                  onChange={(e) => update(index, { hint: e.target.value.replace(/\n/g, " ") })}
                  maxLength={500}
                  readOnly={readOnly}
                  placeholder="Что написать в разделе — попадёт в «Требует уточнения: …»"
                  aria-invalid={hasError(hintIssues) || undefined}
                  aria-describedby={describedBy(hintId, hintIssues)}
                />
                <FieldIssues id={hintId} issues={hintIssues} />
              </div>
              <details className="studio-section__content" open={section.content.trim() !== "" || contentIssues.length > 0}>
                <summary>Заготовка текста (необязательно)</summary>
                <div className="field">
                  <label htmlFor={contentId}>Markdown после подсказки: таблица, список</label>
                  <textarea
                    id={contentId}
                    data-control="content"
                    rows={3}
                    value={section.content}
                    onChange={(e) => update(index, { content: e.target.value })}
                    maxLength={4000}
                    readOnly={readOnly}
                    aria-invalid={hasError(contentIssues) || undefined}
                    aria-describedby={describedBy(contentId, contentIssues)}
                  />
                  <FieldIssues id={contentId} issues={contentIssues} />
                </div>
              </details>
            </li>
          );
        })}
      </ol>
      {readOnly ? null : (
        <Button id="tpl-add-section" icon="plus" onClick={add} disabled={sections.length >= maxSections}>
          Добавить раздел
        </Button>
      )}
      <p className="visually-hidden" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}
