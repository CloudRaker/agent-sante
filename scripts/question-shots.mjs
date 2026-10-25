// Screenshots of the question card (open, then answered), phone and desktop, light and dark.
// Needs a local dev server with FAKE_UPSTREAMS=1. The fake agent asks "who is it for" on
// "J'ai de la fièvre, où aller ?". Usage:
//   node scripts/question-shots.mjs [http://localhost:5173]
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://localhost:5173";
const out = new URL("../screenshots/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
for (const vp of [
  { name: "390", width: 390, height: 844, mobile: true },
  { name: "1280", width: 1280, height: 800, mobile: false },
]) {
  for (const scheme of ["light", "dark"]) {
    const tag = `${vp.name}-${scheme}`;
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
      isMobile: vp.mobile,
      hasTouch: vp.mobile,
      colorScheme: scheme,
      locale: "fr-CA",
    });
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
    await page.getByRole("textbox").fill("J'ai de la fièvre, où aller ?");
    await page.keyboard.press("Enter");
    const card = page.getByRole("group", { name: /Pour qui/ });
    await card.waitFor({ timeout: 30000 });
    await page.waitForTimeout(1200);
    // The card has the focus (from code, so no ring): the shot shows it as the person sees it.
    const focused = await page.evaluate(() => document.activeElement?.tagName);
    console.log(`focus after the question: ${focused}`);
    await page.screenshot({ path: `${out}question-open-${tag}.png` });
    console.log(`question-open-${tag}.png`);
    await card.getByRole("button", { name: "Pour un enfant" }).click();
    await page.getByText(/La fièvre est fréquente/).waitFor({ timeout: 30000 });
    await page.waitForTimeout(1500);
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${out}question-answered-${tag}.png` });
    console.log(`question-answered-${tag}.png`);
    await ctx.close();
  }
}
await browser.close();
