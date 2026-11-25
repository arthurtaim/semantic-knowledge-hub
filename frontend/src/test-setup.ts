import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { forgetPanelConversations } from "./components/DocumentAssistant";
import { clearConversation } from "./lib/conversation";
import { forgetDocumentTree } from "./lib/useDocumentTree";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // The assistant keeps its conversations in memory across visits (lib/conversationStore.ts); tests start empty.
  clearConversation();
  forgetPanelConversations();
  // The documents tree is shared between views and pages; every test asks its own mocked API.
  forgetDocumentTree();
});

// jsdom does not implement scrollIntoView.
Element.prototype.scrollIntoView = function scrollIntoView() {};
