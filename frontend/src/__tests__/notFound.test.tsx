import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AskResponse, AskStreamEvent } from "../api/types";
import { AskPage } from "../pages/AskPage";
import { supportedAnswer } from "./fixtures";
import { mockApi, ndjsonStream, renderAt, type MockRoute } from "./helpers";

/*
 * The amber line under an answer names the words of the question that no source contains: «Не найдено в
 * документах: «…»». The server never lists function words (предлоги, союзы, частицы, местоимения); when nothing
 * meaningful is missing it sends nothing and the line is not shown (owner's review, round 2).
 */

function streamRoute(response: AskResponse): MockRoute {
  const events: AskStreamEvent[] = [{ type: "final", response }];
  return {
    method: "POST",
    path: "/api/assistant/ask/stream",
    respond: (init) => {
      const stream = ndjsonStream();
      const result = stream.respond(init);
      stream.push(...events);
      stream.close();
      return result;
    },
  };
}

const partial: AskResponse = {
  ...supportedAnswer,
  mode: "internal_api",
  confidence: "partial",
  warnings: [],
  answer: "Четыре слоя [1].",
};

async function ask() {
  await userEvent.type(screen.getByLabelText("Вопрос"), "Через какие слои идут данные по регламенту?");
  await userEvent.click(screen.getByRole("button", { name: "Отправить" }));
  await screen.findByRole("heading", { name: "Ассистент" });
}

afterEach(() => vi.unstubAllGlobals());

describe("«Не найдено в документах»", () => {
  it("names the missing words the server reports under the new label", async () => {
    mockApi([streamRoute({ ...partial, unmatched_terms: ["регламенту"] })]);
    renderAt("/ask", "/ask", <AskPage />);
    await ask();
    const line = document.querySelector(".answer__unsupported") as HTMLElement;
    expect(line).toHaveTextContent("Не найдено в документах: «регламенту»");
    expect(screen.queryByText(/Нет подтверждения в источниках/)).toBeNull();
  });

  it("shows no line when nothing meaningful is missing", async () => {
    mockApi([streamRoute({ ...partial, unmatched_terms: [] })]);
    renderAt("/ask", "/ask", <AskPage />);
    await ask();
    expect(document.querySelector(".answer__unsupported")).toBeNull();
    expect(screen.queryByText(/Не найдено в документах/)).toBeNull();
  });
});
