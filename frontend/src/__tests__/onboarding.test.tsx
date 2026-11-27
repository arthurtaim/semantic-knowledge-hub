import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OnboardingBatch, OnboardingItem, OnboardingItemDetail } from "../api/types";
import { KnowledgeOnboardingPage } from "../pages/KnowledgeOnboardingPage";
import { mockApi, renderRoutes } from "./helpers";

/* M8 «Массовый импорт»: upload, a staged batch with backend counters, nothing preselected, review of one file
 * (origins, evidence, model suggestions accepted explicitly, relation candidates unchecked), a side-effect-free check
 * of the selection and an explicit «Создать черновики» sent ONCE with the fingerprint and an idempotency key. */

afterEach(() => vi.restoreAllMocks());

const BATCH = "0123456789abcdef0123456789abcdef";
const ROUTES = { "/documents/onboarding": <KnowledgeOnboardingPage /> };

function item(overrides: Partial<OnboardingItem>): OnboardingItem {
  return {
    item_id: "aaaaaaaaaaaaaaaa",
    path: "profile.md",
    display_name: "profile.md",
    size: 120,
    media_type: "text/markdown",
    parser: "markdown",
    parse_status: "parsed",
    status: "parsed",
    proposed_operation: "create",
    document_id: null,
    title: "Synthetic dataset profile",
    template_id: "dataset",
    doc_type: "dataset",
    existing_doc: null,
    duplicates: [],
    errors: 0,
    warnings: 0,
    links: 1,
    needs_review: true,
    excluded: false,
    ai_state: "none",
    revision: 1,
    outcome: null,
    ...overrides,
  };
}

const ITEMS = [
  item({}),
  item({ item_id: "bbbbbbbbbbbbbbbb", path: "../../evil.md", display_name: "evil.md", parse_status: "invalid", status: "invalid", proposed_operation: "skip", errors: 1, excluded: true }),
  item({ item_id: "cccccccccccccccc", path: "copy.md", display_name: "copy.md", parse_status: "duplicate", status: "skipped", proposed_operation: "skip", excluded: true, duplicates: [{ kind: "exact_hash", item_id: "aaaaaaaaaaaaaaaa", document_id: null, message: "Точная копия «profile.md»." }] }),
];

function batch(overrides: Partial<OnboardingBatch> = {}): OnboardingBatch {
  return {
    batch_id: BATCH,
    state: "parsed",
    source_kind: "zip",
    created_at: "2026-11-28T10:00:00Z",
    expires_at: "2026-12-01T10:00:00Z",
    file_count: 3,
    bytes_total: 500,
    revision: 1,
    counts: { total: 3, parsed: 1, invalid: 1, unsupported: 0, duplicate: 1, conflict: 0, updates: 0, excluded: 2, draft_created: 0, draft_failed: 0 },
    items: ITEMS,
    ai_available: true,
    index_unchanged: true,
    ...overrides,
  };
}

const DETAIL: OnboardingItemDetail = {
  ...item({}),
  checksum_sha256: "x",
  diagnostics: [{ severity: "warning", code: "extracted_text", message: "Проверьте текст.", field: null }],
  fields: [
    { field: "title", value: "Synthetic dataset profile", origin: "parser", confidence: null, evidence: [{ file: "profile.md", line: null, snippet: "заголовок первого уровня", document_id: null }], needs_review: true, note: "" },
    { field: "tags", value: ["demo"], origin: "frontmatter", confidence: null, evidence: [{ file: "profile.md", line: null, snippet: "из YAML файла", document_id: null }], needs_review: false, note: "" },
    { field: "owner", value: "data-team", origin: "model", confidence: 0.6, evidence: [{ file: "profile.md", line: null, snippet: "Владелец: data-team", document_id: null }], needs_review: true, note: "" },
  ],
  candidate_links: [
    {
      link_id: "l1",
      link_kind: "wikilink",
      target_document_id: "SEM-STD-001",
      target_title: "Стандарт",
      target_item_id: null,
      resolve_state: "resolved",
      evidence: { file: "profile.md", line: 3, snippet: "См. [[SEM-STD-001]]", document_id: null },
      selected_by_user: false,
      status: "candidate",
      bound_to_entity_graph: false,
    },
  ],
  decisions: { excluded: false, operation: null, fields: {}, selected_links: null, reviewed: false },
  body_preview: "text",
  preview_html: "<p>Синтетический текст</p>",
  diff: null,
  diff_stats: null,
  ai_note: null,
};

const base = [
  { path: /\/api\/onboarding\/capabilities$/, body: { formats: [".md", ".zip"], parsers: {}, upload_mb: 20, expanded_mb: 100, max_files: 200, file_mb: 10, ttl_hours: 72, ai_available: false, ai_items_per_batch: 20 } },
  { path: /\/api\/onboarding\/batches$/, body: [] },
  { path: /\/api\/authoring\/templates/, body: [{ id: "dataset", title: "Датасет" }] },
];

describe("Массовый импорт", () => {
  it("uploads the chosen files as one multipart request and opens the batch", async () => {
    const calls = mockApi([...base, { method: "POST", path: /\/api\/onboarding\/batches$/, status: 201, body: batch() }, { path: new RegExp(`/api/onboarding/batches/${BATCH}$`), body: batch() }]);
    renderRoutes("/documents/onboarding", ROUTES);
    expect(await screen.findByText(/До 200 файлов и 20 МБ/)).toBeInTheDocument();
    expect(screen.getByText(/Ничего не попадёт в базу знаний/)).toBeInTheDocument();
    const input = screen.getByLabelText("Выбрать файлы или ZIP") as HTMLInputElement;
    await userEvent.upload(input, new File(["PK"], "batch.zip", { type: "application/zip" }));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toContain(`batch=${BATCH}`));
    const post = calls.find((c) => c.method === "POST" && /\/api\/onboarding\/batches$/.test(c.url));
    expect(post?.body).toBeInstanceOf(FormData);
    const form = post?.body as FormData;
    expect(form.get("source_kind")).toBe("zip");
    expect((form.getAll("files")[0] as File).name).toBe("batch.zip");
  });

  it("shows backend counters, preselects nothing and creates drafts ONCE after an explicit check", async () => {
    const result = { batch_id: BATCH, state: "confirmed", outcomes: { aaaaaaaaaaaaaaaa: { state: "draft_created", proposal_id: "p1", document_id: "SEM-DOC-010", operation: "create", code: null, message: null } }, created: 1, failed: 0, replayed: false };
    const calls = mockApi([
      ...base,
      { path: new RegExp(`/api/onboarding/batches/${BATCH}$`), body: batch() },
      { method: "POST", path: /\/preview$/, body: { batch_id: BATCH, revision: 1, fingerprint: "f".repeat(64), planned: [{ item_id: "aaaaaaaaaaaaaaaa", path: "profile.md", operation: "create", document_id: null, title: "T", template_id: "dataset", related_ids: [], errors: [] }], blocked: [], skipped: [], creates: 1, updates: 0, index_unchanged: true } },
      { method: "POST", path: /\/confirm$/, body: result },
    ]);
    renderRoutes(`/documents/onboarding?batch=${BATCH}`, ROUTES);
    expect(await screen.findByText(/Файлов:/)).toHaveTextContent("Файлов: 3 · разобрано 1 · ошибок 1");
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes.every((b) => !(b as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByRole("checkbox", { name: "Выбрать «evil.md»" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Выбрать готовые (1)" }));
    await userEvent.click(screen.getByRole("button", { name: "Проверить выбор (1)" }));
    const create = await screen.findByRole("button", { name: "Создать черновики (1)" });
    expect(screen.getByText(/Черновики не утверждаются и не попадают в поиск/)).toBeInTheDocument();
    await userEvent.dblClick(create);
    expect(await screen.findByRole("link", { name: "черновик SEM-DOC-010" })).toHaveAttribute("href", "/proposals/p1");
    const confirms = calls.filter((c) => c.method === "POST" && c.url.endsWith("/confirm"));
    expect(confirms).toHaveLength(1);
    expect(confirms[0]?.body).toMatchObject({ expected_revision: 1, fingerprint: "f".repeat(64), item_ids: ["aaaaaaaaaaaaaaaa"] });
    expect(String((confirms[0]?.body as { idempotency_key: string }).idempotency_key).length).toBeGreaterThanOrEqual(8);
  });

  it("reviews one file: origins and evidence, a model suggestion accepted explicitly, candidates unchecked, a stale save explained", async () => {
    let patchStatus = 200;
    const calls = mockApi([
      ...base,
      { path: new RegExp(`/api/onboarding/batches/${BATCH}$`), body: batch() },
      { path: /\/items\/aaaaaaaaaaaaaaaa$/, body: DETAIL },
      {
        method: "PATCH",
        path: /\/items\/aaaaaaaaaaaaaaaa$/,
        respond: () =>
          patchStatus === 200
            ? new Response(JSON.stringify({ ...DETAIL, revision: 2 }), { status: 200, headers: { "Content-Type": "application/json" } })
            : new Response(JSON.stringify({ code: "stale_revision", message: "x", request_id: "t" }), { status: 409 }),
      },
    ]);
    renderRoutes(`/documents/onboarding?batch=${BATCH}`, ROUTES);
    await userEvent.click(await screen.findByRole("button", { name: "profile.md" }));
    const panel = await screen.findByRole("region", { name: "Файл profile.md" });
    expect(within(panel).getByText(/из текста · «заголовок первого уровня»/)).toBeInTheDocument();
    expect(within(panel).getByText(/Проверьте текст/)).toBeInTheDocument();
    expect(within(panel).getByText("из YAML файла")).toBeInTheDocument(); // the origin is not repeated as its own quote
    expect(within(panel).getByText("Синтетический текст")).toBeInTheDocument();
    expect(within(panel).getByRole("checkbox", { name: /SEM-STD-001/ })).not.toBeChecked();
    expect((within(panel).getByLabelText("Владелец") as HTMLInputElement).value).toBe("");  // not applied by itself
    await userEvent.click(within(panel).getByRole("button", { name: "Принять" }));
    expect((within(panel).getByLabelText("Владелец") as HTMLInputElement).value).toBe("data-team");
    await userEvent.click(within(panel).getByRole("button", { name: "Сохранить решения" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ expected_revision: 1, fields: { owner: "data-team" }, selected_links: [], reviewed: true });
    patchStatus = 409;
    await userEvent.click(within(panel).getByRole("button", { name: "Исключить из импорта" }));
    expect(await within(panel).findByText(/Файл уже изменили в другой вкладке/)).toBeInTheDocument();
  });

  it("an expired batch says so and allows nothing", async () => {
    mockApi([...base, { path: new RegExp(`/api/onboarding/batches/${BATCH}$`), body: batch({ state: "expired" }) }]);
    renderRoutes(`/documents/onboarding?batch=${BATCH}`, ROUTES);
    expect(await screen.findByText(/срок хранения истёк: изменить его нельзя/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Выбрать готовые (1)" })).toBeDisabled();
  });
});
