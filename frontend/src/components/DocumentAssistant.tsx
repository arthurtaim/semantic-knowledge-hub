import { useEffect, useRef, type RefObject } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { AiMode, AssistantSkill, DocumentDetail, SkillAccess } from "../api/types";
import { AI_CHIP_LABEL } from "../lib/aiMode";
import { selectionLabel, type CapturedSelection } from "../lib/selection";
import { displayOf, useAssistantTurns, type AssistantTurns } from "../lib/useAssistantTurns";
import { toAskRequest, useComposer, type ComposerController, type ComposerMessage } from "../lib/useComposer";
import { useSkills, type SkillsState } from "../lib/useSkills";
import { TurnView } from "./AssistantTurn";
import { Composer } from "./Composer";
import { SidePanel, type SidePanelMode } from "./shell/SidePanel";
import { Chip } from "./ui/Chip";
import { Icon, type IconName } from "./ui/Icon";

/*
 * The assistant panel of a document (docs/ui-v2/specs/03_SCREENS.md §3, design-04): the context as chips
 * («Этот документ», «Выделение: N строк»), quick actions mapped to the skill registry, a short conversation and
 * the compact field. Every message carries this document (and the selection) as context; answers follow the
 * dialog's rules (components/AssistantTurn.tsx). It opens only on the reader's action and applies nothing:
 * «Предложить правку» gives an AI proposal for review — or, where the AI cannot write (mock), the manual path.
 */

export const ASSISTANT_PANEL_ID = "document-assistant";
export const ASSISTANT_INPUT_ID = "doc-assistant-input";

/** A skill's name and right for the bubble when the registry is not at hand (the server checks it anyway). */
const FALLBACK_ACCESS: Record<string, SkillAccess> = { improve_section: "draft" };

interface QuickAction {
  skill: string;
  label: string;
  icon: IconName;
}

/** design-04, in this order; each is a skill of GET /api/assistant/skills. */
export const QUICK_ACTIONS: QuickAction[] = [
  { skill: "explain", label: "Объяснить раздел", icon: "info" },
  { skill: "find_related", label: "Найти связанные", icon: "map" },
  { skill: "check_freshness", label: "Проверить актуальность", icon: "clock" },
  { skill: "improve_section", label: "Предложить правку", icon: "edit" },
];

/** Where a change is proposed by hand: the existing «Предложить изменение» flow. */
export function manualProposalHref(documentId: string): string {
  return `/proposals/new?document=${encodeURIComponent(documentId)}`;
}

export interface DocumentAssistant {
  composer: ComposerController;
  skills: SkillsState;
  conversation: AssistantTurns;
  /** The skill from the registry (undefined while it is not loaded or unknown). */
  skill: (id: string) => AssistantSkill | undefined;
  /** «Предложить правку» runs `improve_section` only when the registry says it is available. */
  canImprove: boolean;
  /** Runs a skill on this document (and the selection in the field) without a question. */
  runSkill: (skillId: string, label: string) => void;
  /** Makes a selection the context of the field (the chip «Выделение: N строк»). */
  takeSelection: (selection: CapturedSelection) => void;
  send: (message: ComposerMessage) => void;
}

/** The assistant's state lives with the document page: closing the panel keeps the conversation of this visit. */
export function useDocumentAssistant(doc: DocumentDetail, mode: AiMode | null | undefined): DocumentAssistant {
  const skills = useSkills(mode);
  const composer = useComposer({ defaults: { documents: [{ id: doc.id, title: doc.title, status: doc.status }] } });
  const conversation = useAssistantTurns({ composer });
  const skill = (id: string) => skills.items?.find((item) => item.id === id);

  // The panel's conversation ends with the visit: files attached in it are deleted on the server (nobody can
  // reach that conversation again), as «Новый диалог» does in the dialog.
  const files = useRef(composer.draft.files);
  files.current = composer.draft.files;
  useEffect(
    () => () => {
      for (const file of files.current) {
        if (file.status === "ready" && file.attachment) void api.deleteAttachment(file.attachment.id).catch(() => undefined);
      }
    },
    [],
  );
  const improve = skill("improve_section");

  function runSkill(skillId: string, label: string) {
    if (conversation.busy()) return;
    const known = skill(skillId);
    const message: ComposerMessage = { ...composer.message(), question: "", skill: known ?? null, attachments: [] };
    const request = toAskRequest(message, conversation.history);
    request.skill_id = skillId;
    void conversation.run(request, {
      skill: { id: skillId, name: known?.name ?? label, access: known?.access ?? FALLBACK_ACCESS[skillId] ?? "read" },
      files: [],
      documents: [],
      selection: message.selection?.label ?? null,
      action: label,
    });
  }

  return {
    composer,
    skills,
    conversation,
    skill,
    canImprove: improve?.available === true,
    runSkill,
    takeSelection: (selection) =>
      composer.setSelection({
        document_id: doc.id,
        section_anchor: selection.sectionAnchor,
        text: selection.text,
        label: selectionLabel(selection),
      }),
    send: (message) => {
      if (conversation.busy()) return;
      // This document is the context of every message; the panel shows it once, above, not on each bubble.
      void conversation.run(toAskRequest(message, conversation.history), {
        ...displayOf(message),
        documents: message.documents.filter((item) => item.id !== doc.id).map((item) => ({ id: item.id, title: item.title })),
      });
    },
  };
}

interface QuickActionsProps {
  doc: DocumentDetail;
  assistant: DocumentAssistant;
}

function QuickActions({ doc, assistant }: QuickActionsProps) {
  const { skills, conversation, composer } = assistant;
  const hasSelection = composer.draft.selection !== null;
  return (
    <ul className="doc-assistant__actions" aria-label="Быстрые действия">
      {QUICK_ACTIONS.map((action) => {
        const skill = assistant.skill(action.skill);
        const icon = <Icon name={action.icon} size={15} className="doc-assistant__action-icon" />;
        if (action.skill === "improve_section" && !(assistant.canImprove && hasSelection)) {
          // Every AI action has a manual path: without the AI skill (or a selection for it) — the change editor.
          const reason = !assistant.canImprove
            ? `${skill?.unavailable_reason ?? "ИИ-правка сейчас недоступна."} Откроется ручное предложение изменения.`
            : "Откроется ручное предложение изменения. Для правки с ИИ выделите фрагмент в тексте.";
          const noteId = `doc-assistant-note-${action.skill}`;
          return (
            <li key={action.skill}>
              <Link to={manualProposalHref(doc.id)} className="doc-assistant__action" aria-describedby={noteId}>
                {icon}
                <span className="doc-assistant__action-label">{action.label}</span>
              </Link>
              <p id={noteId} className="doc-assistant__action-note">
                {reason}
              </p>
            </li>
          );
        }
        const unavailable = skill !== undefined && !skill.available;
        const noteId = `doc-assistant-note-${action.skill}`;
        return (
          <li key={action.skill}>
            <button
              type="button"
              className="doc-assistant__action"
              disabled={unavailable || conversation.pending}
              aria-describedby={unavailable ? noteId : undefined}
              onClick={() => assistant.runSkill(action.skill, action.label)}
            >
              {icon}
              <span className="doc-assistant__action-label">{action.label}</span>
            </button>
            {unavailable ? (
              <p id={noteId} className="doc-assistant__action-note">
                {skill.unavailable_reason ?? "Недоступно в этом режиме."}
              </p>
            ) : null}
          </li>
        );
      })}
      {skills.failed ? (
        <li>
          <p className="doc-assistant__action-note">Список навыков сейчас недоступен — сервер проверит навык при запуске.</p>
        </li>
      ) : null}
    </ul>
  );
}

interface DocumentAssistantPanelProps {
  doc: DocumentDetail;
  assistant: DocumentAssistant;
  mode: SidePanelMode;
  aiMode: AiMode;
  onClose: () => void;
  /** Removes the selection from the context (and its mark in the text). */
  onClearSelection: () => void;
  /** The toolbar toggle: focus goes back there when the control that opened the panel is gone. */
  toggleRef: RefObject<HTMLElement | null>;
}

export function DocumentAssistantPanel({ doc, assistant, mode, aiMode, onClose, onClearSelection, toggleRef }: DocumentAssistantPanelProps) {
  const { composer, conversation, skills } = assistant;
  const { turns, pending } = conversation;
  const inputRef = composer.inputRef as RefObject<HTMLElement | null>;
  const conversationRef = useRef<HTMLDivElement>(null);
  const selection = composer.draft.selection;

  // A new message, then its answer: when the message starts low in the panel (or above it), scroll the panel —
  // not the page — so it starts at the top; the context stays in view while there is room for both.
  const lastTurn = turns[turns.length - 1];
  const lastKey = lastTurn ? `${lastTurn.id}:${lastTurn.phase}` : "";
  useEffect(() => {
    const last = conversationRef.current?.lastElementChild;
    const body = last?.closest(".side-panel__body");
    if (!lastKey || !(last instanceof HTMLElement) || !(body instanceof HTMLElement)) return;
    const offset = last.getBoundingClientRect().top - body.getBoundingClientRect().top;
    if (offset < 0 || offset > body.clientHeight / 2) body.scrollTop += offset - 12;
  }, [lastKey]);

  return (
    <SidePanel
      id={ASSISTANT_PANEL_ID}
      title="Ассистент"
      mode={mode}
      onClose={onClose}
      className="side-panel--assistant"
      initialFocus={inputRef}
      returnFocus={() => toggleRef.current}
      actions={<span className="doc-assistant__mode">{AI_CHIP_LABEL[aiMode]}</span>}
      footer={
        <Composer
          variant="compact"
          composer={composer}
          skills={skills}
          onSend={assistant.send}
          pending={pending}
          onCancel={conversation.cancel}
          inputId={`${ASSISTANT_INPUT_ID}`}
          label="Вопрос по документу"
          placeholder="Спросите про этот документ"
          contextChips={false}
        />
      }
    >
      <div className="doc-assistant">
        <section className="doc-assistant__context" aria-labelledby="doc-assistant-context">
          <h3 id="doc-assistant-context" className="doc-assistant__label">
            Контекст
          </h3>
          <ul className="doc-assistant__chips">
            <li>
              <Chip tone="document" title={`${doc.title} (${doc.id})`}>
                Этот документ
              </Chip>
            </li>
            {selection ? (
              <li>
                <Chip tone="skill" title={selection.text} onRemove={onClearSelection} removeLabel="Убрать выделение из контекста">
                  {selection.label}
                </Chip>
              </li>
            ) : null}
          </ul>
        </section>

        <QuickActions doc={doc} assistant={assistant} />

        <section className="doc-assistant__conversation" aria-label="Переписка">
          {turns.length === 0 ? (
            <p className="doc-assistant__empty">
              Ответы — только по документам команды, с цитатами. Правки ассистент предлагает на ревью и ничего не меняет
              сам.
            </p>
          ) : (
            <div ref={conversationRef} className="doc-assistant__turns">
              {turns.map((turn, index) => (
                <TurnView
                  key={turn.id}
                  turn={turn}
                  turnNo={index + 1}
                  compact
                  onRetry={
                    turn === turns[turns.length - 1] && turn.phase === "error" ? () => void conversation.run(turn.request, turn.display) : undefined
                  }
                  onRefine={(question) => {
                    composer.setText(question);
                    composer.focus();
                  }}
                  onAskCorporate={(request, display) => void conversation.run(request, display)}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </SidePanel>
  );
}
