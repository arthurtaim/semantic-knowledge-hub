import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { NOTHING_ATTACHED, TurnView, type Turn } from "../components/AssistantTurn";
import { Composer } from "../components/Composer";
import { PageToolbar } from "../components/shell/PageToolbar";
import { Button } from "../components/ui/Button";
import { canAsk } from "../lib/aiMode";
import { scopeFromParam, scopeSources } from "../lib/assistant";
import { clearHandOff, peekHandOff, restoreConversation, saveConversation } from "../lib/conversation";
import { pluralRu } from "../lib/labels";
import { noteDialogSources, rememberDialog } from "../lib/recentQuestions";
import { useSession } from "../lib/session";
import { displayOf, MAX_HISTORY_TURNS, useAssistantTurns } from "../lib/useAssistantTurns";
import { toAskRequest, useComposer, type ComposerMessage } from "../lib/useComposer";
import { useSkills } from "../lib/useSkills";
import type { HomeHandOff } from "./HomePage";

/*
 * /ask is a dialog (docs/ui-v2/specs/02_ASSISTANT.md §2, design-03): the user's messages on the right with what
 * was attached, the assistant's answers with citation markers and one list of sources each, the field pinned at
 * the bottom. Streaming stages, «Недостаточно данных», errors with a retry and conflicts are states of a turn
 * (components/AssistantTurn.tsx, lib/useAssistantTurns.ts — shared with the document's assistant panel).
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

export function AskPage() {
  const [params, setParams] = useSearchParams();
  const session = useSession();
  const aiMode = session?.features.ai_mode;
  const userId = session?.user.user_id;
  const about = params.get("about");
  const initialQuestion = params.get("q");
  // `?run=1` (from «Спросить или найти»): ask at once. The flag is removed from the URL first, so a reload or a
  // second effect run (React StrictMode) never asks twice.
  const runRequested = params.get("run") === "1";
  // A message sent from the home page: it starts a new dialog here with its chips (lib/conversation.ts).
  const [handed] = useState(() => peekHandOff<HomeHandOff>());
  const composer = useComposer({
    persistKey: "dialog",
    initial: handed ? { conversationId: handed.conversationId, draft: handed.draft } : null,
  });
  const skills = useSkills(aiMode);
  // Completed turns survive a visit to a cited document (memory only; see lib/conversation.ts).
  const conversation = useAssistantTurns({
    composer,
    initial: () => (handed ? [] : restoreConversation<Turn>()),
    onStart: (request, display) =>
      rememberDialog(userId, {
        question: request.question,
        skill: display.skill?.name,
        context: display.files[0]?.name ?? display.documents[0]?.title ?? null,
      }),
    onAnswer: (request, display, response) =>
      noteDialogSources(userId, request.question, display.skill?.name ?? null, response.citations.length),
  });
  const { turns, pending, run, history: context } = conversation;

  useEffect(() => saveConversation(turns.filter((turn) => turn.phase === "done")), [turns]);

  // `?q=` / `?about=` fill the field and `?scope=` the scope (unless a message is about to run).
  useEffect(() => {
    if (handed || runRequested) return;
    if (about) composer.setText(`Что известно о «${about}»?`);
    else if (initialQuestion) composer.setText(initialQuestion.slice(0, 2000));
    if (params.get("scope")) composer.setScope(scopeFromParam(params.get("scope")));
    // Read once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function dropRunFlag() {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete("run");
        return next;
      },
      { replace: true },
    );
  }

  // The hand-off from the home page runs once (the timer survives StrictMode's double effects).
  useEffect(() => {
    if (!handed || !canAsk(aiMode)) return undefined;
    const timer = window.setTimeout(() => {
      clearHandOff();
      if (runRequested) dropRunFlag();
      conversation.clear();
      void run(toAskRequest(handed.message), displayOf(handed.message));
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handed, aiMode]);

  useEffect(() => {
    if (handed || !runRequested || !canAsk(aiMode)) return undefined;
    const timer = window.setTimeout(() => {
      const text = (params.get("q") ?? "").trim().slice(0, 2000);
      const scope = scopeFromParam(params.get("scope"));
      dropRunFlag();
      if (text.length < 3) return;
      // A question from «Спросить или найти» starts a new dialog (no earlier answers, files or skill).
      conversation.clear();
      const conversationId = composer.reset();
      composer.setScope(scope);
      void run(
        {
          question: text,
          sources: scopeSources(scope),
          include_drafts: false,
          include_deprecated: false,
          history: [],
          conversation_id: conversationId,
        },
        NOTHING_ATTACHED,
      );
    }, 0);
    return () => window.clearTimeout(timer);
    // run/params are read at the moment of the request; the effect reacts to the flag only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runRequested, aiMode]);

  function send(message: ComposerMessage) {
    if (conversation.busy()) return;
    void run(toAskRequest(message, context), displayOf(message));
  }

  function newConversation() {
    if (conversation.busy()) return;
    conversation.clear();
    composer.reset();
    composer.focus();
  }

  function refine(question: string) {
    composer.setText(question);
    composer.focus();
  }

  const lastTurn = turns[turns.length - 1];
  const first = turns[0];

  // AI_PROVIDER=disabled: no question form with a button that can only fail — the page says so and searches.
  if (aiMode === "disabled") return <AskUnavailable initial={about ?? initialQuestion ?? ""} />;

  return (
    <div className="dialog">
      <PageToolbar
        crumbs={
          first
            ? [{ label: "Ассистент", to: "/" }, { label: first.request.question || first.display.skill?.name || "Диалог" }]
            : [{ label: "Ассистент" }]
        }
        actions={
          <Button icon="plus" onClick={newConversation} disabled={pending}>
            <span className="toolbar-action__label">Новый диалог</span>
          </Button>
        }
      />
      {turns.length > 0 ? (
        <>
          <h1 className="visually-hidden">Диалог с ассистентом</h1>
          <section className="conversation" aria-label="Диалог">
            {turns.map((turn, index) => (
              <TurnView
                key={turn.id}
                turn={turn}
                turnNo={index + 1}
                onRetry={turn === lastTurn && turn.phase === "error" ? () => void run(turn.request, turn.display) : undefined}
                onRefine={refine}
                onAskCorporate={(request, display) => void run(request, display)}
              />
            ))}
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

      <div className="dialog__composer">
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
