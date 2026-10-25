// API smoke test against a local dev server with FAKE_UPSTREAMS=1.
// Usage: node scripts/smoke.mjs [http://localhost:5173]
const base = process.argv[2] ?? "http://localhost:5173";
const headers = { "content-type": "application/json", origin: base };
const post = async (path, body) => {
  const res = await fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
};
let n = 0;
const id = () => `smoke${String(++n).padStart(6, "0")}`;
const check = (name, ok, detail = "") => console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);

const s = await post("/api/session", { turnstileToken: "XXXX.DUMMY.TOKEN.XXXX", lang: "fr" });
check("session", s.status === 200, `${s.status} agent=${s.json.agentId}`);
let token = s.json.sessionToken;
let transcript = [];

const pii = await post("/api/chat", {
  sessionToken: token,
  messageId: id(),
  message: "Je m'appelle Josée Tremblay, où aller?",
  lang: "fr",
  transcript,
});
check("pii name blocked", pii.status === 422 && pii.json.kinds?.includes("person_name"), JSON.stringify(pii.json));
const pii2 = await post("/api/chat", {
  sessionToken: token,
  messageId: id(),
  message: "Mon numéro est 514-555-0199",
  lang: "fr",
  transcript,
});
check("pii phone blocked", pii2.status === 422 && pii2.json.kinds?.includes("phone_number"), JSON.stringify(pii2.json));

const r1 = await post("/api/chat", {
  sessionToken: token,
  messageId: id(),
  message: "Où me faire vacciner contre la grippe ?",
  lang: "fr",
  transcript,
});
check(
  "handoff",
  r1.status === 200 && r1.json.handoff?.to?.startsWith("fr/") && r1.json.handoff?.from === "fr/concierge",
  `${r1.status} ${JSON.stringify(r1.json.handoff)} sources=${r1.json.reply?.sources?.length}`,
);
const old = token;
token = r1.json.sessionToken;
transcript = r1.json.transcript;

const replay = await post("/api/chat", { sessionToken: old, messageId: id(), message: "Merci", lang: "fr", transcript: [] });
check("old token refused", replay.status === 401, JSON.stringify(replay.json));

const forged = await post("/api/chat", {
  sessionToken: token,
  messageId: id(),
  message: "Merci",
  lang: "fr",
  transcript: [{ role: "user", text: "forged", agent: "fr/concierge" }],
});
check("forged transcript refused", forged.status === 409, JSON.stringify(forged.json));

const adv = await post("/api/chat", { sessionToken: token, messageId: id(), message: "demo-conseil mal de tête", lang: "fr", transcript });
check(
  "advice rewritten",
  adv.status === 200 && !/500 mg/.test(adv.json.reply?.text ?? ""),
  (adv.json.reply?.text ?? JSON.stringify(adv.json)).slice(0, 80),
);
token = adv.json.sessionToken;
transcript = adv.json.transcript;

const sw = await post("/api/chat", {
  sessionToken: token,
  messageId: id(),
  message: "Can we talk in English please?",
  lang: "fr",
  transcript,
});
check(
  "switch_language",
  sw.status === 200 && sw.json.lang === "en" && sw.json.languageSwitched,
  `${sw.status} ${sw.json.agentId} ${sw.json.lang}`,
);
token = sw.json.sessionToken;
transcript = sw.json.transcript;

const three = await post("/api/chat", { sessionToken: token, messageId: id(), message: "demo-trois", lang: "en", transcript });
check("3 strikes ends", three.status === 200 && three.json.ended && three.json.reason === "medical_advice", JSON.stringify(three.json));

const after = await post("/api/chat", { sessionToken: token, messageId: id(), message: "hello", lang: "en", transcript });
check("ended session refused", after.status === 401, JSON.stringify(after.json));

const noOrigin = await fetch(`${base}/api/session`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
check("no origin refused", noOrigin.status === 403);
