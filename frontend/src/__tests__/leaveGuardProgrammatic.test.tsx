import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { requestLeave, UnsavedChangesGuard } from "../components/UnsavedChangesGuard";

/* SYS-007 follow-up: navigation started from code (the ⌘K quick find, header search) goes through the same dialog. */
function Editor({ dirty }: { dirty: boolean }) {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <>
      <p data-testid="where">{location.pathname}</p>
      <UnsavedChangesGuard when={dirty} />
      <button type="button" onClick={() => requestLeave(() => navigate("/elsewhere"))}>
        Найти и открыть
      </button>
    </>
  );
}

function renderAt(dirty: boolean) {
  return render(
    <MemoryRouter initialEntries={["/docs/edit"]}>
      <Routes>
        <Route path="*" element={<Editor dirty={dirty} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("requestLeave", () => {
  it("asks first while there are unsaved edits; «Остаться» keeps the page", () => {
    renderAt(true);
    fireEvent.click(screen.getByText("Найти и открыть"));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    fireEvent.click(screen.getByText("Остаться"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByTestId("where").textContent).toBe("/docs/edit");
  });

  it("«Выйти без сохранения» runs the navigation", () => {
    renderAt(true);
    fireEvent.click(screen.getByText("Найти и открыть"));
    act(() => {
      fireEvent.click(screen.getByText("Выйти без сохранения"));
    });
    expect(screen.getByTestId("where").textContent).toBe("/elsewhere");
  });

  it("navigates at once without unsaved edits", () => {
    renderAt(false);
    fireEvent.click(screen.getByText("Найти и открыть"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByTestId("where").textContent).toBe("/elsewhere");
  });
});
