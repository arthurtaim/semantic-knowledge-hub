import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AskResponse, AskStreamEvent } from "../api/types";
import { clearConversation } from "../lib/conversation";
import { readRecentDialogs } from "../lib/recentQuestions";
import { AskPage } from "../pages/AskPage";
import { HomePage } from "../pages/HomePage";
import { freshSync, proposalSummary, skills, supportedAnswer } from "./fixtures";
import { memoryStorage, mockApi, ndjsonStream, renderRoutes, type MockRoute, type RecordedCall } from "./helpers";

/*
 * Round 2, decision 8: a recent dialog reopens with its skill, its files and its dialog id — a live file as a chip
 * that is sent, an expired or deleted one as a grey chip that is not; a skill run without a question reopens too.
 */

const KEY = "skh.recent-questions.v1:local-demo-user";
const STREAM = "/api/assistant/ask/stream";
const LIVE = "ATT-00000000000000aa";
const EXPIRED = "ATT-00000000000000bb";
const DIALOG = "conv-recent-0001";

const mockEvents = (response: AskResponse): AskStreamEvent[] => [
  { type: "status", stage: "retrieving" },
  { type: "status", stage: "validating" },
  { type: "final", response },
];

function streamRoute(): MockRoute {
  return {
    method: "POST",
    path: STREAM,
    respond: (init) => {
      const stream = ndjsonStream();
      const response = stream.respond(init);
      stream.push(...mockEvents(supportedAnswer));
      stream.close();
      return response;
    },
  };
}

function routes(extra: MockRoute[] = []): MockRoute[] {
  return [
    ...extra,
    { path: "/api/assistant/skills", body: skills },
    { path: "/api/drafts", body: { items: [proposalSummary({ status: "draft" })], total: 1 } },
    { path: "/api/documents?size=100", body: { items: [], total: 0, page: 1, size: 100 } },
    { path: "/api/index/status", body: freshSync },
    { method: "DELETE", path: /\/api\/assistant\/attachments\//, status: 204 },
  ];
}

const pages = { "/": <HomePage />, "/ask": <AskPage /> };
const posts = (calls: RecordedCall[]) => calls.filter((c) => c.method === "POST" && c.url === STREAM);

function remember(entries: unknown[]) {
  window.localStorage.setItem(KEY, JSON.stringify(entries));
}

const file = (id: string, name: string, expires: string) => ({
  id,
  name,
  size: 2048,
  mime: "text/csv",
  summary: "12 строк",
  expires_at: expires,
  gone: false,
});

async function reopen(name: RegExp) {
  const recent = (await screen.findByRole("heading", { name: "Недавние диалоги" })).closest("section") as HTMLElement;
  await userEvent.click(within(recent).getByRole("link", { name }));
  await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/ask$/));
}

/** The field's chips (a sent message repeats its chips in the dialog above, under the same name). */
const chips = () => screen.getAllByRole("list", { name: "Приложено к сообщению" }).at(-1) as HTMLElement;
const fileChip = (name: string) => within(chips()).getByRole("button", { name: `Убрать файл «${name}»` }).closest(".chip") as HTMLElement;

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  clearConversation();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearConversation();
});

describe("Reopening a recent dialog", () => {
  it("restores the skill, a live file and a grey expired one in the same dialog; Enter sends only the live file", async () => {
    remember([
      {
        question: "Сверить выгрузку с маппингом ARIS",
        at: "2026-11-24T10:00:00Z",
        skill: "Сравнить с файлом",
        skill_id: "compare_with_file",
        sources: 2,
        context: "aris.csv",
        conversation_id: DIALOG,
        attachments: [file(LIVE, "aris.csv", "2099-01-01T00:00:00Z"), file(EXPIRED, "old.csv", "2020-01-01T00:00:00Z")],
        documents: [],
      },
    ]);
    const calls = mockApi(routes([streamRoute()]));
    renderRoutes("/", pages);
    await reopen(/Сверить выгрузку с маппингом ARIS/);

    expect(await screen.findByRole("button", { name: "Убрать навык «Сравнить с файлом»" })).toBeInTheDocument();
    expect(screen.getByLabelText("Вопрос")).toHaveValue("Сверить выгрузку с маппингом ARIS");
    expect(fileChip("aris.csv")).toHaveTextContent("2 КБ · 12 строк");
    expect(fileChip("aris.csv")).not.toHaveClass("chip--unavailable");
    expect(fileChip("old.csv")).toHaveTextContent("файл больше недоступен");
    expect(fileChip("old.csv")).toHaveClass("chip--unavailable");
    expect(posts(calls)).toHaveLength(0); // a skill with files waits for Enter

    await userEvent.type(screen.getByLabelText("Вопрос"), "{Enter}");
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]?.body).toMatchObject({
      question: "Сверить выгрузку с маппингом ARIS",
      skill_id: "compare_with_file",
      conversation_id: DIALOG,
      attachment_ids: [LIVE],
    });
  });

  it("opens a skill run without a question: the skill chip and an empty field (older entry: the skill by name)", async () => {
    remember([{ question: "", at: "2026-11-24T09:00:00Z", skill: "Найти связи", sources: null, context: null }]);
    const calls = mockApi(routes([streamRoute()]));
    renderRoutes("/", pages);
    await reopen(/Найти связи/);
    expect(await screen.findByRole("button", { name: "Убрать навык «Найти связи»" })).toBeInTheDocument();
    expect(screen.getByLabelText("Вопрос")).toHaveValue("");
    expect(screen.getByLabelText("Вопрос")).toHaveFocus();
    expect(posts(calls)).toHaveLength(0);
  });

  it("asks a plain question again at once, as before", async () => {
    remember([{ question: "Что отправляет ARIS в каталог?", at: null, skill: null, sources: 3, context: null }]);
    const calls = mockApi(routes([streamRoute()]));
    renderRoutes("/", pages);
    await reopen(/Что отправляет ARIS в каталог\?/);
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]?.body).toMatchObject({ question: "Что отправляет ARIS в каталог?" });
    expect(posts(calls)[0]?.body).not.toHaveProperty("attachment_ids");
  });

  it("greys a file out when the server answers attachment_not_found, and does not send it again", async () => {
    remember([
      {
        question: "Что в этой выгрузке?",
        at: null,
        skill: null,
        sources: null,
        context: "aris.csv",
        conversation_id: DIALOG,
        attachments: [file(LIVE, "aris.csv", "2099-01-01T00:00:00Z")],
      },
    ]);
    let attempt = 0;
    const calls = mockApi(
      routes([
        {
          method: "POST",
          path: STREAM,
          respond: (init) => {
            attempt += 1;
            if (attempt === 1) {
              return new Response(
                JSON.stringify({
                  code: "attachment_not_found",
                  message: "Вложение не найдено в этом диалоге или срок его хранения истёк. Прикрепите файл заново.",
                  request_id: "r",
                  details: { attachment_id: LIVE },
                }),
                { status: 404, headers: { "Content-Type": "application/json" } },
              );
            }
            return streamRoute().respond?.(init) as Response;
          },
        },
      ]),
    );
    renderRoutes("/", pages);
    await reopen(/Что в этой выгрузке\?/);
    expect(fileChip("aris.csv")).not.toHaveClass("chip--unavailable");
    await userEvent.type(screen.getByLabelText("Вопрос"), "{Enter}");
    expect(await screen.findByText("Файл больше недоступен")).toBeInTheDocument(); // the turn's error title
    await waitFor(() => expect(fileChip("aris.csv")).toHaveClass("chip--unavailable"));
    expect(fileChip("aris.csv")).toHaveTextContent("файл больше недоступен");
    expect(readRecentDialogs("local-demo-user")[0]?.attachments[0]?.gone).toBe(true);

    // The question was put back; sending again goes without the file.
    expect(screen.getByLabelText("Вопрос")).toHaveValue("Что в этой выгрузке?");
    await userEvent.type(screen.getByLabelText("Вопрос"), "{Enter}");
    await waitFor(() => expect(posts(calls)).toHaveLength(2));
    expect(posts(calls)[1]?.body).toMatchObject({ question: "Что в этой выгрузке?", conversation_id: DIALOG });
    expect(posts(calls)[1]?.body).not.toHaveProperty("attachment_ids");
  });

  it("«Новый диалог» deletes the dialog's files on the server; the recent dialog then shows them as unavailable", async () => {
    remember([
      {
        question: "Сверить выгрузку",
        at: null,
        skill: "Сравнить с файлом",
        skill_id: "compare_with_file",
        sources: null,
        context: "aris.csv",
        conversation_id: DIALOG,
        attachments: [file(LIVE, "aris.csv", "2099-01-01T00:00:00Z")],
      },
    ]);
    const calls = mockApi(routes([streamRoute()]));
    renderRoutes("/", pages);
    await reopen(/Сверить выгрузку/);
    await screen.findByRole("button", { name: "Убрать навык «Сравнить с файлом»" });
    await userEvent.click(screen.getByRole("button", { name: "Новый диалог" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith(LIVE))).toBe(true));
    expect(readRecentDialogs("local-demo-user")[0]?.attachments[0]?.gone).toBe(true);
  });

  it("remembers the dialog id, the skill's id and the attached file's details when a message is sent", async () => {
    const calls = mockApi(routes([streamRoute()]));
    renderRoutes("/ask", pages);
    await userEvent.type(screen.getByLabelText("Вопрос"), "Где хранится база знаний?{Enter}");
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    const [entry] = readRecentDialogs("local-demo-user");
    expect(entry).toMatchObject({ question: "Где хранится база знаний?", skill: null, attachments: [], documents: [] });
    expect(entry?.conversationId).toBe((posts(calls)[0]?.body as { conversation_id: string }).conversation_id);
  });
});
