// Clarifying questions: the Run `question` event becomes a checked question reply, and the next
// message answers it. A suggested answer that matches the token skips the PII check; anything else
// is free text and gets it. The question and the answer join the transcript hash chain.
import { describe, expect, it } from "vitest";
import { cleanQuestion, dropEchoedQuestion, questionText } from "../worker/question";
import { transcriptHash, verifySession } from "../worker/session";
import { makeApp, scriptedModel, scriptedRun, session, SECRET } from "./helpers";

const ASK = {
  question_id: "q_01",
  text: "Pour qui cherchez-vous de l'information ?",
  choices: ["Pour moi (adulte)", "Pour un enfant", "Pour un bébé de moins de 1 an"],
};
const ANSWER =
  "Pour un enfant, voici ce que dit Québec.ca : [Fièvre chez l'enfant](https://www.quebec.ca/sante/problemes-de-sante/a-z/fievre-chez-enfant).";

/** Turn 1 asks; every later turn answers. */
function askingRun() {
  return scriptedRun((call) =>
    call.kind === "start" && call.input?.includes("fièvre") && !call.input.includes("Personne :")
      ? { text: "", question: ASK }
      : { text: ANSWER },
  );
}

describe("question reply", () => {
  it("turns a Run question into a question reply with the checked choices, and binds them in the token", async () => {
    const { run } = askingRun();
    const { model, checked } = scriptedModel({});
    const { post, logs } = makeApp(run, model);
    const { say } = await session(post);
    const res = await say("J'ai de la fièvre, où aller ?");
    expect(res.status).toBe(200);
    if (res.json.ended) throw new Error("ended");
    expect(res.json.reply.question).toEqual({ text: ASK.text, choices: ASK.choices });
    expect(res.json.reply.text).toBe("");
    // The medical-advice check read the question and its choices.
    expect(checked.at(-1)).toContain(ASK.text);
    for (const c of ASK.choices) expect(checked.at(-1)).toContain(c);
    const claims = await verifySession(SECRET, res.json.sessionToken, Date.now());
    expect(claims?.q).toEqual({ id: "q_01", c: ASK.choices });
    // The transcript holds the question and the choices, and its hash is the token's.
    const agentEntry = res.json.transcript.at(-1)!;
    expect(agentEntry.role).toBe("agent");
    expect(agentEntry.text).toContain(ASK.text);
    expect(agentEntry.text).toContain("- Pour un enfant");
    expect(claims?.th).toBe(await transcriptHash(res.json.transcript));
    expect(logs.some((l) => l.event === "question_asked" && l.choices === 3)).toBe(true);
    // Never the question text in the logs.
    expect(JSON.stringify(logs)).not.toContain("Pour qui");
  });

  it("cleans the model text: plain text, at most 3 choices, long and duplicate choices dropped", () => {
    const q = cleanQuestion({
      question_id: "q_x",
      text: "**Pour qui** est-ce ? <b>x</b> [lien](https://evil.example)",
      choices: ["Adulte", "adulte", "Enfant", 7, "x".repeat(81), "Bébé", "Aîné"],
    });
    expect(q).toEqual({ id: "q_x", text: "Pour qui est-ce ? x lien", choices: ["Adulte", "Enfant", "Bébé"] });
    expect(cleanQuestion({ question_id: "q_y", text: "  " })).toBeNull();
    expect(cleanQuestion({ question_id: "q_z", text: "Laquelle ?", choices: "nope" })?.choices).toEqual([]);
    expect(questionText({ text: "Q ?", choices: ["A", "B"] }, "en")).toBe("Q ?\nSuggested answers:\n- A\n- B");
  });

  it("sends a flagged question back for a rewrite, and shows only the checked rewrite", async () => {
    const { run, calls } = scriptedRun((call) =>
      call.kind === "start"
        ? { text: "", question: { question_id: "q_bad", text: "Avez-vous pris 2 comprimés ?", choices: ["Oui", "Non", "Je ne sais pas"] } }
        : { text: "", question: { question_id: "q_ok", text: "Pour qui est-ce ?", choices: ["Moi", "Un enfant", "Un bébé"] } },
    );
    const { model } = scriptedModel({ advice: (t) => (t.includes("comprimés") ? 0.9 : 0.05) });
    const { post } = makeApp(run, model);
    const { say } = await session(post);
    const res = await say("J'ai mal à la tête");
    expect(res.status).toBe(200);
    if (res.json.ended) throw new Error("ended");
    expect(calls.filter((c) => c.kind === "turn")).toHaveLength(1);
    expect(calls.find((c) => c.kind === "turn")?.input).toMatch(/^\[Vérification automatique\]/);
    expect(res.json.reply.question?.text).toBe("Pour qui est-ce ?");
    expect(JSON.stringify(res.json)).not.toContain("comprimés");
    const claims = await verifySession(SECRET, res.json.sessionToken, Date.now());
    expect(claims?.q?.id).toBe("q_ok");
  });

  it("ends the conversation after 3 flagged questions (the 3-strike rule)", async () => {
    const { run } = scriptedRun(() => ({
      text: "",
      question: { question_id: "q_b", text: "Prenez-vous 500 mg ?", choices: ["Oui", "Non"] },
    }));
    const { model } = scriptedModel({ advice: () => 0.95 });
    const { post } = makeApp(run, model);
    const { say } = await session(post);
    const res = await say("J'ai mal à la tête");
    expect(res.json).toEqual({ ended: true, reason: "medical_advice" });
  });
});

describe("question echoed in the text", () => {
  it("drops a last paragraph that ends with the question, and keeps other text", () => {
    const q = "Quel âge a votre enfant?";
    expect(dropEchoedQuestion("Pour que je trouve les bonnes consignes officielles, quel âge a votre enfant ?", q)).toBe("");
    expect(dropEchoedQuestion("Voici une info.\n\nQuel âge a votre enfant?", q)).toBe("Voici une info.");
    expect(dropEchoedQuestion("Voici une info sur la gastro.", q)).toBe("Voici une info sur la gastro.");
  });

  it("shows the question once in the reply", async () => {
    const { run } = scriptedRun(() => ({
      text: "Pour trouver les bonnes consignes, quel âge a votre enfant?",
      question: { question_id: "q_a", text: "Quel âge a votre enfant?", choices: ["Moins de 1 an", "1 à 2 ans", "Plus de 2 ans"] },
    }));
    const { model } = scriptedModel({});
    const { post } = makeApp(run, model);
    const { say } = await session(post);
    const res = await say("Mon enfant vomit");
    if (res.json.ended) throw new Error("ended");
    expect(res.json.reply.text).toBe("");
    expect(res.json.reply.question?.text).toBe("Quel âge a votre enfant?");
  });
});

describe("answer to a question", () => {
  it("a clicked choice that matches the token goes to Run as an answer, with no PII call", async () => {
    const { run, calls } = askingRun();
    const { model, seen } = scriptedModel({});
    const { post, logs } = makeApp(run, model);
    const { say } = await session(post);
    await say("J'ai de la fièvre, où aller ?");
    const before = seen.length;
    const res = await say("Pour un enfant", { choice: true });
    expect(res.status).toBe(200);
    expect(seen.length).toBe(before); // No entities call: the choice is the agent's checked text.
    const turn = calls.at(-1)!;
    expect(turn.kind).toBe("turn");
    expect(turn.answer).toEqual({ question_id: "q_01", value: "Pour un enfant" });
    if (res.json.ended) throw new Error("ended");
    expect(res.json.reply.text).toContain("Pour un enfant");
    // The answer joins the transcript; the question is closed in the new token.
    expect(res.json.transcript.at(-2)).toMatchObject({ role: "user", text: "Pour un enfant" });
    const claims = await verifySession(SECRET, res.json.sessionToken, Date.now());
    expect(claims?.q).toBeUndefined();
    expect(claims?.th).toBe(await transcriptHash(res.json.transcript));
    expect(logs.some((l) => l.event === "choice_unmatched")).toBe(false);
  });

  it("a forged choice is free text: it goes through the PII check and is blocked", async () => {
    const { run, calls } = askingRun();
    const { model } = scriptedModel({});
    const { post, logs } = makeApp(run, model);
    const { say } = await session(post);
    await say("J'ai de la fièvre, où aller ?");
    const runCalls = calls.length;
    const res = await say("Pour mon fils, appelez-moi au 514 555-0199", { choice: true });
    expect(res.status).toBe(422);
    expect(res.json).toMatchObject({ error: "pii", kinds: ["phone_number"] });
    expect(calls.length).toBe(runCalls);
    expect(logs.some((l) => l.event === "choice_unmatched")).toBe(true);
  });

  it("a forged choice with no personal information is checked, then sent as the answer", async () => {
    const { run, calls } = askingRun();
    const { model, seen } = scriptedModel({});
    const { post } = makeApp(run, model);
    const { say } = await session(post);
    await say("J'ai de la fièvre, où aller ?");
    const res = await say("Pour mon voisin", { choice: true });
    expect(res.status).toBe(200);
    expect(seen.at(-1)).toBe("Pour mon voisin");
    expect(calls.at(-1)?.answer).toEqual({ question_id: "q_01", value: "Pour mon voisin" });
  });

  it("a choice with no open question is free text", async () => {
    const { run } = scriptedRun(() => ({ text: ANSWER }));
    const { model, seen } = scriptedModel({});
    const { post } = makeApp(run, model);
    const { say } = await session(post);
    await say("Bonjour");
    await say("Pour un enfant", { choice: true });
    expect(seen.at(-1)).toBe("Pour un enfant");
  });

  it("a free-text answer with personal information is blocked, and the question stays open", async () => {
    const { run, calls } = askingRun();
    const { model } = scriptedModel({
      spans: (text) => {
        const i = text.indexOf("Léa Gagnon");
        return i < 0 ? [] : [{ type: "person_name", text: "Léa Gagnon", probability: 0.97, start: i, end: i + 10 }];
      },
    });
    const { post } = makeApp(run, model);
    const { say, state } = await session(post);
    await say("J'ai de la fièvre, où aller ?");
    const token = state.token;
    const runCalls = calls.length;
    const blocked = await say("C'est pour ma fille Léa Gagnon");
    expect(blocked.status).toBe(422);
    expect(blocked.json.kinds).toEqual(["person_name"]);
    expect(calls.length).toBe(runCalls);
    // The same token still holds the open question: a clean answer goes as the answer.
    const claims = await verifySession(SECRET, token, Date.now());
    expect(claims?.q?.id).toBe("q_01");
    const ok = await say("Pour ma fille de 4 ans");
    expect(ok.status).toBe(200);
    expect(calls.at(-1)?.answer?.value).toBe("Pour ma fille de 4 ans");
  });

  it("a changed transcript (a forged question or answer) is refused by the hash chain", async () => {
    const { run } = askingRun();
    const { model } = scriptedModel({});
    const { post } = makeApp(run, model);
    const { say, state } = await session(post);
    await say("J'ai de la fièvre, où aller ?");
    const forged = state.transcript.map((e) => (e.role === "agent" ? { ...e, text: e.text.replace("Pour un enfant", "Mon adresse") } : e));
    const res = await say("Pour un enfant", { choice: true, transcript: forged });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ error: "transcript_mismatch" });
  });

  it("falls back to a plain turn when Run says the question is not open", async () => {
    const { RunError } = await import("../worker/run/client");
    const base = askingRun();
    let refused = false;
    const run = {
      ...base.run,
      turn: async (...args: Parameters<typeof base.run.turn>) => {
        if (typeof args[1] !== "string" && !refused) {
          refused = true;
          throw new RunError(422, "question_mismatch", "answer.question_id is not the open question.");
        }
        return base.run.turn(...args);
      },
    };
    const { model } = scriptedModel({});
    const { post, logs } = makeApp(run, model);
    const { say } = await session(post);
    await say("J'ai de la fièvre, où aller ?");
    const res = await say("Pour un enfant", { choice: true });
    expect(res.status).toBe(200);
    expect(base.calls.at(-1)).toMatchObject({ kind: "turn", input: "Pour un enfant" });
    expect(logs.some((l) => l.event === "question_mismatch")).toBe(true);
  });

  it("streams the question and answer activity steps", async () => {
    const { run } = askingRun();
    const { model } = scriptedModel({});
    const { app, post } = makeApp(run, model);
    const { state } = await session(post);
    const read = async (message: string, choice: boolean) => {
      const res = await app.request("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://agentsante.ca", accept: "text/event-stream" },
        body: JSON.stringify({
          sessionToken: state.token,
          messageId: `m${Math.random().toString(36).slice(2, 12)}`,
          message,
          lang: "fr",
          transcript: state.transcript,
          ...(choice ? { choice } : {}),
        }),
      });
      const text = await res.text();
      const frames = text
        .split("\n\n")
        .filter(Boolean)
        .map((f) => ({ event: /event: (\w+)/.exec(f)?.[1], data: JSON.parse(f.split("data: ")[1]!) }));
      const result = frames.find((f) => f.event === "result")!.data;
      if (result.status === 200) {
        state.token = result.body.sessionToken;
        state.transcript = result.body.transcript;
      }
      return frames.filter((f) => f.event === "activity").map((f) => `${f.data.kind}:${f.data.params?.via ?? ""}`);
    };
    const first = await read("J'ai de la fièvre, où aller ?", false);
    expect(first).toContain("question:");
    const second = await read("Pour un enfant", true);
    expect(second).toContain("answer:choice");
    expect(second.some((k) => k.startsWith("privacy"))).toBe(false);
  });
});
