import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { When } from "../components/When";
import { formatWhen } from "../lib/labels";

// Local wall-clock times: the formatter works in the reader's time zone.
const now = new Date(2026, 10, 23, 15, 50, 0);
const local = (d: number, h: number, m: number) => new Date(2026, 10, d, h, m, 0).toISOString();

describe("formatWhen: one date format for lists and tables", () => {
  it("is relative for the last hour, today and yesterday", () => {
    expect(formatWhen(new Date(2026, 10, 23, 15, 49, 30).toISOString(), now)).toMatchObject({ text: "только что", relative: true });
    expect(formatWhen(local(23, 15, 49), now).text).toBe("1 мин. назад");
    expect(formatWhen(local(23, 15, 20), now).text).toBe("30 мин. назад");
    expect(formatWhen(local(23, 9, 5), now).text).toBe("сегодня, 09:05");
    expect(formatWhen(local(22, 18, 0), now).text).toBe("вчера, 18:00");
  });

  it("falls back to a short date with the full date and time in `full`", () => {
    const older = formatWhen(local(12, 8, 30), now);
    expect(older.text).toBe("12 нояб. 2026 г.");
    expect(older.full).toBe("12 ноября 2026 г. в 08:30");
    expect(older.relative).toBe(false);
  });

  it("treats a bare date as a day and never invents a time", () => {
    expect(formatWhen("2026-11-23", now).text).toBe("сегодня");
    expect(formatWhen("2026-11-22", now).text).toBe("вчера");
    expect(formatWhen("2026-10-01", now)).toEqual({ text: "1 окт. 2026 г.", full: "1 октября 2026 г.", relative: false });
  });

  it("does not call a future moment «только что»", () => {
    expect(formatWhen(local(24, 10, 0), now).text).toBe("24 нояб. 2026 г.");
  });

  it("renders a non-wrapping <time> with the full date as tooltip; relative text also for screen readers", () => {
    const value = new Date(Date.now() - 5 * 60_000).toISOString();
    render(<When value={value} />);
    const time = screen.getByText(/мин\. назад/);
    expect(time.tagName).toBe("TIME");
    expect(time).toHaveAttribute("datetime", value);
    expect(time).toHaveClass("when");
    expect(time.getAttribute("title")).toMatch(/2026|20\d\d/);
    expect(time.querySelector(".visually-hidden")).not.toBeNull();
  });

  it("shows the fallback without a value", () => {
    render(<When value={null} fallback="не проверялось" />);
    expect(screen.getByText("не проверялось")).toBeInTheDocument();
  });
});
