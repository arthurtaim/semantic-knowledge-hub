import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type { AssistantAttachment, AssistantSkill } from "../api/types";

/** UI v2 typed client: skills and conversation attachments (docs/ui-v2/specs/02_ASSISTANT.md §5). */

function json(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "X-Request-ID": "req-test" },
  });
}

const attachment: AssistantAttachment = {
  id: "ATT-0123456789abcdef",
  conversation_id: "conv-0001-test",
  name: "fields.csv",
  size: 42,
  mime: "text/csv",
  status: "ready",
  summary: "3 строки",
  error_code: null,
  expires_at: "2026-11-25T10:00:00Z",
};

afterEach(() => vi.restoreAllMocks());

describe("assistant skills and attachments client", () => {
  it("loads the skill registry from the server", async () => {
    const skill: AssistantSkill = {
      id: "compare_with_file",
      name: "Сравнить с файлом",
      description: "Сверит вложение с утверждёнными документами",
      access: "read",
      requires: { document: false, selection: false, attachment: true },
      prompt_optional: true,
      available: true,
      unavailable_reason: null,
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(json([skill]));
    await expect(api.assistantSkills()).resolves.toEqual([skill]);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("/api/assistant/skills");
  });

  it("uploads multipart with the conversation id first and no JSON content type", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(attachment, 201));
    const file = new File(["region_code;region_name\n01;A\n"], "fields.csv", { type: "text/csv" });
    await expect(api.uploadAttachment("conv-0001-test", file)).resolves.toEqual(attachment);
    const [url, init] = fetchSpy.mock.calls[0] ?? ["", undefined];
    expect(url).toBe("/api/assistant/attachments");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBeUndefined();
    expect(headers["X-SKH-Client"]).toBe("web");
    const form = init?.body as FormData;
    expect([...form.keys()]).toEqual(["conversation_id", "file"]);
    expect((form.get("file") as File).name).toBe("fields.csv");
  });

  it("returns a rejected file as an attachment with an error code", async () => {
    const tooLarge = { ...attachment, status: "error", summary: null, error_code: "too_large", expires_at: null };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(tooLarge, 200));
    const result = await api.uploadAttachment("conv-0001-test", new Blob(["x"]), "huge.csv");
    expect(result.status).toBe("error");
    expect(result.error_code).toBe("too_large");
  });

  it("deletes an attachment idempotently", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(null, 204));
    await expect(api.deleteAttachment("ATT-0123456789abcdef")).resolves.toBeNull();
    const [url, init] = fetchSpy.mock.calls[0] ?? ["", undefined];
    expect(url).toBe("/api/assistant/attachments/ATT-0123456789abcdef");
    expect(init?.method).toBe("DELETE");
  });
});

describe("knowledge search client", () => {
  it("asks GET /api/search with the query, the scopes as CSV and a limit", async () => {
    const body = { query: "маппинг", items: [], total: 0, scopes: [], warnings: [] };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(body));
    await expect(api.search({ q: "маппинг", source: ["team", "corporate"], limit: 8 })).resolves.toEqual(body);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      `/api/search?q=${encodeURIComponent("маппинг").replace(/%20/g, "+")}&source=team%2Ccorporate&limit=8`,
    );
  });
});
