// Conversation state. It lives in memory only: no storage, no cookies.
// A reload or a closed tab ends the conversation.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage } from "@/components/arc/chat-thread/chat-thread";
import { RECAP_MESSAGE, type AgentQuestion, type Citation, type EndReason, type Lang, type PiiKind, type SessionResponse, type Source, type TranscriptEntry } from "@shared/api";
import type { Attachments } from "@shared/places";
import { ApiFailure, endSession, sendChatStream } from "@/lib/api";
import { downloadPdf } from "@/lib/download";
import { applyActivity, settleSteps, type ActivityStep, type TurnActivity } from "./activity";

export const USER_ID = "vous";
export const AGENT_ID = "agent";

export interface ReplyMeta {
  sources: Source[];
  /** Verified verbatim quotes. The reply text holds a `[[citation:N]]` line for each. */
  citations?: Citation[];
  /** Places and Clic Santé links that the agent tools found for this reply. */
  attachments?: Attachments;
  /** Agent id when this reply came from a handoff. */
  handoffTo?: string;
  languageSwitched?: boolean;
  /** What the agents did for this reply (steps and total time). */
  activity?: TurnActivity;
  /** A clarifying question of the agent, checked like the reply. */
  question?: AgentQuestion;
  /** The answer of the person to `question`. Set: the question card is locked. */
  answer?: string;
  /** A recap reply: the PDF (base64) and its file name, to download it again. */
  recap?: { pdf: string; filename: string };
}

/** The places and Clic Santé links shown in the conversation, newest first, for the recap PDF. */
export function shownAttachments(meta: Record<string, ReplyMeta>): Attachments | undefined {
  const all = Object.values(meta).reverse();
  const items = new Map<string, NonNullable<Attachments["places"]>["items"][number]>();
  let area = "";
  const links = new Map<string, NonNullable<Attachments["appointments"]>[number]>();
  for (const m of all) {
    for (const p of m.attachments?.places?.items ?? []) if (!items.has(p.id) && items.size < 10) items.set(p.id, p);
    if (!area && m.attachments?.places?.area) area = m.attachments.places.area;
    for (const a of m.attachments?.appointments ?? []) if (!links.has(a.url) && links.size < 4) links.set(a.url, a);
  }
  if (!items.size && !links.size) return undefined;
  return {
    ...(items.size ? { places: { area, items: [...items.values()] } } : {}),
    ...(links.size ? { appointments: [...links.values()] } : {}),
  };
}

export type Notice =
  | { kind: "pii"; kinds: PiiKind[] }
  | { kind: "error"; code: "unavailable" | "busy" | "timeout" | "offline" | "stuck" }
  | { kind: "recap"; code: "unavailable" | "failed" };

export type Ended = { reason: EndReason | "expired" | "closed" | "capacity" | "maintenance" };

export type Phase = "idle" | "working";

interface Options {
  session: SessionResponse;
  lang: Lang;
  /** The conversation moved to the other language (agent event). */
  onLanguage: (lang: Lang) => void;
  /** Simple-language mode (FALC): the Worker tells the agent. */
  simple?: boolean;
}

export function newId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

export function useChat({ session, lang, onLanguage, simple = false }: Options) {
  const token = useRef(session.sessionToken);
  const expiresAt = useRef(session.expiresAt);
  const transcript = useRef<TranscriptEntry[]>(session.transcript);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [meta, setMeta] = useState<Record<string, ReplyMeta>>({});
  const [phase, setPhase] = useState<Phase>("idle");
  /** The live steps of the turn in flight. */
  const [steps, setSteps] = useState<ActivityStep[]>([]);
  const stepsRef = useRef<ActivityStep[]>([]);
  const abort = useRef<AbortController | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [ended, setEnded] = useState<Ended | null>(null);
  const [agentId, setAgentId] = useState(session.agentId);
  const inFlight = useRef(false);
  /** The reply id whose question waits for an answer. The next message answers it. */
  const openQuestion = useRef<string | null>(null);
  const [openQuestionId, setOpenQuestionId] = useState<string | null>(null);
  /** Failed attempts by message id: the second failure of the same message offers a fresh page. */
  const failures = useRef(new Map<string, number>());
  /** Messages sent as a suggested answer, by id (a retry sends them the same way). */
  const choiceIds = useRef(new Set<string>());
  /** Recap requests, by id (the bubble shows a label; the request sends the app message). */
  const recapIds = useRef(new Set<string>());
  const metaRef = useRef<Record<string, ReplyMeta>>({});
  useEffect(() => {
    metaRef.current = meta;
  }, [meta]);
  const langRef = useRef(lang);
  const onLanguageRef = useRef(onLanguage);
  const simpleRef = useRef(simple);
  useEffect(() => {
    langRef.current = lang;
    onLanguageRef.current = onLanguage;
    simpleRef.current = simple;
  }, [lang, onLanguage, simple]);

  const finish = useCallback((reason: Ended["reason"]) => {
    if (token.current) endSession(token.current);
    token.current = "";
    transcript.current = [];
    setPhase("idle");
    setEnded({ reason });
  }, []);

  // The session token expires 10 minutes after the last answer.
  useEffect(() => {
    if (ended) return;
    const check = () => {
      if (token.current && Date.now() >= expiresAt.current) finish("expired");
    };
    const timer = window.setInterval(check, 5000);
    return () => window.clearInterval(timer);
  }, [ended, finish]);

  // Leaving the chat closes the stream; the Worker then stops the turn and cancels its run.
  useEffect(() => () => abort.current?.abort(), []);

  // Closing or reloading the tab ends the run at once, so its short retention period starts.
  useEffect(() => {
    const onHide = () => {
      if (token.current) endSession(token.current);
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, []);

  /** Sets (or clears) the answer shown on the card of the open question. */
  const markAnswer = useCallback((answer: string | undefined) => {
    const replyId = openQuestion.current;
    if (!replyId) return;
    setMeta((m) => (m[replyId] ? { ...m, [replyId]: { ...m[replyId], answer } } : m));
  }, []);

  const deliver = useCallback(
    async (text: string, messageId: string): Promise<"sent" | "blocked" | "failed" | "offline"> => {
      if (inFlight.current || !token.current) return "failed";
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        setNotice({ kind: "error", code: "offline" });
        return "offline";
      }
      inFlight.current = true;
      // The message answers the open question: the card locks at once, and opens again if the
      // message does not go through.
      markAnswer(text);
      setNotice(null);
      setPhase("working");
      stepsRef.current = [];
      setSteps([]);
      const started = performance.now();
      const ctrl = new AbortController();
      abort.current = ctrl;
      setMessages((list) => [
        ...list.filter((m) => m.id !== messageId),
        { id: messageId, authorId: USER_ID, text, createdAt: new Date(), status: "sending" },
      ]);
      const setStatus = (status: ChatMessage["status"]) =>
        setMessages((list) => list.map((m) => (m.id === messageId ? { ...m, status } : m)));
      const isRecap = recapIds.current.has(messageId);
      try {
        const shown = isRecap ? shownAttachments(metaRef.current) : undefined;
        const pending = sendChatStream(
          {
            sessionToken: token.current,
            messageId,
            message: isRecap ? RECAP_MESSAGE[langRef.current] : text,
            lang: langRef.current,
            transcript: transcript.current,
            simple: simpleRef.current,
            ...(choiceIds.current.has(messageId) ? { choice: true } : {}),
            ...(isRecap ? { recap: true, ...(shown ? { shown } : {}) } : {}),
          },
          (activity) => {
            stepsRef.current = applyActivity(stepsRef.current, activity);
            setSteps(stepsRef.current);
            // The conversation moves to the other language: the interface follows at once,
            // not only when the reply arrives.
            const next = activity.kind === "language" && activity.state === "done" ? activity.params?.lang : undefined;
            if ((next === "fr" || next === "en") && next !== langRef.current) onLanguageRef.current(next);
          },
          ctrl.signal,
        );
        // The request has left: the person sees "Envoyé", and the agent row shows the progress.
        setStatus("sent");
        const res = await pending;
        if (res.ended) {
          setStatus("sent");
          finish(res.reason);
          return "sent";
        }
        // The answer went through: that question is closed for good.
        openQuestion.current = null;
        token.current = res.sessionToken;
        expiresAt.current = res.expiresAt;
        transcript.current = res.transcript;
        setAgentId(res.agentId);
        const replyId = newId();
        // Read the steps now: the state updater runs later, after the finally block clears them.
        const done = stepsRef.current.length ? { steps: settleSteps(stepsRef.current), totalMs: performance.now() - started } : undefined;
        setMeta((m) => ({
          ...m,
          [replyId]: {
            sources: res.reply.sources,
            citations: res.reply.citations,
            attachments: res.reply.attachments,
            handoffTo: res.handoff?.to,
            languageSwitched: res.languageSwitched,
            ...(done ? { activity: done } : {}),
            ...(res.reply.question ? { question: res.reply.question } : {}),
            ...(res.recap ? { recap: res.recap } : {}),
          },
        }));
        if (res.recap) downloadPdf(res.recap.pdf, res.recap.filename);
        openQuestion.current = res.reply.question ? replyId : null;
        setOpenQuestionId(openQuestion.current);
        setMessages((list) => [
          ...list.map((m) => (m.id === messageId ? { ...m, status: "sent" as const } : m)),
          // A reply that is only a question still needs text: the thread skips an empty message.
          { id: replyId, authorId: AGENT_ID, text: res.reply.text || res.reply.question?.text || "", createdAt: new Date() },
        ]);
        if (res.lang !== langRef.current) onLanguageRef.current(res.lang);
        return "sent";
      } catch (error) {
        const failure = error instanceof ApiFailure ? error : new ApiFailure(0, { error: "unavailable" });
        const code = failure.body.error;
        markAnswer(undefined);
        if (isRecap && (code === "recap_unavailable" || code === "recap_failed")) {
          // The conversation goes on: the recap row leaves the thread, and a notice says why.
          setMessages((list) => list.filter((m) => m.id !== messageId));
          setNotice({ kind: "recap", code: code === "recap_unavailable" ? "unavailable" : "failed" });
          return "failed";
        }
        if (code === "pii") {
          // The message never left for the model. Take it out of the thread; the composer gets it back.
          setMessages((list) => list.filter((m) => m.id !== messageId));
          setNotice({ kind: "pii", kinds: failure.body.kinds ?? [] });
          return "blocked";
        }
        if (code === "at_capacity" || code === "maintenance") {
          setStatus("sent");
          finish(code === "at_capacity" ? "capacity" : "maintenance");
          return "failed";
        }
        if (code === "session_expired" || code === "transcript_mismatch") {
          setStatus("sent");
          finish("expired");
          return "failed";
        }
        setStatus("failed");
        const mapped = code === "busy" || code === "rate_limited" ? "busy" : code === "timeout" ? "timeout" : "unavailable";
        const count = (failures.current.get(messageId) ?? 0) + 1;
        failures.current.set(messageId, count);
        // The same message fails again: this session may be stuck. Offer a new page.
        setNotice({ kind: "error", code: mapped === "unavailable" && count >= 2 ? "stuck" : mapped });
        return "failed";
      } finally {
        if (abort.current === ctrl) abort.current = null;
        stepsRef.current = [];
        setSteps([]);
        setPhase("idle");
        inFlight.current = false;
      }
    },
    [finish, markAnswer],
  );

  /**
   * `choice`: the text is a suggested answer that the person clicked on the question card.
   * `id` lets a voice message keep its row: the transcript replaces the audio bubble in place.
   */
  const send = useCallback(
    (text: string, options: { choice?: boolean; id?: string } = {}) => {
      const id = options.id ?? newId();
      if (options.choice) choiceIds.current.add(id);
      return deliver(text, id);
    },
    [deliver],
  );

  /** Asks the agent for the recap of the conversation. `label` is the line the thread shows. */
  const recap = useCallback(
    (label: string) => {
      const id = newId();
      recapIds.current.add(id);
      return deliver(label, id);
    },
    [deliver],
  );

  /** The current session token (for /api/transcribe). Empty when the conversation ended. */
  const currentToken = useCallback(() => token.current, []);

  const retry = useCallback(
    (messageId: string) => {
      const failed = messages.find((m) => m.id === messageId);
      if (failed?.text) void deliver(failed.text, messageId);
    },
    [messages, deliver],
  );

  const dismissNotice = useCallback(() => setNotice(null), []);

  return { messages, meta, phase, steps, notice, ended, agentId, openQuestionId, send, recap, retry, dismissNotice, finish, currentToken };
}
