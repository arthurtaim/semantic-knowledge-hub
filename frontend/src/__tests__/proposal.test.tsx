import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { toSideBySide } from "../components/DiffView";
import { ProposalDetailPage } from "../pages/ProposalDetailPage";
import { ProposalEditorPage } from "../pages/ProposalEditorPage";
import { arisDetail, proposal } from "./fixtures";
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
    expect(screen.getByRole("button", { name: "Открыть MR в GitLab" })).toBeDisabled();
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
