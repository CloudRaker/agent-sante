// The safety pipeline of one user turn:
// 1. PII check on the user message (blocked messages never reach Run). On the first message,
//    the routing classify call runs at the same time; its result is dropped when PII is found.
// 2. Start a run (a clear specialist, else the concierge) or send a turn, and read the reply.
// 3. Handle the handoff and switch_language events. The read stops at a valid handoff event.
// 4. Verbatim citations: a quote of official text that verifies against the knowledge assets is
//    shown as a citation card, and the medical-advice check sees a placeholder in its place.
//    A quote that does not verify stays as ordinary agent text (worker/citations.ts).
//    A verified quote in the other language gets a machine translation (worker/translate.ts),
//    which runs at the same time as the check. The check never sees the translation.
// 5. Medical-advice check on the agent's own words, with up to 3 attempts in total. The check
//    starts on the reply text when it arrives, and is used only when that text is the final reply.
//    A clarifying question (Run `ask`) is checked with the reply, the question and its choices
//    together (worker/question.ts). The next message answers it: a suggested answer that matches
//    the choices in the token skips the PII check, anything else is free text and gets it.
// The server never logs message text. The client holds the transcript; its hash
// is bound into the session token.
import type { Activity, ActivityKind, ActivityParams, ActivityState } from "../shared/activity";
import type { Agents } from "../shared/agents";
import type { ApiError, ChatRequest, ChatResponse, Counter, Lang, PiiKind, TranscriptEntry } from "../shared/api";
import { LIMITS, RECAP_MESSAGE, isLang } from "../shared/api";
import type { Attachments } from "../shared/places";
import { extractSources } from "../shared/sources";
import { prepareReply, type KbStore, type PreparedReply } from "./citations";
import { cleanShown, pdfOptions, recapFilename, recapMarkdown, toBase64, type PdfRenderer } from "./recap";
import { translateCitations, type TranslationCache, type Translator } from "./translate";
import { isHeartbeat, toolRow, toolStepKind } from "./activity";
import { checkStatus, MAX_STATUS_LINES } from "./status";
import { cleanQuestion, dropEchoedQuestion, isStoredChoice, questionText } from "./question";
import {
  agentMarker,
  findPostalCodes,
  neutralMarker,
  placeRef,
  replacePostalCodes,
  type GeoPoint,
  type PostalLookup,
} from "./places/postal";
import type { PlaceStore, ToolResult } from "./places/store-core";
import { TURN_BUDGET_MS } from "./guard-core";
import type { CallHow, TurnMeter } from "./costs";
import type { CallOptions, Reply, RunApi, RunEvent, TurnBody } from "./run/client";
import { RunError } from "./run/client";
import { MED_THRESHOLD, PII_THRESHOLD, regexPii } from "./safety/checks";
import { hasAdvice, piiCheck, type DecisionModel } from "./safety/milliseconds";
import { keywordRoute, pickRoute, routeLabels, ROUTE_QUESTION, type Classified } from "./safety/routing";
import { signSession, transcriptHash, isTranscript, type SessionClaims } from "./session";

export const MAX_ATTEMPTS = 3;
export const MAX_HOPS = 2;
/** A Run call needs at least this much of the turn budget left, or the turn stops. */
const MIN_CALL_MS = 5_000;

/** The daily cap of Run calls is used up. */
export class AtCapacity extends Error {
  override name = "AtCapacity";
}

export interface LogEvent {
  [key: string]: string | number | boolean | undefined | string[];
}

export interface PipelineDeps {
  run: RunApi;
  model: DecisionModel;
  agents: Agents;
  secret: string;
  now: () => number;
  log: (event: LogEvent) => void;
  expectedModel?: string;
  /** Adds to an aggregate counter (transparency page). Counts only. */
  count?: (counter: Counter, n?: number) => void;
  /**
   * Takes one unit from the daily cap before each Run start or turn. Returns false when the
   * cap is used up. Absent means no cap.
   */
  take?: () => Promise<boolean>;
  /** The knowledge assets for verbatim citations. Absent: no quote verifies (all are checked). */
  kb?: KbStore;
  /** Renders the recap PDF (worker/recap.ts). Absent: a recap request answers recap_failed. */
  pdf?: PdfRenderer;
  /**
   * Translates a verified quote in the other language into the conversation language. Absent:
   * such a quote shows in its own language with a note.
   */
  translator?: Translator;
  translationCache?: TranslationCache;
  /** Time budget for the translations of one reply (default 3 s). */
  translationBudgetMs?: number;
  /**
   * Gets each activity step as it happens (the streamed /api/chat). Steps carry structured
   * params only, never agent message text. Do not log them.
   */
  onActivity?: (activity: Activity) => void;
  /** The browser closed the request: stop the Run calls, cancel the live run. */
  signal?: AbortSignal;
  /** Postal code positions (D1 POSTAL). Absent: a postal code is still replaced, with no position. */
  postal?: PostalLookup;
  /** Session place state and the tool results of the turn (Durable Object PLACES). */
  places?: PlaceStore;
  /** Collects the runs, agent calls, milliseconds calls and translations of this request (cost analytics). */
  meter?: TurnMeter;
}

export type PipelineResult =
  | { kind: "reply"; status: 200; body: ChatResponse; jti: string; runId: string }
  | { kind: "ended"; status: 200; body: ChatResponse }
  | { kind: "error"; status: number; body: ApiError };

const err = (status: number, body: ApiError): PipelineResult => ({ kind: "error", status, body });

/** The words the agents read. Each agent prompt explains this format. */
const WORDS = {
  fr: {
    user: "Personne",
    agent: "Agent",
    handoff: (from: string, reason: string) => `[Conversation transférée depuis ${from}. Raison : ${reason}]`,
    language: (from: string) =>
      `[La personne écrit maintenant en français. Conversation précédente avec ${from}, possiblement en anglais.]`,
    resume: (agent: string) => `[Suite de la conversation avec ${agent}. La session précédente a pris fin.]`,
    intro: "Voici l'échange jusqu'ici. Répondez au dernier message de la personne, en français.",
    simpleOn:
      "[Mode langage simple activé. Répondez en français facile à lire et à comprendre (FALC) : phrases courtes, mots courants, une idée par phrase. Gardez les liens vers les sources.]",
    simpleOff: "[Mode langage simple désactivé. Répondez comme d'habitude.]",
    recapReady: "Votre récapitulatif est prêt. Le fichier PDF a été téléchargé.",
    rewrite:
      "[Vérification automatique] Votre dernière réponse contient un conseil médical personnel (diagnostic, dose, consigne sur un médicament, traitement à faire soi-même ou décision sur le besoin de consulter). " +
      "Réécrivez la réponse complète sans ce conseil (avec la question et ses réponses proposées, s'il y en avait une). Donnez seulement l'information générale officielle, avec ses liens, " +
      "et orientez vers le bon service (811, 911, pharmacien, CLSC, GMF). Ne parlez pas de cette vérification.",
  },
  en: {
    user: "Person",
    agent: "Agent",
    handoff: (from: string, reason: string) => `[Conversation handed off from ${from}. Reason: ${reason}]`,
    language: (from: string) => `[The person now writes in English. Previous conversation with ${from}, possibly in French.]`,
    resume: (agent: string) => `[Continued conversation with ${agent}. The previous session ended.]`,
    intro: "Here is the exchange so far. Answer the last message of the person, in English.",
    simpleOn:
      "[Simple language mode on. Answer in easy-to-read English: short sentences, common words, one idea per sentence. Keep the source links.]",
    simpleOff: "[Simple language mode off. Answer as usual.]",
    recapReady: "Your recap is ready. The PDF file is downloaded.",
    rewrite:
      "[Automatic check] Your last answer contains personal medical advice (a diagnosis, a dose, an instruction about a medication, a home treatment or a decision on the need for care). " +
      "Rewrite the full answer without this advice (with the question and its suggested answers, if there was one). Give only the general official information, with its links, " +
      "and direct the person to the right service (811, 911, pharmacist, CLSC, GMF). Do not mention this check.",
  },
} as const;

/**
 * Simple-language prefix (FALC). A new run gets the "on" line first when the mode is on.
 * A turn in a live run gets the "on" or "off" line only when the mode changed since the last turn.
 */
export function withMode(lang: Lang, input: string, mode: "on" | "off" | null): string {
  if (!mode) return input;
  return `${mode === "on" ? WORDS[lang].simpleOn : WORDS[lang].simpleOff}\n\n${input}`;
}

/** Plain-text transcript for the first message of a new run. */
export function transcriptInput(lang: Lang, header: string, transcript: TranscriptEntry[], message: string): string {
  const w = WORDS[lang];
  const sep = lang === "fr" ? " : " : ": ";
  const lines = transcript.map((e) => `${e.role === "user" ? w.user : w.agent}${sep}${e.text}`);
  lines.push(`${w.user}${sep}${message}`);
  return `${header}\n${w.intro}\n\n${lines.join("\n\n")}`;
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** Validates the request body. Returns an error result or the clean values. */
export function parseChat(body: unknown): { error: ApiError } | { req: ChatRequest } {
  const b = body as Partial<ChatRequest> | null;
  if (!b || typeof b !== "object") return { error: { error: "invalid_request" } };
  const message = typeof b.message === "string" ? b.message.trim() : "";
  if (!message || message.length > LIMITS.messageChars) return { error: { error: "invalid_request" } };
  if (typeof b.messageId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(b.messageId)) {
    return { error: { error: "invalid_request" } };
  }
  if (!isLang(b.lang) || typeof b.sessionToken !== "string") return { error: { error: "invalid_request" } };
  if (!isTranscript(b.transcript) || byteLength(b.transcript) > LIMITS.transcriptBytes) {
    return { error: { error: "invalid_request" } };
  }
  if (b.simple !== undefined && typeof b.simple !== "boolean") return { error: { error: "invalid_request" } };
  if (b.choice !== undefined && typeof b.choice !== "boolean") return { error: { error: "invalid_request" } };
  if (b.recap !== undefined && typeof b.recap !== "boolean") return { error: { error: "invalid_request" } };
  // A recap request carries the fixed app message only, and needs a conversation to sum up.
  if (b.recap === true && (message !== RECAP_MESSAGE[b.lang] || !b.transcript.some((e) => e.role === "agent"))) {
    return { error: { error: "invalid_request" } };
  }
  // Only these fields are read. A run id or an agent id in the body is ignored on purpose.
  return {
    req: {
      sessionToken: b.sessionToken,
      messageId: b.messageId,
      message,
      lang: b.lang,
      transcript: b.transcript,
      simple: b.simple === true,
      ...(b.choice === true ? { choice: true } : {}),
      ...(b.recap === true ? { recap: true, ...(cleanShown(b.shown) ? { shown: cleanShown(b.shown) } : {}) } : {}),
    },
  };
}

/**
 * Wraps the Run calls of one request: each start or turn takes one unit of the daily cap,
 * and gets only the time that is left of the turn budget.
 */
function meteredRun(deps: PipelineDeps, deadline: number): RunApi {
  const budget = async (): Promise<number> => {
    if (deps.signal?.aborted) throw new RunError(499, "client_closed", "The caller closed the request.");
    const left = deadline - deps.now();
    if (left < MIN_CALL_MS) throw new RunError(504, "reply_timeout", "The turn budget is used up.");
    if (deps.take && !(await deps.take())) throw new AtCapacity();
    return left;
  };
  // Each run that a call starts or uses goes to the meter, also when the call fails after Run gave its id.
  const metered = async (call: Promise<Reply>): Promise<Reply> => {
    try {
      const reply = await call;
      deps.meter?.run(reply.runId, reply.model);
      return reply;
    } catch (error) {
      if (error instanceof RunError) deps.meter?.run(error.runId);
      throw error;
    }
  };
  return {
    start: async (agentId, input, key, options) =>
      metered(
        deps.run.start(agentId, input, key, { ...options, timeoutMs: await budget(), ...(deps.signal ? { signal: deps.signal } : {}) }),
      ),
    turn: async (runId, input, key, options) => {
      deps.meter?.run(runId);
      return metered(
        deps.run.turn(runId, input, key, { ...options, timeoutMs: await budget(), ...(deps.signal ? { signal: deps.signal } : {}) }),
      );
    },
    cancel: (runId) => deps.run.cancel(runId),
  };
}

/**
 * Timing of one request: each awaited dependency call as name@start+duration (ms from the
 * request start), and the total. Numbers and call names only, never text.
 */
export async function runChat(input: PipelineDeps, claims: SessionClaims, req: ChatRequest): Promise<PipelineResult> {
  const t0 = input.now();
  const spans: string[] = [];
  const timed = <T extends object>(name: string, target: T | undefined): T | undefined => {
    if (!target) return target;
    return new Proxy(target, {
      get(obj, key, receiver) {
        const value = Reflect.get(obj, key, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const start = input.now();
          const out = (value as (...a: unknown[]) => unknown).apply(obj, args);
          if (out instanceof Promise) {
            const done = () => spans.push(`${name}.${String(key)}@${start - t0}+${input.now() - start}`);
            out.then(done, done);
          }
          return out;
        };
      },
    });
  };
  const deps: PipelineDeps = {
    ...input,
    run: timed("run", input.run)!,
    model: timed("ms", input.meter ? countedModel(input.model, input.meter) : input.model)!,
    ...(input.translator && { translator: timed("translate", input.translator) }),
    ...(input.postal && { postal: timed("postal", input.postal) }),
    ...(input.places && { places: timed("places", input.places) }),
    ...(input.take && {
      take: () => {
        const start = input.now();
        return input.take!().finally(() => spans.push(`cap@${start - t0}+${input.now() - start}`));
      },
    }),
  };
  try {
    return await runChatInner(deps, claims, req);
  } finally {
    input.log({ event: "timing", total_ms: input.now() - t0, spans: spans.join(" ") });
  }
}

async function runChatInner(input: PipelineDeps, claims: SessionClaims, req: ChatRequest): Promise<PipelineResult> {
  // One deadline for all Run calls of this request. It is shorter than the guard lease.
  const deps: PipelineDeps = { ...input, run: meteredRun(input, input.now() + TURN_BUDGET_MS) };
  const { run, model, agents, log } = deps;
  const transcript = req.transcript;
  const steps = activityTracker(deps);

  // A forged or stale transcript cannot bypass the PII check: it must match the token.
  if ((await transcriptHash(transcript)) !== claims.th) {
    log({ event: "transcript_mismatch" });
    return err(409, { error: "transcript_mismatch" });
  }
  if (transcript.length + 2 > LIMITS.transcriptEntries) {
    if (claims.run) await safeCancel(deps, claims.run);
    return { kind: "ended", status: 200, body: { ended: true, reason: "too_long" } };
  }

  // The answer to an open question. A suggested answer counts only when it is exactly one of the
  // choices in the signed token: it is the agent's own text, which passed the medical-advice check.
  // Any other message (also a forged "choice") is free text and goes through the PII check.
  const open = claims.q;
  const isChoice = req.choice === true && isStoredChoice(open, req.message);
  if (req.choice === true && !isChoice) log({ event: "choice_unmatched", open: open !== undefined });

  // Postal code: the only personal information we accept, as a location only. It leaves the text
  // before the PII check and before Run. The PII check sees a neutral marker; the agent sees a
  // marker with the area and the place reference of the session. The position lookup starts now.
  // A recap request is the fixed app message (checked in parseChat): no text of the person.
  const recap = req.recap === true;
  const postalCodes = isChoice || recap ? [] : findPostalCodes(req.message);
  const checkText = postalCodes.length ? replacePostalCodes(req.message, postalCodes, (m) => neutralMarker(req.lang, m.fsa)) : req.message;
  const lookup: Promise<GeoPoint | null> | null =
    postalCodes.length && deps.postal ? deps.postal.lookup(postalCodes[0]!.code).catch(() => null) : null;
  lookup?.catch(() => {});
  const turnStarted = deps.now();

  // Direct routing applies to the first message of a conversation only, in the language of the session.
  const firstMessage = !claims.run && transcript.length === 0 && req.lang === claims.lang && claims.agent === agents.entry(claims.lang);
  // The regex layer runs first: when it fires, no network call is made at all (also no classify).
  const clean = firstMessage && regexPii(checkText).length === 0;
  // A message that names a vaccine needs no classify call.
  const keyword = clean ? keywordRoute(agents, claims.lang, checkText) : undefined;
  const routing = clean && !keyword && model.classify ? classifyFirst(deps, checkText, claims.lang) : null;

  // 1. PII check. Fail closed: no check, no model. A matched suggested answer has no text of the person.
  let kinds: PiiKind[] = [];
  if (!isChoice && !recap) {
    steps.put("privacy", "privacy", "running");
    try {
      const pii = await piiCheck(model, checkText);
      kinds = pii.kinds;
      // Scores and span types only, never the text.
      log({
        event: "pii_score",
        layer: pii.layer,
        score: round(pii.score),
        threshold: PII_THRESHOLD,
        kept: pii.kept,
        dropped: pii.dropped,
      });
    } catch (error) {
      log({ event: "pii_check_unavailable", code: error instanceof Error ? ((error as { code?: string }).code ?? error.name) : "unknown" });
      steps.put("privacy", "privacy", "failed");
      return err(503, { error: "unavailable" });
    }
    steps.put("privacy", "privacy", kinds.length ? "failed" : "done");
  }
  if (kinds.length) {
    // The routing result is dropped: nothing of this message goes further.
    if (deps.meter) {
      deps.meter.route = "blocked";
      deps.meter.agent = claims.agent;
    }
    deps.count?.("piiBlocks");
    log({ event: "pii_blocked", kinds });
    return err(422, { error: "pii", kinds });
  }

  // The message passed: set the session place and write the agent marker.
  let message = checkText;
  let ref: string | null = null;
  let hasPlace = claims.place === true;
  if (postalCodes.length) {
    const first = postalCodes[0]!;
    steps.put("location", "location", "running", { area: `${first.code.slice(0, 3)} ${first.code.slice(3)}` });
    const point = lookup ? await lookup : null;
    if (point && deps.places) {
      try {
        ref = await placeRef(deps.secret, claims.sid);
        await deps.places.set(ref, { ...point, lang: req.lang, at: deps.now(), code: `${first.code.slice(0, 3)} ${first.code.slice(3)}` });
        hasPlace = true;
      } catch {
        ref = null;
        log({ event: "place_store_failed" });
      }
    }
    // Precision only: never the code, never the position.
    log({ event: "postal_code", found: point !== null, precision: point?.precision, stored: ref !== null });
    message = replacePostalCodes(req.message, postalCodes, (m, i) =>
      i === 0 ? agentMarker(req.lang, m.fsa, point, ref) : neutralMarker(req.lang, m.fsa),
    );
    steps.put("location", "location", ref ? "done" : "failed", { area: `${first.code.slice(0, 3)} ${first.code.slice(3)}` });
  }

  if (open && !recap) steps.put("answer", "answer", "done", { via: isChoice ? "choice" : "text" });

  let agent = claims.agent;
  let lang = claims.lang;
  let runId = claims.run;
  let header = "";
  let languageSwitched = false;
  let handoff: { from: string; to: string } | undefined;
  const idem = (step: string) => `${claims.sid}.${req.messageId}.${step}`;
  const simple = req.simple === true;
  const startMode = simple ? "on" : null;

  // The person changed the language in the UI: move to the agent of that language.
  if (req.lang !== lang) {
    const target = agents.counterpart(agent, req.lang);
    if (runId) await safeCancel(deps, runId);
    header = WORDS[req.lang].language(agent);
    agent = target;
    lang = req.lang;
    runId = "";
    languageSwitched = true;
    steps.put("language:ui", "language", "done", { lang });
  }

  // Direct routing: a clear first question starts its specialist, with no concierge turn.
  if (firstMessage) steps.put("routing", "routing", "running");
  const routed = keyword && lang === claims.lang ? keyword : routing ? pickRoute(agents, lang, await routing) : undefined;
  if (routed) {
    handoff = { from: agent, to: routed };
    agent = routed;
  }
  if (firstMessage) steps.put("routing", "routing", "done", { agent, via: routed ? "direct" : "concierge" });

  // Stops the read of a turn at a handoff or language switch that the loop below follows.
  const follows = (from: string, fromLang: Lang) => (event: RunEvent) => {
    if (event.type === "event.handoff") return agents.isValidHandoff(from, event.data.to);
    if (event.type === "event.switch_language") return isLang(event.data.to) && event.data.to !== fromLang;
    return false;
  };
  // The medical-advice check of the text read so far. The final reply reuses it when the text is the same.
  const early = speculativeCheck(
    model,
    (text) => prepareReply(text, deps.kb, lang),
    (citations) =>
      translateCitations(citations, lang, {
        translator: deps.translator,
        cache: deps.translationCache,
        log: (e) => log(e),
        budgetMs: deps.translationBudgetMs,
        onUsage: (u) => deps.meter?.addTranslation(u.input, u.output, u.estimated),
      }),
  );

  let reply: Reply;
  // The run that is alive now, so a failure can cancel it.
  let live = runId;
  const track = (r: Reply): Reply => {
    live = r.runId;
    return r;
  };
  try {
    // 2. Send the turn, or start a run with the checked transcript.
    const turnMode = simple === (claims.simple === true) ? null : simple ? "on" : "off";
    // An open question gets its answer as a Run answer, so the agent knows what it answers.
    const answer = open && !recap && runId === claims.run ? { question_id: open.id, value: message } : undefined;
    const first: SendArgs = { runId, agent, lang, header, transcript, message, idem, startMode, turnMode, answer };
    const firstHow: CallHow = firstMessage ? (routed ? "direct" : "concierge") : open && !recap ? "answer" : languageSwitched ? "language" : "turn";
    if (deps.meter) {
      deps.meter.route = firstHow === "language" ? "turn" : firstHow;
      deps.meter.agent = agent;
    }
    reply = track(
      await steps.call("agent", { agent }, { stopWhen: follows(agent, lang), onText: early.onText }, firstHow, (o) =>
        sendOrStart(deps, first, o),
      ),
    );

    // 3. Custom events. At most MAX_HOPS new agents per user message.
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const h = reply.handoff;
      const s = reply.switchLanguage;
      // The old run is cancelled while the next one starts: no round trip in between.
      let cancelling: Promise<void>;
      let hopHow: CallHow = "handoff";
      if (h && agents.isValidHandoff(agent, h.to)) {
        cancelling = safeCancel(deps, reply.runId);
        header = WORDS[lang].handoff(agent, String(h.reason ?? "").slice(0, 200));
        handoff = { from: handoff?.from ?? agent, to: h.to };
        agent = h.to;
        // The reason is model text: the browser gets only the target agent.
        steps.put(`handoff:${hop}`, "handoff", "done", { agent });
      } else if (s && isLang(s.to) && s.to !== lang) {
        cancelling = safeCancel(deps, reply.runId);
        header = WORDS[s.to].language(agent);
        agent = agents.counterpart(agent, s.to);
        lang = s.to;
        languageSwitched = true;
        hopHow = "language";
        steps.put(`language:${hop}`, "language", "done", { lang });
      } else {
        // h.to is free text from the model: log it only when it is a known agent id.
        if (h) log({ event: "handoff_refused", from: agent, to: agents.get(String(h.to)) ? String(h.to) : "unknown", type: typeof h.to });
        break;
      }
      log({ event: "agent_change", to: agent, hop, early: reply.stoppedEarly === true });
      // A later hop can stop early too, but only when the loop can still follow it.
      const options: CallOptions = { onText: early.onText, ...(hop + 1 < MAX_HOPS ? { stopWhen: follows(agent, lang) } : {}) };
      try {
        const hopInput = withMode(lang, transcriptInput(lang, header, transcript, message), startMode);
        const target = agent;
        if (deps.meter) {
          if (hopHow === "handoff") deps.meter.route = "handoff";
          deps.meter.agent = target;
        }
        reply = track(await steps.call("agent", { agent }, options, hopHow, (o) => run.start(target, hopInput, idem(`hop${hop}`), o)));
      } finally {
        await cancelling;
      }
      checkModel(deps, reply);
    }

    // A read cut at a handoff that no hop followed has no complete reply: never show it.
    let question = cleanQuestion(reply.question);
    if (reply.question && !question) log({ event: "question_dropped" });
    if (question) reply = { ...reply, text: dropEchoedQuestion(reply.text, question.text) };
    if (reply.status === "failed" || (!reply.text && !question) || reply.stoppedEarly) {
      log({ event: "agent_no_reply", status: reply.status, code: reply.failure?.code, early: reply.stoppedEarly === true });
      await safeCancel(deps, reply.runId);
      // Run refused the run for its concurrency limit: the client waits and retries.
      if (reply.failure?.code === "concurrency_limited") return err(429, { error: "busy", retryAfter: 60 });
      return err(503, { error: "unavailable" });
    }

    // 4. Medical-advice check. The person never sees a reply that did not pass.
    let attempts = 1;
    const checkStep = async (text: string, attempt: number) => {
      steps.put(`safety:${attempt}`, "safety", "running");
      // The question and its choices are checked with the reply, as one text.
      const result = await early.result(text, question ? questionText(question, lang) : "");
      logCitations(deps, result.prepared);
      steps.put(`safety:${attempt}`, "safety", result.flagged ? "failed" : "done");
      return result;
    };
    let check = await checkStep(reply.text, attempts);
    log({ event: "advice_score", score: round(check.score), threshold: MED_THRESHOLD, attempt: attempts });
    while (check.flagged && attempts < MAX_ATTEMPTS) {
      deps.count?.("adviceBlocks");
      log({ event: "advice_flagged", score: round(check.score), attempt: attempts });
      const fix = WORDS[lang].rewrite;
      const fixOptions: CallOptions = { onText: early.onText };
      const restart = (key: string, o: CallOptions) =>
        run.start(agent, withMode(lang, `${transcriptInput(lang, header, transcript, message)}\n\n${fix}`, startMode), idem(key), o);
      const flaggedReply = reply;
      const n = attempts;
      const fixed = await steps.call("rewrite", { attempt: n + 1, of: MAX_ATTEMPTS }, fixOptions, "rewrite", async (o) => {
        if (flaggedReply.status !== "waiting") return restart(`fix${n}`, o);
        try {
          return await run.turn(flaggedReply.runId, fix, idem(`fix${n}`), o);
        } catch (error) {
          // The run ended (for example a retry replayed a turn of a cancelled run): use a new run.
          if (!(error instanceof RunError && error.runGone)) throw error;
          log({ event: "run_gone", code: error.code, attempt: n });
          return restart(`fix${n}r`, o);
        }
      });
      reply = track(fixed);
      attempts++;
      question = cleanQuestion(reply.question);
      if (question) reply = { ...reply, text: dropEchoedQuestion(reply.text, question.text) };
      if (reply.text || question) {
        check = await checkStep(reply.text, attempts);
        log({ event: "advice_score", score: round(check.score), threshold: MED_THRESHOLD, attempt: attempts });
      }
    }
    if (check.flagged && recap) {
      // A recap that keeps a flag is dropped, and the conversation goes on with the last token.
      deps.count?.("adviceBlocks");
      log({ event: "recap_flagged", score: round(check.score), attempts });
      return err(422, { error: "recap_unavailable" });
    }
    if (check.flagged) {
      if (hasPlace) await takeResults(deps, claims.sid, turnStarted);
      deps.count?.("adviceBlocks");
      deps.count?.("adviceEnded");
      log({ event: "advice_ended", score: round(check.score), attempts });
      await safeCancel(deps, reply.runId);
      return { kind: "ended", status: 200, body: { ended: true, reason: "medical_advice" } };
    }

    // The recap PDF: the checked text, its verified quotes and the places shown in the conversation.
    let recapFile: { pdf: string; filename: string } | undefined;
    if (recap) {
      if (!deps.pdf) return err(503, { error: "recap_failed" });
      try {
        const markdown = recapMarkdown(check.prepared.displayText, check.prepared.citations, req.shown, lang, deps.now());
        const bytes = await deps.pdf(markdown, pdfOptions(lang));
        recapFile = { pdf: toBase64(bytes), filename: recapFilename(lang, deps.now()) };
        log({ event: "recap_pdf", bytes: bytes.length, citations: check.prepared.citations.length });
      } catch {
        log({ event: "recap_pdf_failed" });
        return err(503, { error: "recap_failed" });
      }
    }

    // The tool results of this turn go with the checked reply. The model wrote a summary only.
    const attachments = hasPlace ? toAttachments(await takeResults(deps, claims.sid, turnStarted)) : undefined;
    if (deps.meter) deps.meter.question = Boolean(question);
    if (question) {
      steps.put("question", "question", "done");
      log({ event: "question_asked", choices: question.choices.length });
    }

    // The body is built in the try block too: a failure here still cancels the live run.
    const next: TranscriptEntry[] = [
      ...transcript,
      { role: "user", text: message, agent },
      // The question and its choices join the agent entry, so the hash chain covers them.
      {
        role: "agent",
        text: [check.prepared.transcriptText, question ? questionText(question, lang) : ""].filter(Boolean).join("\n\n"),
        agent,
      },
    ];
    const { token, claims: signed } = await signSession(
      deps.secret,
      {
        sid: claims.sid,
        run: reply.status === "waiting" ? reply.runId : "",
        agent,
        lang,
        th: await transcriptHash(next),
        n: claims.n + 1,
        simple,
        ...(hasPlace ? { place: true } : {}),
        ...(question ? { q: { id: question.id, c: question.choices } } : {}),
      },
      deps.now(),
    );
    if (reply.status !== "waiting") log({ event: "run_ended_between_turns", status: reply.status });
    deps.count?.("messages");
    return {
      kind: "reply",
      status: 200,
      jti: signed.jti,
      runId: signed.run,
      body: {
        ended: false,
        reply: {
          // A recap shows as a short line and a download card: the PDF holds the text.
          text: recapFile ? WORDS[lang].recapReady : check.prepared.displayText,
          sources: recapFile ? [] : extractSources(check.prepared.displayText),
          ...(!recapFile && check.prepared.citations.length ? { citations: check.prepared.citations } : {}),
          ...(attachments ? { attachments } : {}),
          ...(question ? { question: { text: question.text, choices: question.choices } } : {}),
        },
        agentId: agent,
        lang,
        sessionToken: token,
        expiresAt: signed.exp * 1000,
        transcript: next,
        ...(handoff ? { handoff } : {}),
        ...(languageSwitched ? { languageSwitched } : {}),
        ...(recapFile ? { recap: recapFile } : {}),
      },
    };
  } catch (error) {
    steps.failOpen();
    // A call that failed after Run gave its run id (a timeout, a closed stream): that run is the live one.
    if (error instanceof RunError && error.runId) live = error.runId;
    return runFailure(deps, error, live, claims.run);
  }
}

/**
 * Activity steps of one request. `put` sends a step update; `call` wraps one Run call in a
 * step and turns the Run work rows and heartbeats of that call into child steps.
 */
function activityTracker(deps: PipelineDeps) {
  const t0 = deps.now();
  const open = new Map<string, Activity>();
  const put = (id: string, kind: ActivityKind, state: ActivityState, params?: ActivityParams) => {
    if (!deps.onActivity) return;
    const activity: Activity = { id, kind, state, t: Math.max(0, deps.now() - t0), ...(params ? { params } : {}) };
    if (state === "running") open.set(id, activity);
    else open.delete(id);
    deps.onActivity(activity);
  };
  const close = (ids: Iterable<string>, state: ActivityState) => {
    for (const id of ids) {
      const step = open.get(id);
      if (step) put(id, step.kind, state, step.params);
    }
  };
  let calls = 0;
  let placeCalls = 0;
  let statusLines = 0;
  return {
    put,
    /** Marks every step that still runs as failed (the request failed). */
    failOpen: () => close([...open.keys()], "failed"),
    async call(
      kind: "agent" | "rewrite",
      params: ActivityParams,
      options: CallOptions,
      how: CallHow,
      fn: (options: CallOptions) => Promise<Reply>,
    ): Promise<Reply> {
      const id = `${kind}:${++calls}`;
      const started = deps.now();
      const wait = `${id}.wait`;
      const children = new Set<string>();
      // Run call ids are opaque: the browser gets short ids of our own.
      const rows = new Map<string, string>();
      put(id, kind, "running", params);
      const onEvent = (event: RunEvent) => {
        options.onEvent?.(event);
        if (event.type === "run.progress" && isHeartbeat(event.data)) {
          children.add(wait);
          if (!open.has(wait)) put(wait, "waiting", "running");
          return;
        }
        // Any other event means the model call that was slow has answered.
        close([wait], "done");
        if (event.type === "event.status") {
          // The agent's own words: shown only after the fast check, dropped silently otherwise.
          if (!deps.onActivity) return;
          if (++statusLines > MAX_STATUS_LINES) return deps.log({ event: "status_dropped", reason: "too_many" });
          const stepId = `${id}.s${statusLines}`;
          void checkStatus(deps.model, event.data).then((v) => {
            if (v.ok) put(stepId, "agent_status", "done", { text: v.text });
            else deps.log({ event: "status_dropped", reason: v.reason });
          });
          return;
        }
        if (event.type !== "run.progress") return;
        // Our place tools: Run sends "Called <operation>" after each `_apis` call.
        const placeStep = toolStepKind(event.data);
        if (placeStep) {
          const stepId = `${id}.p${++placeCalls}`;
          children.add(stepId);
          put(stepId, placeStep, "done");
          return;
        }
        const row = toolRow(event.data);
        if (!row) return;
        let rowId = rows.get(row.callId);
        if (!rowId) {
          rowId = `${id}.t${rows.size + 1}`;
          rows.set(row.callId, rowId);
        }
        children.add(rowId);
        put(rowId, row.kind, row.state, row.params);
      };
      // One usage point per agent call (worker/analytics.ts). The agent is the catalog id the call went to.
      const callAgent = typeof params.agent === "string" ? params.agent : (deps.meter?.agent ?? "");
      const record = () => deps.meter?.calls.push({ agent: callAgent, how, ms: deps.now() - started });
      try {
        const reply = await fn({ ...options, onEvent });
        record();
        close(children, "done");
        put(id, kind, reply.status === "failed" ? "failed" : "done", params);
        return reply;
      } catch (error) {
        record();
        close(children, "failed");
        put(id, kind, "failed", params);
        throw error;
      }
    },
  };
}

interface SendArgs {
  runId: string;
  agent: string;
  lang: Lang;
  header: string;
  transcript: TranscriptEntry[];
  message: string;
  idem: (step: string) => string;
  startMode: "on" | null;
  turnMode: "on" | "off" | null;
  /** The answer to the open question of the live run. */
  answer?: { question_id: string; value: string };
}

async function sendOrStart(deps: PipelineDeps, a: SendArgs, options: CallOptions): Promise<Reply> {
  if (a.runId) {
    try {
      if (a.answer) {
        const mode = withMode(a.lang, "", a.turnMode).trim();
        const body: TurnBody = { answer: a.answer, ...(mode ? { input: mode } : {}) };
        try {
          return await deps.run.turn(a.runId, body, a.idem("turn"), options);
        } catch (error) {
          // The run has no open question with this id: send the answer as a plain message.
          if (!(error instanceof RunError && error.code === "question_mismatch")) throw error;
          deps.log({ event: "question_mismatch" });
          return await deps.run.turn(a.runId, withMode(a.lang, a.message, a.turnMode), a.idem("turnq"), options);
        }
      }
      return await deps.run.turn(a.runId, withMode(a.lang, a.message, a.turnMode), a.idem("turn"), options);
    } catch (error) {
      if (!(error instanceof RunError && error.runGone)) throw error;
      // The run ended (done, idle TTL, purge): continue in a new run with the transcript.
      deps.log({ event: "run_gone", code: error.code });
    }
  }
  const header = a.header || (a.transcript.length ? WORDS[a.lang].resume(a.agent) : "");
  const input = header ? transcriptInput(a.lang, header, a.transcript, a.message) : a.message;
  const reply = await deps.run.start(a.agent, withMode(a.lang, input, a.startMode), a.idem("start"), options);
  checkModel(deps, reply);
  return reply;
}

/**
 * The routing classify call of the first message. It never throws: any failure means "no
 * direct route", and the concierge answers first. Logs the label and the score only.
 */
async function classifyFirst(deps: PipelineDeps, message: string, lang: Lang): Promise<Classified | null> {
  try {
    const result = await deps.model.classify!(message, routeLabels(deps.agents, lang), ROUTE_QUESTION);
    deps.log({
      event: "route_score",
      label: deps.agents.get(result.label) ? result.label : "unclear",
      score: round(result.probability),
      ...(result.second !== undefined ? { second: round(result.second) } : {}),
    });
    return result;
  } catch (error) {
    deps.log({ event: "route_unavailable", code: error instanceof Error ? ((error as { code?: string }).code ?? error.name) : "unknown" });
    return null;
  }
}

/** Counts each milliseconds call (PII, routing, advice checks, status lines) for the cost analytics. */
function countedModel(model: DecisionModel, meter: TurnMeter): DecisionModel {
  const counted: DecisionModel = {
    entities: (text, types) => {
      meter.msCalls++;
      return model.entities(text, types);
    },
    yesNoHint: (text, hint) => {
      meter.msCalls++;
      return model.yesNoHint(text, hint);
    },
  };
  if (model.classify) {
    const classify = model.classify.bind(model);
    counted.classify = (text, labels, question) => {
      meter.msCalls++;
      return classify(text, labels, question);
    };
  }
  return counted;
}

/** Max medical-advice checks started on partial text per request (each costs one unit). */
const MAX_EARLY_CHECKS = 6;

/**
 * Starts the medical-advice check on the reply text as soon as a message event brings it, so
 * the check runs while Run finishes the turn. result(text) reuses that check only when `text`
 * is exactly the checked text; any other text gets a new check. The person still sees only a
 * reply whose final text passed the check. The check reads the agent's own words only:
 * `prepare` puts a placeholder in place of each verified citation.
 */
function speculativeCheck(
  model: DecisionModel,
  prepare: (text: string) => Promise<PreparedReply>,
  translate: (citations: PreparedReply["citations"]) => Promise<PreparedReply["citations"]>,
) {
  type Checked = { flagged: boolean; score: number; prepared: PreparedReply };
  /** `extra`: plain text checked with the reply (a question and its choices). It is not prepared or shown. */
  const checkOf = async (text: string, extra = ""): Promise<Checked> => {
    const prepared = await prepare(text);
    // The check reads checkText only: the translations never reach it.
    const checked = [prepared.checkText, extra].filter(Boolean).join("\n\n");
    const [advice, citations] = await Promise.all([hasAdvice(model, checked), translate(prepared.citations)]);
    return { ...advice, prepared: { ...prepared, citations } };
  };
  let last: { text: string; check: Promise<Checked> } | undefined;
  let started = 0;
  return {
    onText: (text: string) => {
      if (!text || text === last?.text || started >= MAX_EARLY_CHECKS) return;
      started++;
      const check = checkOf(text);
      check.catch(() => {}); // A failure surfaces when result() awaits it (fail closed).
      last = { text, check };
    },
    result: (text: string, extra = "") => (!extra && last?.text === text ? last.check : checkOf(text, extra)),
  };
}

/** The tool results of the turn, and clears them. A store failure gives no attachments, never an error. */
async function takeResults(deps: PipelineDeps, sid: string, since: number): Promise<ToolResult[]> {
  if (!deps.places) return [];
  try {
    return await deps.places.take(await placeRef(deps.secret, sid), since);
  } catch {
    deps.log({ event: "place_take_failed" });
    return [];
  }
}

/** The last places list, and up to 3 appointment links (one per service, last wins). */
export function toAttachments(results: ToolResult[]): Attachments | undefined {
  const out: Attachments = {};
  for (const r of results) {
    if (r.kind === "places") out.places = { area: r.area, items: r.items };
  }
  const links = new Map<string, NonNullable<Attachments["appointments"]>[number]>();
  for (const r of results) if (r.kind === "appointments") links.set(r.link.slug, r.link);
  if (links.size) out.appointments = [...links.values()].slice(-3);
  return out.places || out.appointments ? out : undefined;
}

/** Counts and reasons only: never the quote text, never the full address. */
function logCitations(deps: PipelineDeps, prepared: PreparedReply): void {
  if (prepared.citations.length) deps.log({ event: "citation_verified", count: prepared.citations.length });
  for (const u of prepared.unverified) deps.log({ event: "citation_unverified", host: u.host, reason: u.reason });
}

const round = (n: number) => Math.round(n * 1000) / 1000;

function checkModel(deps: PipelineDeps, reply: Reply): void {
  if (deps.expectedModel && reply.model && reply.model !== deps.expectedModel) {
    // Run used a model that is not the expected one: log an alert.
    deps.log({ event: "model_mismatch", alert: true, model: reply.model });
  }
}

async function safeCancel(deps: PipelineDeps, runId: string): Promise<void> {
  if (!runId) return;
  try {
    await deps.run.cancel(runId);
  } catch (error) {
    deps.log({ event: "cancel_failed", code: error instanceof RunError ? error.code : "unknown" });
  }
}

/**
 * Maps a failure to a response. The live run is cancelled, except when the failure leaves it
 * valid (a rate limit, a busy run, a milliseconds outage, the daily cap) and the session token
 * already holds it: then a retry continues the same run, and /api/end can still cancel it.
 */
async function runFailure(deps: PipelineDeps, error: unknown, runId: string, tokenRun: string): Promise<PipelineResult> {
  const runStillValid = !(error instanceof RunError) || error.status === 429 || error.code === "run_busy";
  if (runId && !(runStillValid && runId === tokenRun)) await safeCancel(deps, runId);
  if (error instanceof AtCapacity) {
    deps.log({ event: "at_capacity" });
    return err(503, { error: "at_capacity" });
  }
  if (error instanceof RunError) {
    const alert = [401, 402, 403, 503].includes(error.status) || error.code === "agent_not_found";
    deps.log({ event: "run_error", status: error.status, code: error.code, alert });
    if (error.status === 429) return err(429, { error: "busy", retryAfter: error.retryAfter ?? 60 });
    if (error.code === "run_busy") return err(409, { error: "busy", retryAfter: 5 });
    if (error.code === "reply_timeout") return err(504, { error: "timeout" });
    return err(503, { error: "unavailable" });
  }
  deps.log({ event: "check_unavailable", name: error instanceof Error ? error.name : "unknown" });
  return err(503, { error: "unavailable" });
}
