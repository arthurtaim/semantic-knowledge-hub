import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { toSideBySide } from "../components/DiffView";
import { ProposalDetailPage } from "../pages/ProposalDetailPage";
import { ProposalEditorPage } from "../pages/ProposalEditorPage";
import { arisDetail, gitlabSession, MR_URL, proposal, submittedProposal } from "./fixtures";
import { mockApi, renderAt } from "./helpers";

const ID = "a".repeat(32);

describe("Proposal review", () => {
  it("shows the diff and marks ready without claiming approval", async () => {
    const calls = mockApi([
      { path: `/api/drafts/${ID}`, body: proposal() },
      { method: "POST", path: `/api/drafts/${ID}/mark-ready`, body: proposal({ status: "ready_for_review", can_mark_ready: false }) },
    ]);
    renderAt(`/proposals/${ID}`, "/proposals/:id", <ProposalDetailPage />);
    const table = await screen.findByRole("table", { name: "Изменения построчно" });
    expect(within(table).getByText("old line")).toBeInTheDocument();
    expect(within(table).getByText("new line")).toBeInTheDocument();
    expect(screen.getByText(/это не утверждение и не merge/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Отметить «Готово к ревью»" }));
    expect(await screen.findByText(/Документ не изменён/)).toBeInTheDocument();
    expect(screen.getAllByText("Готово к ревью").length).toBeGreaterThan(0);
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual([`/api/drafts/${ID}/mark-ready`]);
  });

  it("requires confirmation before rejecting", async () => {
    const calls = mockApi([
      { path: `/api/drafts/${ID}`, body: proposal() },
      { method: "POST", path: `/api/drafts/${ID}/reject`, body: proposal({ status: "rejected", can_reject: false, can_mark_ready: false }) },
    ]);
    renderAt(`/proposals/${ID}`, "/proposals/:id", <ProposalDetailPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Отклонить" }));
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    await userEvent.type(screen.getByLabelText(/Комментарий к отклонению/), "Не нужно");
    await userEvent.click(screen.getByRole("button", { name: "Подтвердить отклонение" }));
    expect(await screen.findByText(/Предложение отклонено/)).toBeInTheDocument();
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ comment: "Не нужно" });
  });

  it("blocks review for stale proposals and shows validation errors", async () => {
    mockApi([
      {
        path: `/api/drafts/${ID}`,
        body: proposal({
          is_stale: true,
          can_mark_ready: false,
          current_revision: "sha256:ffff",
          validation: [{ severity: "error", code: "id_changed", message: "Нельзя менять `id` документа.", field: "id" }],
          error_count: 1,
        }),
      },
    ]);
    renderAt(`/proposals/${ID}`, "/proposals/:id", <ProposalDetailPage />);
    expect(await screen.findByText(/Исходный документ изменился после создания предложения/)).toBeInTheDocument();
    expect(screen.getByText("Нельзя менять `id` документа.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Отметить «Готово к ревью»" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Отправить в GitLab" })).toBeDisabled();
  });

  it("switches to the side-by-side view", async () => {
    mockApi([{ path: `/api/drafts/${ID}`, body: proposal() }]);
    renderAt(`/proposals/${ID}`, "/proposals/:id", <ProposalDetailPage />);
    await userEvent.click(await screen.findByRole("tab", { name: "До и после" }));
    expect(screen.getByRole("table", { name: "Сравнение до и после" })).toBeInTheDocument();
  });

  it("pairs removed and added lines in side-by-side rows", () => {
    const rows = toSideBySide(proposal().diff.lines);
    const changed = rows.find((r) => r.left?.kind === "remove");
    expect(changed?.right?.text).toBe("new line");
  });
});

describe("Proposal editor", () => {
  it("creates a proposal against the current revision and explains AI is off in demo", async () => {
    const calls = mockApi([
      { path: "/api/documents/SEM-INT-ARIS-001", body: arisDetail },
      { method: "POST", path: "/api/drafts", status: 201, body: proposal() },
    ]);
    renderAt("/proposals/new?document=SEM-INT-ARIS-001", "/proposals/new", <ProposalEditorPage />);
    const editor = await screen.findByLabelText(/Текст документа/);
    expect(screen.getByText(/В демо-режиме ИИ не генерирует правки/)).toBeInTheDocument();
    const create = screen.getByRole("button", { name: "Создать предложение" });
    expect(create).toBeDisabled();

    await userEvent.type(editor, "Новая строка");
    await userEvent.type(screen.getByLabelText("Причина изменения"), "Добавить строку");
    await userEvent.click(create);
    expect(await screen.findByText("Другая страница")).toBeInTheDocument();
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toMatchObject({
      document_id: "SEM-INT-ARIS-001",
      base_revision: "sha256:df6c505c42a7e51e",
      reason: "Добавить строку",
      origin: "manual",
    });
  });

  it("shows a revision conflict clearly", async () => {
    mockApi([
      { path: "/api/documents/SEM-INT-ARIS-001", body: arisDetail },
      {
        method: "POST",
        path: "/api/drafts",
        status: 409,
        body: { code: "revision_conflict", message: "Документ изменился после начала редактирования.", request_id: "r" },
      },
    ]);
    renderAt("/proposals/new?document=SEM-INT-ARIS-001", "/proposals/new", <ProposalEditorPage />);
    await userEvent.type(await screen.findByLabelText(/Текст документа/), "x");
    await userEvent.type(screen.getByLabelText("Причина изменения"), "Правка");
    await userEvent.click(screen.getByRole("button", { name: "Создать предложение" }));
    expect(await screen.findByText("Документ изменился")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Загрузить актуальную версию" })).toBeInTheDocument();
  });
});

describe("Proposal lifecycle and GitLab submission", () => {
  const current = (container: HTMLElement) => container.querySelector('.lifecycle [aria-current="step"]');

  it("offers «Отправить в GitLab» for a ready proposal and shows the MR after submitting", async () => {
    const calls = mockApi([
      {
        path: `/api/drafts/${ID}`,
        body: proposal({ status: "ready_for_review", can_mark_ready: false, can_submit: true }),
      },
      { method: "POST", path: `/api/drafts/${ID}/submit`, body: submittedProposal() },
    ]);
    const { container } = renderAt(`/proposals/${ID}`, "/proposals/:id", <ProposalDetailPage />, gitlabSession);
    expect(await screen.findByRole("heading", { name: "Этапы предложения" })).toBeInTheDocument();
    expect(current(container)).toHaveTextContent("MR в GitLab");
    expect(screen.getByText("Исходный документ не изменён — пока существует только предложение.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Отметить «Готово к ревью»" })).toBeNull();
    expect(screen.queryByText(/Отправка в GitLab не настроена/)).toBeNull();

    const submit = screen.getByRole("button", { name: "Отправить в GitLab" });
    expect(submit).toBeEnabled();
    await userEvent.click(submit);

    expect(await screen.findByText(/создан Merge Request/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Открыть Merge Request в GitLab" })).toHaveAttribute("href", MR_URL);
    expect(screen.queryByRole("button", { name: "Отправить в GitLab" })).toBeNull();
    const post = calls.filter((c) => c.method === "POST");
    expect(post.map((c) => c.url)).toEqual([`/api/drafts/${ID}/submit`]);
    expect(post[0]?.headers["X-SKH-Client"]).toBe("web");
  });

  it("explains that sending is not configured and keeps the proposal local", async () => {
    mockApi([
      { path: `/api/drafts/${ID}`, body: proposal({ status: "ready_for_review", can_mark_ready: false, can_submit: false }) },
    ]);
    renderAt(`/proposals/${ID}`, "/proposals/:id", <ProposalDetailPage />);
    expect(await screen.findByText(/Отправка в GitLab не настроена — предложение остаётся локальным в этом приложении/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Отправить в GitLab" })).toBeDisabled();
  });

  it("shows a submission failure with the GitLab error, attempts and a safe retry", async () => {
    const calls = mockApi([
      {
        path: `/api/drafts/${ID}`,
        body: proposal({
          status: "submission_failed",
          can_mark_ready: false,
          can_submit: true,
          can_refresh_status: true,
          submission: {
            attempts: 2,
            last_attempt_at: "2026-11-22T10:00:00Z",
            error_code: "gitlab_timeout",
            error_message: "GitLab не ответил за 30 секунд.",
            uncertain: true,
          },
        }),
      },
      { method: "POST", path: `/api/drafts/${ID}/submit`, body: submittedProposal() },
    ]);
    const { container } = renderAt(`/proposals/${ID}`, "/proposals/:id", <ProposalDetailPage />, gitlabSession);
    const panel = (await screen.findByRole("heading", { name: "Отправка в GitLab не удалась" })).closest("section") as HTMLElement;
    expect(within(panel).getByText("GitLab не ответил за 30 секунд.")).toBeInTheDocument();
    expect(within(panel).getByText("gitlab_timeout")).toBeInTheDocument();
    expect(within(panel).getByText("2")).toBeInTheDocument();
    expect(within(panel).getByText(/приложение сначала проверит GitLab и не создаст дубликат/)).toBeInTheDocument();
    expect(current(container)).toHaveAttribute("data-state", "failed");
    expect(current(container)).toHaveTextContent("ошибка отправки");
    expect(screen.getByRole("button", { name: "Проверить статус в GitLab" })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: "Повторить отправку" }));
    expect(await screen.findByRole("link", { name: "Открыть Merge Request в GitLab" })).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual([`/api/drafts/${ID}/submit`]);
  });

  it("reloads the proposal after a failed submit so the new status is visible", async () => {
    let reads = 0;
    const calls = mockApi([
      {
        path: `/api/drafts/${ID}`,
        body: () => {
          reads += 1;
          return reads === 1
            ? proposal({ status: "ready_for_review", can_mark_ready: false, can_submit: true })
            : proposal({
                status: "submission_failed",
                can_mark_ready: false,
                can_submit: true,
                submission: {
                  attempts: 1,
                  last_attempt_at: "2026-11-22T10:00:00Z",
                  error_code: "gitlab_unavailable",
                  error_message: "GitLab недоступен.",
                  uncertain: false,
                },
              });
        },
      },
      {
        method: "POST",
        path: `/api/drafts/${ID}/submit`,
        status: 503,
        body: { code: "gitlab_unavailable", message: "GitLab недоступен: соединение отклонено.", request_id: "r-503" },
      },
    ]);
    renderAt(`/proposals/${ID}`, "/proposals/:id", <ProposalDetailPage />, gitlabSession);
    await userEvent.click(await screen.findByRole("button", { name: "Отправить в GitLab" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("GitLab недоступен: соединение отклонено.");
    expect(alert).toHaveTextContent("r-503");
    expect(await screen.findByRole("button", { name: "Повторить отправку" })).toBeEnabled();
    expect(screen.getAllByText("Ошибка отправки").length).toBeGreaterThan(0);
    expect(calls.filter((c) => c.method === "GET" && c.url === `/api/drafts/${ID}`)).toHaveLength(2);
  });

  it("explains a revision conflict and links to a new proposal based on the current version", async () => {
    mockApi([
      {
        path: `/api/drafts/${ID}`,
        body: proposal({
          status: "conflict",
          source_document_state: "changed_since_base",
          is_stale: true,
          current_revision: "sha256:ffff",
          can_mark_ready: false,
        }),
      },
    ]);
    const { container } = renderAt(`/proposals/${ID}`, "/proposals/:id", <ProposalDetailPage />, gitlabSession);
    expect(await screen.findByText("Исходный документ изменился после создания предложения.")).toBeInTheDocument();
    expect(screen.getByText(/Ничего не перезаписано/)).toBeInTheDocument();
    const panel = screen.getByRole("heading", { name: "Как продолжить после конфликта" }).closest("section") as HTMLElement;
    expect(within(panel).getByText("sha256:ffff")).toBeInTheDocument();
    expect(within(panel).getByText("sha256:df6c505c42a7e51e")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Создать новое предложение на основе актуальной версии" })).toHaveAttribute(
      "href",
      `/proposals/new?document=SEM-INT-ARIS-001&from=${ID}`,
    );
    expect(screen.queryByRole("button", { name: "Отправить в GitLab" })).toBeNull();
    expect(current(container)).toHaveTextContent("конфликт версий");
  });

  it("shows the MR for a submitted proposal and refreshes its state from GitLab", async () => {
    const calls = mockApi([
      { path: `/api/drafts/${ID}`, body: submittedProposal() },
      {
        method: "POST",
        path: `/api/drafts/${ID}/refresh-status`,
        body: submittedProposal({
          status: "merged",
          can_refresh_status: false,
          merge_request_state: "merged",
          source_document_state: "updated_by_this_proposal",
          current_revision: "sha256:merged",
          merge_request: {
            iid: "42",
            url: MR_URL,
            state: "merged",
            source_branch: "skh/proposal-aaaaaaaa",
            target_branch: "main",
            checked_at: "2026-11-22T11:00:00Z",
          },
        }),
      },
    ]);
    const { container } = renderAt(`/proposals/${ID}`, "/proposals/:id", <ProposalDetailPage />, gitlabSession);
    const panel = (await screen.findByRole("heading", { name: "Merge Request в GitLab" })).closest("section") as HTMLElement;
    expect(within(panel).getByText("skh/proposal-aaaaaaaa")).toBeInTheDocument();
    expect(within(panel).getByText("Открыт, ожидает ревью")).toBeInTheDocument();
    const link = within(panel).getByRole("link", { name: "Открыть Merge Request в GitLab" });
    expect(link).toHaveAttribute("href", MR_URL);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(current(container)).toHaveTextContent("Merge ревьюером");
    expect(screen.getByText(/Открытый Merge Request — тоже ещё не merge/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Проверить статус в GitLab" }));
    expect(await screen.findByText("GitLab подтвердил merge.")).toBeInTheDocument();
    expect(screen.getByText("Изменение принято в GitLab и попало в базу знаний.")).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual([`/api/drafts/${ID}/refresh-status`]);
  });

  it("states that a merged proposal reached the knowledge base and completes every step", async () => {
    mockApi([
      {
        path: `/api/drafts/${ID}`,
        body: submittedProposal({
          status: "merged",
          can_refresh_status: false,
          merge_request_state: "merged",
          source_document_state: "updated_by_this_proposal",
        }),
      },
    ]);
    const { container } = renderAt(`/proposals/${ID}`, "/proposals/:id", <ProposalDetailPage />, gitlabSession);
    expect(await screen.findByText("Изменение принято в GitLab и попало в базу знаний.")).toBeInTheDocument();
    const steps = within(screen.getByRole("list", { name: "Этапы предложения" })).getAllByRole("listitem");
    expect(steps).toHaveLength(5);
    expect(steps.every((step) => step.getAttribute("data-state") === "done")).toBe(true);
    expect(current(container)).toBeNull();
    expect(screen.queryByRole("button", { name: /Отправить в GitLab|Повторить отправку|Отклонить/ })).toBeNull();
  });
});

describe("Proposal editor based on an earlier proposal", () => {
  it("prefills the earlier text against the current revision and warns about overwriting", async () => {
    const calls = mockApi([
      { path: "/api/documents/SEM-INT-ARIS-001", body: { ...arisDetail, revision: "sha256:current" } },
      {
        path: `/api/drafts/${ID}`,
        body: proposal({ status: "conflict", proposed_content: "---\nid: SEM-INT-ARIS-001\n---\n# ARIS v2\n" }),
      },
      { method: "POST", path: "/api/drafts", status: 201, body: proposal() },
    ]);
    renderAt(`/proposals/new?document=SEM-INT-ARIS-001&from=${ID}`, "/proposals/new", <ProposalEditorPage />);
    const editor = await screen.findByLabelText(/Текст документа/);
    expect(editor).toHaveValue("---\nid: SEM-INT-ARIS-001\n---\n# ARIS v2\n");
    expect(screen.getByText(/может отменить правки других авторов/)).toBeInTheDocument();
    expect(screen.getByLabelText("Причина изменения")).toHaveValue("Уточнение формулировки");

    await userEvent.click(screen.getByRole("button", { name: "Создать предложение" }));
    await screen.findByText("Другая страница");
    expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({
      base_revision: "sha256:current",
      proposed_content: "---\nid: SEM-INT-ARIS-001\n---\n# ARIS v2\n",
    });
  });
});
