import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearRecentQuestions,
  findSkill,
  markAttachmentsGone,
  noteDialogSources,
  readRecentDialogs,
  rememberDialog,
  rerunsAtOnce,
  restoreDialog,
  type RecentDialog,
} from "../lib/recentQuestions";
import { skills } from "./fixtures";

// The questions of the remembered dialogs, newest first (the phase-4 wrappers around this API are gone).
const questions = (userId: string) => readRecentDialogs(userId).map((dialog) => dialog.question);
const KEY = "skh.recent-questions.v1:u1";
/** The fields an entry of an earlier round did not have. */
const NOTHING_MORE = { conversationId: null, attachments: [], documents: [] };

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => Array.from(data.keys())[index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, String(value)),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("recent questions (this browser only)", () => {
  it("keeps the last five per user, newest first, without duplicates", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    for (const q of ["один?", "два?", "три?", "четыре?", "пять?", "шесть?", "два?"]) rememberDialog("u1", { question: q });
    expect(questions("u1")).toEqual(["два?", "шесть?", "пять?", "четыре?", "три?"]);
    expect(questions("u2")).toEqual([]);
    clearRecentQuestions("u1");
    expect(questions("u1")).toEqual([]);
  });

  it("ignores short questions, missing users and broken or unavailable storage", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    rememberDialog("u1", { question: "ok" });
    rememberDialog(null, { question: "Где база?" });
    expect(questions("u1")).toEqual([]);
    storage.setItem(KEY, "{not json");
    expect(questions("u1")).toEqual([]);
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(() => rememberDialog("u1", { question: "Где база?" })).not.toThrow();
    expect(() => markAttachmentsGone("u1", ["ATT-0123456789abcdef"])).not.toThrow();
    expect(questions("u1")).toEqual([]);
  });

  // Round 2 (decision 8): the skill's id, the dialog id and what was attached are kept too — never the answer or a
  // file's contents. The earlier test checked the skill's name only.
  it("keeps the skill (id and name), the dialog, the files and documents and the number of sources", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    rememberDialog("u1", {
      question: "",
      skill: { id: "find_related", name: "Найти связи" },
      context: "ARIS → Catalog",
      conversationId: "conv-test-0001",
      documents: [{ id: "DEMO-INT-001", title: "ARIS → Catalog" }],
      at: "2026-11-24T10:00:00Z",
    });
    rememberDialog("u1", {
      question: "Сверить выгрузку",
      skill: { id: "compare_with_file", name: "Сравнить с файлом" },
      context: "aris.csv",
      conversationId: "conv-test-0002",
      attachments: [
        { id: "ATT-0123456789abcdef", name: "aris.csv", size: 2048, mime: "text/csv", summary: "12 строк", expiresAt: "2026-11-25T10:05:00Z" },
        { id: "not-an-attachment-id", name: "broken.csv" },
      ],
      at: "2026-11-24T10:05:00Z",
    });
    noteDialogSources("u1", { question: "Сверить выгрузку", skill: { id: "compare_with_file", name: "Сравнить с файлом" } }, 4);
    expect(readRecentDialogs("u1")).toEqual([
      {
        question: "Сверить выгрузку",
        at: "2026-11-24T10:05:00Z",
        skill: { id: "compare_with_file", name: "Сравнить с файлом" },
        sources: 4,
        context: "aris.csv",
        conversationId: "conv-test-0002",
        attachments: [
          {
            id: "ATT-0123456789abcdef",
            name: "aris.csv",
            size: 2048,
            mime: "text/csv",
            summary: "12 строк",
            expiresAt: "2026-11-25T10:05:00Z",
            gone: false,
          },
        ],
        documents: [],
      },
      {
        question: "",
        at: "2026-11-24T10:00:00Z",
        skill: { id: "find_related", name: "Найти связи" },
        sources: null,
        context: "ARIS → Catalog",
        conversationId: "conv-test-0001",
        attachments: [],
        documents: [{ id: "DEMO-INT-001", title: "ARIS → Catalog" }],
      },
    ]);
    const stored = window.localStorage.getItem(KEY) ?? "";
    expect(stored).not.toContain("answer");
    // Additive format: `skill` is still the name, so older code keeps reading the entries.
    expect((JSON.parse(stored) as { skill: string; skill_id: string }[])[0]).toMatchObject({
      skill: "Сравнить с файлом",
      skill_id: "compare_with_file",
    });
  });

  it("reads the phase-4 format (plain strings) and skips broken entries", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    storage.setItem(KEY, JSON.stringify(["Где база?", 42, null, { question: "" }, { question: "Что такое ревизия?", sources: -1 }]));
    expect(readRecentDialogs("u1")).toEqual([
      { question: "Где база?", at: null, skill: null, sources: null, context: null, ...NOTHING_MORE },
      { question: "Что такое ревизия?", at: null, skill: null, sources: null, context: null, ...NOTHING_MORE },
    ]);
  });

  it("migrates round-1 entries (the skill by name) and keeps them when a new dialog is remembered", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    storage.setItem(
      KEY,
      JSON.stringify([
        { question: "", skill: "Найти связи", context: "ARIS", sources: null, at: "2026-11-23T09:00:00Z" },
        { question: "Сверить", skill: "Сравнить с файлом", conversation_id: "bad id", attachments: "nope", documents: [{ id: "../x" }] },
      ]),
    );
    const migrated = readRecentDialogs("u1");
    expect(migrated[0]).toEqual({
      question: "",
      at: "2026-11-23T09:00:00Z",
      skill: { id: null, name: "Найти связи" },
      sources: null,
      context: "ARIS",
      ...NOTHING_MORE,
    });
    expect(migrated[1]).toMatchObject({ skill: { id: null, name: "Сравнить с файлом" }, ...NOTHING_MORE });
    // A skill known by name only matches the same skill remembered with its id.
    rememberDialog("u1", { question: "", skill: { id: "find_related", name: "Найти связи" } });
    expect(readRecentDialogs("u1").map((d) => d.skill)).toEqual([
      { id: "find_related", name: "Найти связи" },
      { id: null, name: "Сравнить с файлом" },
    ]);
  });

  it("greys out files deleted here or reported missing by the server, in every dialog that had them", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const file = { id: "ATT-0123456789abcdef", name: "a.csv", size: 10, expiresAt: "2026-11-25T10:00:00Z" };
    const other = { id: "ATT-fedcba9876543210", name: "b.csv", size: 20, expiresAt: "2026-11-25T10:00:00Z" };
    rememberDialog("u1", { question: "Первый вопрос", conversationId: "conv-test-0001", attachments: [file, other] });
    rememberDialog("u1", { question: "Второй вопрос", conversationId: "conv-test-0001", attachments: [file] });
    markAttachmentsGone("u1", ["ATT-0123456789abcdef"]);
    expect(readRecentDialogs("u1").map((d) => d.attachments.map((a) => [a.name, a.gone]))).toEqual([
      [["a.csv", true]],
      [
        ["a.csv", true],
        ["b.csv", false],
      ],
    ]);
  });
});

describe("reopening a recent dialog", () => {
  const NOW = Date.parse("2026-11-24T12:00:00Z");
  const dialog = (overrides: Partial<RecentDialog>): RecentDialog => ({
    question: "Сверить выгрузку",
    at: null,
    skill: { id: "compare_with_file", name: "Сравнить с файлом" },
    sources: null,
    context: null,
    conversationId: "conv-test-0002",
    attachments: [],
    documents: [],
    ...overrides,
  });
  const file = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    name: `${id}.csv`,
    size: 2048,
    mime: "text/csv",
    summary: "12 строк",
    expiresAt: "2026-11-25T10:00:00Z",
    gone: false,
    ...overrides,
  });

  it("puts back the question, the documents and the files of the same dialog: live ones ready, others greyed out", () => {
    const item = dialog({
      attachments: [
        file("ATT-000000000000000a"),
        file("ATT-000000000000000b", { expiresAt: "2026-11-24T11:59:00Z" }),
        file("ATT-000000000000000c", { gone: true }),
        file("ATT-000000000000000d", { expiresAt: null }),
      ],
      documents: [{ id: "DEMO-INT-001", title: "ARIS → Catalog" }],
    });
    const { conversationId, draft } = restoreDialog(item, NOW);
    expect(conversationId).toBe("conv-test-0002");
    expect(draft.text).toBe("Сверить выгрузку");
    expect(draft.skill).toBeNull(); // the page adds it from the registry
    expect(draft.documents).toEqual([{ id: "DEMO-INT-001", title: "ARIS → Catalog", status: null }]);
    expect(draft.files.map((f) => [f.name, f.status])).toEqual([
      ["ATT-000000000000000a.csv", "ready"],
      ["ATT-000000000000000b.csv", "unavailable"],
      ["ATT-000000000000000c.csv", "unavailable"],
      ["ATT-000000000000000d.csv", "ready"], // no expiry known: the server decides
    ]);
    expect(draft.files[0]?.attachment).toMatchObject({
      id: "ATT-000000000000000a",
      conversation_id: "conv-test-0002",
      size: 2048,
      summary: "12 строк",
      status: "ready",
    });
    expect(draft.files[1]?.attachment).toBeNull(); // nothing to send
  });

  it("never offers a file whose dialog or size is unknown, and starts a new dialog id without one", () => {
    const orphan = restoreDialog(dialog({ conversationId: null, attachments: [file("ATT-000000000000000a")] }), NOW);
    expect(orphan.conversationId).toMatch(/^conv-/);
    expect(orphan.draft.files[0]?.status).toBe("unavailable");
    const unsized = restoreDialog(dialog({ attachments: [file("ATT-000000000000000a", { size: null })] }), NOW);
    expect(unsized.draft.files[0]?.status).toBe("unavailable");
  });

  it("finds the skill in the registry by id (by name for older entries); one that cannot run is not restored", () => {
    expect(findSkill(skills, { id: "compare_with_file", name: "старое имя" })?.id).toBe("compare_with_file");
    expect(findSkill(skills, { id: null, name: "Найти связи" })?.id).toBe("find_related");
    expect(findSkill(skills, { id: "improve_section", name: "Улучшить раздел" })).toBeNull(); // unavailable in mock
    expect(findSkill(skills, { id: "retired_skill", name: "Ушедший навык" })).toBeNull();
    expect(findSkill(null, { id: "explain", name: "Объяснить" })).toBeNull();
  });

  it("asks a plain question again at once; a skill or a file waits for Enter", () => {
    expect(rerunsAtOnce(dialog({ skill: null }))).toBe(true);
    expect(rerunsAtOnce(dialog({ skill: null, documents: [{ id: "DEMO-INT-001", title: "ARIS" }] }))).toBe(true);
    expect(rerunsAtOnce(dialog({}))).toBe(false);
    expect(rerunsAtOnce(dialog({ skill: null, attachments: [file("ATT-000000000000000a")] }))).toBe(false);
    expect(rerunsAtOnce(dialog({ question: "", skill: { id: "find_related", name: "Найти связи" } }))).toBe(false);
  });
});
