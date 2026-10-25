// Translation of verified official quotes in the other language (worker/translate.ts).
// The translator only gets the verified official text, the translation never reaches the
// medical-advice check, a failure shows the original with a note, and translations are cached.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizeSourceUrl, normalizeText, type KbIndex, type KbLang } from "../shared/kb";
import { createKbStore, type KbStore } from "../worker/citations";
import {
  cleanTranslation,
  createTranslationCache,
  systemPrompt,
  translateCitations,
  TRANSLATION_MODEL,
  workersAiTranslator,
  type Translator,
} from "../worker/translate";
import { readSseFrames, type Activity, type ChatResult } from "../shared/activity";
import type { ChatResponse } from "../shared/api";
import type { DecisionModel } from "../worker/safety/milliseconds";
import { makeApp, mid, ORIGIN, scriptedModel, scriptedRun, session } from "./helpers";

const FR_SRC = "https://sante.quebec/conseils-sante/fievre-0-11-ans/";
const EN_SRC = "https://www.quebec.ca/en/health/finding-a-resource/info-sante-811";
const FR_DOC = `# Fièvre 0-11 ans

Pour les enfants de 5 ans et moins, il est recommandé de prendre la température par voie rectale (anus).

En cas de doute, appelez Info-Santé 811 avant de vous rendre à l’urgence. Une infirmière évaluera votre situation.`;
const EN_DOC = `# Info-Santé 811

A phone line reserved for the parents of children aged from 0 to 17 years is currently available through 811 (option 1).`;
const FR_QUOTE = "En cas de doute, appelez Info-Santé 811 avant de vous rendre à l’urgence. Une infirmière évaluera votre situation.";
const EN_QUOTE = "A phone line reserved for the parents of children aged from 0 to 17 years is currently available through 811 (option 1).";
const EN_OF_FR = "When in doubt, call Info-Santé 811 before you go to the emergency room. A nurse will assess your situation.";

/** In-memory knowledge assets with the language of each file, as scripts/sync-kb.mjs writes them. */
function memoryKb(docs: { url: string; body: string; lang: KbLang }[]): KbStore {
  const files: Record<string, string> = {};
  const index: KbIndex = { version: 1, urls: {}, langs: {} };
  for (const d of docs) {
    const norm = normalizeText(d.body);
    const name = `${createHash("sha256").update(norm).digest("hex").slice(0, 20)}.txt`;
    files[name] = norm;
    index.urls[normalizeSourceUrl(d.url)!] = { files: [name], retrieved: "2026-10-23" };
    index.langs![name] = d.lang;
  }
  return createKbStore(async (path) => {
    if (path === "index.json") return JSON.stringify(index);
    const t = files[path];
    if (t === undefined) throw new Error("404");
    return t;
  });
}

const kb = memoryKb([
  { url: FR_SRC, body: FR_DOC, lang: "fr" },
  { url: EN_SRC, body: EN_DOC, lang: "en" },
]);

/** A translator fake that records every input. */
function fakeTranslator(fn: (text: string, from: KbLang, to: KbLang) => Promise<string> | string = () => EN_OF_FR) {
  const inputs: { text: string; from: KbLang; to: KbLang }[] = [];
  const translator: Translator = {
    model: "test-model",
    async translate(text, from, to) {
      inputs.push({ text, from, to });
      return fn(text, from, to);
    },
  };
  return { translator, inputs };
}

const cite = (text: string, src: string) => `<citation src="${src}">${text}</citation>`;
const enReply = (quote = FR_QUOTE, src = FR_SRC) =>
  `I can't assess your child's condition. Here is what the official page says (in French):\n\n${cite(quote, src)}\n\nCall Info-Santé 811, option 1.`;

describe("translation in the pipeline", () => {
  it("English conversation, verified French quote: translated card, the check and the translator see only what they must", async () => {
    const { run } = scriptedRun(() => ({ text: enReply() }));
    const { model, checked } = scriptedModel({ advice: (t) => (/urgence|emergency room/i.test(t) ? 0.95 : 0.02) });
    const { translator, inputs } = fakeTranslator();
    const { post, logs } = makeApp(run, model, { kb, translator, translationCache: createTranslationCache() });
    const { say } = await session(post, "en");
    const res = await say("My child has a fever, where should I go?");
    expect(res.status).toBe(200);
    if (res.json.ended) throw new Error("ended");
    expect(res.json.reply.citations).toEqual([
      { src: FR_SRC, text: FR_QUOTE, verified: true, retrieved: "2026-10-23", lang: "fr", translation: { text: EN_OF_FR, lang: "en" } },
    ]);
    // The translator got the verified official text only, nothing of the agent's own words.
    expect(inputs).toEqual([{ text: FR_QUOTE, from: "fr", to: "en" }]);
    // The check saw the placeholder, not the quote and not its translation.
    expect(checked).toHaveLength(1);
    expect(checked[0]).toContain("[official quote]");
    expect(checked[0]).not.toContain("urgence");
    expect(checked[0]).not.toContain("emergency room");
    // Later agents read the original quote.
    expect(res.json.transcript.at(-1)?.text).toContain(cite(FR_QUOTE, FR_SRC));
    expect(res.json.transcript.at(-1)?.text).not.toContain(EN_OF_FR);
    expect(logs).toContainEqual(expect.objectContaining({ event: "translation_done", to: "en" }));
    expect(JSON.stringify(logs)).not.toContain("urgence");
    expect(JSON.stringify(logs)).not.toContain("emergency room");
  });

  it("French conversation, verified English quote: translated into French", async () => {
    const reply = `Voici ce que dit la page officielle (en anglais) :\n\n${cite(EN_QUOTE, EN_SRC)}\n\nAppelez Info-Santé 811.`;
    const { run } = scriptedRun(() => ({ text: reply }));
    const { model } = scriptedModel({ advice: () => 0.02 });
    const { translator, inputs } = fakeTranslator(
      () => "Une ligne téléphonique réservée aux parents d'enfants de 0 à 17 ans est offerte au 811 (option 1).",
    );
    const { post } = makeApp(run, model, { kb, translator, translationCache: createTranslationCache() });
    const { say } = await session(post, "fr");
    const res = await say("Mon enfant fait de la fièvre, où aller?");
    if (res.json.ended) throw new Error("ended");
    expect(inputs).toEqual([{ text: EN_QUOTE, from: "en", to: "fr" }]);
    expect(res.json.reply.citations?.[0]).toMatchObject({ lang: "en", translation: { lang: "fr" } });
  });

  it("a quote in the conversation language is not translated", async () => {
    const reply = `Voici l'information officielle :\n\n${cite(FR_QUOTE, FR_SRC)}`;
    const { run } = scriptedRun(() => ({ text: reply }));
    const { model } = scriptedModel({ advice: () => 0.02 });
    const { translator, inputs } = fakeTranslator();
    const { post } = makeApp(run, model, { kb, translator, translationCache: createTranslationCache() });
    const { say } = await session(post, "fr");
    const res = await say("Où aller?");
    if (res.json.ended) throw new Error("ended");
    expect(inputs).toEqual([]);
    expect(res.json.reply.citations?.[0]).toEqual({ src: FR_SRC, text: FR_QUOTE, verified: true, retrieved: "2026-10-23", lang: "fr" });
  });

  it("translation failure: the original shows alone, marked untranslated, and the reply still passes", async () => {
    const { run } = scriptedRun(() => ({ text: enReply() }));
    const { model, checked } = scriptedModel({ advice: () => 0.02 });
    const { translator } = fakeTranslator(() => Promise.reject(new Error("AiError")));
    const { post, logs } = makeApp(run, model, { kb, translator, translationCache: createTranslationCache() });
    const { say } = await session(post, "en");
    const res = await say("My child has a fever, where should I go?");
    if (res.json.ended) throw new Error("ended");
    expect(res.json.reply.citations).toEqual([
      { src: FR_SRC, text: FR_QUOTE, verified: true, retrieved: "2026-10-23", lang: "fr", untranslated: true },
    ]);
    expect(checked[0]).toContain("[official quote]");
    expect(logs).toContainEqual(expect.objectContaining({ event: "translation_failed", from: "fr", to: "en" }));
  });

  it("translation timeout: the reply does not wait past the budget", async () => {
    const { run } = scriptedRun(() => ({ text: enReply() }));
    const { model } = scriptedModel({ advice: () => 0.02 });
    const { translator } = fakeTranslator(() => new Promise<string>(() => {}));
    const { post, logs } = makeApp(run, model, { kb, translator, translationCache: createTranslationCache(), translationBudgetMs: 50 });
    const { say } = await session(post, "en");
    const started = Date.now();
    const res = await say("My child has a fever, where should I go?");
    if (res.json.ended) throw new Error("ended");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(res.json.reply.citations?.[0]).toMatchObject({ lang: "fr", untranslated: true });
    expect(res.json.reply.citations?.[0]).not.toHaveProperty("translation");
    expect(logs).toContainEqual(expect.objectContaining({ event: "translation_failed", reason: "timeout" }));
  });

  it("no translator (no AI binding): the original shows with the note", async () => {
    const { run } = scriptedRun(() => ({ text: enReply() }));
    const { model } = scriptedModel({ advice: () => 0.02 });
    const { post } = makeApp(run, model, { kb });
    const { say } = await session(post, "en");
    const res = await say("My child has a fever, where should I go?");
    if (res.json.ended) throw new Error("ended");
    expect(res.json.reply.citations?.[0]).toMatchObject({ lang: "fr", untranslated: true });
  });

  it("an unverified French quote in an English conversation is agent text: checked, never translated", async () => {
    const changed = FR_QUOTE.replace("doute", "fièvre");
    const { run, calls } = scriptedRun((call) =>
      call.kind === "start" ? { text: enReply(changed) } : { text: "Call Info-Santé 811, option 1." },
    );
    const { model, checked } = scriptedModel({ advice: (t) => (t.includes("urgence") ? 0.95 : 0.02) });
    const { translator, inputs } = fakeTranslator();
    const { post } = makeApp(run, model, { kb, translator, translationCache: createTranslationCache() });
    const { say } = await session(post, "en");
    const res = await say("My child has a fever, where should I go?");
    if (res.json.ended) throw new Error("ended");
    expect(checked[0]).toContain(changed);
    expect(calls.map((c) => c.kind)).toEqual(["start", "turn"]); // flagged, rewritten
    expect(inputs).toEqual([]);
    expect(res.json.reply.citations).toBeUndefined();
  });

  it("a French quote with dosing text verifies with the dose flag, and is never translated", async () => {
    const dosed = memoryKb([{ url: FR_SRC, body: `${FR_DOC}\n\nDonner 1 à 2 comprimés toutes les 4 à 6 heures, au besoin.`, lang: "fr" }]);
    const quote = "Donner 1 à 2 comprimés toutes les 4 à 6 heures, au besoin.";
    const { run } = scriptedRun((call) =>
      call.kind === "start" ? { text: enReply(quote) } : { text: "Ask a pharmacist or call Info-Santé 811." },
    );
    const { model, checked } = scriptedModel({ advice: (t) => (t.includes("comprimés") ? 0.95 : 0.02) });
    const { translator, inputs } = fakeTranslator();
    const { post, logs } = makeApp(run, model, { kb: dosed, translator, translationCache: createTranslationCache() });
    const { say } = await session(post, "en");
    const res = await say("How much can I give my child?");
    if (res.json.ended) throw new Error("ended");
    // Official text, word for word: the check sees the placeholder, the card shows the pharmacist notice.
    expect(checked[0]).not.toContain(quote);
    expect(inputs).toEqual([]);
    expect(res.json.reply.citations?.[0]).toMatchObject({ text: quote, dose: true, untranslated: true });
    expect(logs).not.toContainEqual(expect.objectContaining({ event: "citation_unverified" }));
  });

  it("the second reply with the same quote is a cache hit: one translator call", async () => {
    const { run } = scriptedRun(() => ({ text: enReply() }));
    const { model } = scriptedModel({ advice: () => 0.02 });
    const { translator, inputs } = fakeTranslator();
    const { post, logs } = makeApp(run, model, { kb, translator, translationCache: createTranslationCache() });
    const { say } = await session(post, "en");
    const first = await say("My child has a fever, where should I go?");
    const second = await say("And at night?");
    if (first.json.ended || second.json.ended) throw new Error("ended");
    expect(inputs).toHaveLength(1);
    expect(second.json.reply.citations?.[0]?.translation).toEqual({ text: EN_OF_FR, lang: "en" });
    expect(logs).toContainEqual(expect.objectContaining({ event: "translation_cache_hit", to: "en" }));
  });
});

/** Sends one streamed /api/chat turn on a new session and returns the activity steps and the result. */
async function streamTurn(app: ReturnType<typeof makeApp>, lang: "fr" | "en", message: string) {
  const s = await app.post("/api/session", { turnstileToken: "ok", lang });
  const res = await app.app.request("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, accept: "text/event-stream" },
    body: JSON.stringify({ sessionToken: String(s.json.sessionToken), messageId: mid(), message, lang, transcript: [] }),
  });
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const frames: { event: string; data: string }[] = [];
  for await (const f of readSseFrames(res.body!)) frames.push(f);
  const activities = frames.filter((f) => f.event === "activity").map((f) => JSON.parse(f.data) as Activity);
  const result = JSON.parse(frames.find((f) => f.event === "result")!.data) as ChatResult;
  return { frames, activities, result };
}

describe("citations in the streamed /api/chat", () => {
  it("the result event carries the verified and translated citation, after the activity steps", async () => {
    const { run } = scriptedRun(() => ({ text: enReply() }));
    // The check waits until the translation started: the two run at the same time, or the turn fails.
    let translationStarted!: () => void;
    const started = new Promise<void>((r) => (translationStarted = r));
    const base = scriptedModel({ advice: (t) => (/urgence|emergency room/i.test(t) ? 0.95 : 0.02) });
    const model: DecisionModel = {
      ...base.model,
      async yesNoHint(text, ...rest) {
        await Promise.race([started, new Promise((_, reject) => setTimeout(() => reject(new Error("not parallel")), 1000))]);
        return base.model.yesNoHint(text, ...rest);
      },
    };
    const { translator, inputs } = fakeTranslator((text) => {
      translationStarted();
      return text === FR_QUOTE ? EN_OF_FR : "";
    });
    const app = makeApp(run, model, { kb, translator, translationCache: createTranslationCache() });
    const { frames, activities, result } = await streamTurn(app, "en", "My child has a fever, where should I go?");
    expect(frames.at(-1)?.event).toBe("result");
    expect(activities.map((a) => `${a.kind}:${a.state}`)).toContain("safety:done");
    expect(result.status).toBe(200);
    const body = result.body as ChatResponse;
    if (body.ended) throw new Error("ended");
    expect(body.reply.citations).toEqual([
      { src: FR_SRC, text: FR_QUOTE, verified: true, retrieved: "2026-10-23", lang: "fr", translation: { text: EN_OF_FR, lang: "en" } },
    ]);
    expect(inputs).toEqual([{ text: FR_QUOTE, from: "fr", to: "en" }]);
    // The check saw the placeholder only, never the quote or its translation.
    expect(base.checked).toHaveLength(1);
    expect(base.checked[0]).toContain("[official quote]");
    expect(base.checked[0]).not.toContain("urgence");
    expect(base.checked[0]).not.toContain("emergency room");
    // No activity step carries the quote or its translation.
    const steps = JSON.stringify(activities);
    expect(steps).not.toContain("urgence");
    expect(steps).not.toContain("emergency room");
  });

  it("a French conversation gets the English quote translated in the result event", async () => {
    const { run } = scriptedRun(() => ({ text: `Voici ce que dit la page officielle (en anglais) :\n\n${cite(EN_QUOTE, EN_SRC)}` }));
    const { model } = scriptedModel({ advice: () => 0.02 });
    const FR_OF_EN = "Une ligne téléphonique réservée aux parents d’enfants de 0 à 17 ans est offerte au 811 (option 1).";
    const { translator } = fakeTranslator(() => FR_OF_EN);
    const app = makeApp(run, model, { kb, translator, translationCache: createTranslationCache() });
    const { result } = await streamTurn(app, "fr", "Mon enfant fait de la fièvre, où aller ?");
    const body = result.body as ChatResponse;
    if (body.ended) throw new Error("ended");
    expect(body.reply.citations?.[0]).toMatchObject({
      src: EN_SRC,
      verified: true,
      lang: "en",
      translation: { text: FR_OF_EN, lang: "fr" },
    });
  });
});

/** A Cache API fake keyed by URL. */
function edgeCache() {
  const store = new Map<string, string>();
  const edge = {
    async match(url: string) {
      const t = store.get(url);
      return t === undefined ? undefined : new Response(t);
    },
    async put(url: string, res: Response) {
      store.set(url, await res.text());
    },
  } as unknown as Cache;
  return { edge, store };
}

describe("translation cache", () => {
  it("a new isolate (empty memory) reads the translation from the Cache API", async () => {
    const { edge, store } = edgeCache();
    const { translator, inputs } = fakeTranslator();
    const citation = { src: FR_SRC, text: FR_QUOTE, verified: true as const, lang: "fr" as const };
    await translateCitations([citation], "en", { translator, cache: createTranslationCache(edge) });
    expect(store.size).toBe(1);
    // The key holds the model, the target language and a hash, never the text.
    const [url] = [...store.keys()];
    expect(url).toMatch(/^https:\/\/translations\.agentsante\.invalid\/v1\/test-model\/en\/[0-9a-f]{64}$/);
    const again = await translateCitations([citation], "en", { translator, cache: createTranslationCache(edge) });
    expect(inputs).toHaveLength(1);
    expect(again[0]?.translation).toEqual({ text: EN_OF_FR, lang: "en" });
  });

  it("another target language or another model is another key", async () => {
    const { edge, store } = edgeCache();
    const cache = createTranslationCache(edge);
    const a = fakeTranslator();
    const b = { ...fakeTranslator(), translator: { ...fakeTranslator().translator, model: "other-model" } };
    const citation = { src: FR_SRC, text: FR_QUOTE, verified: true as const, lang: "fr" as const };
    await translateCitations([citation], "en", { translator: a.translator, cache });
    await translateCitations([citation], "en", { translator: b.translator, cache });
    expect(store.size).toBe(2);
  });
});

describe("translator output", () => {
  it("keeps a clean translation and refuses empty, markup, preambles and wrong lengths", () => {
    expect(cleanTranslation(FR_QUOTE, `  "${EN_OF_FR}"  `)).toBe(EN_OF_FR);
    expect(cleanTranslation(FR_QUOTE, "")).toBeNull();
    expect(cleanTranslation(FR_QUOTE, `<citation src="x">${EN_OF_FR}</citation>`)).toBeNull();
    expect(cleanTranslation(FR_QUOTE, `Here is the translation: ${EN_OF_FR}`)).toBeNull();
    expect(cleanTranslation(FR_QUOTE, "Call 811.")).toBeNull();
    expect(cleanTranslation(FR_QUOTE, EN_OF_FR.repeat(4))).toBeNull();
    expect(cleanTranslation(FR_QUOTE, `${EN_OF_FR} Take 2 tablets.`)).toBeNull();
  });

  it("a translation that adds dosing text is refused: the original shows alone", async () => {
    const { translator } = fakeTranslator(() => "When in doubt, give one tablet every 6 hours and call Info-Santé 811 before the ER.");
    const citation = { src: FR_SRC, text: FR_QUOTE, verified: true as const, lang: "fr" as const };
    const [out] = await translateCitations([citation], "en", { translator, cache: createTranslationCache() });
    expect(out).toMatchObject({ untranslated: true });
    expect(out).not.toHaveProperty("translation");
  });

  it("a translation the output check refuses counts as a failure", async () => {
    const { translator } = fakeTranslator(() => "Sure! Take two pills.");
    const citation = { src: FR_SRC, text: FR_QUOTE, verified: true as const, lang: "fr" as const };
    const [out] = await translateCitations([citation], "en", { translator, cache: createTranslationCache() });
    expect(out).toMatchObject({ untranslated: true });
    expect(out).not.toHaveProperty("translation");
  });

  it("the Workers AI translator sends a strict system prompt and the text alone as the user message", async () => {
    const calls: { model: string; input: Record<string, unknown> }[] = [];
    const ai = {
      async run(model: string, input: Record<string, unknown>) {
        calls.push({ model, input });
        return { response: EN_OF_FR, usage: { prompt_tokens: 210, completion_tokens: 60, total_tokens: 270 } };
      },
    };
    const out = await workersAiTranslator(ai).translate(FR_QUOTE, "fr", "en", new AbortController().signal);
    expect(out).toEqual({ text: EN_OF_FR, usage: { input: 210, output: 60, estimated: false } });
    expect(calls[0]?.model).toBe(TRANSLATION_MODEL);
    expect(calls[0]?.input).toMatchObject({
      messages: [
        { role: "system", content: systemPrompt("fr", "en") },
        { role: "user", content: FR_QUOTE },
      ],
      temperature: 0,
    });
    expect(systemPrompt("fr", "en")).toContain("Output only the English translation");
    expect(systemPrompt("en", "fr")).toContain("from English to French");
  });

  it("a Workers AI answer with no usage field gives an estimated token count", async () => {
    const ai = { run: async () => ({ response: EN_OF_FR }) };
    const out = await workersAiTranslator(ai).translate(FR_QUOTE, "fr", "en", new AbortController().signal);
    expect(out).toMatchObject({ text: EN_OF_FR, usage: { estimated: true } });
    expect(typeof out === "object" && out.usage.output).toBe(Math.ceil(EN_OF_FR.length / 4));
  });

  it("an unexpected Workers AI answer shape is an error", async () => {
    const ai = { run: async () => ({ result: 1 }) };
    await expect(workersAiTranslator(ai).translate(FR_QUOTE, "fr", "en", new AbortController().signal)).rejects.toThrow(
      "translation_shape",
    );
  });
});
