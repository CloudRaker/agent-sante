import { describe, expect, it } from "vitest";
import { vaccineAgent } from "../worker/fake/run";

const FR_SPEC = vaccineAgent("fr");
const EN_SPEC = vaccineAgent("en");
import { agents, validateCatalog } from "../shared/agents";
import { extractSources, officialDomain } from "../shared/sources";
import { readSse, RunClient } from "../worker/run/client";
import { keepPiiSpan, regexPii } from "../worker/safety/checks";
import { signSession, transcriptHash, verifySession } from "../worker/session";

const SECRET = "s".repeat(40);

describe("regex PII layer", () => {
  it.each([
    ["courriel jean@example.com", "email_address"],
    ["appelez-moi au (514) 555-0199", "phone_number"],
    ["j'habite au H2X 1Y4", "postal_code"],
    ["ma carte TREJ 1234 5678", "health_insurance_number"],
    ["mon NAS 046 454 286", "other_identifier"],
    ["née le 12 mars 1984", "date_of_birth"],
  ])("finds %s", (text, kind) => {
    expect(regexPii(text)).toContain(kind);
  });
  it.each([
    "Je suis en H2X",
    "Le Centre antipoison est au 1 800 463-5060",
    "J'ai 42 ans",
    "Mon rendez-vous est le 3 novembre",
    "811 ne répond pas",
    "né en 1984",
  ])("allows %s", (text) => {
    expect(regexPii(text)).toEqual([]);
  });
  it("drops policy-allowed spans", () => {
    const text = "Faut-il aller à l'hôpital Charles-Le Moyne?";
    const start = text.indexOf("Charles");
    expect(keepPiiSpan({ type: "person_name", text: "Charles-Le Moyne", probability: 0.9, start, end: start + 16 }, text)).toBe(false);
    expect(keepPiiSpan({ type: "street_address", text: "rue Masson", probability: 0.9, start: 0, end: 10 }, "rue Masson")).toBe(false);
  });
});

describe("sources", () => {
  it("keeps official https links only, and never santequebec.ca", () => {
    const text =
      "Voir [Grippe](https://www.quebec.ca/sante/grippe), https://sante.quebec/conseils. Pas https://santequebec.ca/medecin ni http://www.quebec.ca/x ni https://evil.example.";
    const s = extractSources(text);
    expect(s.map((x) => x.domain)).toEqual(["quebec.ca", "sante.quebec"]);
    expect(s[0]?.title).toBe("Grippe");
    expect(officialDomain("https://rvsq.gouv.qc.ca/")).toBe("rvsq.gouv.qc.ca");
    expect(officialDomain("https://quebec.ca.evil.example/")).toBeNull();
  });
});

describe("session token", () => {
  it("round-trips, refuses tampering and expiry", async () => {
    const now = Date.now();
    const { token } = await signSession(SECRET, { sid: "s1", run: "run_1", agent: "fr/concierge", lang: "fr", th: "h", n: 0 }, now);
    expect((await verifySession(SECRET, token, now))?.run).toBe("run_1");
    const [h, b, sig] = token.split(".");
    const forged = JSON.parse(atob(b!.replaceAll("-", "+").replaceAll("_", "/")));
    forged.run = "run_other";
    const forgedBody = btoa(JSON.stringify(forged)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    expect(await verifySession(SECRET, `${h}.${forgedBody}.${sig}`, now)).toBeNull();
    expect(await verifySession("o".repeat(40), token, now)).toBeNull();
    expect(await verifySession(SECRET, token, now + 11 * 60_000)).toBeNull();
  });
  it("hashes transcripts by content", async () => {
    const a = await transcriptHash([{ role: "user", text: "a", agent: "fr/concierge" }]);
    expect(a).not.toBe(await transcriptHash([{ role: "user", text: "b", agent: "fr/concierge" }]));
    expect(a).toBe(await transcriptHash([{ role: "user", text: "a", agent: "fr/concierge" }]));
  });
});

describe("agents catalog", () => {
  it("is valid and pairs every agent with its counterpart", () => {
    expect(validateCatalog(agents.catalog)).toEqual([]);
    expect(agents.counterpart("fr/concierge", "en")).toBe("en/concierge");
    expect(agents.isValidHandoff("fr/concierge", FR_SPEC)).toBe(true);
    expect(agents.isValidHandoff("fr/concierge", EN_SPEC)).toBe(false);
  });
});

const sse = (frames: object[]) =>
  new Response(frames.map((f, i) => `id: ${i + 1}\nevent: x\ndata: ${JSON.stringify(f)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream", "x-run-id": "run_9" },
  });

describe("Run client", () => {
  it("parses SSE frames split across chunks", async () => {
    const text = 'data: {"seq":1,"type":"a","data":{}}\n\ndata: {"seq":2,"ty';
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(text));
        c.enqueue(new TextEncoder().encode('pe":"b","data":{}}\n\n'));
        c.close();
      },
    });
    const out = [];
    for await (const e of readSse(stream)) out.push(e.type);
    expect(out).toEqual(["a", "b"]);
  });

  it("joins messages, reads handoff, stops at turn.completed, encodes agent ids", async () => {
    const urls: string[] = [];
    const client = new RunClient({
      token: "crr_test",
      origin: "https://run.test",
      base: "agent-sante",
      fetcher: async (url, init) => {
        urls.push(String(url));
        expect((init?.headers as Record<string, string> | undefined)?.authorization).toBe("Bearer crr_test");
        return sse([
          { seq: 1, type: "run.started", turn: 1, data: { model: "anthropic/claude-haiku-5-5" } },
          { seq: 2, type: "turn.started", turn: 1, data: {} },
          { seq: 3, type: "message", turn: 1, data: { text: "Bonjour." } },
          { seq: 4, type: "event.handoff", turn: 1, data: { to: FR_SPEC, reason: "vaccin" } },
          { seq: 5, type: "turn.completed", turn: 1, data: { turn: 1, reason: "yield" } },
        ]);
      },
    });
    const reply = await client.start("fr/concierge", "hi", "k1");
    expect(urls[0]).toBe("https://run.test/agent-sante/fr/concierge");
    expect(reply).toMatchObject({
      runId: "run_9",
      status: "waiting",
      text: "Bonjour.",
      handoff: { to: FR_SPEC },
      model: "anthropic/claude-haiku-5-5",
    });
  });

  it("maps run_terminal to runGone, and treats run.completed as a terminal reply", async () => {
    const client = new RunClient({
      token: "t",
      origin: "https://run.test",
      base: "b",
      fetcher: async () => sse([{ seq: 7, type: "run.completed", turn: 2, data: { result: "Fin." } }]),
    });
    expect(await client.turn("run_1", "x", "k")).toMatchObject({ status: "completed", text: "Fin." });
    const gone = new RunClient({
      token: "t",
      origin: "https://run.test",
      base: "b",
      fetcher: async () => new Response(JSON.stringify({ error: { code: "run_terminal", message: "ended" } }), { status: 409 }),
    });
    await expect(gone.turn("run_1", "x", "k")).rejects.toMatchObject({ code: "run_terminal", runGone: true });
  });
});
