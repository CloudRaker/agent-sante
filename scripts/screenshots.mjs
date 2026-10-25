// Screenshots of the gate and the chat, phone and desktop, light and dark.
// Needs a local dev server with FAKE_UPSTREAMS=1 (pnpm dev:fake). Usage:
//   node scripts/screenshots.mjs [http://localhost:5173]
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://localhost:5173";
const out = new URL("../screenshots/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });

const viewports = [
  { name: "390", width: 390, height: 844, mobile: true },
  { name: "1280", width: 1280, height: 800, mobile: false },
];
const only = process.env.ONLY;

const browser = await chromium.launch();
for (const vp of viewports) {
  for (const scheme of ["light", "dark"]) {
    const tag = `${vp.name}-${scheme}`;
    if (only && !tag.includes(only)) continue;
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
      isMobile: vp.mobile,
      hasTouch: vp.mobile,
      colorScheme: scheme,
      locale: "fr-CA",
    });
    const page = await ctx.newPage();
    const shot = async (name, fullPage = false, settle = 700) => {
      await page.waitForTimeout(settle);
      await page.screenshot({ path: `${out}${name}-${tag}.png`, fullPage });
      console.log(`${name}-${tag}.png`);
    };
    // The site pages first (full page), then the gate and chat flow.
    for (const [name, path] of [
      ["call811", "/appeler-le-811"],
      ["transparency", "/transparence"],
      ["press", "/presse"],
    ]) {
      await page.goto(`${base}${path}`, { waitUntil: "networkidle" });
      // Scroll once so the counters that roll in view settle before the full-page shot.
      // Step through the page: a jump to the bottom can skip the in-view trigger of a counter.
      await page.evaluate(async () => {
        for (let y = 0; y < document.body.scrollHeight; y += window.innerHeight / 2) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 250));
        }
      });
      await page.waitForTimeout(1800);
      await page.evaluate(() => window.scrollTo(0, 0));
      await shot(name, true);
    }
    await page.goto(base, { waitUntil: "networkidle" });
    await page.getByText("En ce moment au Québec").scrollIntoViewIfNeeded();
    await shot("home-live");
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.getByRole("button", { name: "Options d'affichage" }).click();
    await shot("display-menu");
    await page.getByRole("switch", { name: "Grand texte" }).click();
    await page.keyboard.press("Escape");
    // Escape gives the trigger keyboard focus; drop it so the shot shows the page at rest.
    await page.waitForTimeout(400);
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    await shot("home-large-text");
    await page.evaluate(() => localStorage.removeItem("agent-sante.large-text"));
    await page.goto(base, { waitUntil: "networkidle" });
    await shot("gate-1");
    await page.getByRole("button", { name: /^Continuer/ }).click();
    await shot("gate-2");
    await page.getByRole("button", { name: /^Continuer/ }).click();
    await page.getByRole("checkbox").nth(0).click();
    await page.getByRole("checkbox").nth(1).click();
    await page
      .waitForFunction(() => document.querySelector('[name="cf-turnstile-response"]')?.value, null, { timeout: 20000 })
      .catch(() => {});
    await shot("gate-3");
    await page.getByRole("button", { name: /Commencer la conversation/ }).click();
    await page.getByRole("textbox").waitFor();
    await shot("chat-empty");
    await page.getByRole("button", { name: /fièvre/ }).click();
    await page.keyboard.press("Enter");
    // The live steps: wait for the first work row of the fake agent (a knowledge search).
    await page
      .getByText(/Recherche dans les sources officielles/)
      .first()
      .waitFor({ timeout: 15000 });
    await shot("chat-typing", false, 450);
    await page.getByRole("heading", { name: "Sources officielles", exact: true }).first().waitFor({ timeout: 15000 });
    await shot("chat-reply");
    await page
      .getByRole("button", { name: /étapes ·/ })
      .first()
      .click();
    await page
      .getByRole("button", { name: /étapes ·/ })
      .first()
      .scrollIntoViewIfNeeded();
    await shot("chat-activity");
    await page.getByRole("button", { name: /Terminer la conversation/ }).waitFor();
    await page.getByRole("textbox").fill("Je m'appelle Josée Tremblay, mon numéro est 514-555-0199");
    await page.keyboard.press("Enter");
    await page.getByText(/Retirez vos renseignements personnels/).waitFor();
    await shot("chat-pii");
    await page.getByRole("textbox").fill("demo-trois");
    await page.keyboard.press("Enter");
    await page.getByText(/Nous ne pouvons pas poursuivre/).waitFor({ timeout: 20000 });
    await shot("chat-ended");
    await ctx.close();
  }
}
await browser.close();
