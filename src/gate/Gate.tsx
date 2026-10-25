// Consent gate as a conversation: Agent Santé introduces itself, then each disclaimer is a
// message that the person accepts with one button where the composer will be. After the last
// one the session starts and the same messages stay on screen above the chat, so nothing jumps.
// The invisible Turnstile check runs in the background from the first screen.
// Arc chat-thread (the bubbles) and Arc button; the dock uses the chat screen styles.
import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Alert } from "@/components/arc/alert/alert";
import { Button } from "@/components/arc/button/button";
import { motionTokens } from "@/components/arc/motion-tokens";
import { ChatThread, type ChatMessage } from "@/components/arc/chat-thread/chat-thread";
import type { SessionResponse } from "@shared/api";
import { AssistantReply } from "@/chat/AssistantReply";
import { AGENT_ID, USER_ID } from "@/chat/useChat";
import chatStyles from "@/chat/chat.module.css";
import { useI18n } from "@/i18n";
import { PAGE_PATHS } from "@/i18n/pages";
import { ApiFailure, startSession } from "@/lib/api";
import type { Theme } from "@/shell/theme";
import { Turnstile, type TurnstileHandle } from "./Turnstile";
import styles from "./gate.module.css";

/** Pause with the typing dots before the next message of the agent. */
const TYPING_MS = 550;
/** Opening: dots, the hello, dots, the first consent, then the button fades in. */
const OPENING_MS = [700, 900];

export function Gate({
  siteKey,
  theme,
  onStarted,
}: {
  siteKey: string;
  theme: Theme;
  /** `intro`: the onboarding messages, shown again above the chat. */
  onStarted: (session: SessionResponse, intro: ChatMessage[]) => void;
}) {
  const { t, lang } = useI18n();
  const g = t.gate;
  const steps = [g.notGovernment, g.notEmergency, g.privacy];
  const [accepted, setAccepted] = useState(0);
  const [typing, setTyping] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [humanError, setHumanError] = useState(false);
  const [startError, setStartError] = useState(false);
  const [limit, setLimit] = useState<"capacity" | "maintenance" | null>(null);
  const [starting, setStarting] = useState(false);
  const [waitingToken, setWaitingToken] = useState(false);
  const turnstile = useRef<TurnstileHandle | null>(null);
  const action = useRef<HTMLButtonElement>(null);
  const [startedAt] = useState(() => Date.now());
  const reduced = useReducedMotion();
  // 0: dots only. 1: the hello and dots. 2: the first consent and the button. Reduced motion skips it.
  const [opening, setOpening] = useState(() => (reduced ? 2 : 0));
  useEffect(() => {
    if (opening >= 2) return;
    const timer = window.setTimeout(() => setOpening(opening + 1), OPENING_MS[opening]);
    return () => window.clearTimeout(timer);
  }, [opening]);

  const messages = useMemo<ChatMessage[]>(() => {
    const at = (n: number) => new Date(startedAt + n);
    if (opening === 0) return [];
    const list: ChatMessage[] = [{ id: "intro-hello", authorId: AGENT_ID, text: g.hello, createdAt: at(0) }];
    if (opening === 1) return list;
    steps.forEach((text, i) => {
      if (i > accepted) return;
      if (i === accepted && typing) return;
      list.push({ id: `intro-${i}`, authorId: AGENT_ID, text, createdAt: at(1 + i * 2) });
      if (i < accepted) {
        list.push({ id: `intro-${i}-ok`, authorId: USER_ID, text: i === steps.length - 1 ? g.acceptLast : g.accept, createdAt: at(2 + i * 2), status: "sent" });
      }
    });
    return list;
    // `steps` changes with `g`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [g, accepted, typing, startedAt, opening]);

  const participants = useMemo(
    () => [
      { id: USER_ID, name: t.chat.you },
      { id: AGENT_ID, name: t.chat.agent, avatar: "/avatar.svg" },
    ],
    [t],
  );

  const last = accepted === steps.length - 1;
  const done = accepted >= steps.length;

  const start = async () => {
    setStartError(false);
    if (!token) {
      // The invisible check is still running: start as soon as its token comes, or show the
      // error after a short wait.
      setWaitingToken(true);
      return;
    }
    setStarting(true);
    try {
      onStarted(await startSession(token, lang), messages);
    } catch (error) {
      const code = error instanceof ApiFailure ? error.body.error : undefined;
      if (code === "at_capacity" || code === "maintenance") {
        setLimit(code === "at_capacity" ? "capacity" : "maintenance");
        return;
      }
      setStartError(true);
      setToken(null);
      turnstile.current?.reset();
      if (error instanceof ApiFailure && error.status === 403) setHumanError(true);
    } finally {
      setStarting(false);
    }
  };

  useEffect(() => {
    if (!waitingToken) return;
    if (token) {
      setWaitingToken(false);
      void start();
      return;
    }
    const timer = window.setTimeout(() => {
      setWaitingToken(false);
      setHumanError(true);
    }, 8000);
    return () => window.clearTimeout(timer);
    // `start` reads the latest state; it runs once when the token arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingToken, token]);

  // The last accept starts the session; it runs once the person's answer is on screen.
  useEffect(() => {
    if (done && !starting && !startError && !limit && !humanError) void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);

  const accept = () => {
    const next = accepted + 1;
    setAccepted(next);
    if (next < steps.length) {
      setTyping(true);
      window.setTimeout(() => setTyping(false), TYPING_MS);
    }
  };

  // Focus stays on the action button between steps, for keyboard and screen reader users.
  useEffect(() => {
    // The button was disabled during the typing pause, so it lost focus. No ring after a tap.
    if (!typing) action.current?.focus({ preventScroll: true, focusVisible: false } as FocusOptions);
  }, [typing, accepted, opening]);

  const external = { target: "_blank", rel: "noopener noreferrer" } as const;
  const failed = startError || humanError;

  return (
    <div className={chatStyles.chat}>
      <div className={chatStyles.threadArea}>
        <ChatThread
          className={chatStyles.thread}
          participants={participants}
          currentUserId={USER_ID}
          messages={messages}
          typing={typing || opening < 2 ? [AGENT_ID] : []}
          composer={false}
          allowAttachments={false}
          locale={t.meta.locale}
          label={t.chat.threadLabel}
          labels={t.chat.labels}
          failedStatusOnly
          // The same renderer as the agent replies in the chat, so the two look the same.
          renderText={(message) => <AssistantReply text={message.text ?? ""} />}
        />
      </div>
      <div className={chatStyles.dock}>
        <div className={chatStyles.dockInner}>
          <Turnstile
            siteKey={siteKey}
            lang={lang}
            theme={theme}
            label={g.confirm.humanCheck}
            handle={turnstile}
            onToken={(value) => {
              setToken(value);
              if (value) setHumanError(false);
            }}
            onError={() => setHumanError(true)}
          />
          <Alert open={!!limit} tone="warning" title={limit ? t[limit].title : ""}>
            {limit ? t[limit].text : ""}
          </Alert>
          <Alert open={!limit && failed} tone="danger" title={startError ? g.confirm.startFailed : g.confirm.humanNeeded} />
          <motion.div
            className={styles.actions}
            initial={false}
            animate={opening < 2 ? { opacity: 0, y: reduced ? 0 : 8 } : { opacity: 1, y: 0 }}
            transition={reduced ? { duration: 0 } : { ...motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.considered } }}
            // Not reachable before it shows.
            inert={opening < 2 || undefined}
          >
          {done ? (
            <Button
              ref={action}
              variant="primary"
              size="lg"
              className={styles.action}
              loading={!failed && !limit}
              disabled={!!limit}
              onClick={() => void start()}
            >
              {failed ? g.confirm.retry : g.acceptLast}
            </Button>
          ) : (
            <Button ref={action} variant="primary" size="lg" className={styles.action} disabled={typing} onClick={accept}>
              {last ? g.acceptLast : g.accept}
            </Button>
          )}
          <p className={styles.links}>
            <a href={PAGE_PATHS[lang].privacy} {...external}>
              {g.privacyLink}
              <span className="sr-only"> {t.common.newTab}</span>
            </a>
            <span aria-hidden="true"> · </span>
            {g.terms}{" "}
            <a href={PAGE_PATHS[lang].terms} {...external}>
              {g.termsLink}
              <span className="sr-only"> {t.common.newTab}</span>
            </a>
          </p>
          </motion.div>
        </div>
      </div>
    </div>
  );
}
