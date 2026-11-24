import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { DocumentDetail } from "../api/types";
import { DocumentDetails } from "../components/DocumentDetails";
import { formatDate, formatDateTime } from "../lib/labels";
import { arisDetail } from "./fixtures";

/** The «Обновлён» and «Дата ревизии» rows of «Сведения о документе»: two different dates, each under its own name. */
function renderDetails(doc: DocumentDetail) {
  render(
    <MemoryRouter>
      <DocumentDetails doc={doc} publication={{ status: null, failed: false }} />
    </MemoryRouter>,
  );
  const row = (term: string) => (screen.getByText(term, { selector: "dt" }).parentElement as HTMLElement).querySelector("dd") as HTMLElement;
  return { updated: row("Обновлён"), revision: row("Дата ревизии") };
}

describe("«Сведения о документе»: the document's own date next to the revision date", () => {
  it("shows the date from the document's metadata as «Обновлён», and keeps the revision date", () => {
    const { updated, revision } = renderDetails({ ...arisDetail, metadata_updated_at: "2026-10-05" });
    expect(updated).toHaveTextContent(formatDate("2026-10-05"));
    expect(revision).toHaveTextContent(formatDateTime(arisDetail.updated_at));
  });

  it("says the date is not given instead of borrowing the revision (load) time", () => {
    const { updated, revision } = renderDetails({ ...arisDetail, metadata_updated_at: null });
    expect(updated).toHaveTextContent("дата не указана");
    expect(within(updated).queryByText(formatDate(arisDetail.updated_at))).toBeNull();
    expect(revision).toHaveTextContent(formatDateTime(arisDetail.updated_at));
  });
});
