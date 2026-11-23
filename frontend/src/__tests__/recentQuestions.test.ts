import { afterEach, describe, expect, it, vi } from "vitest";
import { clearRecentQuestions, readRecentQuestions, rememberQuestion } from "../lib/recentQuestions";

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
    for (const q of ["один?", "два?", "три?", "четыре?", "пять?", "шесть?", "два?"]) rememberQuestion("u1", q);
    expect(readRecentQuestions("u1")).toEqual(["два?", "шесть?", "пять?", "четыре?", "три?"]);
    expect(readRecentQuestions("u2")).toEqual([]);
    clearRecentQuestions("u1");
    expect(readRecentQuestions("u1")).toEqual([]);
  });

  it("ignores short questions, missing users and broken or unavailable storage", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    rememberQuestion("u1", "ok");
    rememberQuestion(null, "Где база?");
    expect(readRecentQuestions("u1")).toEqual([]);
    storage.setItem("skh.recent-questions.v1:u1", "{not json");
    expect(readRecentQuestions("u1")).toEqual([]);
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(() => rememberQuestion("u1", "Где база?")).not.toThrow();
    expect(readRecentQuestions("u1")).toEqual([]);
  });
});
