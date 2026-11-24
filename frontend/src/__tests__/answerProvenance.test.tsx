import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnswerProvenance, AskResponse, AskStreamEvent, Citation, SystemFact } from "../api/types";
import { answerWithSources } from "../components/AnswerParts";
import { NOTHING_ATTACHED, TurnView, type Turn } from "../components/AssistantTurn";
import { citationLabels } from "../lib/assistant";
import { citationOrigin, provenanceLine } from "../lib/provenance";
import { AskPage } from "../pages/AskPage";
import { insufficientAnswer, supportedAnswer } from "./fixtures";
import { mockApi, ndjsonStream, renderAt, type MockRoute } from "./helpers";

/*
 * Origin of an answer's sources (docs/API_CONTRACTS.md «Answer provenance», docs/UI_REDESIGN.md «Происхождение
 * источников»): metadata of the validated evidence, shown as ONE quiet line per answer — not a warning notice and not
 * a mark repeated on every source. Per-source marks appear only when the sources of one answer differ. Nothing is
 * ever called «реальный»: «без пометки» is the absence of a synthetic mark, an attachment's origin is not stated.
 */

const STREAM = "/api/assistant/ask/stream";

function streamRoute(response: AskResponse): MockRoute {
  return {
    method: "POST",
    path: STREAM,
    respond: (init) => {
      const stream = ndjsonStream();
      const reply = stream.respond(init);
      stream.push({ type: "final", response } satisfies AskStreamEvent);
      stream.close();
      return reply;
    },
  };
}

const provenance = (overrides: Partial<AnswerProvenance>): AnswerProvenance => ({
  overall: "none",
  synthetic: 0,
  not_synthetic: 0,
  unknown: 0,
  by_kind: {},
  ...overrides,
});

const teamCitation = supportedAnswer.citations[0] as Citation;
const unmarkedPage: Citation = {
  ref: 2,
  source_type: "confluence",
  document_id: "300201",
  title: "Регламент выпуска справочников",
  source_uri: "https://confluence.example.test/pages/300201",
  revision: "7",
  status: null,
  section: "Порядок выпуска",
  section_anchor: null,
  excerpt: "Справочник выпускается после согласования владельцем.",
  retrieved_at: "2026-11-24T10:00:00Z",
  is_demo: false,
  app_path: "/corporate/300201",
  source_kind: "confluence_mcp",
  source_id: "confluence:ops:300201:7",
  external_status: "approved",
  provenance: "not_synthetic",
};
const fileCitation: Citation = {
  ref: 3,
  source_type: "attachment",
  document_id: "ATT-0123456789abcdef",
  title: "aris_export_2026-11.csv",
  source_uri: "attachment://ATT-0123456789abcdef",
  revision: "",
  status: null,
  section: null,
  section_anchor: null,
  excerpt: "aris_object_guid;aris_status;aris_comment",
  retrieved_at: "2026-11-24T10:00:00Z",
  // An attachment carries no provenance metadata: `is_demo: false` here must never read as «real».
  is_demo: false,
  app_path: null,
  attachment_id: "ATT-0123456789abcdef",
  attachment_name: "aris_export_2026-11.csv",
  locator: "строка 1",
  provenance: "unknown",
};

const MIXED_WARNING =
  "Ответ опирается на источники разного происхождения: часть помечена как синтетическая (учебная), часть — нет. " +
  "Происхождение указано у каждого источника; синтетические сведения не являются фактами о банке.";

const generated: AskResponse = { ...supportedAnswer, mode: "internal_api", answer: "Четыре слоя [1]." };

const mixed: AskResponse = {
  ...supportedAnswer,
  mode: "internal_api",
  answer: "Четыре слоя [1]. Справочник выпускается после согласования [2]. В файле есть колонка aris_comment [3].",
  citations: [teamCitation, unmarkedPage, fileCitation],
  warnings: [MIXED_WARNING],
  provenance: provenance({ overall: "mixed", synthetic: 1, not_synthetic: 1, unknown: 1, by_kind: { team: 1, corporate: 1, attachment: 1 } }),
};

const fileOnly: AskResponse = {
  ...supportedAnswer,
  mode: "internal_api",
  answer: "В файле есть колонка aris_comment [1].",
  citations: [{ ...fileCitation, ref: 1 }],
  warnings: [],
  provenance: provenance({ overall: "unknown", unknown: 1, by_kind: { attachment: 1 } }),
};

async function askWith(response: AskResponse) {
  mockApi([streamRoute(response)]);
  renderAt("/ask", "/ask", <AskPage />);
  await userEvent.type(screen.getByLabelText("Вопрос"), "Какие слои у архитектуры?");
  await userEvent.click(screen.getByRole("button", { name: "Отправить" }));
  return screen.findByRole("region", { name: "Ассистент" });
}

const line = (root: HTMLElement) => root.querySelector(".answer__provenance");
const marks = (root: HTMLElement) => Array.from(root.querySelectorAll(".source-origin"));

afterEach(() => vi.restoreAllMocks());

describe("provenanceLine: the answer's one line, by overall", () => {
  it.each([
    [provenance({ overall: "synthetic", synthetic: 3 }), "Источники: синтетические (учебные)"],
    [provenance({ overall: "not_synthetic", not_synthetic: 2 }), "Источники: не помечены как синтетические"],
    [provenance({ overall: "unknown", unknown: 1 }), "Происхождение источников не указано"],
    [provenance({ overall: "mixed", synthetic: 2, not_synthetic: 1 }), "Источники: смешанные — 2 синтетических, 1 без пометки"],
    [provenance({ overall: "mixed", synthetic: 1, unknown: 2 }), "Источники: смешанные — 1 синтетический, 2 без указания происхождения"],
    [provenance({ overall: "mixed", synthetic: 5, not_synthetic: 1, unknown: 1 }), "Источники: смешанные — 5 синтетических, 1 без пометки, 1 без указания происхождения"],
  ])("%j → %s", (value, text) => {
    expect(provenanceLine(value)).toBe(text);
  });

  it("says nothing when the answer relies on no source, or the server sent no summary", () => {
    expect(provenanceLine(provenance({ overall: "none" }))).toBeNull();
    expect(provenanceLine(undefined)).toBeNull();
    expect(provenanceLine(null)).toBeNull();
  });

  it("reads a citation without `provenance` the way the server derives it — an attachment is never «not synthetic»", () => {
    const legacy: Citation = { ...teamCitation, provenance: undefined };
    expect(citationOrigin(legacy)).toBe("synthetic");
    expect(citationOrigin({ ...legacy, is_demo: false })).toBe("not_synthetic");
    expect(citationOrigin({ ...fileCitation, provenance: undefined })).toBe("unknown");
  });
});

describe("Answer: provenance as metadata, not a warning", () => {
  it("one line for an answer over synthetic sources — no mark on each source, no warning notice", async () => {
    const answer = await askWith(generated);
    expect(line(answer)).toHaveTextContent("Источники: синтетические (учебные)");
    // In the answer's head, not a notice.
    expect(line(answer)?.closest(".answer__head")).not.toBeNull();
    expect(line(answer)?.closest(".notice")).toBeNull();
    expect(answer.querySelector(".notice--warning")).toBeNull();
    // All sources share the origin: the line says it once; neither the source row nor the card repeats it.
    expect(marks(answer)).toHaveLength(0);
    const sources = within(answer).getByRole("region", { name: "Источники" });
    expect(sources).not.toHaveTextContent(/синтетическ|демо/);
    expect(answer.textContent).not.toMatch(/Используются только демо-документы/);
  });

  it("the extractive answer (no model) shows the same line next to its mode — two different things", async () => {
    const answer = await askWith(supportedAnswer);
    expect(line(answer)).toHaveTextContent("Источники: синтетические (учебные)");
    expect(within(answer).getByText("Без языковой модели: дословные выдержки", { selector: ".answer__mode" })).toBeInTheDocument();
    expect(marks(answer)).toHaveLength(0);
  });

  it.each([
    ["insufficient evidence", insufficientAnswer],
    [
      "general knowledge",
      { ...generated, answer: "RAG — поиск фрагментов и ответ по ним.", citations: [], general_knowledge: true, provenance: provenance({ overall: "none" }) },
    ],
  ])("nothing for an answer that relies on no source (%s)", async (_case, response) => {
    const answer = await askWith(response);
    expect(line(answer)).toBeNull();
    expect(answer.textContent).not.toMatch(/синтетическ|Происхождение/);
  });

  it("nothing claimed when an older server sends no summary", async () => {
    const answer = await askWith({ ...generated, provenance: undefined });
    expect(line(answer)).toBeNull();
    expect(marks(answer)).toHaveLength(0);
  });

  it("mixed: the line counts the origins and each source and card names its own; the server's warning stays", async () => {
    const answer = await askWith(mixed);
    expect(line(answer)).toHaveTextContent("Источники: смешанные — 1 синтетический, 1 без пометки, 1 без указания происхождения");
    expect(within(answer).getByText(MIXED_WARNING)).toBeInTheDocument();

    const sources = within(answer).getByRole("region", { name: "Источники" });
    const row = (ref: number) => sources.querySelector(`#cite-1-${ref}`) as HTMLElement;
    expect(within(row(1)).getByText("синтетический")).toHaveClass("source-origin--synthetic");
    expect(within(row(2)).getByText("не помечен как синтетический")).toHaveClass("source-origin--not_synthetic");
    expect(within(row(3)).getByText("происхождение не указано")).toHaveClass("source-origin--unknown");
    // The mark is named for a screen reader too.
    expect(within(row(1)).getByText("синтетический")).toHaveTextContent("Происхождение: синтетический");

    // The citation card of a marker says the same.
    const text = answer.querySelector(".answer__text") as HTMLElement;
    const card = (name: string) => document.getElementById(within(text).getByRole("link", { name }).getAttribute("aria-describedby") ?? "") as HTMLElement;
    expect(card("Источник 1")).toHaveTextContent("синтетический");
    expect(card("Источник К1")).toHaveTextContent("не помечен как синтетический");
    expect(card("Источник Ф1")).toHaveTextContent("происхождение не указано");

    // Never «real»: not on the unmarked page, not on the attachment.
    expect(answer.textContent).not.toMatch(/реальн/i);
  });

  it("attachments only: «Происхождение источников не указано», no per-source repetition, never «реальный»", async () => {
    const answer = await askWith(fileOnly);
    expect(line(answer)).toHaveTextContent("Происхождение источников не указано");
    expect(marks(answer)).toHaveLength(0);
    expect(answer.textContent).not.toMatch(/реальн|без пометки|не помечен/i);
  });

  it("the document panel (compact) shows the same one line", () => {
    const turn: Turn = {
      id: 1,
      request: { question: "Какие слои?", sources: ["team"], include_drafts: false, include_deprecated: false },
      display: NOTHING_ATTACHED,
      phase: "done",
      passages: 1,
      provider: "internal_api",
      preliminary: "",
      response: generated,
      error: null,
    };
    renderAt("/documents/SEM-ARCH-001", "/documents/:id", <TurnView turn={turn} turnNo={1} onRefine={() => {}} onAskCorporate={() => {}} compact />);
    const answer = screen.getByRole("region", { name: "Ассистент" });
    expect(answer).toHaveClass("answer--compact");
    expect(line(answer)).toHaveTextContent("Источники: синтетические (учебные)");
    expect(marks(answer)).toHaveLength(0);
  });
});

describe("Copied answer and system facts", () => {
  it("«Копировать с источниками» carries the origin out of the app (and per source when mixed)", () => {
    const synthetic = answerWithSources(generated, citationLabels(generated.citations), false);
    expect(synthetic.trim().split("\n").at(-1)).toBe("Происхождение источников: синтетические (учебные)");
    expect(synthetic).not.toMatch(/\] .* · синтетический/);

    const copied = answerWithSources(mixed, citationLabels(mixed.citations), false);
    expect(copied).toContain("Происхождение источников: смешанные — 1 синтетический, 1 без пометки, 1 без указания происхождения");
    expect(copied).toMatch(/\[1\] .*· синтетический\n/);
    expect(copied).toMatch(/\[К1\] .*· не помечен как синтетический\n/);
    expect(copied).toMatch(/\[Ф1\] .*· происхождение не указано\n/);

    expect(answerWithSources(insufficientAnswer, new Map(), false)).not.toMatch(/Происхождение/);
  });

  it("documents listed by a system fact name their origin only when the answer's sources differ", async () => {
    const list: SystemFact = {
      ref: "F1",
      tool: "catalog_query",
      operation: "list",
      label: "Документы в доступном каталоге SKH",
      value: 2,
      unit: "documents",
      effective_filters: {},
      definition: null,
      access_scope: "visible_to_request_context",
      source: "skh_document_registry",
      generation: "g7",
      as_of: "2026-11-24T09:00:00Z",
      items: [
        { id: "DEMO-SEM-002", title: "Логическая модель", kind: "document", status: "approved", detail: null, app_path: "/documents/DEMO-SEM-002", is_demo: true },
        { id: "SEM-RUN-001", title: "Регламент", kind: "document", status: "approved", detail: null, app_path: "/documents/SEM-RUN-001", is_demo: false },
      ],
      truncated: false,
      breakdown: null,
    };
    const facts: AskResponse = {
      ...generated,
      answer: "В каталоге два документа [F1].",
      citations: [],
      system_facts: [list],
      warnings: [MIXED_WARNING],
      provenance: provenance({ overall: "mixed", synthetic: 1, not_synthetic: 1, by_kind: { team: 2 } }),
    };
    const answer = await askWith(facts);
    const items = within(answer).getByRole("list", { name: "Объекты: Документы в доступном каталоге SKH" });
    expect(within(items).getByText("синтетический")).toBeInTheDocument();
    expect(within(items).getByText("не помечен как синтетический")).toBeInTheDocument();
  });

  it("…and not when they share one origin (the line covers them)", async () => {
    const answer = await askWith({
      ...generated,
      answer: "В каталоге один документ [F1].",
      citations: [],
      system_facts: [
        {
          ref: "F1",
          tool: "catalog_query",
          operation: "list",
          label: "Документы в доступном каталоге SKH",
          value: 1,
          unit: "documents",
          effective_filters: {},
          definition: null,
          access_scope: "visible_to_request_context",
          source: "skh_document_registry",
          generation: "g7",
          as_of: "2026-11-24T09:00:00Z",
          items: [{ id: "DEMO-SEM-002", title: "Логическая модель", kind: "document", status: "approved", detail: null, app_path: "/documents/DEMO-SEM-002", is_demo: true }],
          truncated: false,
          breakdown: null,
        },
      ],
      provenance: provenance({ overall: "synthetic", synthetic: 1, by_kind: { team: 1 } }),
    });
    expect(line(answer)).toHaveTextContent("Источники: синтетические (учебные)");
    expect(marks(answer)).toHaveLength(0);
  });
});
