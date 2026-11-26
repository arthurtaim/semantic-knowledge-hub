import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { BrowserRouter, Link, MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { SessionContext } from "../lib/session";
import { DocumentCreatePage } from "../pages/DocumentCreatePage";
import { checkResponse, NEW_DOC_BODY, NEW_DOC_ID, newDocumentProposal, session, templates } from "./fixtures";
import { mockApi, type MockRoute, type RecordedCall } from "./helpers";

/*
 * SYS-007: leaving the document editor with unsaved edits asks first — an in-app link (the sidebar, «Отмена»), the
 * browser's Back / Forward and a reload or tab close. «Остаться» keeps the text and the URL, «Выйти без сохранения»
 * leaves and drops the edits; a saved draft leaves without a question.
 */

const DRAFT_URL = `/documents/new?draft=${NEW_DOC_ID}`;
const ADDED = " Новый абзац.";

function draftRoutes(extra: MockRoute[] = []): MockRoute[] {
  return [
    ...extra,
    { path: `/api/drafts/${NEW_DOC_ID}`, body: newDocumentProposal() },
    { path: /^\/api\/authoring\/templates(\?include_hidden=true)?$/, body: templates },
    { method: "POST", path: "/api/authoring/check", body: checkResponse() },
  ];
}

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{`${location.pathname}${location.search}`}</span>;
}

/** The editor page with a navigation link next to it, like the app's sidebar. */
function Page() {
  return (
    <>
      <nav aria-label="Основная навигация">
        <Link to="/projects">Проекты</Link>
      </nav>
      <Routes>
        <Route path="/documents/new" element={<DocumentCreatePage />} />
        <Route
          path="/projects"
          element={
            <>
              <p>Страница проектов</p>
              <Link to={DRAFT_URL}>Открыть черновик</Link>
            </>
          }
        />
        <Route path="*" element={<p>Другая страница</p>} />
      </Routes>
      <LocationProbe />
    </>
  );
}

function renderIn(router: (children: ReactNode) => ReactNode) {
  return render(<SessionContext.Provider value={session}>{router(<Page />)}</SessionContext.Provider>);
}

const renderAtDraft = () => renderIn((children) => <MemoryRouter initialEntries={[DRAFT_URL]}>{children}</MemoryRouter>);
const location = () => screen.getByTestId("location").textContent;
const body = () => screen.getByRole("textbox", { name: /Markdown/ }) as HTMLTextAreaElement;
const dialog = () => screen.queryByRole("alertdialog", { name: "Есть несохранённые изменения" });
const saves = (calls: RecordedCall[]) => calls.filter((c) => c.method === "PUT" || (c.method === "POST" && c.url.includes("/drafts")));

/** Opens the stored draft and adds a paragraph: the editor shows «Есть несохранённые изменения». */
async function editDraft() {
  expect(await screen.findByRole("textbox", { name: /Markdown/ })).toHaveValue(NEW_DOC_BODY);
  await userEvent.type(body(), ADDED);
  expect(await screen.findByText("Есть несохранённые изменения")).toBeInTheDocument();
}

function beforeUnloadPrevented(): boolean {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

describe("Leaving the document editor with unsaved edits", () => {
  it("asks before an in-app link; «Остаться» keeps the text and the URL", async () => {
    const calls = mockApi(draftRoutes());
    renderAtDraft();
    await editDraft();

    const link = screen.getByRole("link", { name: "Проекты" });
    await userEvent.click(link);
    const confirm = await screen.findByRole("alertdialog", { name: "Есть несохранённые изменения" });
    expect(confirm).toHaveAttribute("aria-modal", "true");
    expect(confirm).toHaveTextContent(/будут потеряны/);
    expect(location()).toBe(DRAFT_URL);

    await userEvent.click(screen.getByRole("button", { name: "Остаться" }));
    expect(dialog()).not.toBeInTheDocument();
    expect(location()).toBe(DRAFT_URL);
    expect(body()).toHaveValue(NEW_DOC_BODY + ADDED);
    expect(screen.getByText("Есть несохранённые изменения")).toBeInTheDocument();
    expect(saves(calls)).toHaveLength(0);
  });

  it("«Выйти без сохранения» navigates and drops the edits", async () => {
    const calls = mockApi(draftRoutes());
    renderAtDraft();
    await editDraft();

    await userEvent.click(screen.getByRole("link", { name: "Проекты" }));
    await userEvent.click(await screen.findByRole("button", { name: "Выйти без сохранения" }));
    expect(await screen.findByText("Страница проектов")).toBeInTheDocument();
    expect(location()).toBe("/projects");
    expect(dialog()).not.toBeInTheDocument();
    expect(saves(calls)).toHaveLength(0);

    // Back on the draft: the stored text, without the dropped paragraph, and no question on the way.
    await userEvent.click(screen.getByRole("link", { name: "Открыть черновик" }));
    expect(await screen.findByRole("textbox", { name: /Markdown/ })).toHaveValue(NEW_DOC_BODY);
    expect(dialog()).not.toBeInTheDocument();
  });

  it("asks on the editor's own «Отмена» with the same dialog", async () => {
    mockApi(draftRoutes());
    renderAtDraft();
    await editDraft();

    await userEvent.click(screen.getByRole("link", { name: "Отмена" }));
    expect(await screen.findByRole("alertdialog", { name: "Есть несохранённые изменения" })).toBeInTheDocument();
    expect(location()).toBe(DRAFT_URL);
    await userEvent.click(screen.getByRole("button", { name: "Выйти без сохранения" }));
    await waitFor(() => expect(location()).toBe(`/proposals/${NEW_DOC_ID}`));
  });

  it("does not ask after a successful save, and not for a pristine draft", async () => {
    const calls = mockApi(
      draftRoutes([{ method: "PUT", path: `/api/drafts/${NEW_DOC_ID}`, body: newDocumentProposal({ edit_version: 2 }) }]),
    );
    renderAtDraft();
    expect(await screen.findByRole("textbox", { name: /Markdown/ })).toHaveValue(NEW_DOC_BODY);
    expect(beforeUnloadPrevented()).toBe(false);

    await userEvent.type(body(), ADDED);
    expect(beforeUnloadPrevented()).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Сохранить черновик" }));
    expect(await screen.findByText(/Черновик сохранён в/)).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    expect(beforeUnloadPrevented()).toBe(false);

    await userEvent.click(screen.getByRole("link", { name: "Проекты" }));
    expect(await screen.findByText("Страница проектов")).toBeInTheDocument();
    expect(dialog()).not.toBeInTheDocument();
  });

  it("is keyboard accessible: focus on «Остаться», Tab stays inside, Esc stays, focus returns", async () => {
    mockApi(draftRoutes());
    renderAtDraft();
    await editDraft();

    const link = screen.getByRole("link", { name: "Проекты" });
    link.focus();
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("alertdialog", { name: "Есть несохранённые изменения" })).toBeInTheDocument();
    const stay = screen.getByRole("button", { name: "Остаться" });
    const leave = screen.getByRole("button", { name: "Выйти без сохранения" });
    expect(stay).toHaveFocus();

    await userEvent.tab();
    expect(leave).toHaveFocus();
    await userEvent.tab();
    expect(stay).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(leave).toHaveFocus();

    await userEvent.keyboard("{Escape}");
    expect(dialog()).not.toBeInTheDocument();
    expect(location()).toBe(DRAFT_URL);
    expect(body()).toHaveValue(NEW_DOC_BODY + ADDED);
    expect(link).toHaveFocus();

    // The same from the keyboard: Enter on «Выйти без сохранения» leaves.
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("button", { name: "Остаться" })).toHaveFocus();
    await userEvent.tab();
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByText("Страница проектов")).toBeInTheDocument();
  });
});

describe("Leaving the document editor with the browser's Back button", () => {
  it("asks on Back, keeps the page on «Остаться» and goes back on «Выйти без сохранения»", async () => {
    window.history.replaceState(null, "", "/projects");
    mockApi(draftRoutes());
    renderIn((children) => <BrowserRouter>{children}</BrowserRouter>);
    await userEvent.click(await screen.findByRole("link", { name: "Открыть черновик" }));
    await waitFor(() => expect(location()).toBe(DRAFT_URL));
    await editDraft();

    act(() => window.history.back());
    expect(await screen.findByRole("alertdialog", { name: "Есть несохранённые изменения" })).toBeInTheDocument();
    // The browser's address goes back to the draft as well.
    await waitFor(() => expect(`${window.location.pathname}${window.location.search}`).toBe(DRAFT_URL));
    expect(location()).toBe(DRAFT_URL);

    await userEvent.click(screen.getByRole("button", { name: "Остаться" }));
    expect(dialog()).not.toBeInTheDocument();
    expect(body()).toHaveValue(NEW_DOC_BODY + ADDED);
    expect(location()).toBe(DRAFT_URL);

    act(() => window.history.back());
    await userEvent.click(await screen.findByRole("button", { name: "Выйти без сохранения" }));
    expect(await screen.findByText("Страница проектов")).toBeInTheDocument();
    expect(location()).toBe("/projects");
    expect(window.location.pathname).toBe("/projects");
    expect(dialog()).not.toBeInTheDocument();
  });
});
