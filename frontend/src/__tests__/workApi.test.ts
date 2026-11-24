import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../api/client";

/** M6 typed client (docs/WORK_MANAGEMENT.md): URLs, methods, bodies and structured errors — no UI yet. */

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "X-Request-ID": "req-test" },
  });
}

afterEach(() => vi.restoreAllMocks());

describe("work management client", () => {
  it("builds task list queries: comma lists, booleans, keys in the path", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ items: [], total: 0 }));
    await api.workTasks("ARIS", {
      status: ["todo", "in_progress"],
      assignee: "none",
      overdue: true,
      include_archived: false,
      sort: "start_date",
      limit: 50,
    });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "/api/projects/ARIS/tasks?status=todo%2Cin_progress&assignee=none&overdue=true&include_archived=false&sort=start_date&limit=50",
    );
  });

  it("patches a task with the expected version and the CSRF header", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ id: "t1", version: 3 }));
    await api.workUpdateTask("ARIS-12", { expected_version: 2, status: "review" });
    const [url, init] = fetchSpy.mock.calls[0] ?? ["", undefined];
    expect(url).toBe("/api/tasks/ARIS-12");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({ expected_version: 2, status: "review" });
    expect((init?.headers as Record<string, string>)["X-SKH-Client"]).toBe("web");
  });

  it("archives with query parameters and previews/applies the schedule", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.resolve(json({})));
    await api.workArchiveTask("t1", 4, true);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("/api/tasks/t1?expected_version=4&cascade=true");
    expect(fetchSpy.mock.calls[0]?.[1]?.method).toBe("DELETE");
    await api.workSchedulePreview("ARIS", {
      mode: "shift_successors",
      changes: [{ task_id: "ARIS-1", start_date: "2026-11-30", duration_workdays: 2 }],
    });
    expect(fetchSpy.mock.calls[1]?.[0]).toBe("/api/projects/ARIS/schedule/preview");
    await api.workScheduleApply("ARIS", {
      preview_id: "p1",
      expected_plan_revision: 7,
      client_request_id: "apply-0000001",
      accept_warnings: true,
    });
    const [url, init] = fetchSpy.mock.calls[2] ?? ["", undefined];
    expect(url).toBe("/api/projects/ARIS/schedule/apply");
    expect(JSON.parse(String(init?.body))).toMatchObject({ expected_plan_revision: 7, accept_warnings: true });
  });

  it("surfaces stale writes as structured ApiError with details", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json(
        { code: "stale_schedule", message: "План изменился", request_id: "r1", details: { reason: "plan_revision", current: 9 } },
        409,
      ),
    );
    const error = await api.workScheduleApply("ARIS", { preview_id: "p", expected_plan_revision: 1, client_request_id: "apply-0000002" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).code).toBe("stale_schedule");
    expect((error as ApiError).details).toEqual({ reason: "plan_revision", current: 9 });
  });
});
