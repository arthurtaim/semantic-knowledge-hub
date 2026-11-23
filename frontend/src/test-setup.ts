import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { clearConversation } from "./lib/conversation";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // The ask page keeps its conversation in memory across visits; tests start empty.
  clearConversation();
});

// jsdom does not implement scrollIntoView.
Element.prototype.scrollIntoView = function scrollIntoView() {};
