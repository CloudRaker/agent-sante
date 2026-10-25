// milliseconds client and checks: thresholds and fail-closed behaviour.
import { describe, expect, it } from "vitest";
import { MED_HINT, MED_THRESHOLD, PII_THRESHOLD, PII_TYPES, keepPiiSpan, regexPii } from "../worker/safety/checks";
import { Milliseconds, SafetyUnavailable, hasAdvice, piiCheck, type CallMeta } from "../worker/safety/milliseconds";
import { makeApp, scriptedModel, scriptedRun, session } from "./helpers";

const CLEAN = "Consultez [Québec.ca](https://www.quebec.ca/sante).";

function client(responses: (() => Promise<Response>)[], timeoutMs = 3000) {
  const metas: CallMeta[] = [];
  let i = 0;
  const fetcher = (async (_url: string, init: RequestInit) => {
    const next = responses[Math.min(i++, responses.length - 1)]!;
    return await new Promise<Response>((resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      next().then(resolve, reject);
    });
  }) as unknown as typeof fetch;
  return { ms: new Milliseconds("k", "https://ms.test", fetcher, (m) => metas.push(m), timeoutMs), metas, calls: () => i };
}

const at = (p: number) => hasAdvice({ entities: async () => [], yesNoHint: async () => p }, "r");
const never = () => new Promise<Response>(() => {});

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => async () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("final definitions", () => {
  it("uses the thresholds and the hint pair", () => {
    expect(PII_THRESHOLD).toBe(0.7);
    expect(MED_THRESHOLD).toBe(0.5);
    expect(MED_HINT.statement).toBe("The reply gives the reader personal medical advice.");
    expect(MED_HINT.when_true).toMatch(/^The reply gives the reader personal medical advice: a diagnosis/);
    expect(MED_HINT.when_false).toMatch(/leaves the decision to that service\.$/);
    expect(PII_TYPES.person_name).toContain("pharmacy chain, store");
  });

  it("applies the regex and keepPiiSpan rules of the final checks.mjs", () => {
    expect(regexPii("mon numéro de dossier c'est le 4417 2290")).toContain("file_number");
    expect(regexPii("j'ai ce problème depuis 2019")).toEqual([]);
    const text = "Je suis allée au Jean Coutu, puis au 2250, avenue du Mont-Royal Est.";
    const coutu = text.indexOf("Jean Coutu");
    expect(keepPiiSpan({ type: "person_name", text: "Jean Coutu", probability: 0.9, start: coutu, end: coutu + 10 }, text)).toBe(false);
    const street = text.indexOf("avenue");
    expect(keepPiiSpan({ type: "street_address", text: "avenue du Mont-Royal Est", probability: 0.9, start: street, end: street + 24 }, text)).toBe(true);
    const ph = "pharmacie Marie Dubois";
    expect(keepPiiSpan({ type: "person_name", text: "Marie Dubois", probability: 0.9, start: 10, end: 22 }, ph)).toBe(false);
  });

  it("check B flags at 0.5 and above", async () => {
    expect((await at(0.5)).flagged).toBe(true);
    expect((await at(0.499)).flagged).toBe(false);
  });

  it("check A reports scores and span types, never text", async () => {
    // A name that is not in a self-introduction shape goes to the model layer.
    const text = "Ma fille Josée habite à H2X.";
    const r = await piiCheck(
      {
        entities: async () => [
          { type: "person_name", text: "Josée", probability: 0.97, start: 9, end: 14 },
          { type: "postal_code", text: "H2X", probability: 0.9, start: 24, end: 27 },
        ],
        yesNoHint: async () => 0,
      },
      text,
    );
    expect(r).toMatchObject({ kinds: ["person_name"], layer: "model", score: 0.97, kept: ["person_name"], dropped: ["postal_code"] });
    expect(JSON.stringify(r)).not.toContain("Josée");
  });

  it("check A blocks a self-introduction with a lowercase name before the model call", async () => {
    let calls = 0;
    const model = { entities: async () => (calls++, []), yesNoHint: async () => 0 };
    const r = await piiCheck(model, "salut moi c'est baptiste, je pense que j'ai la grippe");
    expect(r).toMatchObject({ kinds: ["person_name"], layer: "regex" });
    expect(calls).toBe(0);
    expect((await piiCheck(model, "moi c'est la fièvre qui m'inquiète")).kinds).toEqual([]);
  });
});

describe("milliseconds client", () => {
  it("logs headers metadata of each call", async () => {
    const { ms, metas } = client([json(200, { probability: 0.12 }, { "x-input-tokens": "380", "x-inference-ms": "44" })]);
    expect(await ms.yesNoHint("t", MED_HINT)).toBe(0.12);
    expect(metas[0]).toMatchObject({ path: "yes-no", status: 200, inputTokens: 380, inferenceMs: 44 });
  });

  it("fails closed on a timeout, after one retry", async () => {
    const { ms, calls } = client([never], 20);
    await expect(ms.entities("t", PII_TYPES)).rejects.toMatchObject({ code: "timeout" });
    expect(calls()).toBe(2);
  });

  it("retries once on 529, then fails closed", async () => {
    const { ms, calls } = client([json(529, {}), json(529, { error: { code: "overloaded" } })]);
    await expect(ms.yesNoHint("t", MED_HINT)).rejects.toBeInstanceOf(SafetyUnavailable);
    expect(calls()).toBe(2);
  });

  it("does not wait for a 429 with retry-after over 2 seconds", async () => {
    const { ms, calls } = client([json(429, { error: { code: "rate_limit_exceeded" } }, { "retry-after": "5" })]);
    await expect(ms.entities("t", PII_TYPES)).rejects.toMatchObject({ status: 429 });
    expect(calls()).toBe(1);
  });

  it("refuses a yes-no answer with no probability", async () => {
    const { ms } = client([json(200, { answer: true })]);
    await expect(ms.yesNoHint("t", MED_HINT)).rejects.toMatchObject({ code: "bad_shape" });
  });

  it("fails closed on 401 with no retry", async () => {
    const { ms, calls } = client([json(401, { error: { code: "invalid_api_key" } })]);
    await expect(ms.entities("t", PII_TYPES)).rejects.toMatchObject({ code: "invalid_api_key" });
    expect(calls()).toBe(1);
  });
});

describe("pipeline fails closed", () => {
  it("never shows a reply when check B is down, and cancels the run", async () => {
    const { run, calls } = scriptedRun(() => ({ text: CLEAN }));
    const model = {
      entities: async () => [],
      yesNoHint: async () => {
        throw new SafetyUnavailable(0, "timeout");
      },
    };
    const { post, logs } = makeApp(run, model);
    const { say } = await session(post);
    const res = await say("Bonjour");
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.json)).not.toContain("Québec.ca");
    expect(calls.at(-1)).toMatchObject({ kind: "cancel", target: "run_1" });
    expect(logs.some((l) => l.event === "check_unavailable")).toBe(true);
  });

  it("logs the PII and advice scores with their thresholds", async () => {
    const { run } = scriptedRun(() => ({ text: CLEAN }));
    const { post, logs } = makeApp(run, scriptedModel({ advice: () => 0.12 }).model);
    const { say } = await session(post);
    await say("Bonjour");
    expect(logs.find((l) => l.event === "pii_score")).toMatchObject({ threshold: 0.7, layer: "model" });
    expect(logs.find((l) => l.event === "advice_score")).toMatchObject({ score: 0.12, threshold: 0.5, attempt: 1 });
  });
});

describe("classify scores", () => {
  it("returns the best score of the other labels for the router margin rule", async () => {
    const { ms } = client([json(200, { label: "a", probability: 0.4, confidence: 0.1, scores: { a: 0.4, b: 0.15, unclear: 0.12 } })]);
    expect(await ms.classify("t", { a: "x", b: "y" })).toEqual({ label: "a", probability: 0.4, second: 0.15 });
    const { ms: noScores } = client([json(200, { label: "a", probability: 0.4 })]);
    expect(await noScores.classify("t", { a: "x" })).toEqual({ label: "a", probability: 0.4 });
  });

  it("does not take a place named after a person for a person name", () => {
    const places: [string, string][] = [
      ["c'est quoi le numero de telephone du jean coutu", "jean"],
      ["c'est quoi le numero de telephone du jean coutu", "jean coutu"],
      ["est-ce que le Brunet est ouvert ce soir", "Brunet"],
      ["je suis allé à Charles-Le Moyne hier", "Charles"],
      ["l'urgence de Maisonneuve-Rosemont est pleine?", "Maisonneuve"],
      ["où est le CLSC Samuel-de-Champlain", "Samuel"],
      ["the ER at the Jewish General", "Jewish General"],
      ["je vais au Pierre-Boucher", "Pierre"],
    ];
    for (const [text, word] of places) expect({ text, kept: keepPiiSpan(nameSpan(text, word), text) }).toEqual({ text, kept: false });
    const people: [string, string][] = [
      ["mon voisin Pierre Tremblay a la grippe", "Pierre Tremblay"],
      ["chez Marie on a tous la gastro", "Marie"],
      ["Julie Roy a besoin d'un médecin", "Julie Roy"],
    ];
    for (const [text, word] of people) expect({ text, kept: keepPiiSpan(nameSpan(text, word), text) }).toEqual({ text, kept: true });
  });
});

function nameSpan(text: string, word: string) {
  const start = text.toLowerCase().indexOf(word.toLowerCase());
  return { type: "person_name" as const, text: text.slice(start, start + word.length), probability: 0.9, start, end: start + word.length };
}
