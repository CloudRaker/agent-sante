// Screenshots of a voice message: recording, the audio bubble while it transcribes, and the
// transcript that took its place. Phone and desktop, light and dark.
// Needs a local dev server with FAKE_UPSTREAMS=1 (the fake transcriber waits about 1.8 s).
// The page gets a synthetic microphone (a tone with a speech-like loudness, from Web Audio),
// because headless Chromium 156 never answers getUserMedia, also with the fake-device flags.
// No real audio is used. Usage:
//   node scripts/voice-shots.mjs [http://localhost:5173]
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

/** Runs in the page before the app: getUserMedia returns the synthetic microphone. */
function fakeMicrophone() {
  navigator.mediaDevices.getUserMedia = async () => {
    const ctx = new AudioContext();
    await ctx.resume();
    const tone = ctx.createOscillator();
    tone.frequency.value = 180;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const sink = ctx.createMediaStreamDestination();
    tone.connect(gain).connect(sink);
    tone.start();
    // Syllables: loud and soft parts, with short pauses, like speech.
    let t = 0;
    setInterval(() => {
      t++;
      const pause = t % 17 < 3;
      gain.gain.setTargetAtTime(pause ? 0.01 : 0.15 + 0.85 * Math.abs(Math.sin(t * 0.9) * Math.sin(t * 0.37)), ctx.currentTime, 0.03);
    }, 90);
    return sink.stream;
  };
}

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
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
    await page.addInitScript(fakeMicrophone);
    page.on("pageerror", (e) => console.error("pageerror", e.message));
    const shot = async (name, settle = 500) => {
      await page.waitForTimeout(settle);
      await page.screenshot({ path: `${out}${name}-${tag}.png` });
      console.log(`${name}-${tag}.png`);
    };
    await page.goto(base, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /^Continuer/ }).click();
    await page.getByRole("button", { name: /^Continuer/ }).click();
    await page.getByRole("checkbox").nth(0).click();
    await page.getByRole("checkbox").nth(1).click();
    await page
      .waitForFunction(() => document.querySelector('[name="cf-turnstile-response"]')?.value, null, { timeout: 20000 })
      .catch(() => {});
    await page.getByRole("button", { name: /Commencer la conversation/ }).click();
    await page.getByRole("textbox").waitFor();
    await page.getByRole("button", { name: "Enregistrer un message vocal" }).click();
    await page.getByRole("button", { name: "Envoyer le message vocal" }).waitFor();
    // Let the time and the live bars move.
    await page.waitForTimeout(4200);
    // Drop the keyboard focus ring of Send (focus moved there on start), so the shot shows the bar at rest.
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    await shot("voice-recording", 100);
    await page.getByRole("button", { name: "Envoyer le message vocal" }).click();
    await page.getByText("Transcription…").waitFor();
    await shot("voice-transcribing", 400);
    // The transcript replaces the bubble and goes to the agent like typed text.
    await page.getByText(/Où me faire vacciner contre la grippe près de chez moi/).waitFor({ timeout: 10000 });
    await shot("voice-transcript", 600);
    await ctx.close();
  }
}
await browser.close();
