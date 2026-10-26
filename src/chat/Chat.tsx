// The chat screen: thread, live activity steps, one morphing alert, composer.
// The person never sees an unchecked reply: the thread receives a reply only after both checks pass.
import { useReducedMotion } from "motion/react";
import { CircleCheck, FileDown, FileText, LogOut, MessageCircleOff, Phone, RotateCw, X } from "lucide-react";
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { Alert } from "@/components/arc/alert/alert";
import { Button } from "@/components/arc/button/button";
import {
  ChatComposer,
  ChatThread,
  type ChatComposerHandle,
  type ChatMessage,
  type ChatThreadHandle,
} from "@/components/arc/chat-thread/chat-thread";
import { EmptyState } from "@/components/arc/empty-state/empty-state";
import { LIMITS, type Lang, type SessionResponse } from "@shared/api";
import { piiMessage, useI18n } from "@/i18n";
import { usePrefs } from "@/app/prefs";
import { latestStatus, livePhase } from "./activity";
import { ActivityList } from "./ActivityTimeline";
import { AssistantReply } from "./AssistantReply";
import { canRecord, useRecorder, type RecorderError } from "./recorder";
import { MicButton, RecordingBar, VOICE_DISCLOSURE_ID, VoiceBubble } from "./VoiceMessage";
import { useVoice } from "./useVoice";
import { AGENT_ID, USER_ID, useChat } from "./useChat";
import styles from "./chat.module.css";
import voiceStyles from "./voice.module.css";

/** Typing pause before the greeting, after the gate. */
const GREETING_MS = 600;

export interface ChatHandle {
  focusComposer: () => void;
}

export function Chat({
  session,
  intro = [],
  onLanguage,
  onRestart,
  handle,
}: {
  session: SessionResponse;
  /** The consent messages of the gate, shown first so the screen does not change. Display only. */
  intro?: ChatMessage[];
  onLanguage: (lang: Lang) => void;
  onRestart: () => void;
  handle?: Ref<ChatHandle>;
}) {
  const { t, lang } = useI18n();
  const { simple } = usePrefs();
  const chat = useChat({ session, lang, onLanguage, simple });
  const composer = useRef<ChatComposerHandle>(null);
  const thread = useRef<ChatThreadHandle>(null);
  const restartButton = useRef<HTMLButtonElement>(null);
  const busy = chat.phase !== "idle";
  const mic = useRef<HTMLButtonElement>(null);
  // The mic shows where the browser can record. Nothing is asked before the first tap.
  const [canMic] = useState(canRecord);
  /** A visible note under the composer (mic blocked, no mic). */
  const [micNote, setMicNote] = useState<string | null>(null);
  /** One polite line for screen readers (cancelled, mic errors). */
  const [said, setSaid] = useState("");

  useImperativeHandle(handle, () => ({ focusComposer: () => composer.current?.focus() }), []);

  // After the gate, focus goes to the message box.
  useEffect(() => {
    composer.current?.focus();
  }, []);

  const openQuestion = chat.openQuestionId;

  // When the conversation ends, focus goes to the restart button, next to the explanation.
  useEffect(() => {
    if (chat.ended) restartButton.current?.focus();
  }, [chat.ended]);

  const onSend = useCallback(
    async (text: string, id?: string) => {
      const clean = text.slice(0, LIMITS.messageChars);
      const result = await chat.send(clean, { id });
      // A blocked or offline message goes back into the box, so the person edits it instead of typing it again.
      // A voice message too: its transcript becomes text in the box, with the usual PII alert.
      if (result === "blocked" || result === "offline") composer.current?.fill(clean);
    },
    [chat],
  );

  // Voice messages: the bubble shows at once, then its transcript takes its row and goes through
  // the normal chat path (PII check, routing, model), exactly like typed text.
  const voice = useVoice({
    token: chat.currentToken,
    onText: (id, text) => void onSend(text, id),
    onExpired: () => chat.finish("expired"),
  });
  const v = t.voice;
  const onMicError = useCallback(
    (error: RecorderError) => {
      const note = error === "denied" ? v.denied : error === "no_mic" ? v.noMic : v.micFailed;
      setMicNote(note);
      setSaid(note);
    },
    [v],
  );
  const recorder = useRecorder({ maxMs: LIMITS.audioSeconds * 1000, onDone: voice.add, onError: onMicError });
  const recording = recorder.state === "recording";
  const cancelled = useRef(false);
  const startRecording = useCallback(() => {
    setMicNote(null);
    setSaid("");
    voice.clearFailed();
    void recorder.start();
  }, [recorder, voice]);
  const cancelRecording = useCallback(() => {
    cancelled.current = true;
    recorder.cancel();
    setSaid(v.cancelled);
  }, [recorder, v]);
  // After a cancel, focus goes back to the mic (the composer shows again in the same render).
  useEffect(() => {
    if (!recording && cancelled.current) {
      cancelled.current = false;
      mic.current?.focus();
    }
  }, [recording]);
  /** The box waits while an agent turn runs or a transcript is on its way, so the messages stay in order. */
  const locked = busy || voice.busy;
  // The box is disabled while a turn runs or a transcript is on its way; focus returns to it when
  // the answer (or an error) is in. A reply with a question keeps the focus on its card instead
  // (the card takes it when it appears).
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !locked && !chat.ended && !openQuestion) composer.current?.focus();
    wasBusy.current = locked;
  }, [locked, chat.ended, openQuestion]);
  // The greeting is a message of the agent, after the consent steps. Display only. After the gate it
  // comes after a short typing pause, like the gate messages, so it glides in instead of jumping.
  const [greetingAt] = useState(() => new Date());
  const reducedMotion = useReducedMotion();
  const [greeted, setGreeted] = useState(() => intro.length === 0 || !!reducedMotion);
  useEffect(() => {
    if (greeted) return;
    const timer = window.setTimeout(() => setGreeted(true), GREETING_MS);
    return () => window.clearTimeout(timer);
  }, [greeted]);
  const messages = useMemo(
    () => [
      ...intro,
      ...(greeted ? [{ id: "intro-greeting", authorId: AGENT_ID, text: t.gate.greeting, createdAt: greetingAt }] : []),
      ...chat.messages,
      ...voice.items.map((item) => ({ id: item.id, authorId: USER_ID, createdAt: item.createdAt })),
    ],
    [intro, t, greeted, greetingAt, chat.messages, voice.items],
  );
  const fresh = chat.messages.length === 0 && voice.items.length === 0;
  const renderOwn = useCallback(
    (message: ChatMessage) => {
      const item = voice.items.find((x) => x.id === message.id);
      if (!item) return null;
      return (
        <VoiceBubble
          item={item}
          onRetry={() => void voice.retry(item.id)}
          onType={() => {
            voice.remove(item.id);
            composer.current?.focus();
          }}
        />
      );
    },
    [voice],
  );

  const participants = useMemo(
    () => [
      { id: USER_ID, name: t.chat.you },
      { id: AGENT_ID, name: t.chat.agent, avatar: "/avatar.svg" },
    ],
    [t],
  );

  const onAnswer = useCallback(
    async (text: string, choice: boolean) => {
      const result = await chat.send(text, { choice });
      // A blocked free answer goes back into the main box, like any blocked message.
      if (!choice && (result === "blocked" || result === "offline")) composer.current?.fill(text);
    },
    [chat],
  );

  const ended = chat.ended !== null;
  const renderText = useCallback(
    (message: ChatMessage) => (
      <AssistantReply
        text={message.text ?? ""}
        meta={chat.meta[message.id]}
        ask={{
          disabled: busy || ended || message.id !== openQuestion,
          focus: message.id === openQuestion,
          onAnswer: (text, choice) => void onAnswer(text, choice),
        }}
        followUp={{ send: (text) => void onSend(text), disabled: busy || ended || recording }}
      />
    ),
    [chat.meta, busy, ended, openQuestion, onAnswer, onSend, recording],
  );

  // One polite line when a question card appears: the question and the number of suggested answers.
  const openMeta = openQuestion ? chat.meta[openQuestion]?.question : undefined;
  const questionLine = openMeta && !busy ? t.chat.question.announce(openMeta.text, openMeta.choices.length) : "";

  const notice = chat.notice;
  const alertTitle = notice?.kind === "pii" ? t.pii.title : notice?.kind === "recap" ? t.recap.errorTitle : t.errors.title;
  const alertBody =
    notice?.kind === "pii"
      ? piiMessage(notice.kinds, lang)
      : notice?.kind === "error"
        ? t.errors[notice.code]
        : notice?.kind === "recap"
          ? t.recap.errors[notice.code]
          : "";
  /** At least one answer of an agent: the recap has something to sum up. */
  const answered = chat.messages.some((m) => m.authorId === AGENT_ID);
  // "Terminer" first offers the recap PDF. The panel takes the place of the composer.
  const [ending, setEnding] = useState(false);
  const [recapDone, setRecapDone] = useState(false);
  const askRecap = async () => {
    const result = await chat.recap(t.recap.label);
    if (result === "sent") setRecapDone(true);
  };

  // Expired and closed conversations replace the thread with one calm screen.
  const expired = chat.ended?.reason === "expired" || chat.ended?.reason === "closed";
  const closed = chat.ended?.reason === "closed";
  const reason = chat.ended?.reason;
  const endedCopy =
    reason === "medical_advice"
      ? { title: t.ended.adviceTitle, text: t.ended.advice }
      : reason === "capacity"
        ? t.capacity
        : reason === "maintenance"
          ? t.maintenance
          : { title: t.ended.longTitle, text: t.ended.long };
  // Screen readers get one polite line per phase (message check, agent work, reply check), not every step.
  const phase = livePhase(chat.steps);
  // A new agent status line is read once, in the agent's words.
  const agentLine = latestStatus(chat.steps);
  const statusText = agentLine
    ? t.chat.activity.agentSays(agentLine)
    : phase === "checking"
      ? t.chat.status.checking
      : phase === "reviewing"
        ? t.chat.status.reviewing
        : t.chat.status.searching;

  return (
    <div className={styles.chat}>
      <p className="sr-only" aria-live="polite">
        {questionLine}
      </p>
      <div className={styles.threadArea}>
        {expired ? (
          <div className={styles.center}>
            <EmptyState
              label={closed ? t.ended.closedTitle : t.ended.expiredTitle}
              icon={closed ? <CircleCheck size={24} strokeWidth={1.75} /> : <MessageCircleOff size={24} strokeWidth={1.75} />}
              title={closed ? t.ended.closedTitle : t.ended.expiredTitle}
              description={closed ? t.ended.closed : t.ended.expired}
              action={
                <Button ref={restartButton} variant="primary" onClick={onRestart}>
                  {t.ended.restart}
                </Button>
              }
            />
          </div>
        ) : (
          <ChatThread
            ref={thread}
            className={styles.thread}
            participants={participants}
            currentUserId={USER_ID}
            messages={messages}
            typing={busy || !greeted ? [AGENT_ID] : []}
            typingDetail={busy ? <ActivityList steps={chat.steps} live /> : undefined}
            typingStatusLabel={busy ? statusText : undefined}
            composer={false}
            allowAttachments={false}
            locale={t.meta.locale}
            label={t.chat.threadLabel}
            labels={t.chat.labels}
            renderText={renderText}
            renderOwn={renderOwn}
            failedStatusOnly
            onRetry={chat.ended ? undefined : chat.retry}
          />
        )}
      </div>

      {!expired && (
        <div className={styles.dock}>
          <div className={styles.dockInner}>
            <Alert open={!!notice && !chat.ended} tone={notice?.kind === "pii" ? "danger" : "warning"} title={alertTitle}>
              {alertBody}
              {notice?.kind === "error" && notice.code === "stuck" && (
                // A reload starts a new session: the conversation only lives in this page.
                <Button variant="secondary" size="sm" className={styles.reload} onClick={() => window.location.reload()}>
                  <RotateCw size={16} strokeWidth={1.75} aria-hidden="true" />
                  {t.errors.reload}
                </Button>
              )}
            </Alert>
            {chat.ended ? (
              <div className={styles.ended}>
                <Alert tone="warning" title={endedCopy.title}>
                  {endedCopy.text}
                </Alert>
                {chat.ended.reason !== "too_long" && (
                  <ul className={styles.endCalls}>
                    {t.emergency.lines.slice(0, 2).map((l) => (
                      <li key={l.id}>
                        <a className={styles.endCall} href={`tel:${l.tel}`} data-urgent={l.id === "911" || undefined}>
                          <Phone size={16} strokeWidth={1.75} aria-hidden="true" />
                          {l.label} {l.number}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
                <Button ref={restartButton} variant="primary" size="lg" onClick={onRestart}>
                  {t.ended.restart}
                </Button>
              </div>
            ) : ending ? (
              <section className={styles.endPanel} aria-labelledby="recap-title">
                <div className={styles.endPanelHead}>
                  <span className={styles.endPanelIcon} data-done={recapDone || undefined} aria-hidden="true">
                    {recapDone ? <CircleCheck size={20} strokeWidth={1.75} /> : <FileText size={20} strokeWidth={1.75} />}
                  </span>
                  <div className={styles.endPanelCopy}>
                    <h2 id="recap-title" className={styles.endPanelTitle}>
                      {recapDone ? t.recap.doneTitle : t.recap.offerTitle}
                    </h2>
                    <p className={styles.endPanelText}>{recapDone ? t.recap.doneText : t.recap.offerText}</p>
                  </div>
                  <Button variant="ghost" size="sm" className={styles.endPanelClose} disabled={busy} onClick={() => setEnding(false)} aria-label={t.recap.back}>
                    <X size={18} strokeWidth={1.75} aria-hidden="true" />
                  </Button>
                </div>
                <div className={styles.endPanelActions}>
                  {!recapDone && (
                    <Button variant="primary" size="md" loading={busy} disabled={busy} onClick={() => void askRecap()}>
                      <FileDown size={16} strokeWidth={1.75} aria-hidden="true" />
                      {t.recap.download}
                    </Button>
                  )}
                  <Button variant={recapDone ? "primary" : "secondary"} size="md" disabled={busy} onClick={() => chat.finish("closed")}>
                    {recapDone ? t.chat.end : t.recap.endWithout}
                  </Button>
                </div>
              </section>
            ) : (
              <>
                {fresh && !recording && (
                  <ul className={styles.suggestions} aria-label={t.chat.greeting.suggestionsLabel}>
                    {t.chat.suggestions.map((q) => (
                      <li key={q}>
                        <button type="button" className={styles.suggestion} onClick={() => composer.current?.fill(q)}>
                          {q}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {/* Hidden, not removed, while recording: the box keeps its draft. */}
                <div hidden={recording}>
                  <ChatComposer
                    ref={composer}
                    className={styles.composer}
                    placeholder={openQuestion ? t.chat.question.composer : t.chat.placeholder}
                    allowAttachments={false}
                    disabled={locked}
                    accessory={
                      canMic ? (
                        <MicButton ref={mic} disabled={locked} busy={recorder.state === "starting"} onClick={startRecording} />
                      ) : undefined
                    }
                    labels={{ send: t.chat.send }}
                    onSend={(draft) => {
                      voice.clearFailed();
                      void onSend(draft.text);
                    }}
                  />
                </div>
                {recording && (
                  <RecordingBar elapsedMs={recorder.elapsedMs} levels={recorder.live} onSend={recorder.stop} onCancel={cancelRecording} />
                )}
                <div className={styles.under}>
                  {/* While recording, the hint says where the voice goes. */}
                  {micNote || recording || !answered ? (
                    <p className={styles.hint}>{micNote ?? (recording ? v.disclosure : t.chat.hint)}</p>
                  ) : (
                    // After the first answer: the recap of the conversation, one tap away.
                    <button type="button" className={styles.recapLink} disabled={locked} onClick={() => void askRecap()}>
                      <FileDown size={16} strokeWidth={1.75} aria-hidden="true" />
                      {t.recap.link}
                    </button>
                  )}
                  {canMic && (
                    <>
                      <span id={VOICE_DISCLOSURE_ID} hidden>
                        {v.disclosure}
                      </span>
                      <output className={voiceStyles.srOnly}>{said}</output>
                    </>
                  )}
                  {/* Always in the layout, hidden until the first message: the dock keeps its height when it appears. */}
                  <Button
                    variant="ghost"
                    size="sm"
                    className={styles.endButton}
                    aria-label={t.chat.endLabel}
                    disabled={locked || recording || chat.messages.length === 0}
                    style={chat.messages.length === 0 ? { visibility: "hidden" } : undefined}
                    onClick={() => setEnding(true)}
                  >
                    <LogOut size={16} strokeWidth={1.75} aria-hidden="true" />
                    {t.chat.end}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
