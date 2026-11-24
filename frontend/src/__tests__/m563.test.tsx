import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { describe, expect, it } from "vitest";
import type { AiProposal, TemplateSummary } from "../api/types";
import { AiAssistPanel, useAiProposal } from "../components/AiProposal";
import { WikiLinkTextarea } from "../components/WikiLinkTextarea";
import { TemplatesPage } from "../pages/TemplatesPage";
import { mockApi, renderAt } from "./helpers";

const template = (over: Partial<TemplateSummary>): TemplateSummary => ({
  id: "dataset_spec",
  title: "Спецификация датасета",
  description: "Атрибуты, источники, качество.",
  doc_type: "dataset",
  category: "Данные",
  owner: "demo-semantic-team",
  labels: ["dataset"],
  status: "active",
  version: 1,
  versions: [1],
  updated: "2026-11-10",
  listed: true,
  required_sections: 9,
  optional_sections: 0,
  documents: 2,
  ...over,
});

describe("Template Hub", () => {
  it("lists templates with version, status, usage and marks deprecated ones", async () => {
    mockApi([
      {
        path: "/api/templates",
        body: [
          template({}),
          template({ id: "meeting_decision", title: "Решение встречи", status: "deprecated", version: 2, versions: [1, 2], doc_type: "decision", category: "Решения" }),
        ],
      },
    ]);
    renderAt("/templates", "/templates", <TemplatesPage />);
    const list = await screen.findByRole("list", { name: "Шаблоны" });
    const dataset = within(list).getByRole("link", { name: "Спецификация датасета" }).closest("li") as HTMLElement;
    expect(within(list).getByRole("link", { name: "Спецификация датасета" })).toHaveAttribute("href", "/templates/dataset_spec");
    expect(dataset).toHaveTextContent("v1");
    expect(dataset).toHaveTextContent("Активен");
    expect(dataset).toHaveTextContent("Документов2");
    const deprecated = within(list).getByRole("link", { name: "Решение встречи" }).closest("li") as HTMLElement;
    expect(deprecated).toHaveClass("template-tile--deprecated");
    expect(within(deprecated).getByText("Устарел")).toBeInTheDocument();
    expect(within(deprecated).getByText(/Не используется для новых документов/)).toBeInTheDocument();
    expect(screen.getByText("2 шаблона")).toBeInTheDocument();
  });
});

function Editor() {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  return <WikiLinkTextarea aria-label="Текст" value={value} onValueChange={setValue} textareaRef={ref} />;
}

describe("[[ autocomplete", () => {
  it("suggests documents, never picks by itself and inserts [[ID|Title]] for the chosen one", async () => {
    const calls = mockApi([
      {
        path: "/api/links/suggest?q=DEMO-SR&limit=8",
        body: [
          { document_id: "DEMO-SRC-001", title: "Ландшафт источников", status: "approved", type: "source", matched: "id", alias: null, insert: "[[DEMO-SRC-001|Ландшафт источников]]" },
          { document_id: "DEMO-SRC-002", title: "ARIS", status: "approved", type: "source", matched: "id", alias: null, insert: "[[DEMO-SRC-002|ARIS]]" },
        ],
      },
    ]);
    renderAt("/", "/", <Editor />);
    const box = screen.getByRole("textbox", { name: "Текст" }) as HTMLTextAreaElement;
    // user-event: "[[" types one literal "[".
    await userEvent.type(box, "См. [[[[DEMO-SR");
    const listbox = await screen.findByRole("listbox", { name: "Документы для ссылки" });
    expect(await within(listbox).findAllByRole("option")).toHaveLength(2);
    expect(box).toHaveAttribute("aria-controls", listbox.id);
    expect(within(listbox).queryByRole("option", { selected: true })).toBeNull(); // nothing pre-selected
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(within(listbox).getByRole("option", { selected: true })).toHaveTextContent("ARIS");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(box.value).toBe("См. [[DEMO-SRC-002|ARIS]]"));
    expect(box.selectionStart).toBe(box.value.length);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(calls.filter((c) => c.url.startsWith("/api/links/suggest")).length).toBeGreaterThanOrEqual(1);
  });
});

const proposal: AiProposal = {
  id: "AIP-0123456789abcdef",
  kind: "suggest_metadata",
  status: "suggested",
  created_at: "2026-11-23T10:00:00Z",
  decided_at: null,
  mode: "mock",
  base: { draft_id: "d1", edit_version: 1, document_id: "SEM-DS-001", revision: null, template_id: "dataset_spec", template_version: 1, index_generation: "g1" },
  summary: "Предложений по метаданным: 2.",
  items: [
    { id: "tags", kind: "metadata", field: "tags", section: null, target_id: null, current: ["dataset"], proposed: ["dataset", "crm"], reason: "теги базы", evidence: [], applicable: true },
    {
      id: "related_ids",
      kind: "metadata",
      field: "related_ids",
      section: null,
      target_id: null,
      current: [],
      proposed: ["DEMO-SRC-004"],
      reason: "похожие документы",
      evidence: [{ document_id: "DEMO-SRC-004", title: "CRM", revision: "sha256:1234567890abcdef", status: "approved", quote: "", reason: "похожий утверждённый документ" }],
      applicable: true,
    },
    { id: "owner", kind: "note", field: "owner", section: null, target_id: null, current: null, proposed: null, reason: "ИИ не назначает владельца", evidence: [], applicable: false },
  ],
  warnings: [],
  insufficient: false,
  graph_link: null,
  applied_items: [],
  result_draft_id: null,
};

function Panel() {
  const state = useAiProposal();
  return (
    <AiAssistPanel
      title="ИИ"
      intro={null}
      state={state}
      actions={[{ key: "meta", label: "Предложить метаданные", build: () => ({ kind: "suggest_metadata", draft_id: "d1" }) }]}
      appliedNote={() => <p>Черновик обновлён</p>}
    />
  );
}

describe("AI proposal: explicit accept / reject", () => {
  it("applies only the chosen field and shows the partial result", async () => {
    const calls = mockApi([
      { method: "POST", path: "/api/ai/proposals", status: 201, body: proposal },
      {
        method: "POST",
        path: `/api/ai/proposals/${proposal.id}/accept`,
        body: { ...proposal, status: "partially_applied", applied_items: ["tags"], result_draft_id: "d1" },
      },
    ]);
    renderAt("/", "/", <Panel />);
    await userEvent.click(screen.getByRole("button", { name: "Предложить метаданные" }));
    expect(await screen.findByText("Предложение")).toBeInTheDocument();
    // a suggested related document is visibly a suggestion, with its evidence
    expect(screen.getAllByText("предложено").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "CRM" })).toHaveAttribute("href", "/documents/DEMO-SRC-004");
    // an information item has no checkbox; nothing is pre-selected
    expect(screen.queryByRole("checkbox", { name: /Поле «Владелец»/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Применить выбранное (0)" })).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox", { name: "Принять: Поле «Теги»" }));
    await userEvent.click(screen.getByRole("button", { name: "Применить выбранное (1)" }));
    expect(await screen.findByText("Частично применено")).toBeInTheDocument();
    expect(screen.getByText("Черновик обновлён")).toBeInTheDocument();
    const accept = calls.find((c) => c.url.endsWith("/accept"));
    expect(accept?.body).toEqual({ item_ids: ["tags"] });
  });

  it("rejects without changes and explains a stale proposal with «Сформировать заново»", async () => {
    let created = 0;
    const calls = mockApi([
      { method: "POST", path: "/api/ai/proposals", status: 201, body: () => ({ ...proposal, id: created++ === 0 ? proposal.id : "AIP-fedcba9876543210" }) },
      { method: "POST", path: `/api/ai/proposals/${proposal.id}/reject`, body: { ...proposal, status: "rejected" } },
      {
        method: "POST",
        path: "/api/ai/proposals/AIP-fedcba9876543210/accept",
        status: 409,
        body: { code: "ai_proposal_stale", message: "Предложение устарело: черновик изменён.", request_id: "r" },
      },
    ]);
    renderAt("/", "/", <Panel />);
    await userEvent.click(screen.getByRole("button", { name: "Предложить метаданные" }));
    await userEvent.click(await screen.findByRole("button", { name: "Отклонить" }));
    expect(await screen.findByText("Отклонено")).toBeInTheDocument();
    expect(screen.getByText(/Предложение отклонено — ничего не изменено/)).toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith("/accept"))).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: "Предложить метаданные" }));
    await userEvent.click(await screen.findByRole("checkbox", { name: "Принять: Поле «Теги»" }));
    await userEvent.click(screen.getByRole("button", { name: "Применить выбранное (1)" }));
    expect(await screen.findByText("Устарело")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Сформировать заново" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Применить выбранное/ })).toBeNull();
  });
});
