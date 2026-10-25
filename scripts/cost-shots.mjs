// Screenshots of the home numbers strip and of the costs and usage page, phone (390) and desktop
// (1280), light and dark. Needs a local dev server with FAKE_UPSTREAMS=1 and a few fake
// conversations (run scripts/smoke.mjs first, so the numbers are not empty). Usage:
//   node scripts/cost-shots.mjs [http://localhost:5173]
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://localhost:5173";
const out = new URL("../screenshots/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });

const shots = [
  { name: "home-strip", path: { fr: "/", en: "/en" }, target: "section[aria-labelledby='home-stats-title']" },
  { name: "costs-page", path: { fr: "/couts", en: "/en/costs" }, target: null },
];

const browser = await chromium.launch();
for (const vp of [
  { name: "390", width: 390, height: 844, mobile: true },
  { name: "1280", width: 1280, height: 800, mobile: false },
]) {
  for (const scheme of ["light", "dark"]) {
    for (const lang of ["fr", "en"]) {
      if (lang === "en" && scheme === "dark") continue;
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 2,
        isMobile: vp.mobile,
        hasTouch: vp.mobile,
        colorScheme: scheme,
        reducedMotion: "reduce",
        locale: lang === "fr" ? "fr-CA" : "en-CA",
      });
      for (const shot of shots) {
        const page = await ctx.newPage();
        await page.goto(`${base}${shot.path[lang]}`, { waitUntil: "networkidle" });
        const name = `${shot.name}-${lang}-${vp.name}-${scheme}.png`;
        if (shot.target) {
          const el = page.locator(shot.target);
          await el.waitFor();
          await el.scrollIntoViewIfNeeded();
          await page.waitForTimeout(600);
          await el.screenshot({ path: `${out}${name}` });
        } else {
          await page.locator("h2#usage-title").waitFor();
          await page.waitForTimeout(800);
          await page.screenshot({ path: `${out}${name}`, fullPage: true });
        }
        console.log(name);
        await page.close();
      }
      await ctx.close();
    }
  }
}
await browser.close();
