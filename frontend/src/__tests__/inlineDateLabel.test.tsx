import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { InlineDate } from "../components/work/InlineEdit";

/* Audit SYS-011: an abbreviated month already ends with a dot — the button's name must not read «4 дек.. Изменить». */
describe("InlineDate accessible name", () => {
  it("does not double the dot after an abbreviated month", () => {
    render(<InlineDate value="2026-12-04" display="4 дек." label="Начало PA-4" onCommit={() => undefined} />);
    expect(screen.getByRole("button").getAttribute("aria-label")).toBe("Начало PA-4: 4 дек. Изменить");
  });

  it("ends a display without a dot with one", () => {
    render(<InlineDate value={null} display="не задано" label="Срок PA-4" onCommit={() => undefined} />);
    expect(screen.getByRole("button").getAttribute("aria-label")).toBe("Срок PA-4: не задано. Изменить");
  });
});
