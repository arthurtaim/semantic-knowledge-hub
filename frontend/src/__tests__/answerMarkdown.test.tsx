import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AskRequest, AskResponse, AskStreamEvent, Citation, SystemFact } from "../api/types";
import { AnswerText, answerWithSources, factRefsOf } from "../components/AnswerParts";
import { AnswerView } from "../components/AssistantTurn";
import { citationLabels } from "../lib/assistant";
import { safeHref } from "../lib/answerMarkdown";
import { AskPage } from "../pages/AskPage";
import { supportedAnswer } from "./fixtures";
import { mockApi, ndjsonStream, renderAt } from "./helpers";

/*
 * Workstream A: the validated answer is Markdown (docs/AI_NATIVE_TOOLS.md: «a Markdown final answer»), rendered by
 * one safe AST path (components/AnswerMarkdown.tsx, lib/answerMarkdown.ts). Before it, `AnswerText` split the raw
 * text on blank lines and newlines and showed `**`, backticks, list dashes and table pipes literally.
 */

const teamCitation = supportedAnswer.citations[0] as Citation;
const corporateCitation: Citation = {
  ref: 2,
  source_type: "confluence",
  document_id: "200101",
  title: "Регламент заморозки изменений метаданных (демо)",
  source_uri: "mock-confluence://OPS/200101",
  revision: "3",
  status: null,
  section: "Когда действует заморозка",
  section_anchor: null,
  excerpt: "Заморозка действует в последнюю неделю квартала.",
  retrieved_at: "2026-11-23T12:00:00Z",
  is_demo: true,
  app_path: "/corporate/200101",
  source_kind: "confluence_mcp",
  source_id: "confluence:demo-wiki:200101:3",
  external_status: "unknown",
};
const fact: SystemFact = {
  ref: "F1",
  tool: "catalog_query",
  operation: "count",
  label: "Документы в доступном каталоге SKH",
  value: 83,
  unit: "documents",
  effective_filters: {},
  definition: null,
  access_scope: "visible_to_request_context",
  source: "skh_document_registry",
  generation: "g1",
  as_of: "2026-11-24T10:00:00Z",
  items: [],
  truncated: false,
  breakdown: null,
};

afterEach(() => vi.unstubAllGlobals());

interface TextOptions {
  citations?: Citation[];
  facts?: SystemFact[];
  compact?: boolean;
}

function textElement(text: string, { citations = [teamCitation], facts = [], compact = false }: TextOptions = {}) {
  const answer = { ...supportedAnswer, citations, system_facts: facts } as AskResponse;
  return (
    <MemoryRouter>
      <AnswerText
        text={text}
        citations={citations}
        labels={citationLabels(citations)}
        turnNo={1}
        question="Какие слои?"
        facts={factRefsOf(answer)}
        compact={compact}
      />
    </MemoryRouter>
  );
}

function renderText(text: string, options: TextOptions = {}) {
  const result = render(textElement(text, options));
  return { text: document.querySelector(".answer__text") as HTMLElement, ...result };
}

/** The text a reader sees: without the marker cards (hidden until hover or focus) and screen-reader-only notes. */
function readable(root: HTMLElement): string {
  const copy = root.cloneNode(true) as HTMLElement;
  copy.querySelectorAll("[hidden], .visually-hidden").forEach((el) => el.remove());
  return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
}

const markersIn = (root: HTMLElement) => within(root).queryAllByRole("link", { name: /^(Источник|Данные системы) / });

describe("Answer text is rendered as Markdown", () => {
  it("renders strong, inline code, a list, a heading and a GFM table instead of showing the syntax", () => {
    const { text } = renderText(
      [
        "## Модель данных",
        "",
        "**Что нашлось:**",
        "",
        "- `BusinessProcess` — бизнес-процесс [1]",
        "- `DataProduct` — продукт данных",
        "",
        "| Сущность | Слой |",
        "| --- | --- |",
        "| `BusinessProcess` | логический |",
      ].join("\n"),
    );
    expect(text).not.toHaveTextContent("**");
    expect(text).not.toHaveTextContent("`");
    expect(text).not.toHaveTextContent("|");
    expect(within(text).getByText("Что нашлось:").tagName).toBe("STRONG");
    expect(within(text).getAllByText("BusinessProcess")[0]?.tagName).toBe("CODE");
    expect(within(text).getAllByRole("listitem")).toHaveLength(2);
    expect(within(text).getByRole("heading", { name: "Модель данных" })).toBeInTheDocument();
    const table = within(text).getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((th) => th.textContent)).toEqual(["Сущность", "Слой"]);
    expect(within(table).getByRole("cell", { name: "логический" })).toBeInTheDocument();
    // A table scrolls sideways in its own frame, never the page.
    expect(table.parentElement).toHaveClass("answer-md__frame", "answer-md__frame--table");
    expect(screen.getByRole("link", { name: "Источник 1" })).toBeInTheDocument();
  });

  it("renders emphasis, an ordered list from its start, a fenced code block, line breaks and safe links", () => {
    const { text } = renderText(
      [
        "Это *важно* и ~~устарело~~, примерно ~100 документов и ~20 шаблонов.",
        "Вторая строка того же абзаца.",
        "",
        "3. третий",
        "4. четвёртый",
        "",
        "```sql",
        "SELECT id FROM docs;",
        "```",
        "",
        "См. [документ](/documents/SEM-ARCH-001), [GitLab](https://gitlab.example/skh) и [почту](mailto:team@example.org).",
      ].join("\n"),
    );
    expect(within(text).getByText("важно").tagName).toBe("EM");
    expect(within(text).getByText("устарело").tagName).toBe("DEL");
    // «~100 … ~20» is an approximation in Russian prose, not a strikethrough.
    expect(text.querySelectorAll("del")).toHaveLength(1);
    expect(text).toHaveTextContent("примерно ~100 документов и ~20 шаблонов.");
    // The model's line break stays a line break.
    expect(text.querySelector("p br")).not.toBeNull();
    const list = within(text).getByRole("list");
    expect(list.tagName).toBe("OL");
    expect(list).toHaveAttribute("start", "3");
    const code = text.querySelector("pre > code") as HTMLElement;
    expect(code).toHaveTextContent("SELECT id FROM docs;");
    expect(code.closest(".answer-md__frame--code")).not.toBeNull();

    expect(within(text).getByRole("link", { name: "документ" })).toHaveAttribute("href", "/documents/SEM-ARCH-001");
    const external = within(text).getByRole("link", { name: /GitLab/ });
    expect(external).toHaveAttribute("href", "https://gitlab.example/skh");
    expect(external).toHaveAttribute("target", "_blank");
    expect(external).toHaveAttribute("rel", "noopener noreferrer");
    expect(external).toHaveAccessibleName("GitLab (откроется в новой вкладке)");
    expect(within(text).getByRole("link", { name: "почту" })).toHaveAttribute("href", "mailto:team@example.org");
  });

  it("puts Markdown headings below the answer's own heading: h3+ in the dialog, h4+ in the document panel", () => {
    const markdown = "# Итог\n\n## Детали\n\n#### Мелочь";
    const { unmount } = renderText(markdown);
    expect(screen.getByRole("heading", { name: "Итог" }).tagName).toBe("H3");
    expect(screen.getByRole("heading", { name: "Детали" }).tagName).toBe("H4");
    expect(screen.getByRole("heading", { name: "Мелочь" }).tagName).toBe("H6");
    unmount();
    renderText(markdown, { compact: true });
    expect(screen.getByRole("heading", { name: "Итог" }).tagName).toBe("H4");
    expect(screen.getByRole("heading", { name: "Детали" }).tagName).toBe("H5");
  });
});

describe("Markers are AST nodes of verified references only", () => {
  const citations = [teamCitation, corporateCitation];

  it("turns verified [n] and [F1] into accessible markers in a paragraph, bold, a list item and a table cell", async () => {
    const { text } = renderText(
      [
        "Слоёв четыре [1].",
        "",
        "**Заморозка — в конце квартала [2]**",
        "",
        "- в каталоге 83 документа [F1]",
        "",
        "| Источник | Ссылка |",
        "| --- | --- |",
        "| регламент | [2] |",
      ].join("\n"),
      { citations, facts: [fact] },
    );
    expect(text).not.toHaveTextContent("[");
    expect(markersIn(text).map((m) => m.textContent)).toEqual(["1", "К1", "С1", "К1"]);

    const team = within(text).getByRole("link", { name: "Источник 1" });
    expect(team.closest("p")).not.toBeNull();
    expect(team).toHaveAttribute("href", teamCitation.app_path); // navigation to the cited section
    const [inBold, inCell] = within(text).getAllByRole("link", { name: "Источник К1" }) as [HTMLElement, HTMLElement];
    expect(inBold.closest("strong")).not.toBeNull();
    expect(inBold).toHaveClass("cite-ref--corporate");
    expect(inCell.closest("td")).not.toBeNull();
    const factMarker = within(text).getByRole("link", { name: "Данные системы С1" });
    expect(factMarker.closest("li")).not.toBeNull();
    expect(factMarker).toHaveAttribute("href", "#fact-1-F1");

    // Tooltip on hover and focus, as before.
    const card = document.getElementById(team.getAttribute("aria-describedby") ?? "") as HTMLElement;
    expect(card).toHaveAttribute("role", "tooltip");
    expect(card).not.toBeVisible();
    await userEvent.hover(team);
    expect(card).toBeVisible();
    expect(card).toHaveTextContent(teamCitation.title);
    act(() => factMarker.focus());
    const factCard = document.getElementById(factMarker.getAttribute("aria-describedby") ?? "") as HTMLElement;
    expect(factCard).toBeVisible();
    expect(factCard).toHaveTextContent("По данным реестра SKH");
  });

  it("handles adjacent markers, punctuation around them and markers inside emphasis", () => {
    const { text } = renderText("Слои [1][2]. Подробнее ([1]); *курсив [2]*, конец[1].", { citations });
    expect(markersIn(text).map((m) => m.textContent)).toEqual(["1", "К1", "1", "К1", "1"]);
    // The blank before a marker belongs to the pill (it has its own margin); punctuation stays where it was.
    expect(readable(text)).toBe("Слои1К1. Подробнее (1); курсивК1, конец1.");
    expect(within(text).getAllByRole("link", { name: "Источник К1" })[1]?.closest("em")).not.toBeNull();
  });

  it("leaves unknown markers literal: an unverified number, an unknown fact, a raw model marker", () => {
    const { text } = renderText("Слоёв четыре [1], ещё [7] и [F9], сырой [C1].", { facts: [fact] });
    expect(markersIn(text).map((m) => m.textContent)).toEqual(["1"]);
    expect(readable(text)).toBe("Слоёв четыре1, ещё [7] и [F9], сырой [C1].");
  });

  it("never converts markers inside inline code, fenced code, link text, link URLs or titles", () => {
    const { text } = renderText(
      [
        "Код `[1]` и `[F1]` остаётся кодом.",
        "",
        "```",
        "items[1] = value [F1]",
        "```",
        "",
        "Ссылка [см. [1]](/documents/SEM-ARCH-001 \"заголовок [1]\") и [адрес](https://example.org/a[1]).",
      ].join("\n"),
      { facts: [fact] },
    );
    expect(markersIn(text)).toHaveLength(0);
    expect(within(text).getByText("[1]", { selector: "code" })).toBeInTheDocument();
    expect(within(text).getByText("[F1]", { selector: "code" })).toBeInTheDocument();
    expect(text.querySelector("pre code")).toHaveTextContent("items[1] = value [F1]");
    const inner = within(text).getByRole("link", { name: "см. [1]" });
    expect(inner).toHaveAttribute("href", "/documents/SEM-ARCH-001");
    expect(inner).toHaveAttribute("title", "заголовок [1]");
    // The URL is the model's (percent-encoded by the parser), not a reference.
    expect(within(text).getByRole("link", { name: /^адрес/ })).toHaveAttribute("href", "https://example.org/a%5B1%5D");
  });

  it("does not let a model-written definition `[1]: url` turn the marker into its link", () => {
    const { text } = renderText("[1]: https://evil.example/\n\nСлоёв четыре [1].");
    // Definitions are switched off: the line is plain text (its URL an ordinary external link), and every [1] is
    // the verified citation — never a link labelled «1» to the model's address.
    const markers = within(text).getAllByRole("link", { name: "Источник 1" });
    expect(markers.map((m) => m.getAttribute("href"))).toEqual([teamCitation.app_path, teamCitation.app_path]);
    expect(within(text).queryByRole("link", { name: "1" })).toBeNull();
    expect(readable(text)).toBe("1: https://evil.example/ Слоёв четыре1.");
  });

  it("keeps a marker mounted and focused when the answer re-renders", () => {
    const view = renderText("Слоёв четыре [1].");
    const marker = screen.getByRole("link", { name: "Источник 1" });
    act(() => marker.focus());
    view.rerender(textElement("Слоёв четыре [1]."));
    expect(screen.getByRole("link", { name: "Источник 1" })).toBe(marker);
    expect(marker).toHaveFocus();
  });
});

describe("Model text is untrusted: no HTML, scripts, unsafe links or remote images", () => {
  it("shows raw HTML as text and never creates script, img, iframe or event-handler elements", () => {
    const alert = vi.fn();
    vi.stubGlobal("alert", alert);
    const { text } = renderText(
      [
        "<script>alert(1)</script>",
        "",
        'Текст <img src=x onerror="alert(2)"> и <b onclick="alert(3)">жирный</b>.',
        "",
        '<div onclick="alert(4)"><iframe src="https://evil.example"></iframe></div>',
        "",
        "![схема](https://evil.example/track.png) и ![](data:image/png;base64,AAAA)",
      ].join("\n"),
    );
    expect(text.querySelectorAll("script, img, iframe, b, div[onclick]")).toHaveLength(0);
    expect([...text.querySelectorAll("*")].filter((el) => [...el.attributes].some((a) => a.name.startsWith("on")))).toEqual([]);
    expect(text).toHaveTextContent("<script>alert(1)</script>");
    expect(text).toHaveTextContent('<img src=x onerror="alert(2)">');
    // An image of model text is never requested: its alt text stands in.
    expect(within(text).getByText("[изображение: схема]")).toHaveClass("answer-md__image");
    expect(within(text).getByText("[изображение]")).toBeInTheDocument();
    expect(alert).not.toHaveBeenCalled();
  });

  it("keeps only http(s), mailto and app-path links; javascript:, data:, protocol-relative and the like lose the link", () => {
    const { text } = renderText(
      [
        "[js](javascript:alert(1)) [JS](JAVASCRIPT:alert(1)) [vb](vbscript:msgbox(1)) [data](data:text/html,<b>x</b>)",
        "[proto](//evil.example/x) [rel](documents/x) [frag](#top) <javascript:alert(1)>",
        "[ok](https://example.org/ok) [slash](/\\evil.example)",
      ].join("\n"),
    );
    const links = within(text).getAllByRole("link");
    // `/\host` would be read as another host: the parser percent-encodes the backslash, a same-origin path remains.
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["https://example.org/ok", "/%5Cevil.example"]);
    for (const label of ["js", "JS", "vb", "data", "proto", "rel", "frag"]) {
      expect(within(text).getByText(label)).toHaveClass("answer-md__link-text");
    }
    // The autolink's text may say «javascript:…»; no attribute anywhere carries such a URL.
    const attributes = [...text.querySelectorAll("*")].flatMap((el) => [...el.attributes].map((a) => a.value));
    expect(attributes.filter((value) => /javascript:|vbscript:|data:/i.test(value))).toEqual([]);
  });

  it("safeHref allows only http(s), mailto and app paths", () => {
    expect(safeHref("https://example.org/a?b#c")).toBe("https://example.org/a?b#c");
    expect(safeHref("mailto:team@example.org")).toBe("mailto:team@example.org");
    expect(safeHref("/documents/SEM-ARCH-001#section")).toBe("/documents/SEM-ARCH-001#section");
    for (const bad of ["javascript:alert(1)", " javascript:alert(1)", "java\nscript:alert(1)", "data:text/html,x", "//evil.example", "/\\evil.example", "ftp://x", "#x", "x", "", null]) {
      expect(safeHref(bad)).toBeNull();
    }
  });
});

describe("Answer view: compact panel, copy with sources, streaming", () => {
  const request: AskRequest = { question: "Какие слои?", sources: ["team"], include_drafts: false, include_deprecated: false, history: [] };
  const markdownAnswer: AskResponse = {
    ...supportedAnswer,
    mode: "internal_api",
    warnings: [],
    answer: [
      "**Что нашлось:** четыре слоя [1], заморозка [2].",
      "",
      "- каталог: 83 документа [F1]",
      "- код `[2]` — не ссылка",
      "",
      "| Слой | Источник |",
      "| --- | --- |",
      "| витрина | [1] |",
    ].join("\n"),
    citations: [teamCitation, corporateCitation],
    system_facts: [fact],
  };

  it("renders the same Markdown in the compact document panel, with its table in its own frame", () => {
    renderAt(
      "/",
      "/",
      <aside className="doc-assistant">
        <AnswerView answer={markdownAnswer} request={request} turnNo={1} onRefine={() => {}} onAskCorporate={() => {}} compact />
      </aside>,
    );
    const answer = document.querySelector(".answer--compact") as HTMLElement;
    const text = answer.querySelector(".answer__text") as HTMLElement;
    expect(within(text).getByText("Что нашлось:").tagName).toBe("STRONG");
    expect(markersIn(text).map((m) => m.textContent)).toEqual(["1", "К1", "С1", "1"]);
    expect(within(text).getByRole("table").parentElement).toHaveClass("answer-md__frame--table");
    // Quotes are shown once, under «Источники» (and in the marker's card), never in the answer body.
    expect(readable(text)).not.toContain(teamCitation.excerpt);
  });

  it("copies readable text with relabelled markers and the sources, without Markdown syntax", () => {
    const copied = answerWithSources(markdownAnswer, citationLabels(markdownAnswer.citations), false);
    const [body] = copied.split("\n\nДанные системы SKH:");
    expect(body).toBe(
      [
        "Что нашлось: четыре слоя [1], заморозка [К1].",
        "",
        "- каталог: 83 документа [С1]",
        "- код [2] — не ссылка",
        "",
        "Слой | Источник",
        "витрина | [1]",
      ].join("\n"),
    );
    expect(copied).toContain("Источники:\n[1] Semantic Layer — demonstration architecture");
    expect(copied).toContain("[К1] Регламент заморозки изменений метаданных (демо) — Confluence, версия 3");
  });

  it("streams preliminary text as inert Markdown, then swaps in the validated answer with live markers", async () => {
    const stream = ndjsonStream();
    mockApi([{ method: "POST", path: "/api/assistant/ask/stream", respond: (init) => stream.respond(init) }]);
    renderAt("/ask", "/ask", <AskPage />);
    await userEvent.type(screen.getByLabelText("Вопрос"), "Какие слои?");
    await userEvent.click(screen.getByRole("button", { name: "Отправить" }));
    const events: AskStreamEvent[] = [
      { type: "status", stage: "generating", passages: 2, provider: "internal_api" },
      { type: "delta", text: "**Слоёв** четыре [C1] и [1], " },
      { type: "delta", text: "см. [документ](/documents/SEM-ARCH-001) и [сайт](https://example.org)." },
    ];
    stream.push(...events);
    const label = await screen.findByText("Предварительный текст модели — цитаты ещё не проверены");
    const preliminary = label.closest("section") as HTMLElement;
    expect(within(preliminary).getByText("Слоёв").tagName).toBe("STRONG");
    // Nothing in unvalidated text is interactive: no markers, no links.
    expect(within(preliminary).queryAllByRole("link")).toHaveLength(0);
    expect(preliminary).toHaveTextContent("четыре [C1] и [1], см. документ и сайт.");

    stream.push({ type: "final", response: { ...markdownAnswer, mode: "internal_api" } });
    stream.close();
    expect(await screen.findByRole("heading", { name: "Ассистент" })).toBeInTheDocument();
    expect(screen.queryByText("Предварительный текст модели — цитаты ещё не проверены")).toBeNull();
    const text = document.querySelector(".answer__text") as HTMLElement;
    expect(markersIn(text).map((m) => m.textContent)).toEqual(["1", "К1", "С1", "1"]);
  });
});
