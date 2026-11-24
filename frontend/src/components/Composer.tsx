import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import { api, isCancelled } from "../api/client";
import type { AssistantSkill, SearchResult } from "../api/types";
import { AI_CHIP_LABEL, canAsk } from "../lib/aiMode";
import {
  ATTACHMENT_ACCEPT,
  MISSING_INPUT_HINT,
  SCOPE_OPTIONS,
  SKILL_ACCESS_LABEL,
  extensionOf,
  filesSummary,
  formatBytes,
  missingInput,
  scopeLabel,
} from "../lib/assistant";
import { pluralRu } from "../lib/labels";
import { useSession } from "../lib/session";
import { MAX_CONTEXT_DOCUMENTS, type ComposerController, type ComposerFile, type ComposerMessage } from "../lib/useComposer";
import { useSkills, type SkillsState } from "../lib/useSkills";
import { Chip } from "./ui/Chip";
import { Icon, type IconName } from "./ui/Icon";
import { Popover } from "./ui/Popover";
import { StatusMark } from "./ui/StatusMark";

/*
 * The assistant field (docs/ui-v2/specs/02_ASSISTANT.md §3, design-07): one component on the home page, at the
 * bottom of the dialog and (compact) in a document's assistant panel. Chips above the text (a skill — green, at
 * most one — files of this dialog, documents, a selection); «Файл» / drag-and-drop / paste; «Навык» / «/» at the
 * start of a line; «Документ» / «@»; «Где искать»; the AI mode; send.
 *
 * With `AI_PROVIDER=disabled` it is a search field: no file or skill controls at all, Enter searches the catalogue
 * and ↑/↓ pick an instant match. The skill and document lists are listboxes driven from the text field
 * (`aria-activedescendant`): ↑/↓ move, Enter chooses, Esc closes.
 */

/** Debounce of document lookups while typing after «@» (and of instant matches in search mode). */
export const COMPOSER_DELAY_MS = 150;
const DOCUMENT_LIMIT = 8;
const MIN_QUESTION = 3;
const MAX_QUESTION = 2000;

export type ComposerVariant = "home" | "dialog" | "compact";

type Popup =
  | { kind: "skills"; source: "slash" | "button"; query: string; start: number }
  | { kind: "documents"; query: string; start: number }
  | { kind: "search"; query: string; start: 0 };

type Option =
  | { kind: "skill"; key: string; skill: AssistantSkill; disabled: boolean }
  | { kind: "document"; key: string; document: SearchResult; disabled: false };

interface DocumentLookup {
  query: string;
  items: SearchResult[];
  loading: boolean;
  failed: boolean;
}

export interface ComposerProps {
  /** `home`: the main field; `dialog`: pinned under the conversation; `compact`: a document's assistant panel. */
  variant: ComposerVariant;
  /** The field's state (lib/useComposer.ts), owned by the page. */
  composer: ComposerController;
  /** A message to send (never called in search mode or while files are being read). */
  onSend: (message: ComposerMessage) => void;
  /** The skill registry; loaded here when the page does not pass it. */
  skills?: SkillsState;
  /** A request is running: the send button becomes «Отменить». */
  pending?: boolean;
  onCancel?: () => void;
  inputId?: string;
  /** The text field's accessible name (default «Вопрос»). */
  label?: string;
  placeholder?: string;
  autoFocus?: boolean;
  /** Shown under the field as an alert (a request error that belongs to the field). */
  error?: ReactNode;
  /** A quiet line under the field that describes it (e.g. how many earlier answers go along as context). */
  note?: ReactNode;
}

function fileIcon(file: ComposerFile): IconName {
  if (file.status === "error") return "alert";
  return ["csv", "xlsx", "json", "yaml", "yml", "sql"].includes(extensionOf(file.name)) ? "file" : "file-text";
}

/** The size, plus the server's summary when the file has been read («48 КБ · 3 листа»). */
function fileMeta(file: ComposerFile): string {
  if (file.status === "reading") return "Читаю…";
  if (file.status === "error") return file.error ?? "не принят";
  const size = formatBytes(file.attachment?.size ?? file.size);
  const summary = file.attachment?.summary;
  return summary ? `${size} · ${summary}` : size;
}

function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

/** What is being dragged in: the count always, the size only when the browser reports it. */
function dragSummary(event: DragEvent): { count: number; bytes: number | null } {
  const files = Array.from(event.dataTransfer?.files ?? []);
  if (files.length > 0) return { count: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0) };
  const items = Array.from(event.dataTransfer?.items ?? []).filter((item) => item.kind === "file");
  return { count: Math.max(1, items.length), bytes: null };
}

/** One row per document: the best passage wins (the search returns sections). */
function uniqueDocuments(items: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  return items.filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)));
}

export function Composer({
  variant,
  composer,
  onSend,
  skills: skillsProp,
  pending = false,
  onCancel,
  inputId,
  label = "Вопрос",
  placeholder,
  autoFocus,
  error,
  note,
}: ComposerProps) {
  const session = useSession();
  const navigate = useNavigate();
  const mode = session?.features.ai_mode;
  const searchMode = !canAsk(mode);
  const loaded = useSkills(mode, skillsProp === undefined);
  const skills = skillsProp ?? loaded;
  const generatedId = useId();
  const fieldId = inputId ?? `${generatedId}-field`;
  const listId = `${generatedId}-list`;
  const hintId = `${generatedId}-hint`;
  const noteId = `${generatedId}-note`;
  const fileInput = useRef<HTMLInputElement>(null);
  const { draft, inputRef } = composer;
  const text = draft.text;
  const compact = variant === "compact";

  const [popup, setPopup] = useState<Popup | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [lookup, setLookup] = useState<DocumentLookup>({ query: "", items: [], loading: false, failed: false });
  const [announcement, setAnnouncement] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ count: number; bytes: number | null } | null>(null);
  const dragDepth = useRef(0);
  const caretAfter = useRef<number | null>(null);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus, inputRef]);

  // Grows with the text up to 8 lines (the CSS max-height), then scrolls.
  useLayoutEffect(() => {
    const field = inputRef.current;
    if (!field) return;
    field.style.height = "auto";
    if (field.scrollHeight > 0) field.style.height = `${field.scrollHeight}px`;
    if (caretAfter.current !== null) {
      field.setSelectionRange(caretAfter.current, caretAfter.current);
      caretAfter.current = null;
    }
  }, [text, inputRef]);

  const lookupQuery = popup && popup.kind !== "skills" ? popup.query.trim() : null;
  const minLookup = popup?.kind === "search" ? 2 : 1;

  // Documents for «@» (and instant matches in search mode): the existing ranked search, debounced; a newer
  // query cancels the older one.
  useEffect(() => {
    if (lookupQuery === null) return undefined;
    if (lookupQuery.length < minLookup) {
      setLookup({ query: lookupQuery, items: [], loading: false, failed: false });
      return undefined;
    }
    setLookup((current) => ({ ...current, query: lookupQuery, loading: true, failed: false }));
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api
        .search({ q: lookupQuery.slice(0, 200), limit: DOCUMENT_LIMIT }, { signal: controller.signal })
        .then((result) => {
          const items = uniqueDocuments(result.items);
          setLookup({ query: lookupQuery, items, loading: false, failed: false });
          setAnnouncement(
            items.length === 0
              ? "Документов не найдено"
              : `${pluralRu(items.length, "Найден", "Найдено", "Найдено")} ${items.length} ${pluralRu(items.length, "документ", "документа", "документов")}`,
          );
        })
        .catch((err: unknown) => {
          if (isCancelled(err) || controller.signal.aborted) return;
          setLookup({ query: lookupQuery, items: [], loading: false, failed: true });
        });
    }, COMPOSER_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [lookupQuery, minLookup]);

  const skillQuery = popup?.kind === "skills" ? popup.query.toLocaleLowerCase("ru") : "";
  const options: Option[] =
    popup?.kind === "skills"
      ? (skills.items ?? [])
          .filter((skill) => !skillQuery || skill.name.toLocaleLowerCase("ru").includes(skillQuery) || skill.id.includes(skillQuery))
          .map((skill) => ({ kind: "skill", key: `skill-${skill.id}`, skill, disabled: !skill.available }))
      : popup && lookup.query === lookupQuery
        ? lookup.items.map((document) => ({ kind: "document", key: `doc-${document.id}`, document, disabled: false }))
        : [];
  // Lists of skills and documents preselect the first choice (Enter takes it); instant matches in search mode
  // preselect nothing, so Enter searches unless the user moved to a match.
  const fallbackKey = popup?.kind === "search" ? null : (options.find((option) => !option.disabled)?.key ?? null);
  const active = options.find((option) => option.key === activeKey) ?? options.find((option) => option.key === fallbackKey);
  const activeIndex = active ? options.indexOf(active) : -1;
  const open = popup !== null;

  const missing = searchMode
    ? null
    : missingInput(draft.skill, {
        documents: draft.documents.length,
        selection: draft.selection !== null,
        attachments: draft.files.filter((file) => file.status === "ready").length,
      });
  const hasText = text.trim().length > 0;
  const canSend = searchMode
    ? true
    : !pending && !composer.reading && missing === null && (hasText || Boolean(draft.skill?.prompt_optional));

  function closePopup(remember = true) {
    if (remember && popup) setDismissed(`${popup.kind}:${popup.start}`);
    setPopup(null);
    setActiveKey(null);
  }

  /** Opens the list a trigger asks for, unless the user closed that very trigger with Esc. */
  function show(next: Popup) {
    if (dismissed === `${next.kind}:${next.start}`) return;
    setPopup((current) =>
      current && current.kind === next.kind && current.start === next.start && "query" in current && current.query === next.query
        ? current
        : next,
    );
  }

  /** Which list the text before the caret asks for: «/» at the start of a line, «@» after a space. */
  function sync(value: string, caret: number, keepButtonList: boolean) {
    if (searchMode) {
      const query = value.trim();
      if (query.length >= 2) show({ kind: "search", query, start: 0 });
      else {
        setPopup(null);
        setDismissed(null);
      }
      return;
    }
    const before = value.slice(0, caret);
    const slash = /(?:^|\n)\/([^\s/]*)$/.exec(before);
    if (slash) {
      const query = slash[1] ?? "";
      show({ kind: "skills", source: "slash", query, start: caret - query.length - 1 });
      return;
    }
    const at = /(?:^|\s)@([^\s@]*)$/.exec(before);
    if (at) {
      const query = at[1] ?? "";
      show({ kind: "documents", query, start: caret - query.length - 1 });
      return;
    }
    setDismissed(null);
    setPopup((current) => (keepButtonList && current?.kind === "skills" && current.source === "button" ? current : null));
  }

  function onChange(event: ChangeEvent<HTMLTextAreaElement>) {
    const value = event.target.value.slice(0, MAX_QUESTION);
    composer.setText(value);
    setLocalError(null);
    setActiveKey(null);
    sync(value, event.target.selectionStart ?? value.length, false);
  }

  /** Removes the «/…» or «@…» the user typed to open a list (it is replaced by a chip). */
  function removeTrigger(current: Popup) {
    if (current.kind === "search" || (current.kind === "skills" && current.source === "button")) return;
    const end = current.start + 1 + current.query.length;
    composer.setText(text.slice(0, current.start) + text.slice(end));
    caretAfter.current = current.start;
  }

  function choose(option: Option) {
    if (!popup) return;
    if (option.kind === "skill") {
      if (option.disabled) {
        setAnnouncement(`Навык «${option.skill.name}» недоступен: ${option.skill.unavailable_reason ?? "в этом режиме"}.`);
        return;
      }
      removeTrigger(popup);
      composer.setSkill(option.skill);
      setAnnouncement(`Навык: ${option.skill.name} (${SKILL_ACCESS_LABEL[option.skill.access]}).`);
    } else if (popup.kind === "search") {
      closePopup(false);
      navigate(`/documents/${encodeURIComponent(option.document.id)}`);
      return;
    } else {
      removeTrigger(popup);
      const added = composer.addDocument({ id: option.document.id, title: option.document.title, status: option.document.status });
      setAnnouncement(
        added
          ? `Документ «${option.document.title}» добавлен как контекст.`
          : draft.documents.some((item) => item.id === option.document.id)
            ? `Документ «${option.document.title}» уже выбран.`
            : `Можно выбрать не больше ${MAX_CONTEXT_DOCUMENTS} документов.`,
      );
    }
    closePopup(false);
    composer.focus();
  }

  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (searchMode) {
      const query = text.trim();
      closePopup(false);
      navigate(query ? `/documents?query=${encodeURIComponent(query)}` : "/documents");
      return;
    }
    if (pending) return;
    if (composer.reading) {
      setAnnouncement("Дождитесь, пока файлы будут прочитаны.");
      return;
    }
    if (!canSend) return;
    const question = text.trim();
    if (question.length > 0 && question.length < MIN_QUESTION) {
      setLocalError("Введите вопрос длиной не менее 3 символов.");
      return;
    }
    closePopup(false);
    onSend(composer.message());
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
    if (open && options.length > 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const count = options.length;
      const from = activeIndex;
      const next = event.key === "ArrowDown" ? (from + 1) % count : from <= 0 ? count - 1 : from - 1;
      setActiveKey(options[next]?.key ?? null);
      return;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      closePopup();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      if (open && active) {
        event.preventDefault();
        choose(active);
        return;
      }
      event.preventDefault();
      submit();
      return;
    }
    if (event.key === "Backspace" && text === "" && !searchMode) {
      const field = event.currentTarget;
      if (field.selectionStart === 0 && field.selectionEnd === 0 && composer.removeLast()) {
        event.preventDefault();
        setAnnouncement("Последнее вложение убрано.");
      }
    }
  }

  function toggleSkills() {
    if (popup?.kind === "skills") {
      closePopup(false);
    } else {
      setDismissed(null);
      setActiveKey(null);
      setPopup({ kind: "skills", source: "button", query: "", start: -1 });
    }
    composer.focus();
  }

  /** «Документ» types «@» at the caret (after a space), which opens the document search. */
  function startDocument() {
    const field = inputRef.current;
    const caret = field?.selectionStart ?? text.length;
    const before = text.slice(0, caret);
    const prefix = before === "" || /\s$/.test(before) ? "" : " ";
    const value = `${before}${prefix}@${text.slice(caret)}`;
    composer.setText(value);
    caretAfter.current = caret + prefix.length + 1;
    setDismissed(null);
    setPopup({ kind: "documents", query: "", start: caret + prefix.length });
    composer.focus();
  }

  function onFiles(event: ChangeEvent<HTMLInputElement>) {
    composer.addFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
    composer.focus();
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (searchMode) return;
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    composer.addFiles(files);
  }

  const dropHandlers = searchMode
    ? {}
    : {
        onDragEnter: (event: DragEvent<HTMLFormElement>) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          dragDepth.current += 1;
          setDrag(dragSummary(event));
        },
        onDragOver: (event: DragEvent<HTMLFormElement>) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
        },
        onDragLeave: (event: DragEvent<HTMLFormElement>) => {
          if (!hasFiles(event)) return;
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDrag(null);
        },
        onDrop: (event: DragEvent<HTMLFormElement>) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          dragDepth.current = 0;
          setDrag(null);
          composer.addFiles(Array.from(event.dataTransfer?.files ?? []));
          composer.focus();
        },
      };

  const skill = draft.skill;
  const corporate = session?.features.corporate_search;
  const resolvedPlaceholder =
    placeholder ??
    (searchMode
      ? "Найти в базе знаний"
      : skill?.prompt_optional
        ? "Уточните задачу или оставьте поле пустым — Enter запустит навык"
        : draft.files.length > 0 && !skill
          ? "Что сделать с файлами?"
          : "Спросите, опишите задачу или перетащите файл");
  const chips = !searchMode && (skill || draft.files.length > 0 || draft.documents.length > 0 || draft.selection);
  const popupSide = variant === "home" ? "bottom" : "top";
  const listLabel = popup?.kind === "skills" ? "Навыки" : popup?.kind === "documents" ? "Документы" : "Подсказки";
  const hints: ReactNode[] = [];
  if (missing && skill) hints.push(`Навыку «${skill.name}» ${MISSING_INPUT_HINT[missing]}.`);
  if (!searchMode && draft.scope !== "team" && corporate === "disabled") {
    hints.push("Корпоративные источники (Confluence Data Center) не подключены — ответ будет только по документам команды.");
  }
  if (!searchMode && draft.scope !== "team" && corporate === "mock") {
    hints.push("Корпоративные источники — mock-коннектор с синтетическими страницами.");
  }

  return (
    <form
      className={`composer composer--${variant}${searchMode ? " composer--search" : ""}${drag ? " is-dragging" : ""}`}
      role={searchMode ? "search" : undefined}
      onSubmit={submit}
      {...dropHandlers}
    >
      <div className="composer__box">
        {chips ? (
          <ul className="composer__chips" aria-label="Приложено к сообщению">
            {skill ? (
              <li>
                <Chip tone="skill" icon="skill" onRemove={() => composer.setSkill(null)} removeLabel={`Убрать навык «${skill.name}»`}>
                  {skill.name}
                </Chip>
              </li>
            ) : null}
            {draft.files.map((file) => (
              <li key={file.key}>
                <Chip
                  tone={file.status === "error" ? "danger" : "file"}
                  icon={file.status === "reading" ? undefined : fileIcon(file)}
                  className={file.status === "reading" ? "chip--reading" : undefined}
                  meta={fileMeta(file)}
                  title={file.status === "error" ? `${file.name}: ${file.error ?? ""}` : file.name}
                  onRemove={() => composer.removeFile(file.key)}
                  removeLabel={`Убрать файл «${file.name}»`}
                >
                  {file.name}
                </Chip>
              </li>
            ))}
            {draft.documents.map((document) => (
              <li key={document.id}>
                <Chip
                  tone="document"
                  icon="documents"
                  title={`${document.title} (${document.id})`}
                  onRemove={() => composer.removeDocument(document.id)}
                  removeLabel={`Убрать документ «${document.title}»`}
                >
                  {document.title}
                </Chip>
              </li>
            ))}
            {draft.selection ? (
              <li>
                <Chip tone="document" icon="edit" onRemove={() => composer.setSelection(null)} removeLabel="Убрать выделение">
                  {draft.selection.label}
                </Chip>
              </li>
            ) : null}
          </ul>
        ) : null}

        <label htmlFor={fieldId} className="visually-hidden">
          {searchMode ? "Поиск по базе знаний" : label}
        </label>
        <textarea
          ref={inputRef}
          id={fieldId}
          className="composer__input"
          rows={searchMode ? 1 : variant === "home" ? 3 : 2}
          value={text}
          placeholder={resolvedPlaceholder}
          maxLength={MAX_QUESTION}
          autoComplete="off"
          spellCheck={false}
          aria-autocomplete="list"
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open && active ? `${listId}-${activeIndex}` : undefined}
          aria-describedby={[hints.length > 0 ? hintId : null, note ? noteId : null].filter(Boolean).join(" ") || undefined}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onSelect={(event) => {
            const field = event.currentTarget;
            if (field.selectionStart === field.selectionEnd) sync(field.value, field.selectionStart, true);
          }}
          onBlur={() => closePopup(false)}
        />

        <div className="composer__bar">
          {searchMode ? (
            <span className="composer__scope-static">Документы команды</span>
          ) : (
            <>
              <button
                type="button"
                className="composer__tool"
                aria-label={compact ? "Прикрепить файл" : undefined}
                title={compact ? "Прикрепить файл" : undefined}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => fileInput.current?.click()}
              >
                <Icon name="paperclip" />
                {compact ? null : <span className="composer__tool-label">Файл</span>}
              </button>
              <button
                type="button"
                className="composer__tool"
                aria-label={compact ? "Навык" : undefined}
                title={compact ? "Навык" : undefined}
                aria-haspopup="listbox"
                aria-expanded={popup?.kind === "skills"}
                aria-controls={popup?.kind === "skills" ? listId : undefined}
                onMouseDown={(event) => event.preventDefault()}
                onClick={toggleSkills}
              >
                <Icon name="skill" />
                {compact ? null : <span className="composer__tool-label">Навык</span>}
              </button>
              {compact ? null : (
                <button
                  type="button"
                  className="composer__tool"
                  aria-haspopup="listbox"
                  aria-expanded={popup?.kind === "documents"}
                  aria-controls={popup?.kind === "documents" ? listId : undefined}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={startDocument}
                >
                  <Icon name="at" />
                  <span className="composer__tool-label">Документ</span>
                </button>
              )}
              {compact ? null : (
                <>
                  <span className="composer__separator" aria-hidden="true" />
                  <ScopeControl composer={composer} side={popupSide} corporate={corporate} />
                </>
              )}
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                accept={ATTACHMENT_ACCEPT}
                aria-label="Файлы для этого диалога"
                tabIndex={-1}
                onChange={onFiles}
              />
            </>
          )}
          <span className="composer__spacer" />
          {compact || searchMode || !mode ? null : (
            <span className="composer__mode">{skill ? SKILL_ACCESS_LABEL[skill.access] : AI_CHIP_LABEL[mode]}</span>
          )}
          {pending ? (
            <button type="button" className="composer__send composer__send--stop" aria-label="Отменить" onClick={onCancel}>
              <span className="composer__stop" aria-hidden="true" />
            </button>
          ) : (
            <button
              type="submit"
              className={`composer__send${searchMode ? " composer__send--search" : ""}`}
              aria-label={searchMode ? "Найти" : "Отправить"}
              disabled={!canSend}
              onMouseDown={(event) => event.preventDefault()}
            >
              <Icon name={searchMode ? "search" : "send"} size={searchMode ? 16 : 18} strokeWidth={searchMode ? 1.75 : 2} />
            </button>
          )}
        </div>

        {drag ? (
          <div className="composer__drop" aria-hidden="true">
            <Icon name="upload" size={20} />
            <span className="composer__drop-title">Отпустите, чтобы прикрепить</span>
            <span className="composer__drop-meta">{filesSummary(drag.count, drag.bytes)}</span>
          </div>
        ) : null}
      </div>

      <div className={`composer__popup composer__popup--${popupSide}`} hidden={!open}>
        {popup?.kind === "skills" ? <p className="composer__popup-head">Навык задаёт, что ассистент сделает и что ему разрешено</p> : null}
        <ul id={listId} role="listbox" aria-label={listLabel} className="composer__list">
          {options.map((option, index) => (
            <li
              key={option.key}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={option === active}
              aria-disabled={option.disabled || undefined}
              className={`composer__option${option === active ? " is-active" : ""}${option.disabled ? " is-disabled" : ""}`}
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => {
                if (activeKey !== option.key) setActiveKey(option.key);
              }}
              onClick={() => choose(option)}
            >
              {option.kind === "skill" ? (
                <>
                  <span className="composer__option-main">
                    <span className="composer__option-title">{option.skill.name}</span>
                    <span className="composer__option-desc">
                      {option.skill.available ? option.skill.description : option.skill.unavailable_reason ?? "Недоступен в этом режиме"}
                    </span>
                  </span>
                  <span className={`composer__access composer__access--${option.skill.access}`}>
                    {SKILL_ACCESS_LABEL[option.skill.access]}
                  </span>
                </>
              ) : (
                <>
                  <span className="composer__option-main">
                    <span className="composer__option-title">{option.document.title}</span>
                    <span className="composer__option-desc">
                      <span className="doc-id">{option.document.id}</span>
                      {option.document.section ? `, раздел «${option.document.section}»` : ""}
                    </span>
                  </span>
                  <StatusMark status={option.document.status} />
                </>
              )}
            </li>
          ))}
        </ul>
        {popup?.kind === "skills" && skills.items === null ? (
          <p className="composer__popup-note">{skills.failed ? "Список навыков сейчас недоступен." : "Загружаю навыки…"}</p>
        ) : null}
        {popup?.kind === "skills" && skills.items !== null && options.length === 0 ? (
          <p className="composer__popup-note">Нет навыка «{popup.query}».</p>
        ) : null}
        {popup && popup.kind !== "skills" && (lookupQuery ?? "").length < minLookup ? (
          <p className="composer__popup-note">Введите название или ID документа.</p>
        ) : null}
        {popup && popup.kind !== "skills" && (lookupQuery ?? "").length >= minLookup && lookup.loading && options.length === 0 ? (
          <p className="composer__popup-note">Ищу документы…</p>
        ) : null}
        {popup && popup.kind !== "skills" && lookup.failed ? (
          <p className="composer__popup-note">Поиск сейчас недоступен{popup.kind === "search" ? " — нажмите Enter, чтобы открыть каталог" : ""}.</p>
        ) : null}
        {popup && popup.kind !== "skills" && !lookup.loading && !lookup.failed && lookup.query === lookupQuery && (lookupQuery ?? "").length >= minLookup && options.length === 0 ? (
          <p className="composer__popup-note">Документов не найдено.</p>
        ) : null}
        <p className="composer__popup-foot" aria-hidden="true">
          <span>↑↓ выбрать</span>
          <span>Enter {popup?.kind === "search" ? "открыть" : "выбрать"}</span>
          <span>Esc закрыть</span>
        </p>
      </div>

      {hints.length > 0 || localError || error || note ? (
        <div className="composer__notes">
          {note ? (
            <p id={noteId} className="composer__hint">
              {note}
            </p>
          ) : null}
          {hints.length > 0 ? (
            <div id={hintId}>
              {hints.map((hint, index) => (
                <p key={index} className="composer__hint">
                  {hint}
                </p>
              ))}
            </div>
          ) : null}
          {localError ? (
            <p className="composer__error" role="alert">
              {localError}
            </p>
          ) : null}
          {error}
        </div>
      ) : null}

      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
      <p className="visually-hidden" role="status" aria-live="polite">
        {composer.announcement}
      </p>
    </form>
  );
}

/** «Где искать: Команда»: the scope and whether drafts / deprecated documents may answer. */
function ScopeControl({
  composer,
  side,
  corporate,
}: {
  composer: ComposerController;
  side: "top" | "bottom";
  corporate: string | undefined;
}) {
  const id = useId();
  const name = useId();
  const { scope, includeDrafts, includeDeprecated } = composer.draft;
  const extra = [includeDrafts ? "с черновиками" : null, includeDeprecated ? "с устаревшими" : null].filter(Boolean).join(", ");
  return (
    <Popover
      id={`${id}-scope`}
      side={side}
      align="start"
      className="composer__scope"
      panelClassName="composer__scope-panel"
      trigger={(props) => (
        <button type="button" className="composer__tool" aria-label={`Где искать: ${scopeLabel(scope)}${extra ? `, ${extra}` : ""}`} {...props}>
          <span>
            <span className="composer__tool-label">Где искать: </span>
            {scopeLabel(scope)}
            {extra ? `, ${extra}` : ""}
          </span>
          <Icon name="chevron" size={14} />
        </button>
      )}
    >
      <fieldset className="composer__fieldset">
        <legend>Где искать</legend>
        {SCOPE_OPTIONS.map((option) => (
          <label key={option.value} className="composer__radio">
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={scope === option.value}
              onChange={() => composer.setScope(option.value)}
            />
            {option.label}
          </label>
        ))}
      </fieldset>
      <fieldset className="composer__fieldset">
        <legend>Учитывать также</legend>
        <label className="composer__radio">
          <input type="checkbox" checked={includeDrafts} onChange={(event) => composer.setIncludeDrafts(event.target.checked)} />
          Черновики и документы на ревью
        </label>
        <label className="composer__radio">
          <input
            type="checkbox"
            checked={includeDeprecated}
            onChange={(event) => composer.setIncludeDeprecated(event.target.checked)}
          />
          Устаревшие документы
        </label>
      </fieldset>
      <p className="composer__scope-note">
        {corporate === "connected"
          ? "Корпоративные источники — Confluence Data Center, отдельной помеченной группой."
          : corporate === "mock"
            ? "Корпоративные источники — mock-коннектор с синтетическими страницами."
            : "Корпоративные источники (Confluence Data Center) не подключены."}
      </p>
    </Popover>
  );
}
