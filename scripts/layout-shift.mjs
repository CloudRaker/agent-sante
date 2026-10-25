// Measures how the chat moves during a full turn, phone and desktop, and records a video.
// Needs a local dev server with FAKE_UPSTREAMS=1. Usage:
//   node scripts/layout-shift.mjs [http://localhost:5173] [label]   (REDUCED=1: reduced motion, SHIFTS=1: shift sources)
// Per turn it reports:
// - cls: the sum of the layout-shift entries (PerformanceObserver).
// - down: how far (px) the person's own message moved DOWN on screen. While the thread is pinned
//   to the bottom, new content only pushes it up. Any downward travel is a visible bounce.
// - reversals: how often that message changed direction (up, then down, then up).
// - maxJump: the largest move (px) between two animation frames.
// - gap: the largest distance (px) between the bottom of the last row and the bottom of the scroller.
// Videos go to test-results/layout/<label>-<width>.webm.
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://localhost:5173";
const label = process.argv[3] ?? "run";
const out = new URL(`../test-results/layout/`, import.meta.url).pathname;
mkdirSync(out, { recursive: true });

const viewports = [
  { name: "390", width: 390, height: 844, mobile: true },
  { name: "1280", width: 1280, height: 800, mobile: false },
];
const turns = [
  { text: "Où aller si mon enfant fait de la fièvre ?", name: "fever" },
  { text: "Où me faire vacciner contre la grippe ?", name: "handoff" },
  // The agent asks first (question card), then the person clicks a suggested answer.
  { text: "J'ai de la fièvre, où aller ?", name: "question", question: true },
  { choice: "Pour un enfant", name: "answer" },
];

// Runs in the page: one sample per animation frame, plus the layout-shift entries.
const recorder = () => {
  const state = { on: false, frames: [], shifts: [] };
  new PerformanceObserver((list) => {
    if (!state.on) return;
    for (const e of list.getEntries())
      state.shifts.push({
        value: e.value,
        recent: e.hadRecentInput,
        t: e.startTime,
        nodes: (e.sources ?? []).map((x) => {
          const n = x.node;
          const el = n && n.nodeType === 1 ? n : n?.parentElement;
          return el ? `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)} ${Math.round(x.previousRect.y)}->${Math.round(x.currentRect.y)} h${Math.round(x.previousRect.height)}->${Math.round(x.currentRect.height)}` : "?";
        }),
      });
  }).observe({ type: "layout-shift", buffered: false });
  const tick = () => {
    if (!state.on) return;
    const scroller = document.querySelector("[data-chat-scroller]");
    if (scroller) {
      const box = scroller.getBoundingClientRect();
      const mine = [...scroller.querySelectorAll("li[data-mine]")].at(-1);
      const rows = scroller.querySelectorAll("ol > li");
      const last = rows[rows.length - 1];
      state.frames.push({
        t: performance.now(),
        top: scroller.scrollTop,
        anchor: mine ? mine.getBoundingClientRect().top : null,
        // The anchor row: a new own message replaces the old one as anchor. That switch is not a move.
        row: mine ? (mine.getAttribute("data-row-id") ?? "") : null,
        gap: last ? last.getBoundingClientRect().bottom - box.bottom : null,
      });
    }
    requestAnimationFrame(tick);
  };
  window.layoutProbe = {
    start() {
      state.on = true;
      state.frames = [];
      state.shifts = [];
      requestAnimationFrame(tick);
    },
    stop() {
      state.on = false;
      return { frames: state.frames, shifts: state.shifts };
    },
  };
};

const r = (n) => Math.round(n * 10) / 10;

function analyse({ frames, shifts }) {
  let down = 0;
  let up = 0;
  let maxJump = 0;
  let reversals = 0;
  let dir = 0;
  let gap = 0;
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1].anchor;
    const b = frames[i].anchor;
    if (frames[i].gap !== null) gap = Math.max(gap, Math.abs(frames[i].gap));
    if (a === null || b === null || frames[i - 1].row !== frames[i].row) continue;
    const d = b - a;
    if (Math.abs(d) < 0.5) continue;
    if (d > 0) down += d;
    else up -= d;
    maxJump = Math.max(maxJump, Math.abs(d));
    const s = Math.sign(d);
    if (dir && s !== dir) reversals++;
    dir = s;
  }
  const cls = shifts.reduce((n, s) => n + s.value, 0);
  return { cls: Math.round(cls * 10000) / 10000, down: r(down), up: r(up), reversals, maxJump: r(maxJump), gap: r(gap), frames: frames.length };
}

const browser = await chromium.launch();
const results = [];
for (const vp of viewports) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 1,
    isMobile: vp.mobile,
    hasTouch: vp.mobile,
    locale: "fr-CA",
    // REDUCED=1 measures the reduced-motion branch.
    reducedMotion: process.env.REDUCED ? "reduce" : "no-preference",
    recordVideo: { dir: out, size: { width: vp.width, height: vp.height } },
  });
  await ctx.addInitScript(recorder);
  const page = await ctx.newPage();
  await page.goto(base, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /^Continuer/ }).click();
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: /^Continuer/ }).click();
  await page.waitForTimeout(400);
  await page.getByRole("checkbox").nth(0).click();
  await page.getByRole("checkbox").nth(1).click();
  await page
    .waitForFunction(() => document.querySelector('[name="cf-turnstile-response"]')?.value, null, { timeout: 20000 })
    .catch(() => {});
  await page.getByRole("button", { name: /Commencer la conversation/ }).click();
  await page.getByRole("textbox").waitFor();
  for (const turn of turns) {
    const sources = page.getByRole("heading", { name: "Sources officielles", exact: true });
    const before = await sources.count();
    if (turn.choice) {
      await page.evaluate(() => window.layoutProbe.start());
      await page.getByRole("group", { name: /Pour qui/ }).getByRole("button", { name: turn.choice }).click();
    } else {
      await page.getByRole("textbox").fill(turn.text);
      await page.evaluate(() => window.layoutProbe.start());
      await page.keyboard.press("Enter");
    }
    if (turn.question) await page.getByRole("group", { name: /Pour qui/ }).waitFor({ timeout: 30000 });
    else await sources.nth(before).waitFor({ timeout: 30000 });
    await page.waitForTimeout(1500);
    const data = await page.evaluate(() => window.layoutProbe.stop());
    const row = { viewport: vp.name, turn: turn.name, ...analyse(data) };
    if (process.env.SHIFTS) for (const sh of data.shifts) console.log(vp.name, turn.name, Math.round(sh.t), sh.value.toFixed(4), sh.recent, sh.nodes.join(" | "));
    if (process.env.DUMP === `${vp.name}-${turn.name}`) {
      const t0 = data.frames[0]?.t ?? 0;
      for (const f of data.frames) console.log(Math.round(f.t - t0), Math.round(f.top), f.anchor === null ? "-" : Math.round(f.anchor), f.gap === null ? "-" : Math.round(f.gap));
    }
    results.push(row);
  }
  const video = page.video();
  await ctx.close();
  if (video) {
    const path = `${out}${label}-${vp.name}.webm`;
    await video.saveAs(path);
    await video.delete();
  }
}
await browser.close();
for (const row of results) console.log(Object.entries(row).map(([k, v]) => `${k}=${v}`).join("  "));
