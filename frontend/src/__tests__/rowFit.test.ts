import { describe, expect, it } from "vitest";
import { fitsOneRow } from "../lib/rowFit";

/*
 * Planner v2 §3.9: the filter row switches the Gantt's controls to the compact form by the width of the row itself,
 * comparing the filters' natural width plus the controls' FULL width with the room the row has. Widths below are the
 * ones measured in Chrome on the seeded project (filters 200 + 84 + 124 + 66 with 8 px gaps, full controls 575 px).
 */

const FILTERS = [200, 84, 124, 66];

describe("fitsOneRow", () => {
  it("the full Gantt controls fit at 1440 px (row 1152 px inside its padding), not at 1280 or 1100 with the sidebar", () => {
    expect(fitsOneRow({ available: 1152, start: FILTERS, startGap: 8, groupGap: 12, end: 575 })).toBe(true);
    expect(fitsOneRow({ available: 992, start: FILTERS, startGap: 8, groupGap: 12, end: 575 })).toBe(false);
    expect(fitsOneRow({ available: 812, start: FILTERS, startGap: 8, groupGap: 12, end: 575 })).toBe(false);
  });

  it("counts the gaps between the filters and between the groups; an exact fit fits", () => {
    // 474 + 3 × 8 + 12 + 575 = 1085
    expect(fitsOneRow({ available: 1085, start: FILTERS, startGap: 8, groupGap: 12, end: 575 })).toBe(true);
    expect(fitsOneRow({ available: 1084, start: FILTERS, startGap: 8, groupGap: 12, end: 575 })).toBe(false);
  });

  it("a chip of a chosen filter takes room: the same row stops fitting", () => {
    expect(fitsOneRow({ available: 1152, start: [...FILTERS, 140], startGap: 8, groupGap: 12, end: 575 })).toBe(false);
  });

  it("no filters at all: only the controls", () => {
    expect(fitsOneRow({ available: 600, start: [], startGap: 8, groupGap: 12, end: 575 })).toBe(true);
  });
});
