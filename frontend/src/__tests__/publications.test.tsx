import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IntegrationsResponse, PublicationJobState, PublicationJobSummary } from "../api/types";
import { PublicationsPage } from "../pages/PublicationsPage";
import { arisDetail, integrations, PUB_REVISION, session } from "./fixtures";
import { mockApi, mockViewport, renderRoutes, type MockRoute } from "./helpers";

const JOBS = "/api/publications/jobs";
const ARIS = "SEM-INT-ARIS-001";
const location = () => screen.getByTestId("location").textContent;

function job(id: string, state: PublicationJobState, overrides: Partial<PublicationJobSummary> = {}): PublicationJobSummary {
  return {
    id,
    document_id: ARIS,
    document_path: `docs/${ARIS}.md`,
    revision: PUB_REVISION,
    state,
    action: null,
    proposal_id: null,
    created_at: "2026-11-22T10:00:00Z",
    updated_at: "2026-11-22T10:00:05Z",
    attempts: 0,
    error_code: null,
    error_message: null,
    uncertain: false,
    page_id: null,
    version_after: null,
    published_at: null,
    ...overrides,
  };
}

/** The publisher's integration row as the server reports it: disabled (the default), or another state. */
function withPublisher(state: "disabled" | "connected" | "error", message: string): IntegrationsResponse {
  return {
    ...integrations,
    items: integrations.items.map((item) =>
      item.name === "confluence_publisher" ? { ...item, state, human_readable_message: message } : item,
    ),
  };
}

const DISABLED_MESSAGE =
  "Не настроено (CONFLUENCE_REST_URL не задан). Публикация утверждённых документов из GitLab включается только после отдельного согласования; запись выключена по умолчанию.";

function routes(items: PublicationJobSummary[], status: IntegrationsResponse | null, extra: MockRoute[] = []): MockRoute[] {
  return [
    ...extra,
    { path: JOBS, body: { items, total: items.length } },
    status ? { path: "/api/integrations/status", body: status } : { path: "/api/integrations/status", status: 403, body: { code: "forbidden", message: "Нет прав." } },
    { path: `/api/documents/${ARIS}`, body: arisDetail },
    // SEM-GONE-001 is not mocked: the reader cannot open it (404), so it keeps only its ID.
  ];
}

const renderPage = (s = session) =>
  renderRoutes("/publications", { "/publications": <PublicationsPage />, "/publications/:jobId": <p>Страница задания</p> }, s);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("«Публикации» page", () => {
  it("lists the jobs with their document, a Russian state label of the right tone, the page, revision and time", async () => {
    const items = [
      job("j-published", "published", { page_id: "5000123", version_after: 2, action: "update" }),
      job("j-ready", "dry_run_ready", { action: "create" }),
      job("j-failed", "failed", { error_code: "confluence_unavailable", error_message: "Confluence недоступен." }),
      job("j-conflict", "conflict", { page_id: "5000456" }),
      job("j-unknown", "result_unknown", { uncertain: true }),
      job("j-superseded", "superseded"),
      job("j-pending", "pending"),
      job("j-gone", "validating", { document_id: "SEM-GONE-001" }),
    ];
    const calls = mockApi(routes(items, withPublisher("connected", "Подключено: пространство SKHTEST.")));
    renderPage();
    const table = await screen.findByRole("table", { name: "Задания публикации в Confluence" });
    expect(within(table).getAllByRole("columnheader").map((th) => th.textContent)).toEqual([
      "Документ",
      "Состояние",
      "Страница Confluence",
      "Ревизия",
      "Обновлено",
    ]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(8);

    const expected: [string, string, string][] = [
      ["j-published", "Опубликовано", "pub-state--published"],
      ["j-ready", "Предпросмотр готов", "pub-state--dry_run_ready"],
      ["j-failed", "Ошибка публикации", "pub-state--failed"],
      ["j-conflict", "Конфликт", "pub-state--conflict"],
      ["j-unknown", "Результат не подтверждён", "pub-state--result_unknown"],
      ["j-superseded", "Заменено новой ревизией", "pub-state--superseded"],
      ["j-pending", "Ожидает предпросмотра", "pub-state--pending"],
      ["j-gone", "Идёт предпросмотр", "pub-state--validating"],
    ];
    expected.forEach(([id, label, tone], index) => {
      const row = rows[index] as HTMLElement;
      const state = within(row).getByText(label);
      expect(state, id).toHaveClass("pub-state", tone);
      expect(state).toHaveAttribute("data-publication-state", tone.replace("pub-state--", ""));
    });

    // Title → the job page; ID → the document. The title comes from the document itself.
    const first = rows[0] as HTMLElement;
    expect(within(first).getByRole("link", { name: arisDetail.title })).toHaveAttribute("href", "/publications/j-published");
    expect(within(first).getByRole("link", { name: `${ARIS}, открыть документ` })).toHaveAttribute("href", `/documents/${ARIS}`);
    expect(first).toHaveTextContent("Страница 5000123, версия 2");
    expect(first).toHaveTextContent("3f2a9c1d");
    expect(within(first).getByText(/нояб\. 2026/, { selector: "time" })).toHaveAttribute("datetime", "2026-11-22T10:00:05Z");
    expect(within(rows[3] as HTMLElement).getByText("5000456")).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText("—")).toBeInTheDocument(); // no page yet: nothing invented

    // A document the reader cannot open keeps its ID, which then opens the job.
    const gone = rows[7] as HTMLElement;
    expect(within(gone).getByRole("link", { name: "SEM-GONE-001" })).toHaveAttribute("href", "/publications/j-gone");
    expect(within(gone).getAllByRole("link")).toHaveLength(1);

    // One document lookup per document, not per job.
    expect(calls.filter((c) => c.url === `/api/documents/${ARIS}`)).toHaveLength(1);
    expect(screen.getByText("8", { selector: ".page-toolbar__count" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Публикации" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Опубликовать/ })).toBeNull(); // no actions here: they live on the job page
  });

  it("opens the job from anywhere in the row, but a link inside keeps its own target", async () => {
    mockApi(routes([job("j-1", "published", { page_id: "5000123" })], withPublisher("connected", "Подключено.")));
    renderPage();
    const row = (await screen.findByRole("link", { name: arisDetail.title })).closest("tr") as HTMLElement;
    await userEvent.click(within(row).getByText("Страница", { exact: false }));
    expect(location()).toBe("/publications/j-1");
  });

  it("shows card rows on a phone: title, ID, state, page and time; the whole card opens the job", async () => {
    mockViewport(390);
    mockApi(routes([job("j-1", "published", { page_id: "5000123", version_after: 1 }), job("j-2", "failed")], withPublisher("connected", "Подключено.")));
    renderPage();
    const list = await screen.findByRole("list", { name: "Задания публикации в Confluence" });
    expect(screen.queryByRole("table")).toBeNull();
    const cards = within(list).getAllByRole("listitem");
    expect(cards).toHaveLength(2);
    const card = cards[0] as HTMLElement;
    expect(card).toHaveClass("publication-card");
    expect(within(card).getByRole("link", { name: arisDetail.title })).toHaveAttribute("href", "/publications/j-1");
    expect(within(card).getByRole("link", { name: `${ARIS}, открыть документ` })).toHaveAttribute("href", `/documents/${ARIS}`);
    expect(within(card).getByText("Опубликовано")).toHaveClass("pub-state--published");
    expect(card).toHaveTextContent("Страница 5000123, версия 1");
    expect(within(cards[1] as HTMLElement).getByText("Ошибка публикации")).toHaveClass("pub-state--failed");
    expect(cards[1]).not.toHaveTextContent("Страница"); // a job without a page says nothing about one
    await userEvent.click(within(card).getByText(/ревизия/));
    expect(location()).toBe("/publications/j-1");
  });

  it("explains that publication is off when the publisher is disabled: the server's message and a link to its row", async () => {
    mockApi(routes([], withPublisher("disabled", DISABLED_MESSAGE)));
    renderPage();
    expect(await screen.findByText("Публикация в Confluence выключена")).toBeInTheDocument();
    expect(screen.getByText(DISABLED_MESSAGE)).toBeInTheDocument();
    expect(screen.getByText(/нужны настроенный Confluence REST/)).toHaveTextContent(
      "GitLab как источник смёрженных ревизий утверждённых документов",
    );
    expect(screen.getByRole("link", { name: "Интеграции" })).toHaveAttribute("href", "/integrations#integration-confluence_publisher");
    expect(screen.queryByText("Публикаций пока нет")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(document.querySelector(".button--primary")).toBeNull(); // nothing to do here: no primary action
  });

  it("says «Публикаций пока нет» and how a publication starts when the publisher is enabled", async () => {
    mockApi(routes([], withPublisher("connected", "Подключено: пространство SKHTEST, родитель 5000001; запись разрешена.")));
    renderPage();
    expect(await screen.findByText("Публикаций пока нет")).toBeInTheDocument();
    expect(screen.getByText(/Публикация начинается с утверждённого документа/)).toHaveTextContent(
      "перейдите в «История» и в блоке «Публикация в Confluence» нажмите «Подготовить публикацию»",
    );
    expect(screen.getByRole("link", { name: "Перейти к документам" })).toHaveAttribute("href", "/documents");
    expect(screen.queryByText("Публикация в Confluence выключена")).toBeNull();
    expect(screen.queryByRole("link", { name: "Интеграции" })).toBeNull();
  });

  it("shows the server's message when the publisher is configured but its check failed", async () => {
    mockApi(routes([], withPublisher("error", "Пространство или родительская страница публикации не найдены в Confluence.")));
    renderPage();
    expect(await screen.findByText("Публикация в Confluence настроена, но проверка подключения не прошла.")).toBeInTheDocument();
    expect(screen.getByText("Пространство или родительская страница публикации не найдены в Confluence.")).toBeInTheDocument();
    expect(screen.getByText("Публикаций пока нет")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Интеграции" })).toHaveAttribute("href", "/integrations#integration-confluence_publisher");
  });

  it("keeps earlier jobs visible when publication is now off, and says so", async () => {
    mockApi(routes([job("j-1", "published", { page_id: "5000123" })], withPublisher("disabled", DISABLED_MESSAGE)));
    renderPage();
    expect(await screen.findByRole("table", { name: "Задания публикации в Confluence" })).toBeInTheDocument();
    expect(screen.getByText(/сейчас выключена: новые публикации недоступны/)).toBeInTheDocument();
    expect(screen.getByText(DISABLED_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByText("Публикация в Confluence выключена")).toBeNull();
  });

  it("falls back to the session when the integration status is not available to the reader", async () => {
    mockApi(routes([], null));
    renderPage({ ...session, features: { ...session.features, confluence_publish: false } });
    expect(await screen.findByText("Публикация в Confluence выключена")).toBeInTheDocument();
    expect(screen.queryByText(/Состояние интеграции/)).toBeNull(); // no server message to quote
  });

  it("shows the standard error with a retry when the list cannot be loaded", async () => {
    let attempt = 0;
    mockApi([
      {
        path: JOBS,
        status: 503,
        body: () => {
          attempt += 1;
          return { code: "unavailable", message: "Сервис временно недоступен.", request_id: "r-1" };
        },
      },
      { path: "/api/integrations/status", body: withPublisher("connected", "Подключено.") },
    ]);
    renderPage();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Сервис временно недоступен.");
    expect(attempt).toBe(1);
    mockApi(routes([job("j-1", "dry_run_ready")], withPublisher("connected", "Подключено.")));
    await userEvent.click(within(alert).getByRole("button", { name: "Повторить" }));
    expect(await screen.findByRole("table", { name: "Задания публикации в Confluence" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says that only the newest jobs are shown when the server's limit is reached", async () => {
    const items = Array.from({ length: 50 }, (_, i) => job(`j-${i}`, "superseded"));
    mockApi(routes(items, withPublisher("connected", "Подключено.")));
    renderPage();
    expect(await screen.findByText(/Показаны 50 последних заданий/)).toBeInTheDocument();
  });
});
