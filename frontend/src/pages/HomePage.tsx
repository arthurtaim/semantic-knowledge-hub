import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import type { DocumentSummary, ProposalSummary } from "../api/types";
import { Composer } from "../components/Composer";
import { IndexStatusNotice } from "../components/IndexStatusNotice";
import { PageToolbar } from "../components/shell/PageToolbar";
import { Button } from "../components/ui/Button";
import { Icon } from "../components/ui/Icon";
import { When } from "../components/When";
import { canAsk } from "../lib/aiMode";
import { askHref, QUICK_SKILL_IDS } from "../lib/assistant";
import { handOff } from "../lib/conversation";
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

const REVIEW_LIMIT = 3;

function sourcesText(n: number): string {
  return `${n} ${pluralRu(n, "источник", "источника", "источников")}`;
}

/** «Ответ по базе, 3 источника» / «Сравнить с файлом, aris_export.csv». */
function dialogDetail(item: RecentDialog): string {
  const what = item.skill ?? "Ответ по базе";
  const detail = item.context ?? (item.sources !== null ? sourcesText(item.sources) : null);
  return detail ? `${what}, ${detail}` : what;
}

/** The user's recent dialogs (this browser only); a question opens its answer again. */
function RecentDialogs() {
  const session = useSession();
  const userId = session?.user.user_id;
  const [items, setItems] = useState(() => readRecentDialogs(userId));
  useEffect(() => setItems(readRecentDialogs(userId)), [userId]);
  if (items.length === 0) return null;
  return (
    <section className="assistant-home__list" aria-labelledby="recent-dialogs-title">
      <h2 id="recent-dialogs-title">Недавние диалоги</h2>
      <ul>
        {items.map((item, index) => {
          const body = (
            <>
              <span className="assistant-home__row-text">
                <span className="assistant-home__row-title">{item.question || item.skill}</span>
                <span className="assistant-home__row-meta">{dialogDetail(item)}</span>
              </span>
              {item.at ? (
                <span className="assistant-home__row-time">
                  <When value={item.at} />
                </span>
              ) : null}
            </>
          );
          return (
            <li key={`${index}-${item.question}-${item.skill ?? ""}`}>
              {item.question ? (
                <Link to={askHref(item.question)} className="assistant-home__row">
                  {body}
                </Link>
              ) : (
                <span className="assistant-home__row">{body}</span>
              )}
            </li>
          );
        })}
      </ul>
      <p className="assistant-home__note">
        Хранятся только в этом браузере.{" "}
        <button
          type="button"
          className="button button--quiet button--sm"
          onClick={() => {
            clearRecentQuestions(userId);
            setItems([]);
          }}
        >
          Очистить
        </button>
      </p>
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
 * «Ждёт вашего решения»: only what the API reports — proposals marked «Готово к ревью» (the sidebar's «Ревью»
 * count; there is no reviewer assignment) and documents without an owner. Nothing is invented when a list
 * cannot be read.
 */
function AwaitingDecision() {
  const drafts = useAsync(() => api.drafts(), "home-review");
  const documents = useAsync(() => api.documents({ size: 100 }), "home-owners");
  const review = (drafts.data?.items ?? []).filter((p) => p.status === "ready_for_review").sort(byUpdatedDesc);
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
              Новый диалог
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
