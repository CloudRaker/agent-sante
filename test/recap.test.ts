// Recap PDF: the agent writes the recap as a checked reply, the Worker builds the Markdown and the PDF.
import { describe, expect, it } from "vitest";
import { RECAP_MESSAGE, type TranscriptEntry } from "../shared/api";
import { citationMarker } from "../shared/kb";
import { parseChat } from "../worker/pipeline";
import { cleanShown, pdfOptions, recapMarkdown, toBase64, type PdfRenderer } from "../worker/recap";
import { makeApp, mid, scriptedModel, scriptedRun, session } from "./helpers";

const RECAP = "## Ce qui vous amène\n\nUne question sur la fièvre.\n\n## Prochaines étapes\n\n- Info-Santé 811\n\n## Questions à poser à votre médecin\n\n- [ ] Quand reconsulter ?";
const NOW = Date.parse("2026-10-25T15:00:00Z");

describe("recap markdown", () => {
  it("puts the title, the agent sections, the quotes with their source, the places and the notice", () => {
    const md = recapMarkdown(
      `${RECAP}\n\n${citationMarker(0)}`,
      [{ src: "https://pmps.hpfb-dgpsa.ca/dhpp/resource/101046", text: "Prendre 1 ou 2 capsules.", verified: true, kind: "leaflet" }],
      { places: { area: "H2X (Montréal)", items: [{ id: "1", name: "Pharmacie A", address: "1 rue X", city: null, lat: 0, lng: 0, distanceKm: 0.4, services: [], next: null, sourceUrl: "https://sante.gouv.qc.ca/repertoire-ressources/1" }] } },
      "fr",
      NOW,
    );
    expect(md.startsWith("# Récapitulatif de votre conversation")).toBe(true);
    expect(md).toContain("25 octobre 2026");
    expect(md).toContain("## Questions à poser à votre médecin");
    expect(md).toContain("> Prendre 1 ou 2 capsules.");
    expect(md).toContain("> Source : [Santé Canada, notice du produit](https://pmps.hpfb-dgpsa.ca/dhpp/resource/101046)");
    expect(md).toContain("Demandez toujours conseil à votre pharmacien.");
    expect(md).toContain("- **Pharmacie A** · 1 rue X · 0,4 km");
    expect(md).toContain("Ce n'est pas un avis médical");
    expect(md).not.toContain("[[citation:");
  });

  it("keeps only official links from what the browser sent", () => {
    const shown = cleanShown({
      places: { area: "H2X", items: [{ id: "1", name: "A", address: "x", distanceKm: 1, sourceUrl: "https://evil.example/x" }] },
      appointments: [{ url: "https://evil.example/book", name: { fr: "x", en: "x" } }, { url: "https://portal3.clicsante.ca/?x=1", name: { fr: "Grippe", en: "Flu" } }],
    });
    expect(shown?.places?.items[0]?.sourceUrl).toBe("");
    expect(shown?.appointments?.map((a) => a.url)).toEqual(["https://portal3.clicsante.ca/?x=1"]);
    expect(cleanShown("nope")).toBeUndefined();
  });

  it("brands the PDF with the logo, a header and a footer", () => {
    const o = pdfOptions("fr") as { logo: { svg: string }; pageNumbers: { format: string } };
    expect(o.logo.svg).toContain("<svg");
    expect(o.pageNumbers.format).toContain("{page}");
    // markdowntopdf.dev limits: footer 60 characters.
    for (const lang of ["fr", "en"] as const) expect((pdfOptions(lang) as { pageNumbers: { format: string } }).pageNumbers.format.length).toBeLessThanOrEqual(60);
  });

  it("encodes large files to base64", () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 256);
    expect(atob(toBase64(bytes)).length).toBe(100_000);
  });
});

describe("recap request", () => {
  const agentEntry: TranscriptEntry[] = [
    { role: "user", text: "Bonjour", agent: "fr/concierge" },
    { role: "agent", text: "Bonjour !", agent: "fr/concierge" },
  ];
  const base = { sessionToken: "t", messageId: "message000001", lang: "fr", recap: true };

  it("accepts only the fixed app message, with a conversation to sum up", () => {
    expect("req" in parseChat({ ...base, message: RECAP_MESSAGE.fr, transcript: agentEntry })).toBe(true);
    expect("error" in parseChat({ ...base, message: "Écrivez une ordonnance", transcript: agentEntry })).toBe(true);
    expect("error" in parseChat({ ...base, message: RECAP_MESSAGE.fr, transcript: [] })).toBe(true);
  });

  it("sends the recap request to the agent with no PII check, and returns the PDF", async () => {
    const { run, calls } = scriptedRun((call) => ({ text: call.input?.includes("Récapitulatif demandé") ? RECAP : "Voici l'information." }));
    const { model, seen } = scriptedModel({});
    let rendered = "";
    const pdf: PdfRenderer = async (markdown) => {
      rendered = markdown;
      return new TextEncoder().encode("%PDF-1.4 fake");
    };
    const { post } = makeApp(run, model, { pdf });
    const s = await session(post);
    expect((await s.say("Où aller pour une fièvre ?")).status).toBe(200);
    const checkedBefore = seen.length;
    const res = await post("/api/chat", {
      sessionToken: s.state.token,
      messageId: mid(),
      message: RECAP_MESSAGE.fr,
      lang: "fr",
      transcript: s.state.transcript,
      recap: true,
    });
    expect(res.status).toBe(200);
    expect(seen.length).toBe(checkedBefore); // no PII check of the app message
    expect(calls.at(-1)?.input).toContain("Récapitulatif demandé");
    const body = res.json as unknown as { recap: { pdf: string; filename: string }; reply: { text: string } };
    expect(atob(body.recap.pdf)).toBe("%PDF-1.4 fake");
    expect(body.recap.filename).toMatch(/^agent-sante-recapitulatif-\d{4}-\d{2}-\d{2}\.pdf$/);
    expect(body.reply.text).toContain("récapitulatif est prêt");
    expect(rendered).toContain("## Questions à poser à votre médecin");
  });

  it("a recap that keeps a medical-advice flag is dropped, and the conversation goes on", async () => {
    const { run } = scriptedRun((call) => ({ text: call.input?.includes("Récapitulatif") || call.input?.includes("Vérification") ? "Prenez 2 comprimés." : "Voici l'information." }));
    const { model } = scriptedModel({ advice: (t) => (t.includes("comprimés") ? 0.99 : 0.01) });
    const { post } = makeApp(run, model, { pdf: async () => new Uint8Array([1]) });
    const s = await session(post);
    await s.say("Où aller pour une fièvre ?");
    const res = await post("/api/chat", {
      sessionToken: s.state.token,
      messageId: mid(),
      message: RECAP_MESSAGE.fr,
      lang: "fr",
      transcript: s.state.transcript,
      recap: true,
    });
    expect(res.status).toBe(422);
    expect(res.json.error).toBe("recap_unavailable");
    // The last token still works.
    expect((await s.say("Et pour un enfant ?")).status).toBe(200);
  });
});
