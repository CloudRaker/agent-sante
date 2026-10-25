// @vitest-environment jsdom
// Drug tools: name search for any product, leaflet text for non-prescription products only,
// and leaflet quotes that verify against the leaflet (with the pharmacist notice in the UI).
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CitationCard } from "../src/chat/AssistantReply";
import { I18nProvider } from "../src/i18n";
import { toolStepKind } from "../worker/activity";
import { createKbStore, prepareReply, verifyQuote, withLeaflets } from "../worker/citations";
import { leafletSource, parseLeafletSource, readLeaflet, type RawDrug } from "../worker/drugs";
import { jsonCache } from "../worker/places/cache";
import type { DirectoryDeps } from "../worker/places/directory";
import { memoryPlaces } from "../worker/places/store-core";
import { createTools, TOOLS_HEADER, type ToolsDeps } from "../worker/tools";

const SECRET = "tools-secret-tools-secret-0123456789";

const OTC: RawDrug = {
  drug_code: "101046",
  din: "02521237",
  brand_name: "EXTRA STRENGTH TYLENOL LIQUID GELS",
  brand_name_fr: null,
  dispensing_status: "otc",
  is_otc: true,
  is_prescription: false,
  ingredients: [{ name: "ACETAMINOPHEN", name_fr: "Acétaminophène", strength: "500", strength_unit: "MG" }],
  forms: [{ en: "CAPSULE", fr: "Capsule" }],
  routes: [{ en: "ORAL", fr: "Orale" }],
  company: "KENVUE CANADA INC.",
};
const RX: RawDrug = {
  drug_code: "101436",
  brand_name: "AMOXICILLIN CAPSULES BP",
  dispensing_status: "prescription",
  is_otc: false,
  is_prescription: true,
  ingredients: [{ name: "AMOXICILLIN", name_fr: "Amoxicilline", strength: "250", strength_unit: "MG" }],
};
const LEAFLET_FR =
  "# Renseignements pour le consommateur\n\nAdultes et enfants de 12 ans et plus : prendre 1 ou 2 capsules toutes les 4 à 6 heures, au besoin. Ne pas prendre plus de 8 capsules en 24 heures.\n\nNe pas utiliser avec d'autres médicaments contenant de l'acétaminophène.";

/** A directory fake. `leaflets` maps "code:lang" to a consumer-info status and text. */
function directory(leaflets: Record<string, { status: string; text?: string }> = {}) {
  const urls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    urls.push(url.pathname + url.search);
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    if (url.pathname === "/v1/drugs") {
      const otcOnly = url.searchParams.get("dispensing") === "otc";
      return json({ data: otcOnly ? [OTC] : [OTC, RX], next_cursor: null });
    }
    const m = /^\/v1\/drugs\/(\d+)\/consumer-info$/.exec(url.pathname);
    if (m) {
      const drug = m[1] === RX.drug_code ? RX : OTC;
      const entry = leaflets[`${m[1]}:${url.searchParams.get("language")}`] ?? { status: "pending_discovery" };
      return json({
        drug,
        status: entry.status,
        data: entry.text ? [{ document_id: "00099999", text: entry.text }] : [],
      });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const deps: DirectoryDeps = { baseUrl: "https://dir.test", fetcher, cache: jsonCache(undefined), now: Date.now, log: () => {} };
  return { deps, urls };
}

function tools(dir = directory()) {
  const deps: ToolsDeps = { secret: SECRET, places: memoryPlaces(), directory: dir.deps, now: Date.now, log: () => {} };
  const app = createTools(() => deps);
  return async (op: string, body: unknown) => {
    const res = await app.request(`/tools/v1/${op}`, {
      method: "POST",
      headers: { "content-type": "application/json", [TOOLS_HEADER]: SECRET },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
}

describe("drug tools", () => {
  it("drug_search finds any product by name and flags prescription products", async () => {
    const dir = directory();
    const res = await tools(dir)("drug_search", { name: "tylenol", lang: "fr" });
    expect(res.status).toBe(200);
    const products = res.json.products as { name: string; otc: boolean; prescription: boolean; ingredients: string[] }[];
    expect(products.map((p) => [p.name, p.otc, p.prescription])).toEqual([
      ["EXTRA STRENGTH TYLENOL LIQUID GELS", true, false],
      ["AMOXICILLIN CAPSULES BP", false, true],
    ]);
    expect(products[0]!.ingredients).toEqual(["Acétaminophène 500 mg"]);
    expect(dir.urls[0]).toBe("/v1/drugs?q=tylenol&limit=8");
  });

  it("drug_search with otc_only asks the directory for non-prescription products only", async () => {
    const dir = directory();
    const res = await tools(dir)("drug_search", { name: "acétaminophène", otc_only: true, lang: "fr" });
    expect((res.json.products as unknown[]).length).toBe(1);
    expect(dir.urls[0]).toContain("dispensing=otc");
  });

  it("drug_search refuses a missing name", async () => {
    expect((await tools()("drug_search", { name: "a" })).status).toBe(400);
  });

  it("drug_info gives no leaflet for a prescription product", async () => {
    const res = await tools(directory({ "101436:fr": { status: "available", text: LEAFLET_FR } }))("drug_info", {
      drug_code: "101436",
      lang: "fr",
    });
    expect(res.status).toBe(403);
    expect(res.json.error).toBe("prescription_drug");
    expect(res.json).not.toHaveProperty("leaflet");
  });

  it("drug_info gives the leaflet of a non-prescription product and the source to quote", async () => {
    const res = await tools(directory({ "101046:fr": { status: "available", text: LEAFLET_FR } }))("drug_info", {
      drug_code: "101046",
      lang: "fr",
    });
    expect(res.status).toBe(200);
    expect(res.json.leaflet).toBe(LEAFLET_FR);
    expect(res.json.cite_src).toBe("https://pmps.hpfb-dgpsa.ca/dhpp/resource/101046");
    expect(res.json.leaflet_lang).toBe("fr");
  });

  it("drug_info falls back to the leaflet in the other language", async () => {
    const res = await tools(directory({ "101046:en": { status: "available", text: "Adults: take 2 capsules." } }))("drug_info", {
      drug_code: "101046",
      lang: "fr",
    });
    expect(res.json.leaflet_lang).toBe("en");
    expect(res.json.cite_src).toBe("https://dhpp.hpfb-dgpsa.ca/dhpp/resource/101046");
  });

  it("drug_info says when no leaflet is available yet", async () => {
    const res = await tools()("drug_info", { drug_code: "101046", lang: "fr" });
    expect(res.status).toBe(200);
    expect(res.json.leaflet).toBeNull();
    expect(res.json.status).toBe("pending_discovery");
  });

  it("drug tool calls show as a drug step", () => {
    expect(toolStepKind({ text: "Called drug_search" })).toBe("drugs");
    expect(toolStepKind({ text: "Called drug_info" })).toBe("drugs");
  });
});

describe("leaflet sources", () => {
  it("round-trips the product page URL", () => {
    expect(parseLeafletSource(leafletSource("101046", "fr"))).toEqual({ code: "101046", lang: "fr" });
    expect(parseLeafletSource(leafletSource("101046", "en"))).toEqual({ code: "101046", lang: "en" });
    expect(parseLeafletSource("https://dhpp.hpfb-dgpsa.ca/dhpp/resource/abc")).toBeNull();
  });

  it("readLeaflet joins the consumer text", async () => {
    const leaflet = await readLeaflet(directory({ "101046:fr": { status: "available", text: LEAFLET_FR } }).deps, "101046", "fr");
    expect(leaflet?.text).toBe(LEAFLET_FR);
    expect(leaflet?.drug.otc).toBe(true);
  });
});

describe("leaflet quotes", () => {
  const empty = createKbStore(async (path) => {
    if (path === "index.json") return JSON.stringify({ version: 1, urls: {} });
    throw new Error("missing");
  });
  const kb = (leaflets: Record<string, { status: string; text?: string }>) => {
    const dir = directory(leaflets);
    return withLeaflets(empty, async (code, lang) => {
      const l = await readLeaflet(dir.deps, code, lang);
      return l ? { otc: l.drug.otc, text: l.text } : null;
    })!;
  };
  const SRC = "https://pmps.hpfb-dgpsa.ca/dhpp/resource/101046";
  const DOSE = "Adultes et enfants de 12 ans et plus : prendre 1 ou 2 capsules toutes les 4 à 6 heures, au besoin.";

  it("a quote of a non-prescription leaflet verifies, dose included", async () => {
    expect(await verifyQuote(kb({ "101046:fr": { status: "available", text: LEAFLET_FR } }), SRC, DOSE)).toEqual({
      lang: "fr",
      kind: "leaflet",
    });
  });

  it("a quote that is not in the leaflet does not verify", async () => {
    const r = await verifyQuote(kb({ "101046:fr": { status: "available", text: LEAFLET_FR } }), SRC, "Prendre 4 capsules toutes les heures sans limite.");
    expect(r).toEqual({ reason: "not_found" });
  });

  it("a prescription leaflet never verifies", async () => {
    const r = await verifyQuote(
      kb({ "101436:fr": { status: "available", text: LEAFLET_FR } }),
      "https://pmps.hpfb-dgpsa.ca/dhpp/resource/101436",
      DOSE,
    );
    expect(r).toEqual({ reason: "unknown_src" });
  });

  it("a dose quote of an official page verifies only against that page", async () => {
    const r = await verifyQuote(kb({}), "https://www.quebec.ca/sante", DOSE);
    expect(r).toEqual({ reason: "unknown_src" });
  });

  it("a verified leaflet quote is a leaflet citation, hidden from the medical-advice check", async () => {
    const reply = `La notice indique : <citation src="${SRC}">${DOSE}</citation>`;
    const prepared = await prepareReply(reply, kb({ "101046:fr": { status: "available", text: LEAFLET_FR } }), "fr");
    expect(prepared.citations).toHaveLength(1);
    expect(prepared.citations[0]!.kind).toBe("leaflet");
    expect(prepared.checkText).not.toContain("capsules");
  });

  it("the card names the leaflet and tells the person to ask a pharmacist", () => {
    render(
      <I18nProvider lang="fr">
        <CitationCard citation={{ src: SRC, text: DOSE, verified: true, lang: "fr", kind: "leaflet" }} />
      </I18nProvider>,
    );
    expect(screen.getByText("Extrait de la notice du produit")).toBeTruthy();
    expect(
      screen.getByText("Ces informations proviennent de la notice du produit pharmaceutique. Demandez toujours conseil à votre pharmacien."),
    ).toBeTruthy();
  });
});
