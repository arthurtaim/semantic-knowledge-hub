import { describe, expect, it } from "vitest";
import css from "../styles/app.css?raw";

/*
 * The visual system's guarantees (docs/ui-v2/specs/01_VISUAL_SYSTEM.md), checked on the stylesheet itself:
 * every colour is a token, the dark theme is the same under `data-theme="dark"` and «Как в системе», and the
 * token pairs meet WCAG 2.2 AA (text 4.5:1, field boundaries, icons and status marks 3:1).
 */

const END = "/* END OF TOKENS */";
const tokenSection = css.slice(0, css.indexOf(END));
const rest = css.slice(css.indexOf(END));

function block(selector: string): Map<string, string> {
  const start = tokenSection.indexOf(`${selector} {`);
  expect(start, `token block ${selector}`).toBeGreaterThanOrEqual(0);
  const body = tokenSection.slice(start + selector.length + 2, tokenSection.indexOf("}", start));
  const map = new Map<string, string>();
  for (const match of body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) map.set(match[1] as string, (match[2] as string).trim());
  return map;
}

const light = block(":root");
const dark = block(':root[data-theme="dark"]');
const systemDark = block(':root:not([data-theme="light"])');

function resolve(theme: Map<string, string>, name: string): string {
  const value = theme.get(name) ?? light.get(name);
  if (!value) throw new Error(`token ${name} is not defined`);
  const ref = /^var\((--[a-z0-9-]+)\)$/.exec(value);
  return ref ? resolve(theme, ref[1] as string) : value;
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const SURFACES = ["--bg-window", "--bg-sidebar", "--bg-surface", "--bg-subtle", "--bg-hover"];

/** [foreground, background, minimum ratio] */
const PAIRS: [string, string, number][] = [
  ...SURFACES.flatMap((bg): [string, string, number][] => [
    ["--text", bg, 4.5],
    ["--text-secondary", bg, 4.5],
    ["--text-tertiary", bg, 4.5],
    ["--line-field", bg, 3],
  ]),
  ["--text", "--bg-selected", 4.5],
  ["--text-secondary", "--bg-selected", 4.5],
  ["--accent-text", "--bg-surface", 4.5],
  ["--accent-text", "--bg-window", 4.5],
  ["--accent-text", "--accent-wash", 4.5],
  ["--accent", "--bg-surface", 3],
  ["--accent", "--bg-window", 3],
  ["--accent-contrast", "--accent", 4.5],
  ["--accent-contrast", "--accent-hover", 4.5],
  ["--text", "--accent-wash", 4.5],
  ["--badge-text", "--badge-bg", 4.5],
  ["--cite-text", "--cite-bg", 4.5],
  ["--cite-file-text", "--cite-file-bg", 4.5],
  ["--demo-text", "--demo-bg", 4.5],
  ["--demo-dot", "--demo-bg", 3],
  ["--danger-text", "--danger-bg", 4.5],
  ["--danger-text", "--bg-surface", 4.5],
  ["--danger", "--bg-surface", 3],
  ["--status-approved", "--bg-surface", 3],
  ["--status-review", "--bg-surface", 3],
  ["--status-review-text", "--bg-surface", 4.5],
  ["--status-review-text", "--status-review-bg", 4.5],
  ["--status-draft", "--bg-surface", 3],
  ["--status-draft", "--status-draft-bg", 3],
  ["--status-draft-text", "--bg-surface", 4.5],
  ["--status-draft-text", "--status-draft-bg", 4.5],
  ["--status-deprecated", "--bg-surface", 4.5],
  ["--status-deprecated", "--status-deprecated-bg", 4.5],
  ["--text", "--mark-bg", 4.5],
  ["--text", "--diff-add-bg", 4.5],
  ["--text", "--diff-remove-bg", 4.5],
  ["--text-inverse", "--bg-inverse", 4.5],
  ...[
    "--graph-document",
    "--graph-integration",
    "--graph-source-system",
    "--graph-dataset",
    "--graph-semantic-entity",
    "--graph-template",
    "--graph-external-page",
    "--graph-query-context",
    "--graph-edge-active",
  ].map((node): [string, string, number] => [node, "--graph-canvas", 3]),
];

describe("Visual system tokens", () => {
  it("keeps the dark theme identical for data-theme=dark and «Как в системе»", () => {
    expect(dark.size).toBeGreaterThan(40);
    expect(Object.fromEntries(systemDark)).toEqual(Object.fromEntries(dark));
  });

  it("gives every light colour token a dark value", () => {
    const colours = [...light].filter(([, value]) => /^(#|rgb\()/.test(value)).map(([name]) => name);
    expect(colours.length).toBeGreaterThan(40);
    expect(colours.filter((name) => !dark.has(name))).toEqual([]);
  });

  it("uses no colour literal outside the token definitions", () => {
    const literals = rest.match(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/g) ?? [];
    expect(literals).toEqual([]);
  });

  it.each([
    ["light", light],
    ["dark", dark],
  ] as const)("meets WCAG 2.2 AA for text and non-text pairs in the %s theme", (_name, theme) => {
    const failures = PAIRS.map(([fg, bg, min]) => {
      const ratio = contrast(resolve(theme, fg), resolve(theme, bg));
      return { pair: `${fg} on ${bg}`, ratio: Math.round(ratio * 100) / 100, min };
    }).filter(({ ratio, min }) => ratio < min);
    expect(failures).toEqual([]);
  });
});
