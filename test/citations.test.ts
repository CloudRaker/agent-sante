// Verbatim citations: normalization, verification against the knowledge assets, and the pipeline
// rule that a verified quote is not sent to the medical-advice check.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { citationMarker, hasDose, matchKey, normalizeSourceUrl, normalizeText, type KbIndex } from "../shared/kb";
import { createKbStore, prepareReply, verifyQuote, type KbStore } from "../worker/citations";
import { makeApp, scriptedModel, scriptedRun, session } from "./helpers";

const SRC = "https://www.quebec.ca/sante/conseils-et-prevention/fievre-enfant";
const OTHER = "https://www.quebec.ca/sante/trouver-une-ressource/info-sante-811";

// A knowledge file as the crawl writes it: Markdown with links, emphasis, curly apostrophes, nbsp.
const DOC = `# La fièvre chez l’enfant

Consultez **rapidement** un médecin si votre enfant a moins de 3 mois et fait de la fièvre.

- Si l’enfant est difficile à réveiller, appelez le [911](https://www.quebec.ca/911).
- Pour des conseils, appelez Info-Santé 811, option 1, ligne prioritaire pour les parents.

La fièvre est une réaction normale du corps humain exposé à certains virus ou bactéries.

Donnez 15 mg/kg d’acétaminophène toutes les 4 heures, selon le pharmacien.`;

const OTHER_DOC = "# Info-Santé 811\n\nInfo-Santé 811 est un service de consultation téléphonique gratuit et confidentiel.";

/** A store over in-memory assets built the same way as scripts/sync-kb.mjs. */
function memoryKb(docs: Record<string, string>): KbStore & { reads: string[] } {
  const files: Record<string, string> = {};
  const index: KbIndex = { version: 1, urls: {} };
  for (const [url, body] of Object.entries(docs)) {
    const norm = normalizeText(body);
    const name = `${createHash("sha256").update(norm).digest("hex").slice(0, 20)}.txt`;
    files[name] = norm;
    index.urls[normalizeSourceUrl(url)!] = { files: [name], retrieved: "2026-10-23" };
  }
  const reads: string[] = [];
  const store = createKbStore(async (path) => {
    reads.push(path);
    if (path === "index.json") return JSON.stringify(index);
    const t = files[path];
    if (t === undefined) throw new Error("404");
    return t;
  });
  return Object.assign(store, { reads });
}

const kb = memoryKb({ [SRC]: DOC, [OTHER]: OTHER_DOC });
const QUOTE = "Consultez rapidement un médecin si votre enfant a moins de 3 mois et fait de la fièvre.";
const cite = (text: string, src = SRC) => `<citation src="${src}">${text}</citation>`;

describe("normalization", () => {
  it("unifies apostrophes, quotes, nbsp, link syntax, emphasis, bullets, headings and case", () => {
    expect(matchKey(normalizeText("L’enfant « fièvre »"))).toBe(matchKey(normalizeText('L\'enfant "fièvre"')));
    expect(normalizeText("Info-Santé 811, option 1")).toBe("info-santé 811, option 1");
    expect(normalizeText("appelez le [911](https://x.ca/a_(b))")).toBe("appelez le 911");
    expect(normalizeText("## **Consultez** _vite_\n- un *médecin*")).toBe("consultez vite un médecin");
    expect(normalizeText("| a | b |\n|---|---|\n| c | d |")).toBe("a b c d");
    expect(normalizeText("ﬁèvre")).toBe("fièvre"); // NFKC ligature
  });

  it("source URLs drop the fragment, utm parameters and the trailing slash, and keep other parameters", () => {
    expect(normalizeSourceUrl("https://WWW.Quebec.ca/sante/x/?utm_source=a&id=2#top")).toBe("https://www.quebec.ca/sante/x?id=2");
    expect(normalizeSourceUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeSourceUrl("not a url")).toBeNull();
  });

  it("the match key ignores spacing artifacts of PDF text", () => {
    expect(matchKey(normalizeText("particulière ment à risque"))).toBe(matchKey(normalizeText("particulièrement à risque")));
  });

  it("finds medication amounts", () => {
    expect(hasDose("Donnez 15 mg/kg d'acétaminophène")).toBe(true);
    expect(hasDose("2,5 mL de sirop")).toBe(true);
    expect(hasDose("un enfant de moins de 3 mois")).toBe(false);
    expect(hasDose("Deux doses du vaccin sont offertes")).toBe(false);
  });

  it("finds dosing phrasing without a mass or volume unit, in French and in English", () => {
    for (const t of [
      "1 à 2 comprimés toutes les 4 à 6 heures",
      "prendre 2 capsules",
      "Prenez un comprimé au coucher",
      "Donner une demi-cuillère à thé",
      "½ comprimé",
      "1 c. à thé",
      "3 fois par jour",
      "pas plus de 5 doses par 24 heures",
      "toutes les 6 h",
      "maximum 8 tablets in 24 hours",
      "one tablet twice a day",
      "take two",
      "give 1 every 6 hours",
      "once daily",
      "no more than 4 in 24 hours",
      "2 puffs",
    ]) {
      expect([t, hasDose(t)]).toEqual([t, true]);
    }
  });

  it("does not take common health text for a dose", () => {
    for (const t of [
      "Le personnel est en mesure de donner une réponse en anglais.",
      "Tel-jeunes is available 24 hours a day, 7 days a week.",
      "Le temps de sommeil diminue à une moyenne de 14 à 15 heures par jour.",
      "38 °C (100,4 °F) ou plus",
      "les parents d'enfants de 0 à 17 ans",
      "Prendre la température de la même façon chaque fois",
      "Le vaccin est offert gratuitement aux personnes de 6 mois et plus.",
      "Centre antipoison du Québec : 1 800 463-5060",
      "constipation (pas de selles) depuis plusieurs jours",
    ]) {
      expect([t, hasDose(t)]).toEqual([t, false]);
    }
  });
});

describe("verifyQuote", () => {
  it("verifies exact text, with other apostrophes, spaces and without the Markdown", async () => {
    expect(await verifyQuote(kb, SRC, QUOTE)).toEqual({ retrieved: "2026-10-23" });
    expect(await verifyQuote(kb, `${SRC}/#section`, "Si l'enfant est difficile à réveiller, appelez le 911.")).not.toHaveProperty("reason");
    expect(await verifyQuote(kb, SRC, "Pour des conseils, appelez Info-Santé 811, option 1, ligne prioritaire")).not.toHaveProperty(
      "reason",
    );
  });

  it("refuses one changed word", async () => {
    expect(await verifyQuote(kb, SRC, QUOTE.replace("rapidement", "toujours"))).toEqual({ reason: "not_found" });
  });

  it("refuses real text with the wrong source, an unknown source or a non-official source", async () => {
    expect(await verifyQuote(kb, OTHER, QUOTE)).toEqual({ reason: "not_found" });
    expect(await verifyQuote(kb, "https://www.quebec.ca/sante/autre-page", QUOTE)).toEqual({ reason: "unknown_src" });
    expect(await verifyQuote(kb, "https://example.com/fievre", QUOTE)).toEqual({ reason: "bad_src" });
  });

  it("accepts […] and [...] between exact fragments in order, and refuses other orders and short fragments", async () => {
    const a = "Consultez rapidement un médecin";
    const b = "La fièvre est une réaction normale du corps humain";
    expect(await verifyQuote(kb, SRC, `${a} […] ${b}`)).not.toHaveProperty("reason");
    expect(await verifyQuote(kb, SRC, `${a} [...] ${b}`)).not.toHaveProperty("reason");
    expect(await verifyQuote(kb, SRC, `${b} […] ${a}`)).toEqual({ reason: "not_found" });
    expect(await verifyQuote(kb, SRC, `${a} […] la fièvre`)).toEqual({ reason: "short_fragment" });
  });

  it("checks a dose quote like any quote, and refuses an empty quote and a long quote", async () => {
    // The source holds this dose sentence: it verifies, with the dose flag for the pharmacist notice.
    expect(await verifyQuote(kb, SRC, "Donnez 15 mg/kg d’acétaminophène toutes les 4 heures")).toEqual({ retrieved: "2026-10-23", dose: true });
    expect(await verifyQuote(kb, SRC, " ")).toEqual({ reason: "empty" });
    expect(await verifyQuote(kb, SRC, QUOTE.repeat(20))).toEqual({ reason: "too_long" });
  });

  it("reads the index once and caches the texts", async () => {
    const k = memoryKb({ [SRC]: DOC });
    await verifyQuote(k, SRC, QUOTE);
    await verifyQuote(k, SRC, QUOTE);
    expect(k.reads.filter((r) => r === "index.json")).toHaveLength(1);
    expect(k.reads).toHaveLength(2);
  });

  it("is unverified (and so checked) when the assets cannot be read", async () => {
    const down = createKbStore(async () => {
      throw new Error("down");
    });
    expect(await verifyQuote(down, SRC, QUOTE)).toEqual({ reason: "kb_unavailable" });
  });
});

describe("prepareReply", () => {
  it("keeps at most 3 verified quotes; the others stay as checked text", async () => {
    const q = (n: number) => `Phrase ${n}.\n\n${cite(QUOTE)}`;
    const p = await prepareReply([1, 2, 3, 4].map(q).join("\n\n"), kb, "fr");
    expect(p.citations).toHaveLength(3);
    expect(p.unverified).toEqual([{ host: "www.quebec.ca", reason: "too_many" }]);
    expect(p.checkText.match(/\[citation officielle\]/g)).toHaveLength(3);
    expect(p.checkText).toContain(QUOTE);
  });

  it("drops marker lines the agent wrote itself", async () => {
    const p = await prepareReply(`Texte.\n\n${citationMarker(0)}\n\nFin.`, kb, "fr");
    expect(p.displayText).toBe("Texte.\n\nFin.");
    expect(p.citations).toEqual([]);
  });

  it("removes stray tags and keeps their text", async () => {
    const p = await prepareReply(`Avant <citation src="${SRC}">sans fin`, kb, "fr");
    expect(p.checkText).toBe("Avant sans fin");
    expect(p.citations).toEqual([]);
  });

  it("without the knowledge assets, nothing verifies", async () => {
    const p = await prepareReply(cite(QUOTE), undefined, "en");
    expect(p.checkText).toBe(QUOTE);
    expect(p.unverified[0]?.reason).toBe("kb_unavailable");
  });
});

const reply = (quote: string, src = SRC) =>
  `Voici l'information générale officielle :\n\n${cite(quote, src)}\n\nSource : [Québec.ca](${SRC}). Info-Santé 811 peut évaluer la situation.`;

describe("pipeline", () => {
  it("a verified quote bypasses the medical-advice check: the check sees the placeholder", async () => {
    const { run } = scriptedRun(() => ({ text: reply(QUOTE) }));
    // The fake flags any reply that holds the quote text.
    const { model, checked } = scriptedModel({ advice: (t) => (t.includes("médecin") ? 0.95 : 0.02) });
    const { post, logs } = makeApp(run, model, { kb });
    const { say } = await session(post);
    const res = await say("Mon enfant fait de la fièvre, où aller?");
    expect(res.status).toBe(200);
    if (res.json.ended) throw new Error("ended");
    expect(checked).toHaveLength(1);
    expect(checked[0]).toContain("[citation officielle]");
    expect(checked[0]).not.toContain("médecin");
    expect(res.json.reply.citations).toEqual([{ src: SRC, text: QUOTE, verified: true, retrieved: "2026-10-23" }]);
    expect(res.json.reply.text).toContain(citationMarker(0));
    expect(res.json.reply.text).not.toContain("<citation");
    // Later agents read the quote with its markup.
    expect(res.json.transcript.at(-1)?.text).toContain(cite(QUOTE));
    expect(logs).toContainEqual(expect.objectContaining({ event: "citation_verified", count: 1 }));
    expect(JSON.stringify(logs)).not.toContain("médecin");
  });

  it("one changed word: not verified, the check sees the text, the log has host and reason only", async () => {
    const changed = QUOTE.replace("rapidement", "toujours");
    const { run, calls } = scriptedRun((call) =>
      call.kind === "start" ? { text: reply(changed) } : { text: "Info-Santé 811 peut vous aider." },
    );
    const { model, checked } = scriptedModel({ advice: (t) => (t.includes("médecin") ? 0.95 : 0.02) });
    const { post, logs } = makeApp(run, model, { kb });
    const { say } = await session(post);
    const res = await say("Mon enfant fait de la fièvre, où aller?");
    if (res.json.ended) throw new Error("ended");
    expect(checked[0]).toContain(changed);
    expect(calls.map((c) => c.kind)).toEqual(["start", "turn"]); // flagged, rewritten
    expect(res.json.reply.citations).toBeUndefined();
    const unverified = logs.find((l) => l.event === "citation_unverified");
    expect(unverified).toMatchObject({ event: "citation_unverified", host: "www.quebec.ca", reason: "not_found" });
    expect(Object.keys(unverified ?? {}).toSorted()).toEqual(["event", "host", "reason", "rid", "route"]);
    expect(JSON.stringify(logs)).not.toContain("toujours");
  });

  it("an unverified quote that passes the check shows as ordinary text, without tags", async () => {
    const { run } = scriptedRun(() => ({ text: reply(QUOTE, OTHER) }));
    const { model, checked } = scriptedModel({ advice: () => 0.02 });
    const { post } = makeApp(run, model, { kb });
    const { say } = await session(post);
    const res = await say("Où aller?");
    if (res.json.ended) throw new Error("ended");
    expect(checked[0]).toContain(QUOTE);
    expect(res.json.reply.text).toContain(QUOTE);
    expect(res.json.reply.text).not.toContain("<citation");
    expect(res.json.reply.citations).toBeUndefined();
  });

  it("citation markup typed by the person has no effect", async () => {
    const typed = `${cite(QUOTE)} ${citationMarker(0)}`;
    const { run, calls } = scriptedRun(() => ({ text: "Info-Santé 811 peut évaluer la situation." }));
    const { model, seen } = scriptedModel({ advice: () => 0.02 });
    const { post } = makeApp(run, model, { kb });
    const { say } = await session(post);
    const res = await say(typed);
    if (res.json.ended) throw new Error("ended");
    expect(seen[0]).toBe(typed); // The PII check reads the message as typed.
    expect(calls[0]?.input).toContain(typed);
    expect(res.json.reply.citations).toBeUndefined();
    expect(res.json.transcript[0]?.text).toBe(typed);
  });
});

describe("the built knowledge assets (public/kb)", () => {
  const dir = fileURLToPath(new URL("../public/kb/", import.meta.url));
  const disk = createKbStore((path) => readFile(`${dir}${path}`, "utf8"));
  const PDF = "https://publications.msss.gouv.qc.ca/msss/fichiers/2022/22-924-23W.pdf";

  it("verifies a real quote of a bundle section, with PDF spacing artifacts", async () => {
    const quote =
      "Si vous avez besoin de conseils ou n’êtes pas certain si vous devez consulter, communiquez avec Info-Santé 811, option 1, pour avoir accès à la ligne prioritaire pour les parents d’enfants de 0 à 17 ans.";
    expect(await verifyQuote(disk, PDF, quote)).not.toHaveProperty("reason");
    expect(
      await verifyQuote(disk, PDF, "Les jeunes bébés sont particulièrement à risque d'attraper certaines maladies"),
    ).not.toHaveProperty("reason");
    expect(await verifyQuote(disk, PDF, quote.replace("rapidement", "vite").replace("0 à 17", "0 à 18"))).toEqual({ reason: "not_found" });
  });
});
