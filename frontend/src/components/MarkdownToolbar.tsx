import type { RefObject } from "react";
import { applyMarkdown, type MarkdownAction } from "../lib/markdownEdit";

const ACTIONS: { action: MarkdownAction; label: string; hint: string }[] = [
  { action: "heading", label: "Заголовок", hint: "Сделать строку заголовком раздела (##)" },
  { action: "bullets", label: "Список", hint: "Маркированный список" },
  { action: "numbers", label: "Нумерация", hint: "Нумерованный список" },
  { action: "table", label: "Таблица", hint: "Вставить таблицу" },
  { action: "link", label: "Ссылка", hint: "Вставить ссылку" },
  { action: "code", label: "Код", hint: "Блок кода" },
];

interface Props {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

/** Inserts Markdown at the cursor of the editor textarea and returns focus to it. */
export function MarkdownToolbar({ textareaRef, value, onChange, disabled = false }: Props) {
  function apply(action: MarkdownAction) {
    const el = textareaRef.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const result = applyMarkdown(action, value, start, end);
    onChange(result.text);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(result.selectionStart, result.selectionEnd);
    });
  }

  return (
    <div className="md-toolbar" role="group" aria-label="Форматирование Markdown">
      {ACTIONS.map((item) => (
        <button
          key={item.action}
          type="button"
          className="md-toolbar__button"
          title={item.hint}
          disabled={disabled}
          onClick={() => apply(item.action)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
