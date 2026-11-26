// B2 UI measurement (Playwright, Chrome channel, headless, 1440×900) against a Vite dev server of one stack.
// Usage (from <repo>/frontend, or FRONTEND_DIR=<repo>/frontend): node ui_perf.mjs BASE_URL LABEL OUT.json [RUNS]
// Board (project LD): first card time, long tasks, DOM nodes, cards in the DOM, then interactions:
// Alt+→ / Alt+← keyboard move, drag to another column and back, search filter on / off, scroll to the bottom.
// Event Timing entries (durationThreshold 16 ms) give the interaction latency as the browser sees it.
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import os from "node:os";

const require = createRequire(`${process.env.FRONTEND_DIR ?? process.cwd()}/package.json`);
const { chromium } = require("@playwright/test");

const [base, label, out, runsArg] = process.argv.slice(2);
const RUNS = Number(runsArg ?? 5);
const PROJECT = process.env.PROJECT ?? "LD";

const INIT = () => {
  window.__lt = [];
  window.__ev = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__lt.push({ start: e.startTime, dur: e.duration });
    }).observe({ type: "longtask", buffered: true });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        window.__ev.push({ name: e.name, start: e.startTime, dur: e.duration, id: e.interactionId || 0 });
    }).observe({ type: "event", buffered: true, durationThreshold: 16 });
  } catch {
    /* no observer */
  }
  const mark = () => {
    if (!window.__firstCard && document.querySelector(window.__sel || ".board-card")) {
      window.__firstCard = performance.now();
      requestAnimationFrame(() => requestAnimationFrame(() => (window.__firstCardPaint = performance.now())));
    }
  };
  const mo = new MutationObserver(mark);
  document.addEventListener("DOMContentLoaded", () => mo.observe(document.body, { childList: true, subtree: true }));
  window.__last = {};
  for (const type of ["keydown", "pointerup", "input"]) {
    window.addEventListener(type, (e) => (window.__last[type] = e.timeStamp), true);
  }
};

function stats(list) {
  const xs = [...list].sort((a, b) => a - b);
  const pick = (p) => xs[Math.min(xs.length - 1, Math.round((p / 100) * (xs.length - 1)))];
  return { n: xs.length, p50: pick(50), max: xs[xs.length - 1], values: list };
}

async function settle(page, ms = 1200) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(ms);
}

async function dom(page) {
  return page.evaluate(() => ({
    nodes: document.getElementsByTagName("*").length,
    cards: document.querySelectorAll(".board-card").length,
    columns: Object.fromEntries(
      Array.from(document.querySelectorAll(".board__column")).map((c) => [
        c.getAttribute("data-status"),
        { cards: c.querySelectorAll(".board-card").length, label: c.querySelector(".board__count")?.textContent?.trim() },
      ]),
    ),
  }));
}

async function longTasks(page, from = 0) {
  return page.evaluate((from) => {
    const xs = window.__lt.filter((e) => e.start >= from);
    return { count: xs.length, max: Math.round(Math.max(0, ...xs.map((e) => e.dur))), total: Math.round(xs.reduce((s, e) => s + e.dur, 0)) };
  }, from);
}

async function events(page, from) {
  return page.evaluate((from) => {
    const xs = window.__ev.filter((e) => e.start >= from);
    return { max: Math.round(Math.max(0, ...xs.map((e) => e.dur))), names: [...new Set(xs.map((e) => e.name))] };
  }, from);
}

/** Waits in the page (rAF polling) until `cond` holds; returns performance.now() of that frame. */
function until(page, cond, arg) {
  return page.evaluate(
    ([src, arg]) =>
      new Promise((resolve, reject) => {
        const fn = new Function("arg", `return (${src})(arg);`);
        const t0 = performance.now();
        const check = () => {
          if (fn(arg)) resolve(performance.now());
          else if (performance.now() - t0 > 20000) reject(new Error("timeout " + src));
          else requestAnimationFrame(check);
        };
        check();
      }),
    [cond.toString(), arg],
  );
}

const inColumn = (a) => {
  const el = document.querySelector(`.board-card[data-task-key="${a.key}"]`);
  return Boolean(el && el.closest(".board__column")?.getAttribute("data-status") === a.status);
};

async function main() {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(INIT);
  const result = { label, base, project: PROJECT, at: new Date().toISOString(), loadavg_start: os.loadavg(), board: {}, views: {} };

  // warm-up (Vite transforms, browser cache)
  {
    const page = await context.newPage();
    await page.goto(`${base}/projects/${PROJECT}?view=board`);
    await page.locator(".board-card").first().waitFor({ timeout: 60000 });
    await settle(page);
    await page.close();
  }

  const first = [], paint = [], lt = [], ltMax = [], ltTotal = [], nodes = [], cards = [];
  let consoleErrors = [];
  for (let i = 0; i < RUNS; i += 1) {
    const page = await context.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
    });
    await page.goto(`${base}/projects/${PROJECT}?view=board`);
    await page.locator(".board-card").first().waitFor({ timeout: 60000 });
    await settle(page);
    const m = await page.evaluate(() => ({ first: window.__firstCard, paint: window.__firstCardPaint }));
    first.push(Math.round(m.first));
    paint.push(Math.round(m.paint));
    const l = await longTasks(page);
    lt.push(l.count);
    ltMax.push(l.max);
    ltTotal.push(l.total);
    const d = await dom(page);
    nodes.push(d.nodes);
    cards.push(d.cards);
    if (i === RUNS - 1) result.board.columns = d.columns;
    if (i < RUNS - 1) await page.close();
    else result.page = page;
  }
  result.board.first_card_ms = stats(first);
  result.board.first_card_paint_ms = stats(paint);
  result.board.long_tasks = { count: stats(lt), max_ms: stats(ltMax), total_ms: stats(ltTotal) };
  result.board.dom_nodes = stats(nodes);
  result.board.cards_in_dom = stats(cards);

  // --- interactions on the last page ---
  const page = result.page;
  delete result.page;
  const inter = {};
  const firstKey = (status) =>
    page.evaluate((s) => document.querySelector(`.board__column[data-status="${s}"] .board-card`)?.getAttribute("data-task-key"), status);

  // keyboard: Alt+→ then Alt+← on the first «todo» card (optimistic move + focus; then the quiet re-read settles)
  const kb = { right: [], left: [], right_settled: [], event_max: [] };
  for (let r = 0; r < 3; r += 1) {
    const key = await firstKey("todo");
    await page.locator(`.board-card[data-task-key="${key}"] .board-card__title`).focus();
    let from = await page.evaluate(() => performance.now());
    let waitGantt = page.waitForResponse((resp) => resp.url().includes("/gantt"), { timeout: 30000 });
    let done = until(page, inColumn, { key, status: "in_progress" });
    await page.keyboard.press("Alt+ArrowRight");
    let t = await done;
    let t0 = await page.evaluate(() => window.__last.keydown);
    kb.right.push(Math.round(t - t0));
    await waitGantt;
    let settled = await page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => res(performance.now())))));
    kb.right_settled.push(Math.round(settled - t0));
    await settle(page, 600);
    kb.event_max.push((await events(page, from)).max);
    // focus followed the card?
    kb.focus_followed = await page.evaluate((k) => document.activeElement?.closest(".board-card")?.getAttribute("data-task-key") === k, key);
    from = await page.evaluate(() => performance.now());
    waitGantt = page.waitForResponse((resp) => resp.url().includes("/gantt"), { timeout: 30000 });
    done = until(page, inColumn, { key, status: "todo" });
    await page.keyboard.press("Alt+ArrowLeft");
    t = await done;
    t0 = await page.evaluate(() => window.__last.keydown);
    kb.left.push(Math.round(t - t0));
    await waitGantt;
    await settle(page, 600);
    kb.event_max.push((await events(page, from)).max);
  }
  inter.keyboard_move = { right_ms: stats(kb.right), left_ms: stats(kb.left), right_settled_ms: stats(kb.right_settled), event_max_ms: stats(kb.event_max), focus_followed: kb.focus_followed };
  {
    const from = 0;
    inter.keyboard_long_tasks_total = await longTasks(page, from);
  }

  // drag: the first «todo» card into «review» and back
  const drag = { to: [], back: [], event_max: [] };
  for (let r = 0; r < 2; r += 1) {
    for (const [fromStatus, toStatus, bucket] of [["todo", "review", "to"], ["review", "todo", "back"]]) {
      const key = fromStatus === "todo" ? await firstKey("todo") : drag.lastKey;
      drag.lastKey = key;
      const card = page.locator(`.board-card[data-task-key="${key}"]`);
      await card.scrollIntoViewIfNeeded();
      const box = await card.boundingBox();
      const col = await page.locator(`.board__column[data-status="${toStatus}"]`).boundingBox();
      const from = await page.evaluate(() => performance.now());
      const waitGantt = page.waitForResponse((resp) => resp.url().includes("/gantt"), { timeout: 30000 });
      await page.mouse.move(box.x + 30, box.y + 10);
      await page.mouse.down();
      const tx = col.x + col.width / 2;
      const ty = Math.min(col.y + 60, 880);
      for (let s = 1; s <= 8; s += 1) await page.mouse.move(box.x + 30 + ((tx - box.x - 30) * s) / 8, box.y + 10 + ((ty - box.y - 10) * s) / 8);
      const done = until(page, inColumn, { key, status: toStatus });
      await page.mouse.up();
      const t = await done;
      const t0 = await page.evaluate(() => window.__last.pointerup);
      drag[bucket].push(Math.round(t - t0));
      await waitGantt;
      await settle(page, 600);
      drag.event_max.push((await events(page, from)).max);
    }
  }
  inter.drag = { to_ms: stats(drag.to), back_ms: stats(drag.back), event_max_ms: stats(drag.event_max) };

  // search filter on («Нагрузка 99» → few cards) and off (all cards again); includes the 250 ms debounce
  const search = page.getByRole("searchbox").first();
  const filt = { on: [], off: [], on_lt_max: [], off_lt_max: [] };
  for (let r = 0; r < 3; r += 1) {
    let from = await page.evaluate(() => performance.now());
    await search.fill("Нагрузка 99");
    let t0 = await page.evaluate(() => window.__last.input);
    let t = await until(page, () => document.querySelectorAll(".board-card").length > 0 && document.querySelectorAll(".board-card").length < 50);
    filt.on.push(Math.round(t - t0));
    await settle(page, 400);
    filt.on_lt_max.push((await longTasks(page, from)).max);
    const total = await page.evaluate(() => document.querySelectorAll(".board-card").length);
    filt.shown = total;
    from = await page.evaluate(() => performance.now());
    await search.fill("");
    t0 = await page.evaluate(() => window.__last.input);
    t = await until(page, () => document.querySelectorAll(".board-card").length >= 50);
    filt.off.push(Math.round(t - t0));
    await settle(page, 400);
    filt.off_lt_max.push((await longTasks(page, from)).max);
  }
  inter.search_filter = { on_ms: stats(filt.on), off_ms: stats(filt.off), on_long_task_max_ms: stats(filt.on_lt_max), off_long_task_max_ms: stats(filt.off_lt_max), shown_on: filt.shown };

  // scroll to the very bottom of the board (whatever element scrolls), in 10 steps
  {
    const from = await page.evaluate(() => performance.now());
    const res = await page.evaluate(async () => {
      const board = document.querySelector(".board");
      let el = board;
      while (el && el !== document.body) {
        const s = getComputedStyle(el);
        if (/(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1) break;
        el = el.parentElement;
      }
      const scroller = !el || el === document.body ? document.scrollingElement : el;
      const t0 = performance.now();
      for (let i = 1; i <= 10; i += 1) {
        scroller.scrollTop = (scroller.scrollHeight * i) / 10;
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      }
      return { scroller: scroller.className || scroller.tagName, ms: Math.round(performance.now() - t0), height: scroller.scrollHeight };
    });
    await settle(page, 800);
    const l = await longTasks(page, from);
    const d = await dom(page);
    inter.scroll_to_bottom = { ...res, long_tasks: l, cards_in_dom_after: d.cards, dom_nodes_after: d.nodes };
  }
  result.board.interactions = inter;

  // other views (unchanged code; first row time for comparison with the audit)
  for (const [view, sel] of [["list", ".task-row"], ["gantt", ".gantt-bar__body"]]) {
    const times = [];
    for (let i = 0; i < 3; i += 1) {
      const p = await context.newPage();
      await p.addInitScript((s) => (window.__sel = s), sel);
      await p.goto(`${base}/projects/${PROJECT}?view=${view}`);
      await p.locator(sel).first().waitFor({ timeout: 60000 });
      await settle(p, 800);
      times.push(Math.round(await p.evaluate(() => window.__firstCard)));
      if (i === 2) result.views[view] = { first_row_ms: stats(times), long_tasks: await longTasks(p), dom_nodes: (await dom(p)).nodes };
      await p.close();
    }
  }
  result.console_errors = consoleErrors.slice(0, 10);
  result.loadavg_end = os.loadavg();
  await browser.close();
  writeFileSync(out, JSON.stringify(result, null, 1));
  console.log(JSON.stringify({ label, first: result.board.first_card_ms, lt: result.board.long_tasks.max_ms, nodes: result.board.dom_nodes, cards: result.board.cards_in_dom }, null, 0));
  console.log(JSON.stringify(inter, (k, v) => (k === "values" ? undefined : v)));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
