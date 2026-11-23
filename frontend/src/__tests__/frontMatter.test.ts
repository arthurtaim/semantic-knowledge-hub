import { describe, expect, it } from "vitest";
import { frontMatterSummary, splitFrontMatter } from "../lib/frontMatter";

describe("splitFrontMatter", () => {
  it.each([
    "---\nid: A\n---\n# T\n",
    "---\nid: A\n---\n\n\n# T\n",
    "---\r\nid: A\r\n---\r\n\r\n# T\r\n",
    "# No front matter\n---\nnot: yaml\n",
    "---\nid: A\n---",
    "",
  ])("always rebuilds the exact text: %j", (raw) => {
    const { frontMatter, body } = splitFrontMatter(raw);
    expect(frontMatter + body).toBe(raw);
  });

  it("puts the blank lines after the header into the header, so the body starts with content", () => {
    expect(splitFrontMatter("---\nid: A\n---\n\n# T\n").body).toBe("# T\n");
    expect(splitFrontMatter("# T\n---\nx: 1\n---\n").frontMatter).toBe("");
  });

  it("summarises top-level scalar fields and counts the rest", () => {
    const { fields, other } = frontMatterSummary('---\nid: SEM-1\ntitle: "Тест"\nrelated_ids:\n  - SEM-2\nsummary: |\n  x\n---\n');
    expect(fields).toEqual([
      { key: "id", label: "ID", value: "SEM-1" },
      { key: "title", label: "Название", value: "Тест" },
    ]);
    expect(other).toBe(2);
  });
});
