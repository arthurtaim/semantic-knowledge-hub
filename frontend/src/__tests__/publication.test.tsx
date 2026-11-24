import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { IntegrationsResponse } from "../api/types";
import { parseUnifiedDiff } from "../lib/diff";
import { DocumentPage } from "../pages/DocumentPage";
import { IntegrationsPage } from "../pages/IntegrationsPage";
import { ProposalDetailPage } from "../pages/ProposalDetailPage";
import { PublicationJobPage } from "../pages/PublicationJobPage";
import {
  arisDetail,
  CONFLUENCE_PAGE_URL,
  disabledPublication,
  gitlabSession,
  integrations,
  MR_URL,
  PUB_JOB_ID,
  PUB_REVISION,
  publicationJob,
  publicationStatus,
  submittedProposal,
} from "./fixtures";
import { mockApi, renderRoutes, type MockRoute } from "./helpers";

const DOC = "/documents/SEM-INT-ARIS-001";
const JOB = `/api/publications/jobs/${PUB_JOB_ID}`;
const location = () => screen.getByTestId("location").textContent;

function documentRoutes(publication: unknown, extra: MockRoute[] = []): MockRoute[] {
  return [
    ...extra,
    { path: "/api/documents/SEM-INT-ARIS-001", body: arisDetail },
    { path: "/api/drafts?document_id=SEM-INT-ARIS-001", body: { items: [], total: 0 } },
    { path: "/api/documents/SEM-INT-ARIS-001/publication", body: publication },
  ];
}

const renderDocument = () => renderRoutes(DOC, { "/documents/:id": <DocumentPage /> });
/** UI v2: publication lives in the «История» segment of the document. */
async function openHistory() {
  await userEvent.click(await screen.findByRole("tab", { name: "История" }));
}
/** UI v2: the former passport facts are in «Сведения о документе». */
async function openDetails(): Promise<HTMLElement> {
  await userEvent.click(await screen.findByRole("button", { name: "Все сведения" }));
  return screen.getByRole("complementary", { name: "Сведения о документе" });
}
const renderJob = () =>
  renderRoutes(`/publications/${PUB_JOB_ID}`, { "/publications/:jobId": <PublicationJobPage /> });

describe("Document page: publication block", () => {
  it("shows only a quiet note when publication is not configured", async () => {
    mockApi(documentRoutes(disabledPublication));
    renderDocument();
    const details = await openDetails();
    expect(await within(details).findByText("публикация не настроена")).toBeInTheDocument();
    await openHistory();
    expect(await screen.findByText("Публикация в Confluence не настроена в этой установке.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Публикация в Confluence" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Подготовить публикацию" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Опубликовать/ })).toBeNull();
  });

  it("prepares a preview for an unpublished document and opens the job page", async () => {
    const calls = mockApi(
      documentRoutes(publicationStatus(), [
        { method: "POST", path: "/api/documents/SEM-INT-ARIS-001/publication/prepare", body: publicationJob() },
      ]),
    );
    renderDocument();
    await openHistory();
    const section = (await screen.findByRole("heading", { name: "Публикация в Confluence" })).closest("section") as HTMLElement;
    expect(within(section).getByText("Не публиковался")).toBeInTheDocument();
    expect(within(section).getByText("Документ ещё не публиковался в Confluence.")).toBeInTheDocument();
    expect(within(section).getByText("ещё не публиковался")).toBeInTheDocument();
    expect(within(section).getByText("3f2a9c1d")).toBeInTheDocument();
    expect(within(section).getAllByText("тестовый дубль Confluence").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /Опубликовать/ })).toBeNull();

    await userEvent.click(within(section).getByRole("button", { name: "Подготовить публикацию" }));
    await waitFor(() => expect(location()).toBe(`/publications/${PUB_JOB_ID}`));
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual([
      "/api/documents/SEM-INT-ARIS-001/publication/prepare",
    ]);
  });

  it("links to the published page and marks the mock target", async () => {
    mockApi(
      documentRoutes(
        publicationStatus({
          state: "published",
          message: "Опубликована актуальная ревизия документа.",
          mapping: {
            page_id: "98765",
            space_key: "SKHTEST",
            parent_id: "1001",
            page_title: "ARIS integration — questions for discovery",
            page_version: 3,
            published_revision: PUB_REVISION,
            last_published_at: "2026-11-22T11:00:00Z",
            url: CONFLUENCE_PAGE_URL,
          },
          latest_job: publicationJob({ state: "published", page_id: "98765", version_after: 3 }),
        }),
      ),
    );
    renderDocument();
    await openHistory();
    const section = (await screen.findByRole("heading", { name: "Публикация в Confluence" })).closest("section") as HTMLElement;
    expect(within(section).getByText("Опубликован", { selector: ".pub-state" })).toBeInTheDocument();
    const link = within(section).getByRole("link", { name: /Открыть страницу в Confluence/ });
    expect(link).toHaveAttribute("href", CONFLUENCE_PAGE_URL);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(within(link.parentElement as HTMLElement).getByText("тестовый дубль Confluence")).toBeInTheDocument();
    expect(within(section).getByText("«ARIS integration — questions for discovery», версия 3")).toBeInTheDocument();
    expect(within(section).getByRole("link", { name: "Подробнее о публикации" })).toHaveAttribute(
      "href",
      `/publications/${PUB_JOB_ID}`,
    );
    const details = await openDetails();
    expect(within(details).getByText("Опубликован")).toBeInTheDocument();
  });

  it("explains a conflict with the latest job error and links to the preview", async () => {
    const message = "Страница изменена в Confluence вручную (версия 3 → 4). Автоматическая перезапись запрещена.";
    mockApi(
      documentRoutes(
        publicationStatus({
          state: "conflict",
          message,
          latest_job: publicationJob({ state: "conflict", action: "conflict", error_code: "manual_edit", error_message: message }),
        }),
      ),
    );
    renderDocument();
    await openHistory();
    const section = (await screen.findByRole("heading", { name: "Публикация в Confluence" })).closest("section") as HTMLElement;
    expect(within(section).getByText("Конфликт", { selector: ".pub-state" })).toBeInTheDocument();
    expect(within(section).getAllByText(message)).toHaveLength(1);
    expect(within(section).getByText("Последняя попытка публикации")).toBeInTheDocument();
    expect(within(section).getByRole("link", { name: "Открыть предпросмотр" })).toHaveAttribute(
      "href",
      `/publications/${PUB_JOB_ID}`,
    );
  });

  it("says that only a preview is possible when writes are off", async () => {
    mockApi(
      documentRoutes(
        publicationStatus({
          publisher: { mode: "dry_run_only", target_kind: "real", space_key: "SKHTEST", parent_id: "1001", message: "" },
        }),
      ),
    );
    renderDocument();
    await openHistory();
    expect(await screen.findByText(/Запись в Confluence выключена: можно подготовить и проверить предпросмотр/)).toBeInTheDocument();
    expect(screen.getByText(/Реальный сервер — live validation не проводилась/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Опубликовать/ })).toBeNull();
  });
});

describe("Publication job page", () => {
  it("shows a create preview and publishes it", async () => {
    const calls = mockApi([
      { path: JOB, body: publicationJob() },
      { path: "/api/documents/SEM-INT-ARIS-001/publication", body: publicationStatus() },
      {
        method: "POST",
        path: `${JOB}/publish`,
        body: publicationJob({
          state: "published",
          page_id: "98765",
          version_after: 1,
          published_at: "2026-11-22T10:01:00Z",
          can_publish: false,
          can_dry_run: false,
          plan: { ...publicationJob().plan!, target: { ...publicationJob().plan!.target, page_id: "98765", url: CONFLUENCE_PAGE_URL } },
        }),
      },
    ]);
    const { container } = renderJob();
    expect(await screen.findByRole("heading", { level: 1, name: "Публикация в Confluence" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "SEM-INT-ARIS-001" })).toHaveAttribute("href", "/documents/SEM-INT-ARIS-001");
    expect(screen.getByText("Предпросмотр готов", { selector: ".pub-state" })).toBeInTheDocument();
    expect(screen.getByTestId("publication-action")).toHaveTextContent("Будет создана новая страница");
    expect(screen.getByRole("link", { name: /MR !42/ })).toHaveAttribute("href", MR_URL);
    expect(screen.getByText("будет создана")).toBeInTheDocument();
    expect(screen.getByText(/Изображения не публикуются/)).toBeInTheDocument();
    expect(screen.getByText(/Картинки остаются в GitLab/)).toBeInTheDocument();

    const table = screen.getByRole("table", { name: "Содержимое новой страницы" });
    const rows = within(table).getAllByRole("row").filter((r) => r.classList.contains("diff__row"));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.classList.contains("diff__row--add"))).toBe(true);
    // The storage body is shown as code, never rendered as HTML.
    expect(screen.getByText(/<h1>ARIS integration<\/h1>/, { selector: "code" })).toBeInTheDocument();
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    expect(screen.getByText("Выполнен предпросмотр (dry-run)", { exact: false })).toBeInTheDocument();

    const publish = screen.getByRole("button", { name: "Опубликовать в Confluence" });
    expect(publish).toBeEnabled();
    expect(screen.getByRole("button", { name: "Проверить заново (dry-run)" })).toBeEnabled();
    await userEvent.click(publish);
    expect(await screen.findByText("Опубликовано в Confluence.")).toBeInTheDocument();
    const outcome = screen.getByText("Опубликовано в Confluence", { selector: "strong" }).closest(".notice") as HTMLElement;
    expect(within(outcome).getByRole("link", { name: /Открыть страницу в Confluence/ })).toHaveAttribute("href", CONFLUENCE_PAGE_URL);
    expect(within(outcome).getByText("тестовый дубль Confluence")).toBeInTheDocument();
    expect(screen.getByTestId("publication-action")).toHaveTextContent("Создана новая страница");
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual([`${JOB}/publish`]);
  });

  it("never offers publishing while writes are disabled and explains why", async () => {
    const reason = "Запись в Confluence выключена (CONFLUENCE_PUBLISH_ENABLED=false): доступен только предпросмотр.";
    mockApi([{ path: JOB, body: publicationJob({ can_publish: false, publish_enabled: false, publish_disabled_reason: reason }) }]);
    renderJob();
    expect(await screen.findByText(reason)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Опубликовать/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Проверить заново (dry-run)" })).toBeEnabled();
  });

  it("describes an update with versions and blocks publishing on problems", async () => {
    const base = publicationJob().plan!;
    mockApi([
      {
        path: JOB,
        body: publicationJob({
          action: "update",
          can_publish: false,
          plan: {
            ...base,
            action: "update",
            diff_kind: "page_update",
            remote_version: 3,
            target: { ...base.target, page_id: "98765", url: CONFLUENCE_PAGE_URL },
            diff: "--- current-in-confluence\n+++ new-revision\n@@ -1,2 +1,2 @@\n <h1>ARIS integration</h1>\n-<p>Old.</p>\n+<p>New.</p>",
            problems: [
              { severity: "error", code: "status_not_publishable", message: "Статус документа «draft» не допускает публикацию.", field: null },
            ],
          },
        }),
      },
    ]);
    renderJob();
    expect(await screen.findByTestId("publication-action")).toHaveTextContent("Будет обновлена страница 98765 (версия 3 → 4)");
    expect(screen.getByText("Публикация заблокирована:")).toBeInTheDocument();
    expect(screen.getByText(/не допускает публикацию/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Опубликовать в Confluence" })).toBeDisabled();
    expect(screen.getByText(/Публикация заблокирована: устраните проблемы/)).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Изменения страницы построчно" });
    expect(within(table).getByText("<p>Old.</p>")).toBeInTheDocument();
    expect(within(table).getByText("<p>New.</p>")).toBeInTheDocument();
  });

  it("explains a manual edit and acknowledges it only after confirmation", async () => {
    const base = publicationJob().plan!;
    const conflict = publicationJob({
      state: "conflict",
      action: "conflict",
      can_publish: false,
      can_reconcile: true,
      error_code: "manual_edit",
      error_message: "Страница изменена в Confluence вручную (версия 3 → 4).",
      plan: {
        ...base,
        action: "conflict",
        diff_kind: "manual_edit",
        remote_version: 4,
        target: { ...base.target, page_id: "98765", url: CONFLUENCE_PAGE_URL },
        diff: "--- published-by-app\n+++ current-in-confluence\n@@ -1,2 +1,3 @@\n <h1>ARIS integration</h1>\n <p>Synthetic discovery questions.</p>\n+<p>Правка в Confluence.</p>",
        problems: [{ severity: "error", code: "manual_edit", message: "Страница изменена в Confluence вручную (версия 3 → 4).", field: null }],
      },
    });
    const calls = mockApi([
      { path: JOB, body: conflict },
      {
        method: "POST",
        path: `${JOB}/acknowledge-manual-edit`,
        body: publicationJob({ action: "update", plan: { ...base, action: "update", diff_kind: "page_update", remote_version: 4 } }),
      },
    ]);
    renderJob();
    const panel = (await screen.findByRole("heading", { name: "Страница изменена в Confluence вручную" })).closest("section") as HTMLElement;
    expect(within(panel).getByText(/Автоматическая перезапись\s+запрещена/)).toBeInTheDocument();
    expect(within(panel).getByRole("link", { name: "Предложить изменение документа" })).toHaveAttribute(
      "href",
      "/proposals/new?document=SEM-INT-ARIS-001",
    );
    expect(screen.getByRole("table", { name: "Ручная правка построчно" })).toHaveTextContent("Правка в Confluence.");
    expect(screen.getByRole("button", { name: "Повторить" })).toBeEnabled();

    await userEvent.click(within(panel).getByRole("button", { name: "Подтвердить ручную правку" }));
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(screen.getByText(/Принять текущую страницу Confluence как основу\?/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Да, принять текущую страницу как основу" }));
    expect(await screen.findByText(/Ручная правка подтверждена\. Предпросмотр обновлён/)).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual([`${JOB}/acknowledge-manual-edit`]);
    expect(screen.queryByRole("heading", { name: "Страница изменена в Confluence вручную" })).toBeNull();
  });

  it("offers to recreate a page that was deleted in Confluence", async () => {
    const base = publicationJob().plan!;
    const missing = publicationJob({
      state: "conflict",
      action: "conflict",
      can_publish: false,
      can_reconcile: true,
      error_code: "mapped_page_missing",
      plan: {
        ...base,
        action: "conflict",
        target: { ...base.target, page_id: "98765" },
        problems: [{ severity: "error", code: "mapped_page_missing", message: "Страница 98765 не найдена.", field: null }],
      },
    });
    const calls = mockApi([
      { path: JOB, body: missing },
      { method: "POST", path: `${JOB}/release-missing-page`, body: publicationJob() },
    ]);
    renderJob();
    await screen.findByRole("heading", { name: "Опубликованная страница не найдена в Confluence" });
    await userEvent.click(screen.getByRole("button", { name: "Создать страницу заново" }));
    expect(await screen.findByText(/Привязка к удалённой странице снята/)).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual([`${JOB}/release-missing-page`]);
  });

  it("checks an unconfirmed write before anything else", async () => {
    const calls = mockApi([
      {
        path: JOB,
        body: publicationJob({
          state: "result_unknown",
          can_publish: false,
          can_dry_run: false,
          can_reconcile: true,
          uncertain: true,
          attempts: 1,
          error_code: "confluence_write_uncertain",
          error_message: "Ответ Confluence не получен.",
        }),
      },
      {
        method: "POST",
        path: `${JOB}/reconcile`,
        body: publicationJob({ state: "published", page_id: "98765", version_after: 1, can_publish: false, can_reconcile: false }),
      },
    ]);
    renderJob();
    expect(await screen.findByText("Результат публикации не подтверждён", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Опубликовать в Confluence" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Проверить заново (dry-run)" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Проверить результат" }));
    expect(await screen.findByText("Проверка подтвердила: страница опубликована.")).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual([`${JOB}/reconcile`]);
  });

  it("reloads the job and asks to review again when the preview changed (409 plan_changed)", async () => {
    const base = publicationJob().plan!;
    let reads = 0;
    const calls = mockApi([
      {
        path: JOB,
        body: () => {
          reads += 1;
          return reads === 1
            ? publicationJob()
            : publicationJob({
                action: "update",
                plan: { ...base, action: "update", diff_kind: "page_update", remote_version: 7, target: { ...base.target, page_id: "98765" } },
              });
        },
      },
      {
        method: "POST",
        path: `${JOB}/publish`,
        status: 409,
        body: {
          code: "plan_changed",
          message: "Состояние Confluence или документа изменилось после предпросмотра. Проверьте обновлённый предпросмотр.",
          request_id: "r-409",
          details: { state: "dry_run_ready" },
        },
      },
    ]);
    renderJob();
    await userEvent.click(await screen.findByRole("button", { name: "Опубликовать в Confluence" }));
    expect(await screen.findByText("Предпросмотр обновлён: проверьте изменения ещё раз")).toBeInTheDocument();
    expect(screen.getByText(/изменилось после предпросмотра/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("publication-action")).toHaveTextContent("Будет обновлена страница 98765 (версия 7 → 8)"));
    expect(calls.filter((c) => c.method === "GET" && c.url === JOB)).toHaveLength(2);
  });

  it("keeps the page usable when Confluence is unavailable (503)", async () => {
    mockApi([
      { path: JOB, body: publicationJob() },
      {
        method: "POST",
        path: `${JOB}/dry-run`,
        status: 503,
        body: { code: "confluence_unavailable", message: "Confluence недоступен: соединение отклонено.", request_id: "r-503" },
      },
    ]);
    renderJob();
    await userEvent.click(await screen.findByRole("button", { name: "Проверить заново (dry-run)" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Confluence недоступен");
    expect(alert).toHaveTextContent("r-503");
    expect(screen.getByText("Повторите позже. Ничего не записано.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Проверить заново (dry-run)" })).toBeEnabled();
  });
});

describe("Proposal after merge", () => {
  const ID = "a".repeat(32);

  it("asks to retry the knowledge-base sync and links the publication job", async () => {
    const calls = mockApi([
      {
        path: `/api/drafts/${ID}`,
        body: submittedProposal({
          status: "merged",
          merge_request_state: "merged",
          source_document_state: "merged_pending_sync",
          can_refresh_status: true,
          merged_revision: null,
        }),
      },
      { path: "/api/publications/jobs?document_id=SEM-INT-ARIS-001", body: { items: [publicationJob({ proposal_id: ID })], total: 1 } },
      {
        method: "POST",
        path: `/api/drafts/${ID}/refresh-status`,
        body: submittedProposal({
          status: "merged",
          merge_request_state: "merged",
          source_document_state: "updated_by_this_proposal",
          can_refresh_status: false,
          merged_revision: PUB_REVISION,
          synced_at: "2026-11-22T12:00:00Z",
        }),
      },
    ]);
    const session = { ...gitlabSession, features: { ...gitlabSession.features, confluence_publish: true } };
    renderRoutes(`/proposals/${ID}`, { "/proposals/:id": <ProposalDetailPage /> }, session);
    expect(await screen.findByText("Merge подтверждён GitLab; база знаний ещё не синхронизирована.")).toBeInTheDocument();
    expect(screen.getByText(/Нажмите «Проверить статус в GitLab», чтобы повторить синхронизацию/)).toBeInTheDocument();
    expect(screen.getByText(/база знаний ещё не синхронизирована$/, { selector: ".lifecycle__state" })).toBeInTheDocument();
    const link = await screen.findByRole("link", { name: "Публикация в Confluence" });
    expect(link).toHaveAttribute("href", `/publications/${PUB_JOB_ID}`);
    expect(within(link.parentElement as HTMLElement).getByText("Предпросмотр готов")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Проверить статус в GitLab" }));
    expect(await screen.findByText("GitLab подтвердил merge.")).toBeInTheDocument();
    expect(screen.getByText("Синхронизировано с базой знаний:")).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual([`/api/drafts/${ID}/refresh-status`]);
  });

  it("does not look for publication jobs when publishing is not configured", async () => {
    const calls = mockApi([
      {
        path: `/api/drafts/${ID}`,
        body: submittedProposal({ status: "merged", source_document_state: "updated_by_this_proposal", can_refresh_status: false }),
      },
    ]);
    renderRoutes(`/proposals/${ID}`, { "/proposals/:id": <ProposalDetailPage /> }, gitlabSession);
    expect(await screen.findByText("Изменение принято в GitLab и попало в базу знаний.")).toBeInTheDocument();
    expect(calls.some((c) => c.url.startsWith("/api/publications"))).toBe(false);
    expect(screen.queryByRole("link", { name: "Публикация в Confluence" })).toBeNull();
  });
});

describe("Integration labels", () => {
  it("shows target, access, publisher mode and last check without inventing a green state", async () => {
    const labelled: IntegrationsResponse = {
      ...integrations,
      items: [
        {
          ...integrations.items[1]!,
          state: "connected",
          human_readable_message: "Подключено к GitLab.",
          target: "real",
          access: "read",
        },
        {
          ...integrations.items[4]!,
          state: "connected",
          human_readable_message: "Подключено: пространство SKHTEST; только предпросмотр.",
          target: "mock",
          access: "read",
          details: { mode: "dry_run_only", space: "SKHTEST" },
        },
      ],
    };
    mockApi([
      { path: "/api/integrations/status", body: labelled },
      { path: "/api/knowledge/issues", body: [] },
    ]);
    renderRoutes("/integrations", { "/integrations": <IntegrationsPage /> });
    const gitlab = (await screen.findByRole("heading", { name: "GitLab (каноническая база знаний)" })).closest("li") as HTMLElement;
    expect(within(gitlab).getByText("Реальный сервер — live validation не проводилась")).toBeInTheDocument();
    expect(within(gitlab).getByText("только чтение")).toBeInTheDocument();
    expect(within(gitlab).getByText("Последняя проверка")).toBeInTheDocument();
    const publisher = screen.getByRole("heading", { name: "Confluence Data Center (REST, публикация)" }).closest("li") as HTMLElement;
    expect(within(publisher).getByText("Тестовый дубль (mock)")).toBeInTheDocument();
    expect(within(publisher).getByText("Режим публикации")).toBeInTheDocument();
    expect(within(publisher).getByText("только предпросмотр (запись в Confluence выключена)")).toBeInTheDocument();
  });

  it("shows an unconfigured publisher card as not configured", async () => {
    mockApi([
      { path: "/api/integrations/status", body: integrations },
      { path: "/api/knowledge/issues", body: [] },
    ]);
    renderRoutes("/integrations", { "/integrations": <IntegrationsPage /> });
    const publisher = (await screen.findByRole("heading", { name: "Confluence Data Center (REST, публикация)" })).closest(
      "li",
    ) as HTMLElement;
    expect(within(publisher).getByText("Не настроено")).toBeInTheDocument();
    expect(within(publisher).getByText("публикация не настроена")).toBeInTheDocument();
    expect(within(publisher).getByText("не используется")).toBeInTheDocument();
  });
});

describe("Unified diff parsing", () => {
  it("parses hunks, keeps line numbers and treats a removed '--' line as a removal", () => {
    const diff = parseUnifiedDiff("--- a\n+++ b\n@@ -3,3 +3,3 @@\n keep\n--- old dashes\n+new\n\\ No newline at end of file\n… (diff сокращён)");
    expect(diff.additions).toBe(1);
    expect(diff.deletions).toBe(1);
    expect(diff.lines.map((l) => [l.kind, l.old_no, l.new_no, l.text])).toEqual([
      ["hunk", null, null, "@@ -3,3 +3,3 @@"],
      ["context", 3, 3, "keep"],
      ["remove", 4, null, "-- old dashes"],
      ["add", null, 4, "new"],
      ["hunk", null, null, "… (diff сокращён)"],
    ]);
    expect(parseUnifiedDiff("").changed).toBe(false);
  });
});
