import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { clearConversation } from "./lib/conversation";
import { forgetDocumentTree } from "./lib/useDocumentTree";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // The ask page keeps its conversation in memory across visits; tests start empty.
  clearConversation();
  // The documents tree is shared between views and pages; every test asks its own mocked API.
  forgetDocumentTree();
});

// jsdom does not implement scrollIntoView.
Element.prototype.scrollIntoView = function scrollIntoView() {};
