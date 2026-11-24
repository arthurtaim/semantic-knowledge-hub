import { afterEach, describe, expect, it, vi } from "vitest";
import { clearRecentQuestions, noteDialogSources, readRecentDialogs, rememberDialog } from "../lib/recentQuestions";

// The questions of the remembered dialogs, newest first (the phase-4 wrappers around this API are gone).
const questions = (userId: string) => readRecentDialogs(userId).map((dialog) => dialog.question);

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
    storage.setItem("skh.recent-questions.v1:u1", "{not json");
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
    expect(questions("u1")).toEqual([]);
  });

  it("keeps a dialog's skill, its file or document and, once answered, the number of sources (never the answer)", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    rememberDialog("u1", { question: "", skill: "Найти связи", context: "ARIS → Catalog", at: "2026-11-24T10:00:00Z" });
    rememberDialog("u1", { question: "Сверить выгрузку", skill: "Сравнить с файлом", context: "aris.csv", at: "2026-11-24T10:05:00Z" });
    noteDialogSources("u1", "Сверить выгрузку", "Сравнить с файлом", 4);
    expect(readRecentDialogs("u1")).toEqual([
      { question: "Сверить выгрузку", at: "2026-11-24T10:05:00Z", skill: "Сравнить с файлом", sources: 4, context: "aris.csv" },
      { question: "", at: "2026-11-24T10:00:00Z", skill: "Найти связи", sources: null, context: "ARIS → Catalog" },
    ]);
    expect(JSON.stringify(window.localStorage.getItem("skh.recent-questions.v1:u1"))).not.toContain("answer");
  });

  it("reads the phase-4 format (plain strings) and skips broken entries", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    storage.setItem("skh.recent-questions.v1:u1", JSON.stringify(["Где база?", 42, null, { question: "" }, { question: "Что такое ревизия?", sources: -1 }]));
    expect(readRecentDialogs("u1")).toEqual([
      { question: "Где база?", at: null, skill: null, sources: null, context: null },
      { question: "Что такое ревизия?", at: null, skill: null, sources: null, context: null },
    ]);
  });
});
