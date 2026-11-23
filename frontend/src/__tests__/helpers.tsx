import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { vi } from "vitest";
import type { SessionResponse } from "../api/types";
import { SessionContext } from "../lib/session";
import { session as defaultSession } from "./fixtures";

export interface MockRoute {
  method?: string;
  path: string | RegExp;
  status?: number;
  /** A value, or a function called per request (e.g. to return a changed state on a reload). */
  body?: unknown;
  /** Full control over the answer (streams, never-ending or abortable requests); `status`/`body` are ignored. */
  respond?: (init: RequestInit | undefined) => Response | Promise<Response>;
}

export interface RecordedCall {
  method: string;
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

/** Stubs global fetch with a tiny router over `/api/...` paths (pathname + query). */
export function mockApi(routes: MockRoute[]): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null, headers });
    const route = routes.find(
      (r) => (r.method ?? "GET") === method && (typeof r.path === "string" ? r.path === url : r.path.test(url)),
    );
    if (!route) {
      return new Response(JSON.stringify({ code: "not_mocked", message: `No mock for ${method} ${url}`, request_id: "t" }), {
        status: 404,
      });
    }
    if (route.respond) return route.respond(init);
    const body = typeof route.body === "function" ? (route.body as () => unknown)() : route.body;
    // A 204 response must not carry a body.
    return new Response(route.status === 204 ? null : JSON.stringify(body), {
      status: route.status ?? 200,
      headers: { "Content-Type": "application/json", "X-Request-ID": "req-test" },
    });
  });
  return calls;
}

const abortError = () => new DOMException("The operation was aborted.", "AbortError");

/**
 * A controllable NDJSON response body (POST /api/assistant/ask/stream): `push` sends events as lines, `close`
 * ends the stream. Aborting the request's signal errors the body like a real fetch; `aborted` records it.
 */
export function ndjsonStream() {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const state = { aborted: false };
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    // The client releases the body after the terminal event.
    cancel() {
      closed = true;
    },
  });
  return {
    state,
    /** Sends one event per line; a raw string is sent as is (to split lines across chunks). */
    push(...events: (object | string)[]) {
      if (closed) return;
      controller.enqueue(encoder.encode(events.map((e) => (typeof e === "string" ? e : `${JSON.stringify(e)}\n`)).join("")));
    },
    close() {
      if (closed) return;
      closed = true;
      controller.close();
    },
    respond(init: RequestInit | undefined): Response {
      init?.signal?.addEventListener("abort", () => {
        state.aborted = true;
        if (!closed) {
          closed = true;
          controller.error(abortError());
        }
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "application/x-ndjson", "X-Request-ID": "req-stream" },
      });
    },
  };
}

/** A request that never answers until its signal is aborted (then rejects like fetch does). */
export function pendingUntilAborted(state: { aborted: boolean } = { aborted: false }) {
  return (init: RequestInit | undefined) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => {
        state.aborted = true;
        reject(abortError());
      });
    });
}

export function renderAt(
  path: string,
  routePattern: string,
  element: ReactElement,
  session: SessionResponse | null = defaultSession,
) {
  return render(
    <SessionContext.Provider value={session}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={routePattern} element={element} />
          <Route path="*" element={<p>Другая страница</p>} />
        </Routes>
      </MemoryRouter>
    </SessionContext.Provider>,
  );
}

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{`${location.pathname}${location.search}`}</span>;
}

/** Renders several routes and exposes the current URL as `getByTestId("location")`. */
export function renderRoutes(
  path: string,
  routes: Record<string, ReactElement>,
  session: SessionResponse | null = defaultSession,
) {
  return render(
    <SessionContext.Provider value={session}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          {Object.entries(routes).map(([pattern, element]) => (
            <Route key={pattern} path={pattern} element={element} />
          ))}
          <Route path="*" element={<p>Другая страница</p>} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </SessionContext.Provider>,
  );
}
