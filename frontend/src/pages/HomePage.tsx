import { useEffect, useState, type MouseEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import type { ConversationSummary, DocumentSummary, ProposalSummary } from "../api/types";
import { Composer } from "../components/Composer";
import { IndexStatusNotice } from "../components/IndexStatusNotice";
import { PageToolbar } from "../components/shell/PageToolbar";
import { Button } from "../components/ui/Button";
import { Icon } from "../components/ui/Icon";
import { When } from "../components/When";
import { canAsk } from "../lib/aiMode";
import { askHref, QUICK_SKILL_IDS } from "../lib/assistant";
import { forgetLastDialog, handOff } from "../lib/conversation";
import { forgetAllConversations } from "../lib/conversationStore";
import { OPERATION_LABEL, pluralRu, TYPE_LABEL } from "../lib/labels";
import { REVIEW_HREF } from "../lib/routes";
import { clearRecentQuestions, readRecentDialogs, type RecentDialog } from "../lib/recentQuestions";
import { useSession } from "../lib/session";
import { useAsync } from "../lib/useAsync";
import { useComposer, type ComposerDraft, type ComposerMessage } from "../lib/useComposer";
import { useSkills } from "../lib/useSkills";

/*
 * The home page is the assistant (docs/ui-v2/specs/02_ASSISTANT.md §1, design-01/02): a question, the field, four
 * quick skills, the user's recent dialogs and what waits for the user's decision. Without an AI provider it is
 * a search page: «Что нужно найти?», the field searches the knowledge base, no skills.
 */

/** A message from the home page, handed to the dialog page that runs it (lib/conversation.ts). */
export interface HomeHandOff {
  conversationId: string;
  draft: ComposerDraft;
  message: ComposerMessage;
}

/** A recent dialog of this browser (offline fallback) reopened from the home page: the dialog restores its field. */
export interface RecentHandOff {
  recent: RecentDialog;
}

const REVIEW_LIMIT = 3;
const RECENT_LIMIT = 5;

function sourcesText(n: number): string {
  return `${n} ${pluralRu(n, "источник", "источника", "источников")}`;
}

/** «Ответ по базе, 3 источника» / «Сравнить с файлом, aris_export.csv» (a remembered entry of this browser). */
function dialogDetail(item: RecentDialog): string {
  const what = item.skill?.name ?? "Ответ по базе";
  const detail = item.context ?? (item.sources !== null ? sourcesText(item.sources) : null);
  return detail ? `${what}, ${detail}` : what;
}

/** «Ответ по базе, 3 источника · 2 вопроса», «По документу «ARIS» · Объяснить», «…, ответ не получен». */
function conversationDetail(item: ConversationSummary): string {
  const what = item.last_skill?.name ?? "Ответ по базе";
  const unanswered = item.last_status === "failed" || item.last_status === "interrupted";
  const detail = unanswered
    ? "ответ не получен"
    : (item.context ?? (item.last_status === "done" && item.last_sources !== null ? sourcesText(item.last_sources) : null));
  const parts = [detail ? `${what}, ${detail}` : what];
  if (item.origin === "document" && item.document) parts.unshift(`По документу «${item.document.title}»`);
  if (item.turn_count > 1) parts.push(`${item.turn_count} ${pluralRu(item.turn_count, "вопрос", "вопроса", "вопросов")}`);
  return parts.join(" · ");
}

export function conversationHref(id: string): string {
  return `/ask?${new URLSearchParams({ c: id }).toString()}`;
}

/** Where a remembered entry points: its dialog (the stored turns, if the server has them) — never a new question. */
function recentHref(item: RecentDialog): string {
  if (item.conversationId) return conversationHref(item.conversationId);
  return item.question ? `/ask?${new URLSearchParams({ q: item.question }).toString()}` : "/ask";
}

type RecentState =
  | { kind: "loading" }
  | { kind: "server"; items: ConversationSummary[]; retentionDays: number }
  | { kind: "local"; items: RecentDialog[]; reason: "unavailable" | "disabled" };

/**
 * The user's recent dialogs in THIS browser (the server's chat history, docs/API_CONTRACTS.md v0.7). A row opens
 * the stored conversation — its answers as they were, never asked again. When the history cannot be read (or the
 * server keeps none), the entries this browser remembered stand in: a row then puts the question, skill, files and
 * documents back into the field of its dialog and waits for Enter.
 */
function RecentDialogs() {
  const session = useSession();
  const navigate = useNavigate();
  const userId = session?.user.user_id;
  const [state, setState] = useState<RecentState>({ kind: "loading" });
  const [confirm, setConfirm] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    api
      .conversations({ limit: RECENT_LIMIT })
      .then((list) => {
        if (!live) return;
        setState(
          list.enabled
            ? { kind: "server", items: list.items, retentionDays: list.retention_days }
            : { kind: "local", items: readRecentDialogs(userId), reason: "disabled" },
        );
      })
      .catch(() => {
        if (live) setState({ kind: "local", items: readRecentDialogs(userId), reason: "unavailable" });
      });
    return () => {
      live = false;
    };
  }, [userId]);
  if (state.kind === "loading" || state.items.length === 0) return null;

  function reopen(event: MouseEvent<HTMLAnchorElement>, item: RecentDialog) {
    // A new tab or window keeps the plain link (the hand-off lives in this tab's memory only).
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    handOff<RecentHandOff>({ recent: item });
    navigate(recentHref(item));
  }

  async function clear() {
    setFailed(false);
    if (state.kind === "server") {
      try {
        await api.clearConversations();
      } catch {
        setFailed(true);
        return;
      }
      forgetAllConversations();
      forgetLastDialog(); // plain /ask no longer continues a deleted dialog
    }
    clearRecentQuestions(userId);
    setConfirm(false);
    setState((current) => (current.kind === "loading" ? current : { ...current, items: [] }) as RecentState);
  }

  const row = (title: string, detail: string, at: string | null) => (
    <>
      <span className="assistant-home__row-text">
        <span className="assistant-home__row-title">{title}</span>
        <span className="assistant-home__row-meta">{detail}</span>
      </span>
      {at ? (
        <span className="assistant-home__row-time">
          <When value={at} />
        </span>
      ) : null}
    </>
  );

  const note =
    state.kind === "server"
      ? `Хранятся на сервере для этого браузера ${state.retentionDays} ${pluralRu(state.retentionDays, "день", "дня", "дней")}.`
      : state.reason === "unavailable"
        ? "История на сервере недоступна — показаны записи этого браузера."
        : "Хранятся только в этом браузере.";

  return (
    <section className="assistant-home__list" aria-labelledby="recent-dialogs-title">
      <h2 id="recent-dialogs-title">Недавние диалоги</h2>
      <ul>
        {state.kind === "server"
          ? state.items.map((item) => (
              <li key={item.id}>
                <Link to={conversationHref(item.id)} className="assistant-home__row">
                  {row(item.title, conversationDetail(item), item.updated_at)}
                </Link>
              </li>
            ))
          : state.items.map((item, index) => (
              <li key={`${index}-${item.question}-${item.skill?.name ?? ""}`}>
                <Link to={recentHref(item)} className="assistant-home__row" onClick={(event) => reopen(event, item)}>
                  {row(item.question || item.skill?.name || "Диалог", dialogDetail(item), item.at)}
                </Link>
              </li>
            ))}
      </ul>
      {confirm ? (
        <div className="assistant-home__confirm" role="group" aria-labelledby="recent-clear-text">
          <p id="recent-clear-text">
            {state.kind === "server"
              ? "Удалить всю историю диалогов этого браузера? Ответы и файлы диалогов будут удалены."
              : "Забыть недавние диалоги этого браузера?"}
          </p>
          <Button variant="danger" size="sm" onClick={() => void clear()}>
            Очистить историю
          </Button>
          <Button variant="quiet" size="sm" onClick={() => setConfirm(false)}>
            Отмена
          </Button>
        </div>
      ) : (
        <p className="assistant-home__note">
          {note}{" "}
          <button type="button" className="button button--quiet button--sm" onClick={() => setConfirm(true)}>
            Очистить историю
          </button>
        </p>
      )}
      {failed ? <p className="assistant-home__note" role="alert">Не удалось очистить историю. Повторите попытку.</p> : null}
    </section>
  );
}

/** Documents without an owner, if the catalogue page covers every document (otherwise the count would be a guess). */
function ownerless(documents: { items: DocumentSummary[]; total: number } | null): DocumentSummary[] | null {
  if (!documents || documents.items.length < documents.total) return null;
  return documents.items.filter((doc) => doc.owner_missing);
}

function ownerlessHref(items: DocumentSummary[]): string {
  if (items.length === 1 && items[0]) return `/documents/${encodeURIComponent(items[0].id)}`;
  const owners = new Set(items.map((doc) => doc.owner));
  const owner = owners.size === 1 ? [...owners][0] : null;
  return owner ? `/documents?owner=${encodeURIComponent(owner)}` : "/documents";
}

/** «Интеграции и датасеты»: the sections the documents belong to. */
function typesText(items: DocumentSummary[]): string {
  const labels = [...new Set(items.map((doc) => TYPE_LABEL[doc.type]))];
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} и ${labels[labels.length - 1]?.toLocaleLowerCase("ru")}`;
}

function byUpdatedDesc(a: ProposalSummary, b: ProposalSummary): number {
  return b.updated_at.localeCompare(a.updated_at);
}

/**
 * «Ждёт вашего решения»: only what the API reports — proposals «Готово к ревью» that someone else created (the
 * sidebar's «Ревью»: nobody reviews their own change; there is no reviewer assignment) and documents without an
 * owner. Nothing is invented when a list cannot be read.
 */
function AwaitingDecision() {
  const drafts = useAsync(() => api.drafts({ status: "ready_for_review", exclude_own: true }), "home-review");
  const documents = useAsync(() => api.documents({ size: 100 }), "home-owners");
  const review = [...(drafts.data?.items ?? [])].sort(byUpdatedDesc);
  const noOwner = ownerless(documents.data);
  const loading = (drafts.loading && !drafts.data) || (documents.loading && !documents.data);
  const nothing = review.length === 0 && (noOwner?.length ?? 0) === 0;
  return (
    <section className="assistant-home__list" aria-labelledby="awaiting-title">
      <h2 id="awaiting-title">Ждёт вашего решения</h2>
      <ul>
        {review.slice(0, REVIEW_LIMIT).map((p) => (
          <li key={p.id}>
            <Link to={`/proposals/${encodeURIComponent(p.id)}`} className="assistant-home__row">
              <span className="assistant-home__dot assistant-home__dot--review" aria-hidden="true" />
              <span className="assistant-home__row-text">
                <span className="assistant-home__row-title">{p.document_title}</span>
                <span className="assistant-home__row-meta">Готово к ревью · {OPERATION_LABEL[p.operation]}</span>
              </span>
            </Link>
          </li>
        ))}
        {review.length > REVIEW_LIMIT ? (
          <li>
            <Link to={REVIEW_HREF} className="assistant-home__row assistant-home__row--more">
              Все готовые к ревью: {review.length}
            </Link>
          </li>
        ) : null}
        {noOwner && noOwner.length > 0 ? (
          <li>
            <Link to={ownerlessHref(noOwner)} className="assistant-home__row">
              <span className="assistant-home__dot assistant-home__dot--owner" aria-hidden="true" />
              <span className="assistant-home__row-text">
                <span className="assistant-home__row-title">
                  {noOwner.length} {pluralRu(noOwner.length, "документ", "документа", "документов")} без владельца
                </span>
                <span className="assistant-home__row-meta">{typesText(noOwner)}</span>
              </span>
            </Link>
          </li>
        ) : null}
      </ul>
      {loading ? <p className="assistant-home__note">Загрузка…</p> : null}
      {!loading && nothing && !drafts.error && !documents.error ? (
        <p className="assistant-home__note">Сейчас ничего не ждёт решения.</p>
      ) : null}
      {drafts.error ? <p className="assistant-home__note">Не удалось получить предложения на ревью.</p> : null}
      {documents.error ? <p className="assistant-home__note">Не удалось проверить владельцев документов.</p> : null}
    </section>
  );
}

function HomeIndexStatus() {
  const index = useAsync(() => api.indexStatus(), "home-index");
  if (index.error) return <p className="muted">Не удалось получить состояние синхронизации базы знаний.</p>;
  return index.data ? <IndexStatusNotice status={index.data} /> : null;
}

export function HomePage() {
  const session = useSession();
  const navigate = useNavigate();
  const mode = session?.features.ai_mode;
  const ask = canAsk(mode);
  const skills = useSkills(mode);
  const composer = useComposer({ persistKey: "home" });
  const quick = QUICK_SKILL_IDS.flatMap((id) => skills.items?.filter((skill) => skill.id === id && skill.available) ?? []);

  function send(message: ComposerMessage) {
    handOff<HomeHandOff>({ conversationId: message.conversationId, draft: { ...composer.draft, text: "" }, message });
    // The files now belong to the dialog: the home field starts over without deleting them.
    composer.reset({ handedOver: true });
    navigate(message.question ? askHref(message.question, message.scope) : "/ask");
  }

  return (
    <div className="assistant-home">
      <PageToolbar
        title={ask ? "Ассистент" : "Главная"}
        actions={
          ask ? (
            <Button
              icon="plus"
              onClick={() => {
                composer.reset();
                composer.focus();
              }}
            >
              <span className="toolbar-action__label">Новый диалог</span>
            </Button>
          ) : null
        }
      />
      <section className="assistant-home__intro" aria-labelledby="home-title">
        <h1 id="home-title">{ask ? "Что нужно найти или подготовить?" : "Что нужно найти?"}</h1>
        <p className="assistant-home__lead">
          {ask
            ? "Ассистент отвечает только по документам команды и показывает цитаты. Черновики и правки уходят на ревью."
            : "ИИ в этой установке отключён — поиск по документам команды работает полностью, правки проходят ревью."}
        </p>
      </section>

      <Composer variant="home" composer={composer} skills={skills} onSend={send} inputId="home-composer-input" />

      {ask && quick.length > 0 ? (
        <div className="assistant-home__skills" role="group" aria-label="Быстрые навыки">
          {quick.map((skill) => (
            <button
              key={skill.id}
              type="button"
              className="assistant-home__skill"
              aria-pressed={composer.draft.skill?.id === skill.id}
              onClick={() => {
                composer.setSkill(skill);
                composer.focus();
              }}
            >
              <Icon name="skill" />
              {skill.name}
            </button>
          ))}
        </div>
      ) : null}

      <HomeIndexStatus />

      <div className="assistant-home__lists">
        {ask ? <RecentDialogs /> : null}
        <AwaitingDecision />
      </div>

      {ask ? null : (
        <p className="assistant-home__links">
          <Link to="/documents">Открыть каталог документов</Link>
          <Link to="/documents/new">Создать документ</Link>
        </p>
      )}
    </div>
  );
}
