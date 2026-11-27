import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api/client";
import type { AskRequest, AssistantAttachment, StoredTurnRequest, WorkProposalRef } from "../api/types";
import { NOTHING_ATTACHED, TurnView, type Turn, type TurnDisplay } from "../components/AssistantTurn";
import { Composer } from "../components/Composer";
import { ErrorState, Notice } from "../components/Feedback";
import { PageToolbar } from "../components/shell/PageToolbar";
import { Button } from "../components/ui/Button";
import { canAsk } from "../lib/aiMode";
import { CONVERSATION_ID_PATTERN, newConversationId, scopeFromParam, scopeSources } from "../lib/assistant";
import {
  claimFresh,
  clearHandOff,
  deleteDraft,
  dialogKey,
  forgetLastDialog,
  freshDialogId,
  lastDialogId,
  peekHandOff,
  rememberLastDialog,
  restoreDraft,
  saveDraft,
  startFreshDialog,
} from "../lib/conversation";
import {
  ensureLoaded,
  forgetConversation,
  markNew,
  runTurn,
  useConversation,
  type ConversationState,
  type TurnEffects,
} from "../lib/conversationStore";
import { pluralRu } from "../lib/labels";
import {
  findSkill,
  forgetRecentDialog,
  markAttachmentsGone,
  noteDialogSources,
  rememberDialog,
  restoreDialog,
  type RecentAttachment,
  type RecentDialog,
  type RecentSkill,
} from "../lib/recentQuestions";
import { useSession } from "../lib/session";
import { displayOf, MAX_HISTORY_TURNS, useAssistantTurns } from "../lib/useAssistantTurns";
import {
  EMPTY_DRAFT,
  toAskRequest,
  useComposer,
  type ComposerDraft,
  type ComposerFile,
  type ComposerMessage,
} from "../lib/useComposer";
import { usePinnedBottom } from "../lib/usePinnedBottom";
import { useSkills } from "../lib/useSkills";
import type { HomeHandOff, RecentHandOff } from "./HomePage";

/*
 * /ask is a dialog (docs/ui-v2/specs/02_ASSISTANT.md §2, design-03): the user's messages on the right with what
 * was attached, the assistant's answers with citation markers and one list of sources each, the field pinned at
 * the bottom. Streaming stages, «Недостаточно данных», errors with a retry and conflicts are states of a turn
 * (components/AssistantTurn.tsx, lib/useAssistantTurns.ts — shared with the document's assistant panel).
 *
 * Chat history (docs/API_CONTRACTS.md v0.7): the URL names the conversation (`/ask?c=<id>`) once it has a
 * question. Opening it shows the turns of this tab (lib/conversationStore.ts: also an answer still running) or
 * loads the stored ones from the server — it never asks again. `?q=…&run=1` starts a NEW conversation once and the
 * URL becomes `?c=<id>`, so Back, Forward or a reload never repeat the question.
 */

const EXAMPLES = [
  "Где хранится каноническая база знаний команды?",
  "Какие ограничения у интеграции ARIS?",
  "What layers does the demonstration architecture have?",
  "Какой SLA у интеграции с ЦФТ?",
];

/** The ask page without an AI provider: what is off, and the search that still works. */
function AskUnavailable({ initial }: { initial: string }) {
  const composer = useComposer({ defaults: { text: initial } });
  return (
    <div className="dialog dialog--search">
      <div className="dialog__intro">
        <h1>Спросить базу знаний</h1>
        <p className="dialog__lead">ИИ в этой установке отключён — ответы ассистента недоступны. Поиск по документам работает полностью.</p>
      </div>
      <Composer variant="home" composer={composer} onSend={() => undefined} inputId="ask-search-input" />
      <p className="dialog__links">
        <Link to="/documents">Открыть каталог документов</Link>
      </p>
    </div>
  );
}

// --- remembering a dialog in this browser (the offline fallback of «Недавние диалоги») ---------------------------

const recentSkill = (display: TurnDisplay): RecentSkill | null =>
  display.skill ? { id: display.skill.id, name: display.skill.name } : null;

/** What was attached, with the details the field had (size, summary, expiry); a file no longer there was deleted. */
function attachmentsOf(request: AskRequest, display: TurnDisplay, ready: AssistantAttachment[]): RecentAttachment[] {
  const known = new Map(ready.map((a) => [a.id, a]));
  return (request.attachment_ids ?? []).map((id) => {
    const a = known.get(id);
    const name = a?.name ?? display.files.find((file) => file.id === id)?.name ?? id;
    return a
      ? { id, name, size: a.size, mime: a.mime, summary: a.summary, expiresAt: a.expires_at, gone: false }
      : { id, name, size: null, mime: null, summary: null, expiresAt: null, gone: true };
  });
}

/** Effects of a request that do not need the page: the browser's own list of recent dialogs. */
function rememberEffects(userId: string | undefined, ready: () => AssistantAttachment[]): TurnEffects {
  return {
    onStart: (request, display) =>
      rememberDialog(userId, {
        question: request.question,
        skill: recentSkill(display),
        context: display.files[0]?.name ?? display.documents[0]?.title ?? null,
        conversationId: request.conversation_id ?? null,
        attachments: attachmentsOf(request, display, ready()),
        documents: display.documents,
      }),
    onAnswer: (request, display, response) =>
      noteDialogSources(userId, { question: request.question, skill: recentSkill(display) }, response.citations.length),
    onError: (request, _display, error) => {
      if (error.code !== "attachment_not_found") return;
      const named = typeof error.details.attachment_id === "string" ? [error.details.attachment_id] : [];
      markAttachmentsGone(userId, named.length > 0 ? named : (request.attachment_ids ?? []));
    },
  };
}

// --- the field of a stored conversation ----------------------------------------------------------------------------

/** The last stored request of the conversation (the field continues with its skill, files and documents). */
function lastStoredRequest(turns: Turn[]): StoredTurnRequest | null {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const stored = turns[i]?.stored;
    if (stored) return stored.request;
  }
  return null;
}

/** The field as the dialog leaves it after a message: empty text, the skill (from the registry later), the files
 * (a file the server still keeps as a ready chip, otherwise grey) and the chosen documents. */
function draftFromStored(request: StoredTurnRequest, conversationId: string): ComposerDraft {
  const files: ComposerFile[] = request.attachments.map((file) => {
    const base = { key: `stored-${file.id}`, name: file.name, size: file.size ?? 0, error: null };
    if (!file.available || file.size === null) return { ...base, status: "unavailable", attachment: null };
    const attachment: AssistantAttachment = {
      id: file.id,
      conversation_id: conversationId,
      name: file.name,
      size: file.size,
      mime: file.mime ?? "",
      status: "ready",
      summary: file.summary,
      error_code: null,
      expires_at: file.expires_at,
    };
    return { ...base, status: "ready", attachment };
  });
  return {
    ...EMPTY_DRAFT,
    files,
    documents: request.documents.map((doc) => ({ id: doc.id, title: doc.title, status: null })),
    scope: request.sources.includes("corporate") ? (request.sources.includes("team") ? "both" : "corporate") : "team",
    includeDrafts: request.include_drafts,
    includeDeprecated: request.include_deprecated,
  };
}

/** The next dialog that mounts takes the focus («Новый диалог»). */
let focusNextDialog = false;

// --- the page --------------------------------------------------------------------------------------------------------

export function AskPage() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const session = useSession();
  const aiMode = session?.features.ai_mode;
  const userId = session?.user.user_id;
  const about = params.get("about");
  const initialQuestion = params.get("q");
  const runRequested = params.get("run") === "1";
  const c = params.get("c");
  const named = c && CONVERSATION_ID_PATTERN.test(c) ? c : null;
  // A message sent from the home page runs in its own dialog with its chips; a recent dialog of this browser (or
  // a document from the catalog) puts its question, skill, files and documents back into the field.
  const [handed] = useState(() => peekHandOff<HomeHandOff | RecentHandOff>());
  const sent = handed && "message" in handed ? handed : null;
  const reopened = handed && "recent" in handed ? handed.recent : null;
  const [freshId, setFreshId] = useState(() => sent?.conversationId ?? freshDialogId());
  // Plain `/ask` (a link from another section, coming back from a cited document) continues this tab's dialog.
  const plain = !named && !sent && !reopened && !runRequested && !initialQuestion && !about;
  const resumeId = plain ? lastDialogId() : null;
  const activeId = named ?? resumeId ?? freshId;
  const ranFor = useRef<string | null>(null);

  function nameInUrl(id: string) {
    setParams(new URLSearchParams({ c: id }), { replace: true });
  }

  useEffect(() => {
    if (resumeId) nameInUrl(resumeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeId]);

  // The hand-off from the home page runs once; the URL then names its dialog.
  useEffect(() => {
    if (!sent || !canAsk(aiMode) || peekHandOff() !== sent) return;
    clearHandOff();
    markNew(sent.conversationId);
    claimFresh(sent.conversationId);
    nameInUrl(sent.conversationId);
    const files = sent.message.attachments;
    void runTurn(sent.conversationId, toAskRequest(sent.message), displayOf(sent.message), rememberEffects(userId, () => files));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sent, aiMode]);

  // `?run=1` (from «Спросить или найти», ⌘K): a NEW dialog asked once. The URL becomes `?c=<id>` at once, so Back,
  // Forward, a reload or a second effect run (StrictMode: the ref survives it) never ask again.
  useEffect(() => {
    if (sent || !runRequested || !canAsk(aiMode) || ranFor.current === location.key) return;
    ranFor.current = location.key;
    const text = (params.get("q") ?? "").trim().slice(0, 2000);
    const scope = scopeFromParam(params.get("scope"));
    if (text.length < 3) {
      const next = new URLSearchParams(params);
      next.delete("run");
      setParams(next, { replace: true });
      return;
    }
    const id = newConversationId();
    markNew(id);
    saveDraft(dialogKey(id), { conversationId: id, draft: { ...EMPTY_DRAFT, scope } });
    nameInUrl(id);
    void runTurn(
      id,
      { question: text, sources: scopeSources(scope), include_drafts: false, include_deprecated: false, history: [], conversation_id: id },
      NOTHING_ATTACHED,
      rememberEffects(userId, () => []),
    );
    // run/params are read at the moment of the request; the effect reacts to the flag only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runRequested, aiMode]);

  // AI_PROVIDER=disabled: no question form with a button that can only fail — the page says so and searches.
  if (aiMode === "disabled") return <AskUnavailable initial={about ?? initialQuestion ?? ""} />;

  /** «Новый диалог» (and after deleting one): an empty dialog; Back returns to the previous one. */
  function newDialog(replace = false) {
    forgetLastDialog();
    const id = startFreshDialog();
    setFreshId(id);
    focusNextDialog = true;
    navigate("/ask", { replace: replace || !named });
  }

  const forThis = (id: string | null) => id === activeId || (!named && id === null);
  return (
    <AskDialog
      key={activeId}
      conversationId={activeId}
      named={named !== null || resumeId !== null}
      initial={sent && sent.conversationId === activeId ? { conversationId: activeId, draft: sent.draft } : null}
      reopened={reopened && forThis(reopened.conversationId) ? reopened : null}
      prefill={runRequested ? null : about ? `Что известно о «${about}»?` : initialQuestion}
      scopeParam={runRequested ? null : params.get("scope")}
      onNamed={() => {
        claimFresh(activeId);
        nameInUrl(activeId);
      }}
      onNew={newDialog}
    />
  );
}

interface DialogProps {
  conversationId: string;
  /** The URL names this dialog (`?c=`): its stored turns may exist on the server. */
  named: boolean;
  /** The field handed over by the home page with the message that runs in this dialog. */
  initial: { conversationId: string; draft: ComposerDraft } | null;
  /** A recent dialog of this browser, or a document from the catalog, put back into the field. */
  reopened: RecentDialog | null;
  prefill: string | null;
  scopeParam: string | null;
  /** The first question of an unnamed dialog: the URL names it from now on. */
  onNamed: () => void;
  onNew: (replace?: boolean) => void;
}

/** Loads a named dialog's stored turns (unless this tab has them), then shows it. */
function AskDialog(props: DialogProps) {
  const { conversationId, named } = props;
  const state = useConversation(conversationId);
  useEffect(() => {
    if (!named) {
      markNew(conversationId);
      return;
    }
    rememberLastDialog(conversationId);
    void ensureLoaded(conversationId);
  }, [conversationId, named]);

  if (named && (state.load === "none" || state.load === "loading")) {
    return (
      <div className="dialog">
        <PageToolbar crumbs={[{ label: "Ассистент", to: "/" }, { label: "Диалог" }]} />
        <p className="dialog__loading" role="status">
          Загружаю диалог…
        </p>
      </div>
    );
  }
  if (state.load === "failed" && state.loadError) {
    return (
      <div className="dialog">
        <PageToolbar
          crumbs={[{ label: "Ассистент", to: "/" }, { label: "Диалог" }]}
          actions={
            <Button icon="plus" onClick={() => props.onNew()}>
              <span className="toolbar-action__label">Новый диалог</span>
            </Button>
          }
        />
        <ErrorState
          error={state.loadError}
          title="Не удалось загрузить диалог"
          onRetry={() => void ensureLoaded(conversationId, {}, true)}
        />
      </div>
    );
  }
  return <DialogView {...props} state={state} />;
}

function DialogView({ conversationId, named, initial, reopened, prefill, scopeParam, onNamed, onNew, state }: DialogProps & { state: ConversationState }) {
  const session = useSession();
  const aiMode = session?.features.ai_mode;
  const userId = session?.user.user_id;
  // The pinned field: focus moving to a source or a button scrolls it above the field, not under it (2.4.11).
  const pinned = useRef<HTMLDivElement>(null);
  usePinnedBottom(pinned);
  // The field: this tab's own draft of the dialog wins; otherwise what was handed over, a reopened recent dialog,
  // or the stored conversation's last request (its skill, files and documents stay for the next message).
  const [start] = useState(() => {
    if (restoreDraft(dialogKey(conversationId))) return { field: null, skill: null as RecentSkill | null };
    if (initial) return { field: initial, skill: null };
    if (reopened) return { field: restoreDialog(reopened, Date.now(), conversationId), skill: reopened.skill };
    const last = lastStoredRequest(state.turns);
    return {
      field: { conversationId, draft: last ? draftFromStored(last, conversationId) : { ...EMPTY_DRAFT } },
      skill: last?.skill ? { id: last.skill.id, name: last.skill.name } : null,
    };
  });
  const composer = useComposer({
    persistKey: dialogKey(conversationId),
    initial: start.field,
    // Files deleted on the server can no longer come back with a recent dialog.
    onDiscard: (ids) => markAttachmentsGone(userId, ids),
  });
  const skills = useSkills(aiMode);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<ApiError | null>(null);

  const conversation = useAssistantTurns({
    conversationId,
    composer,
    ...rememberEffects(userId, () => composer.message().attachments),
  });
  const { turns, pending, run, history: context } = conversation;

  // Arrival: a reopened entry's hand-off is taken; `?q=` / `?about=` fill the field and `?scope=` the scope.
  useEffect(() => {
    if (reopened) clearHandOff();
    if (prefill) composer.setText(prefill.slice(0, 2000));
    if (scopeParam) composer.setScope(scopeFromParam(scopeParam));
    if (focusNextDialog || reopened) {
      focusNextDialog = false;
      composer.focus();
    }
    // Read once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The skill chip of a restored field comes from the registry (only one that can run now).
  const wantedSkill = useRef(start.skill);
  useEffect(() => {
    const wanted = wantedSkill.current;
    if (!wanted || (skills.items === null && !skills.failed)) return;
    wantedSkill.current = null;
    const skill = findSkill(skills.items, wanted);
    if (skill && !composer.draft.skill) composer.setSkill(skill);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skills.items, skills.failed]);

  function send(message: ComposerMessage) {
    if (conversation.busy()) return;
    if (!named) onNamed();
    void run(toAskRequest(message, context), displayOf(message));
  }

  function newDialog() {
    // A dialog that was never asked anything is gone for good: its files are deleted (a named one stays in the
    // history with its files).
    if (!named && turns.length === 0) composer.reset();
    onNew();
  }

  async function deleteDialog() {
    setDeleteError(null);
    try {
      await api.deleteConversation(conversationId);
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err : new ApiError(0, "client_error", String(err), null));
      return;
    }
    setConfirmDelete(false);
    forgetConversation(conversationId);
    forgetLastDialog(conversationId);
    deleteDraft(dialogKey(conversationId));
    forgetRecentDialog(userId, conversationId);
    onNew(true);
  }

  function refine(question: string) {
    composer.setText(question);
    composer.focus();
  }

  /** M7 «Уточнить»: the same work skill and project, the proposal as the referent; the person writes what to change.
   * The server prepares a NEW proposal (the referenced one stays unchanged) — never an apply. */
  function refineWork(reference: WorkProposalRef) {
    const id = reference.kind === "task_plan" ? "draft_task_plan" : "propose_task_changes";
    const skill = skills.items?.find((item) => item.id === id && item.available) ?? null;
    if (!skill) return;
    composer.setSkill(skill);
    composer.setWork({ projectKey: reference.project_key, taskKeys: [], proposalId: reference.id });
    composer.focus();
  }

  const lastTurn = turns[turns.length - 1];
  const first = turns[0];
  const title = first ? first.request.question || first.display.skill?.name || "Диалог" : (state.stored?.title ?? null);
  const missing = state.load === "missing" && !reopened && !initial && turns.length === 0;

  return (
    <div className="dialog">
      <PageToolbar
        crumbs={title ? [{ label: "Ассистент", to: "/" }, { label: title }] : [{ label: "Ассистент" }]}
        actions={
          <>
            {turns.length > 0 ? (
              <Button variant="quiet" icon="trash" onClick={() => setConfirmDelete(true)} disabled={pending || confirmDelete}>
                <span className="toolbar-action__label">Удалить диалог</span>
              </Button>
            ) : null}
            <Button icon="plus" onClick={newDialog}>
              <span className="toolbar-action__label">Новый диалог</span>
            </Button>
          </>
        }
      />
      {confirmDelete ? (
        <div className="dialog__confirm" role="group" aria-labelledby="dialog-delete-text">
          <p id="dialog-delete-text">Удалить этот диалог из истории? Ответы и прикреплённые к нему файлы будут удалены.</p>
          <Button variant="danger" size="sm" onClick={() => void deleteDialog()}>
            Удалить
          </Button>
          <Button variant="quiet" size="sm" onClick={() => setConfirmDelete(false)}>
            Отмена
          </Button>
        </div>
      ) : null}
      {deleteError ? <ErrorState error={deleteError} title="Не удалось удалить диалог" /> : null}
      {missing ? (
        <Notice tone="info" className="dialog__missing">
          Этого диалога нет в истории этого браузера: он удалён, хранился дольше срока или был начат в другом браузере.
          Новый вопрос начнёт его заново.
        </Notice>
      ) : null}
      {turns.length > 0 ? (
        <>
          <h1 className="visually-hidden">Диалог с ассистентом</h1>
          <section className="conversation" aria-label="Диалог">
            {turns.map((turn, index) => {
              const last = turn === lastTurn;
              const again = () => void run(turn.request, turn.display);
              const resendable = turn.stored ? turn.stored.resendable : true;
              return (
                <TurnView
                  key={turn.id}
                  turn={turn}
                  turnNo={index + 1}
                  onRetry={last && turn.phase === "error" && resendable ? again : undefined}
                  onResend={
                    !pending && resendable && (turn.phase === "interrupted" ? last : Boolean(turn.stored?.withheld)) ? again : undefined
                  }
                  onRefine={refine}
                  onRefineWork={refineWork}
                  onAskCorporate={(request, display) => void run(request, display)}
                  onAnswerNormally={(request, display) => void run(request, display)}
                />
              );
            })}
          </section>
        </>
      ) : (
        <div className="dialog__intro">
          <h1>Спросить базу знаний</h1>
          <p className="dialog__lead">
            Ответ строится только по найденным документам. Если подтверждений нет, ассистент прямо скажет, что данных
            недостаточно.
          </p>
          <div className="dialog__examples" role="group" aria-label="Примеры">
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                className="dialog__example"
                onClick={() => {
                  composer.setText(example);
                  composer.focus();
                }}
              >
                {example}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="dialog__composer" ref={pinned}>
        <Composer
          variant="dialog"
          composer={composer}
          skills={skills}
          onSend={send}
          pending={pending}
          onCancel={conversation.cancel}
          inputId="question"
          placeholder={turns.length > 0 && !composer.draft.skill ? "Уточните вопрос или попросите черновик правки" : undefined}
          note={
            context.length > 0
              ? `С учётом ${context.length} ${pluralRu(context.length, "предыдущего ответа", "предыдущих ответов", "предыдущих ответов")} этого диалога (до ${MAX_HISTORY_TURNS}) — только как контекст.`
              : undefined
          }
        />
      </div>
    </div>
  );
}
