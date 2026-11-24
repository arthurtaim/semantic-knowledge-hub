import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AskResponse, AskStreamEvent, Citation } from "../api/types";
import { AnswerSources } from "../components/AnswerSources";
import { excerptText, rowText } from "../components/CitationExcerpt";
import { AskPage } from "../pages/AskPage";
import { supportedAnswer } from "./fixtures";
import { mockApi, ndjsonStream, renderAt, type MockRoute } from "./helpers";

/*
 * Excerpts from Markdown tables are readable (owner's review, round 2): the server traces the verified quote back to
 * the cited section and sends `excerpt_parts`; cells are never glued into «Роль Система Код Комментарий Источник …».
 */

const GLUED =
  "Роль Система Код Комментарий Источник ARIS (условная модель) SYS-ARIS процессные модели Получатель Data Catalog SYS-CAT каталог активов Со стороны каталога отвечает стюард.";

const tableCitation: Citation = {
  ref: 1,
  source_type: "local",
  document_id: "DEMO-INT-001",
  title: "Поток ARIS → каталог",
  source_uri: "local://DEMO-INT-001",
  revision: "sha256:1111111111111111",
  status: "approved",
  section: "Источник и получатель",
  section_anchor: "источник-и-получатель",
  excerpt: GLUED,
  retrieved_at: "2026-11-24T00:00:00Z",
  is_demo: true,
  app_path: "/documents/DEMO-INT-001#источник-и-получатель",
  excerpt_parts: [
    {
      kind: "table",
      headers: ["Роль", "Система", "Код", "Комментарий"],
      rows: [
        ["Источник", "ARIS (условная модель)", "SYS-ARIS", "процессные модели"],
        ["Получатель", "Data Catalog", "SYS-CAT", ""],
      ],
    },
    { kind: "text", text: "Со стороны каталога отвечает стюард." },
  ],
};

const answer: AskResponse = {
  ...supportedAnswer,
  mode: "internal_api",
  warnings: [],
  answer: "Получатель — Data Catalog [1].",
  citations: [tableCitation],
};

function streamRoute(response: AskResponse): MockRoute {
  const events: AskStreamEvent[] = [{ type: "final", response }];
  return {
    method: "POST",
    path: "/api/assistant/ask/stream",
    respond: (init) => {
      const stream = ndjsonStream();
      const result = stream.respond(init);
      stream.push(...events);
      stream.close();
      return result;
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("Excerpts from Markdown tables", () => {
  it("shows the touched rows as a mini table under «Источники», the prose in quotes, never glued cells", async () => {
    mockApi([streamRoute(answer)]);
    renderAt("/ask", "/ask", <AskPage />);
    await userEvent.type(screen.getByLabelText("Вопрос"), "Кто получатель данных ARIS?");
    await userEvent.click(screen.getByRole("button", { name: "Отправить" }));
    const sources = await screen.findByRole("region", { name: "Источники" });
    const table = within(sources).getByRole("table", { name: "Строки таблицы из раздела «Источник и получатель»" });
    expect(within(table).getAllByRole("columnheader").map((th) => th.textContent)).toEqual(["Роль", "Система", "Код", "Комментарий"]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getAllByRole("cell").map((td) => td.textContent))).toEqual([
      ["Источник", "ARIS (условная модель)", "SYS-ARIS", "процессные модели"],
      ["Получатель", "Data Catalog", "SYS-CAT", ""],
    ]);
    // Narrow columns stack each cell as «заголовок: значение» (CSS reads the label from data-label).
    expect(within(rows[0] as HTMLElement).getByText("SYS-ARIS")).toHaveAttribute("data-label", "Код");
    // A one-token code stays on one line; prose cells wrap.
    expect(within(rows[0] as HTMLElement).getByText("SYS-ARIS")).toHaveClass("excerpt-table__token");
    expect(within(rows[0] as HTMLElement).getByText("процессные модели")).not.toHaveClass("excerpt-table__token");
    expect(within(sources).getByText("Со стороны каталога отвечает стюард.").tagName).toBe("Q");
    expect(sources).not.toHaveTextContent("Роль Система Код");
  });

  it("shows rows of cells separated by « — » in the marker's card, the header row first", async () => {
    mockApi([streamRoute(answer)]);
    renderAt("/ask", "/ask", <AskPage />);
    await userEvent.type(screen.getByLabelText("Вопрос"), "Кто получатель данных ARIS?");
    await userEvent.click(screen.getByRole("button", { name: "Отправить" }));
    const marker = await screen.findByRole("link", { name: "Источник 1" });
    const card = document.getElementById(marker.getAttribute("aria-describedby") ?? "") as HTMLElement;
    await userEvent.hover(marker);
    expect(card).toBeVisible();
    const lines = Array.from(card.querySelectorAll(".cite-card__row")).map((row) => row.textContent);
    expect(lines).toEqual([
      "Роль — Система — Код — Комментарий",
      "Источник — ARIS (условная модель) — SYS-ARIS — процессные модели",
      "Получатель — Data Catalog — SYS-CAT — —",
    ]);
    expect(card.querySelector(".cite-card__row--head")).toHaveTextContent("Роль — Система");
    expect(card).toHaveTextContent("«Со стороны каталога отвечает стюард.»");
    // The question's words are still marked inside the rows.
    expect(within(card).getByText("получатель", { selector: "mark", exact: false })).toBeInTheDocument();
    expect(card).not.toHaveTextContent("Роль Система Код");
  });

  it("renders the same table in the document panel's compact sources", () => {
    renderAt("/", "/", <AnswerSources answer={answer} labels={new Map([[1, "1"]])} turnNo={1} compact />);
    expect(screen.getByRole("table", { name: /Строки таблицы/ })).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(3);
  });

  it("keeps the plain excerpt when there is no table, and copies table rows as text", () => {
    const plain = supportedAnswer.citations[0] as Citation;
    renderAt("/", "/", <AnswerSources answer={supportedAnswer} labels={new Map([[1, "1"]])} turnNo={1} />);
    expect(screen.getByText(plain.excerpt).tagName).toBe("Q");
    expect(screen.queryByRole("table")).toBeNull();
    expect(excerptText(plain)).toBe(plain.excerpt);
    expect(excerptText({ ...plain, excerpt_parts: [{ kind: "text", text: "без таблицы" }] })).toBe(plain.excerpt);
    expect(excerptText(tableCitation)).toBe(
      "Роль — Система — Код — Комментарий: Источник — ARIS (условная модель) — SYS-ARIS — процессные модели; " +
        "Получатель — Data Catalog — SYS-CAT — — Со стороны каталога отвечает стюард.",
    );
    expect(rowText(["a", " ", "c"])).toBe("a — — — c");
  });
});
