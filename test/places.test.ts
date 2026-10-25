// Appointments and places: postal code as a location only, the Worker tools, the attachments.
import { describe, expect, it } from "vitest";
import { readSseFrames, type Activity, type ChatResult } from "../shared/activity";
import type { ChatReply, TranscriptEntry } from "../shared/api";
import type { PlaceItem } from "../shared/places";
import directoryHours from "./fixtures/directory-hours.json";
import directoryPage from "./fixtures/directory-resources.json";
import clicsantePage from "./fixtures/clicsante-availabilities.synthetic.json";
import { fakePostal } from "../worker/fake/postal";
import { toolStepKind } from "../worker/activity";
import { toAttachments } from "../worker/pipeline";
import { jsonCache } from "../worker/places/cache";
import {
  appointmentLink,
  findServices,
  parseAvailabilities,
  portalLink,
  searchAvailabilities,
  serviceOf,
  slugTitle,
  USER_AGENT,
  ClicSanteError,
} from "../worker/places/clicsante";
import { KIND_RULES, nextOpening, searchPlaces, type DirectoryDeps } from "../worker/places/directory";
import {
  agentMarker,
  d1Postal,
  findPostalCodes,
  neutralMarker,
  PLACE_REF,
  placeRef,
  replacePostalCodes,
  type D1Like,
} from "../worker/places/postal";
import { memoryPlaces } from "../worker/places/store-core";
import { createTools, TOOLS_HEADER, type ToolsDeps } from "../worker/tools";
import type { CallOptions, Reply, RunApi } from "../worker/run/client";
import type { EntitySpan } from "../worker/safety/checks";
import { makeApp, mid, ORIGIN, scriptedModel, scriptedRun, SECRET, session } from "./helpers";

const streetSpans = (text: string): EntitySpan[] => {
  const i = text.indexOf("1234 rue Saint-Denis");
  return i >= 0 ? [{ type: "street_address", text: "1234 rue Saint-Denis", probability: 0.97, start: i, end: i + 20 }] : [];
};
const fixedNow = () => Date.parse("2026-10-24T16:00:00Z");

const TOOLS_SECRET = "tools-secret-tools-secret-0123456789";
const CODE_RE = /H2X\s?-?1Y4/i;

/** A fetch fake for the directory: answers the recorded fixtures and records the URLs. */
function directoryFetch() {
  const urls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    const body = url.includes("/hours") ? directoryHours : directoryPage;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetcher, urls };
}

function directoryDeps(fetcher: typeof fetch, now = () => Date.parse("2026-10-24T16:00:00Z")): DirectoryDeps {
  return { baseUrl: "https://dir.test", fetcher, cache: jsonCache(undefined, now), now, log: () => {} };
}

function toolsApp(overrides: Partial<ToolsDeps> = {}) {
  const places = memoryPlaces();
  const dir = directoryFetch();
  const logs: Record<string, unknown>[] = [];
  const deps: ToolsDeps = {
    secret: TOOLS_SECRET,
    places,
    directory: directoryDeps(dir.fetcher),
    postal: fakePostal(),
    now: () => Date.now(),
    log: (e) => logs.push(e),
    ...overrides,
  };
  const app = createTools(() => deps);
  const call = async (op: string, body: unknown, secret: string | null = TOOLS_SECRET) => {
    const res = await app.request(`/tools/v1/${op}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(secret === null ? {} : { [TOOLS_HEADER]: secret }) },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  return { app, call, places, dir, logs, deps };
}

describe("postal code extraction", () => {
  it("finds full codes with a space, a dash or nothing, in any case", () => {
    expect(findPostalCodes("près de H2X 1Y4 svp").map((m) => m.code)).toEqual(["H2X1Y4"]);
    expect(findPostalCodes("h2x-1y4").map((m) => m.code)).toEqual(["H2X1Y4"]);
    expect(findPostalCodes("H2X1Y4, G1R 4S9").map((m) => [m.code, m.fsa])).toEqual([
      ["H2X1Y4", "H2X"],
      ["G1R4S9", "G1R"],
    ]);
  });

  it("ignores an FSA alone, a letter that no code uses, and words", () => {
    expect(findPostalCodes("secteur H2X")).toEqual([]);
    expect(findPostalCodes("D2X 1Y4 et H2X 1Y4Z")).toEqual([]);
    expect(findPostalCodes("COVID-19 en 2026")).toEqual([]);
  });

  it("replaces each code with its marker", () => {
    const text = "Clinique près de H2X 1Y4 ou G1R-4S9 ?";
    const out = replacePostalCodes(text, findPostalCodes(text), (m) => neutralMarker("fr", m.fsa));
    expect(out).toBe("Clinique près de [code postal fourni, secteur H2X] ou [code postal fourni, secteur G1R] ?");
  });

  it("gives an opaque place reference with letters only, the same for one session", async () => {
    const a = await placeRef(SECRET, "sid-1");
    expect(a).toMatch(PLACE_REF);
    expect(await placeRef(SECRET, "sid-1")).toBe(a);
    expect(await placeRef(SECRET, "sid-2")).not.toBe(a);
    expect(await placeRef("another-secret-another-secret-0000", "sid-1")).not.toBe(a);
  });

  it("writes the agent marker with the area, the CLSC territory and the reference", async () => {
    const point = await fakePostal().lookup("H2X1Y4");
    expect(agentMarker("fr", "H2X", point, "ref-abcdefghijkl")).toBe(
      "[code postal fourni, secteur H2X (Montréal), territoire de CLSC : Montréal–Centre-Ville, lieu : ref-abcdefghijkl]",
    );
    expect(agentMarker("en", "H2X", point, "ref-abcdefghijkl")).toBe(
      "[postal code given, area H2X (Montréal), CLSC territory: Montréal–Centre-Ville, place: ref-abcdefghijkl]",
    );
    expect(agentMarker("fr", "Z9Z", null, null)).toBe("[code postal fourni, secteur Z9Z, position introuvable]");
  });
});

function fakeD1() {
  const binds: unknown[][] = [];
  const rows = [
    { cp: "H2X1Y4", lat: 45.509536, lng: -73.569346, mun: "Montréal", ra: "Montréal", clsc: "Montréal–Centre-Ville" },
    { cp: "H2X2A1", lat: 45.51, lng: -73.57, mun: "Montréal", ra: "Montréal", clsc: "Montréal–Centre-Ville" },
  ];
  const db: D1Like = {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          binds.push(values);
          return {
            async all<T>() {
              const [from, to] = values as string[];
              return { results: rows.filter((r) => r.cp >= from! && r.cp < to!) as T[] };
            },
            async first<T>() {
              return (
                query.includes("FROM fsa") && values[0] === "H2X"
                  ? { fsa: "H2X", lat: 45.511247, lng: -73.569393, mun: "Montréal", ra: "Montréal" }
                  : null
              ) as T | null;
            },
          };
        },
      };
    },
  };
  return { db, binds };
}

describe("postal lookup in D1", () => {
  it("sends only the FSA to D1 and finds the code in memory", async () => {
    const { db, binds } = fakeD1();
    const postal = d1Postal(db);
    const p = await postal.lookup("H2X 1Y4");
    expect(p).toMatchObject({ fsa: "H2X", lat: 45.509536, precision: "code", clsc: "Montréal–Centre-Ville", fsaLat: 45.511247 });
    for (const values of binds) for (const v of values) expect(String(v)).not.toMatch(/H2X1Y4/);
    // A second code of the same FSA uses the block in memory.
    const before = binds.length;
    await postal.lookup("H2X2A1");
    expect(binds.length).toBe(before);
  });

  it("falls back to the FSA centroid for an unknown code, and to nothing for an unknown FSA", async () => {
    const { db } = fakeD1();
    const postal = d1Postal(db);
    expect(await postal.lookup("H2X9Z9")).toMatchObject({ precision: "fsa", lat: 45.511247, lng: -73.569393, clsc: null });
    expect(await postal.lookup("K1A0B1")).toBeNull();
  });
});

const advice = () => 0.01;

describe("chat pipeline with a postal code", () => {
  it("never shows the code to the PII check or to Run, and stores the place", async () => {
    const { run, calls } = scriptedRun(() => ({ text: "Voici des établissements près de chez vous." }));
    const { model, seen, checked } = scriptedModel({ advice });
    const places = memoryPlaces();
    const postal = fakePostal();
    const app = makeApp(run, model, { places, postal });
    const s = await session(app.post);
    const res = await s.say("Je cherche une clinique près de H2X 1Y4");
    expect(res.status).toBe(200);
    // The PII check saw the neutral marker only.
    expect(seen.join("\n")).not.toMatch(CODE_RE);
    expect(seen.join("\n")).toContain("[code postal fourni, secteur H2X]");
    expect(seen.join("\n")).not.toContain("ref-");
    // Run got the agent marker with the area, the CLSC territory and the reference.
    const input = calls.find((c) => c.kind === "start")!.input!;
    expect(input).not.toMatch(CODE_RE);
    expect(input).toMatch(
      /\[code postal fourni, secteur H2X \(Montréal\), territoire de CLSC : Montréal–Centre-Ville, lieu : ref-[a-z]{12}\]/,
    );
    // The transcript holds the marker, never the code.
    const reply = res.json as ChatReply;
    expect(JSON.stringify(reply.transcript)).not.toMatch(CODE_RE);
    // The advice check never sees the code either.
    expect(checked.join("\n")).not.toMatch(CODE_RE);
    // The logs never hold the code or the area.
    expect(JSON.stringify(app.logs)).not.toMatch(CODE_RE);
    expect(app.logs.find((l) => l.event === "postal_code")).toMatchObject({ found: true, precision: "code", stored: true });
    // The place store keeps the code to show it back to the person; the model and the logs never get it.
    const ref = /lieu : (ref-[a-z]{12})/.exec(input)![1]!;
    const place = await places.get(ref);
    expect(place).toMatchObject({ fsa: "H2X", municipality: "Montréal", lang: "fr", code: "H2X 1Y4" });
    expect(postal.calls).toEqual(["H2X"]);
  });

  it("still blocks a street address (and stores no place)", async () => {
    const { run, calls } = scriptedRun(() => ({ text: "x" }));
    const { model, seen } = scriptedModel({ spans: streetSpans, advice });
    const places = memoryPlaces();
    const app = makeApp(run, model, { places, postal: fakePostal() });
    const s = await session(app.post);
    const res = await s.say("J'habite au 1234 rue Saint-Denis, H2X 1Y4");
    expect(res.status).toBe(422);
    expect(res.json).toMatchObject({ error: "pii", kinds: ["street_address"] });
    expect(calls).toHaveLength(0);
    expect(seen.join("\n")).not.toMatch(CODE_RE);
    expect(places.size()).toBe(0);
  });

  it("still blocks a phone number next to a postal code", async () => {
    const { run, calls } = scriptedRun(() => ({ text: "x" }));
    const { model, seen } = scriptedModel({ advice });
    const app = makeApp(run, model, { places: memoryPlaces(), postal: fakePostal() });
    const s = await session(app.post);
    const res = await s.say("H2X 1Y4, appelez-moi au 514 555-1234");
    expect(res.status).toBe(422);
    expect(res.json.kinds).toContain("phone_number");
    expect(calls).toHaveLength(0);
    expect(seen).toHaveLength(0); // The regex layer fired: no network call.
  });

  it("uses the FSA centroid for an unknown code, and no reference for an unknown area", async () => {
    const { run, calls } = scriptedRun(() => ({ text: "Réponse." }));
    const { model } = scriptedModel({ advice });
    const places = memoryPlaces();
    const app = makeApp(run, model, { places, postal: fakePostal() });
    const s = await session(app.post);
    await s.say("Près de H2X 9Z9 ?");
    expect(calls.at(-1)!.input).toMatch(/secteur H2X \(Montréal\), lieu : ref-/);
    await s.say("Et près de A1A 1A1 ?");
    expect(calls.at(-1)!.input).toContain("[code postal fourni, secteur A1A, position introuvable]");
    expect(app.logs.filter((l) => l.event === "postal_code").map((l) => l.found)).toEqual([true, false]);
  });

  it("works without a postal database: the code still leaves the text", async () => {
    const { run, calls } = scriptedRun(() => ({ text: "Réponse." }));
    const { model, seen } = scriptedModel({ advice });
    const app = makeApp(run, model, {});
    const s = await session(app.post);
    expect((await s.say("H2X 1Y4")).status).toBe(200);
    expect(calls[0]!.input).toBe("[code postal fourni, secteur H2X, position introuvable]");
    expect(seen.join("")).not.toMatch(CODE_RE);
  });

  it("forgets the place when the person ends the conversation", async () => {
    const { run } = scriptedRun(() => ({ text: "Réponse." }));
    const { model } = scriptedModel({ advice });
    const places = memoryPlaces();
    const app = makeApp(run, model, { places, postal: fakePostal() });
    const s = await session(app.post);
    await s.say("H2X 1Y4");
    expect(places.size()).toBe(1);
    const end = await app.app.request("/api/end", {
      method: "POST",
      headers: { origin: ORIGIN },
      body: JSON.stringify({ sessionToken: s.state.token }),
    });
    expect(end.status).toBe(204);
    expect(places.size()).toBe(0);
  });
});

describe("tool API", () => {
  it("refuses a call without the secret header, or with a wrong one", async () => {
    const t = toolsApp();
    expect((await t.call("places_search", { near: "ref-abcdefghijkl" }, null)).status).toBe(403);
    expect((await t.call("places_search", { near: "ref-abcdefghijkl" }, "wrong")).status).toBe(403);
    expect(t.dir.urls).toEqual([]);
  });

  it("answers 503 when the Worker has no TOOLS_SECRET", async () => {
    const t = toolsApp({ secret: "" });
    expect((await t.call("places_search", {}, "")).status).toBe(503);
  });

  it("resolves near to the session place, sends a rounded position, and keeps the list for the reply", async () => {
    const t = toolsApp();
    const point = (await fakePostal().lookup("H2X1Y4"))!;
    await t.places.set("ref-abcdefghijkl", { ...point, lang: "fr", at: Date.now() });
    const res = await t.call("places_search", { near: "ref-abcdefghijkl", service: "vaccination", radius_km: 5 });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ area: "H2X (Montréal)", count: 3, shown_to_person: true });
    expect((res.json.nearest as unknown[]).length).toBe(3);
    // The model gets no position and no list beyond 3 names.
    expect(JSON.stringify(res.json)).not.toMatch(/latitude|"lat"|45\.5/);
    const url = new URL(t.dir.urls[0]!);
    expect(url.pathname).toBe("/v1/resources");
    expect(url.searchParams.get("lat")).toBe("45.51");
    expect(url.searchParams.get("lon")).toBe("-73.569");
    expect(url.searchParams.get("service")).toBe("vaccination");
    expect(url.searchParams.get("radius_km")).toBe("5");
    expect(t.dir.urls.join(" ")).not.toMatch(/H2X/);
    const results = await t.places.take("ref-abcdefghijkl", 0);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ kind: "places", area: "H2X (Montréal)" });
  });

  it("answers 404 with a short instruction for an unknown or malformed reference", async () => {
    const t = toolsApp();
    for (const near of ["ref-zzzzzzzzzzzz", "H2X 1Y4", "session", 45.5, ""]) {
      const res = await t.call("places_search", { near });
      expect(res.status).toBe(404);
      expect(res.json.error).toBe("unknown_place");
    }
    expect(t.dir.urls).toEqual([]);
  });

  it("finds Clic Santé services by words, in French and English", async () => {
    const t = toolsApp();
    const fr = await t.call("appointments_services", { query: "vaccin contre la grippe" });
    const list = fr.json.services as { service: string; name: string }[];
    expect(list[0]!.service).toMatch(/influenza|virus-respiratoires/);
    const en = await t.call("appointments_services", { query: "blood test", lang: "en" });
    expect((en.json.services as { service: string; name: string }[])[0]).toMatchObject({ service: "prise-de-sang", name: "Blood test" });
    expect((await t.call("appointments_services", {})).status).toBe(400);
  });

  it("links the Clic Santé list page at the full-code position (3 decimals), and never returns the URL to the model", async () => {
    const t = toolsApp();
    const point = (await fakePostal().lookup("H2X1Y4"))!;
    await t.places.set("ref-abcdefghijkl", { ...point, lang: "fr", at: Date.now() });
    const res = await t.call("appointments_link", { service: "vaccination-virus-respiratoires", near: "ref-abcdefghijkl" });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.json)).not.toContain("clicsante.ca");
    expect(JSON.stringify(res.json)).not.toMatch(/45\.5/);
    const [r] = await t.places.take("ref-abcdefghijkl", 0);
    expect(r?.kind).toBe("appointments");
    const link = r!.kind === "appointments" ? r!.link : null;
    expect(link!.url).toBe("https://portal3.clicsante.ca/?serviceId=3161&latitude=45.51&longitude=-73.569&fees=0&performSearch=true");
    expect(link!.url).not.toMatch(/H2X|1Y4|45\.5095/);
  });

  it("shows the full postal code to the person only, never in the agent answer", async () => {
    const t = toolsApp();
    const point = (await fakePostal().lookup("H2X1Y4"))!;
    await t.places.set("ref-abcdefghijkl", { ...point, lang: "fr", at: Date.now(), code: "H2X 1Y4" });
    const places = await t.call("places_search", { near: "ref-abcdefghijkl", service: "vaccination" });
    const link = await t.call("appointments_link", { service: "vaccination-virus-respiratoires", near: "ref-abcdefghijkl" });
    for (const res of [places, link]) {
      expect(JSON.stringify(res.json)).not.toMatch(/1Y4/);
      expect(res.json.area).toBe("H2X (Montréal)");
    }
    const results = await t.places.take("ref-abcdefghijkl", 0);
    const p = results.find((r) => r.kind === "places");
    const a = results.find((r) => r.kind === "appointments");
    expect(p && p.kind === "places" && p.area).toBe("H2X 1Y4 (Montréal)");
    expect(a && a.kind === "appointments" && a.link.area).toBe("H2X 1Y4 (Montréal)");
    expect(a && a.kind === "appointments" && new URL(a.link.url).searchParams.get("postalCode")).toBe("H2X1Y4");
  });

  it("answers appointments_search with 404 while the Clic Santé API is off", async () => {
    const t = toolsApp();
    const res = await t.call("appointments_search", { service: "195", near: "ref-abcdefghijkl" });
    expect(res.status).toBe(404);
    expect(res.json.error).toBe("disabled");
  });

  it("seeds a check place from an FSA centroid only", async () => {
    const t = toolsApp();
    const res = await t.call("check/place", { fsa: "H2X" });
    expect(res.status).toBe(200);
    const ref = String(res.json.ref);
    expect(ref).toMatch(PLACE_REF);
    expect(await t.places.get(ref)).toMatchObject({ lat: 45.511247, lng: -73.569393, precision: "fsa" });
    expect((await t.call("check/place", { fsa: "H2X 1Y4" })).status).toBe(400);
  });
});

/** A raw directory resource for the kind filter test. */
const rawResource = (id: string, name: string, services: string[] = []) => ({
  id,
  name,
  services,
  location: { latitude: 45.48, longitude: -73.58 },
  distance_km: Number(id) / 10,
  source_url: `https://sante.gouv.qc.ca/repertoire-ressources/ressource/?nofiche=${id}`,
});

describe("Clic Santé links and catalog", () => {
  it("builds French and English list page links with 3 decimals", () => {
    const flu = serviceOf("195")!;
    expect(portalLink(flu, "en", { lat: 46.81131, lng: -71.21632 })).toBe(
      "https://portal3.clicsante.ca/en?serviceId=195&latitude=46.811&longitude=-71.216&fees=0&performSearch=true",
    );
  });

  it("links the service page for a service with no known id", () => {
    const e = serviceOf("depistage-itss")!;
    expect(e.id).toBeNull();
    expect(appointmentLink(e, "fr", { lat: 45.5, lng: -73.5 }, "H2X").url).toBe("https://portal3.clicsante.ca/services/depistage-itss");
    expect(appointmentLink(e, "en", null, null).url).toBe("https://portal3.clicsante.ca/en/services/sti-screening");
  });

  it("has the 12 known ids and readable titles", () => {
    for (const id of [3161, 195, 204, 3079, 3157, 1000, 227, 3034, 3166, 3169, 3185, 2446]) expect(serviceOf(String(id))?.id).toBe(id);
    expect(slugTitle("vaccination-contre-l-influenza", "fr")).toBe("Vaccination contre l'influenza");
    expect(findServices("RSV baby")[0]?.id).toBe(3157);
    expect(findServices("de la")).toEqual([]);
  });
});

describe("Clic Santé read API client (fixtures only, never live)", () => {
  const now = fixedNow;

  it("parses places with slot counts and never returns a booking URL", () => {
    const places = parseAvailabilities(clicsantePage, "fr");
    expect(places).toEqual([
      {
        id: "12345",
        name: "Pharmacie Exemple - Atwater",
        address: "1 rue Exemple, Montréal, QC H3Z 0A0",
        lat: 45.49,
        lng: -73.58,
        distanceKm: 0.8,
        slots: { days2: 0, days7: 14, later: 120 },
      },
    ]);
    expect(JSON.stringify(places)).not.toContain("publicUrl");
  });

  it("sends the identifying headers, caches the answer, and respects the global rate limit", async () => {
    const seen: Request[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Request(input, init));
      return new Response(JSON.stringify(clicsantePage), { status: 200 });
    }) as typeof fetch;
    let allowed = true;
    const deps = { fetcher, cache: jsonCache(undefined, now), now, log: () => {}, limiter: { limit: async () => ({ success: allowed }) } };
    const q = { serviceId: 195, lat: 45.511, lng: -73.569, radiusKm: 25, lang: "fr" as const };
    expect(await searchAvailabilities(deps, q)).toHaveLength(1);
    expect(seen).toHaveLength(1);
    const req = seen[0]!;
    expect(req.method).toBe("GET");
    expect(req.headers.get("user-agent")).toBe(USER_AGENT);
    expect(req.headers.get("x-trimoz-access-token")).toBe("public");
    const url = new URL(req.url);
    expect(url.host).toBe("api3.clicsante.ca");
    expect(url.searchParams.get("latitude")).toBe("45.511");
    expect(url.searchParams.get("zipcode")).toBeNull();
    // Cached: no second call.
    await searchAvailabilities(deps, q);
    expect(seen).toHaveLength(1);
    // Rate limited: an error, no call.
    allowed = false;
    await expect(searchAvailabilities(deps, { ...q, serviceId: 204 })).rejects.toBeInstanceOf(ClicSanteError);
    expect(seen).toHaveLength(1);
  });

  it("falls back to the link when the API fails (appointments_search on)", async () => {
    const failing = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    const t = toolsApp({ clicsante: { fetcher: failing, cache: jsonCache(undefined, now), now, log: () => {} } });
    const point = (await fakePostal().lookup("H2X1Y4"))!;
    await t.places.set("ref-abcdefghijkl", { ...point, lang: "fr", at: Date.now() });
    const res = await t.call("appointments_search", { service: "195", near: "ref-abcdefghijkl" });
    expect(res.status).toBe(200);
    expect(res.json.places_with_slots).toBeNull();
    const [r] = await t.places.take("ref-abcdefghijkl", 0);
    expect(r?.kind === "appointments" && r.link.url).toContain("serviceId=195");
  });
});

describe("directory client", () => {
  it("finds the next opening in Québec time", () => {
    const schedules = [
      { date: "2026-10-24", status: "open", intervals: [{ opens: "08:00", closes: "11:00" }] },
      { date: "2026-10-24", status: "open", intervals: [{ opens: "13:00", closes: "17:00" }] },
      { date: "2026-10-26", status: "open", intervals: [{ opens: "08:30", closes: "17:00" }] },
    ];
    // 16:00 UTC = 12:00 in Québec (EDT).
    expect(nextOpening(schedules, Date.parse("2026-10-24T16:00:00Z"))).toEqual({
      date: "2026-10-24",
      opens: "13:00",
      closes: "17:00",
      now: false,
    });
    expect(nextOpening(schedules, Date.parse("2026-10-24T18:00:00Z"))).toMatchObject({ opens: "13:00", now: true });
    expect(nextOpening(schedules, Date.parse("2026-10-24T22:00:00Z"))).toMatchObject({ date: "2026-10-26" });
    expect(nextOpening([], Date.now())).toBeNull();
  });

  it("filters places by kind with the directory type, and by name for kinds without a type", async () => {
    const page = {
      data: [
        rawResource("1", "PHARMACIE JEAN-COUTU EXEMPLE", ["Vaccination"]),
        rawResource("2", "PHARMAPRIX EXEMPLE", []),
      ],
    };
    const urls: string[] = [];
    const fetcher = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(url.includes("/hours") ? { schedules: [] } : page), { status: 200 });
    }) as unknown as typeof fetch;
    const deps = directoryDeps(fetcher);
    const pharmacies = await searchPlaces(deps, { lat: 45.477, lng: -73.584, kind: "pharmacy", radiusKm: 10, limit: 10 });
    expect(pharmacies.map((p) => p.id)).toEqual(["1", "2"]);
    const first = new URL(urls[0]!).searchParams;
    expect(first.get("type")).toBe("pharmacie");
    expect(first.get("q")).toBeNull();
    expect(first.get("limit")).toBe("10");
    urls.length = 0;
    await searchPlaces(deps, { lat: 45.477, lng: -73.584, kind: "crisis_centre", radiusKm: 10, limit: 5 });
    expect(new URL(urls[0]!).searchParams.get("type")).toBe("centre-crise");
    // Kinds without a directory type keep the name and service match.
    expect(KIND_RULES.vaccination.keep("les residences tournesol", ["Vaccination"])).toBe(false);
    expect(KIND_RULES.lab.keep("biron laboratoire medical", [])).toBe(true);
  });

  it("maps the recorded directory page to places with official links", async () => {
    const { fetcher } = directoryFetch();
    const items: PlaceItem[] = await searchPlaces(directoryDeps(fetcher), { lat: 45.51, lng: -73.569, radiusKm: 10, limit: 10 });
    expect(items.length).toBeGreaterThan(0);
    for (const i of items) {
      expect(i.sourceUrl.startsWith("https://sante.gouv.qc.ca/")).toBe(true);
      expect(typeof i.lat).toBe("number");
    }
  });
});

/** A Run fake whose agent calls the Worker tools during the turn, like call_api would. */
function toolRun(tools: ReturnType<typeof toolsApp>): RunApi {
  let n = 0;
  const play = async (input: string, options?: CallOptions): Promise<Reply> => {
    const runId = `run_${++n}`;
    const near = /(?:lieu : |place: )(ref-[a-z]{12})/.exec(input)?.[1];
    if (near) {
      await tools.call("places_search", { near, service: "vaccination" });
      options?.onEvent?.({ seq: 2, type: "run.progress", data: { text: "Called places_search" } });
      await tools.call("appointments_link", { near, service: "195" });
      options?.onEvent?.({ seq: 3, type: "run.progress", data: { text: "Called appointments_link" } });
    }
    return { runId, status: "waiting", lastSeq: 4, text: "J'ai trouvé des lieux près de votre secteur. La liste est sous ce message." };
  };
  return { start: (_a, input, _k, o) => play(input, o), turn: (_r, input, _k, o) => play(typeof input === "string" ? input : (input.input ?? ""), o), cancel: async () => {} };
}

describe("attachments in the streamed reply", () => {
  it("carries the places and the link in the result event, with our activity steps", async () => {
    const tools = toolsApp();
    const { model } = scriptedModel({});
    const app = makeApp(toolRun(tools), model, { places: tools.places, postal: fakePostal() });
    const s = await app.post("/api/session", { turnstileToken: "ok", lang: "fr" });
    const res = await app.app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, accept: "text/event-stream" },
      body: JSON.stringify({
        sessionToken: s.json.sessionToken,
        messageId: mid(),
        message: "Vaccin grippe près de H2X 1Y4",
        lang: "fr",
        transcript: [] as TranscriptEntry[],
      }),
    });
    const frames: { event: string; data: string }[] = [];
    for await (const f of readSseFrames(res.body!)) frames.push(f);
    const activities = frames.filter((f) => f.event === "activity").map((f) => JSON.parse(f.data) as Activity);
    const result = JSON.parse(frames.find((f) => f.event === "result")!.data) as ChatResult;
    expect(result.status).toBe(200);
    const body = result.body as ChatReply;
    expect(body.reply.attachments?.places?.area).toBe("H2X 1Y4 (Montréal)");
    expect(body.reply.attachments?.places?.items.length).toBeGreaterThan(0);
    expect(body.reply.attachments?.appointments?.[0]?.url).toContain("serviceId=195");
    expect(activities.map((a) => `${a.kind}:${a.state}`)).toEqual(
      expect.arrayContaining(["location:running", "location:done", "places:done", "appointments:done"]),
    );
    const location = activities.find((a) => a.kind === "location");
    // Activity steps go to the person's browser only: they show the person's own code.
    expect(location?.params).toEqual({ area: "H2X 1Y4" });
    // The results are taken: the next turn starts empty.
    const next = await app.post("/api/chat", {
      sessionToken: body.sessionToken,
      messageId: mid(),
      message: "Merci",
      lang: "fr",
      transcript: body.transcript,
    });
    expect(next.status).toBe(200);
    expect((next.json as ChatReply).reply.attachments).toBeUndefined();
  });

  it("keeps the last places list and one link per service", () => {
    const at = 1;
    const link = (slug: string, url: string) => ({
      kind: "appointments" as const,
      at,
      link: { serviceId: 1, slug, name: { fr: slug, en: slug }, area: "H2X", url },
    });
    const out = toAttachments([
      { kind: "places", at, area: "A", items: [] },
      { kind: "places", at, area: "B", items: [] },
      link("a", "u1"),
      link("a", "u2"),
      link("b", "u3"),
    ]);
    expect(out?.places?.area).toBe("B");
    expect(out?.appointments?.map((l) => l.url)).toEqual(["u2", "u3"]);
    expect(toAttachments([])).toBeUndefined();
  });

  it("maps the Run progress phrase of our operations to steps", () => {
    expect(toolStepKind({ text: "Called places_search" })).toBe("places");
    expect(toolStepKind({ text: "Called appointments_link" })).toBe("appointments");
    expect(toolStepKind({ text: "Called something_else" })).toBeNull();
    expect(toolStepKind({ text: "Searching knowledge for x" })).toBeNull();
  });
});

describe("Clic Santé live answer shape (recorded 2026-10-24, service 3161)", () => {
  it("reads the snake_case places and the counts of each service", async () => {
    const { default: real } = await import("./fixtures/clicsante-real-3161.json");
    const places = parseAvailabilities(real as never, "fr", 10, 3161);
    for (const p of places) {
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.address.length).toBeGreaterThan(0);
      expect(p.slots.days7 + p.slots.later).toBeGreaterThan(0);
    }
    const sorted = places.map((p) => p.distanceKm ?? 1e9);
    expect(sorted).toEqual([...sorted].toSorted((a, b) => a - b));
  });
});
