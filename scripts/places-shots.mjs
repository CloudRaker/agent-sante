// Screenshots of the places card (map and compact list), phone and desktop, light and dark.
// Needs a local dev server with FAKE_UPSTREAMS=1 and TOOLS_SECRET in .dev.vars. Usage:
//   node scripts/places-shots.mjs [http://localhost:5173]
// MapKit JS accepts a token only on its origin. The script serves the local app under
// https://www.agentsante.ca inside the browser (Playwright routing; nothing leaves the machine
// except the MapKit and map tile requests), and gives the page the public *.agentsante.ca token.
import { mkdirSync, readFileSync } from "node:fs";
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://localhost:5173";
const out = new URL("../screenshots/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const token = /"MAPKIT_JS_TOKEN":\s*"([^"]+)"/.exec(wrangler)?.[1];
const ORIGIN = "https://www.agentsante.ca";

const browser = await chromium.launch();
for (const vp of [
  { name: "390", width: 390, height: 844, mobile: true },
  { name: "1280", width: 1280, height: 800, mobile: false },
]) {
  for (const scheme of ["light", "dark"]) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
      isMobile: vp.mobile,
      hasTouch: vp.mobile,
      colorScheme: scheme,
      locale: "fr-CA",
    });
    await ctx.route(`${ORIGIN}/**`, async (route) => {
      const req = route.request();
      const url = req.url().replace(ORIGIN, base);
      const headers = { ...req.headers(), origin: base, host: new URL(base).host };
      if (new URL(url).pathname === "/api/config") {
        const res = await route.fetch({ url, headers });
        const body = await res.json();
        return route.fulfill({ response: res, json: { ...body, mapkitToken: token } });
      }
      return route.fulfill({ response: await route.fetch({ url, headers }) });
    });
    const page = await ctx.newPage();
    await page.goto(ORIGIN, { waitUntil: "networkidle" });
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
    await page.getByRole("textbox").fill("Je cherche une pharmacie près de H2X 1Y4");
    await page.keyboard.press("Enter");
    await page.getByRole("heading", { name: /Établissements près de/ }).waitFor({ timeout: 30000 });
    await page.getByRole("heading", { name: /Établissements près de/ }).scrollIntoViewIfNeeded();
    await page.waitForTimeout(2500);
    if (process.env.WIDTH_DEBUG) {
      const wide = await page.evaluate(() => {
        const w = document.documentElement.clientWidth;
        return [...document.querySelectorAll("body *")]
          .filter((el) => el.getBoundingClientRect().right > w + 1 || el.matches("[data-chat-scroller], [data-chat-scroller] li[data-rich], [data-chat-scroller] li[data-rich] *:has(> [class*=attachments])"))
          .slice(0, 30)
          .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 50)} x${Math.round(el.getBoundingClientRect().left)} w${Math.round(el.getBoundingClientRect().width)} sw${el.scrollWidth}`);
      });
      console.log(vp.name, scheme, wide.join("\n"));
    }
    const card = page.locator("section", { has: page.getByRole("heading", { name: /Établissements près de/ }) });
    await card.screenshot({ path: `${out}places-${vp.name}-${scheme}.png` });
    await page.screenshot({ path: `${out}places-page-${vp.name}-${scheme}.png` });
    console.log(`places-${vp.name}-${scheme}.png`);
    await ctx.close();
  }
}
await browser.close();
