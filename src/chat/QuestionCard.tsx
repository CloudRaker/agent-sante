// A clarifying question of the agent: the question, up to 3 suggested answers (Arc `button`) and
// an "Other answer" field (Arc `input`). A click on a suggested answer sends it at once: it is an
// action, not a selection, so it is a button and not a radio. After the answer the card locks and
// shows the answer. The layout of the card never changes when it locks: the buttons and
// the field stay in place, only their state and the field label change.
import { Check, MessageCircleQuestionMark, SendHorizontal } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/arc/button/button";
import { Input } from "@/components/arc/input/input";
import { LIMITS, type AgentQuestion } from "@shared/api";
import { useI18n } from "@/i18n";
import styles from "./question.module.css";

export interface QuestionCardProps {
  question: AgentQuestion;
  /** The answer of the person. Set: the card is locked. */
  answer?: string;
  /** A turn runs or the conversation ended: nothing can be sent now. */
  disabled?: boolean;
  /** Move focus to the card when it mounts (the newest open question). */
  focusOnMount?: boolean;
  onAnswer?: (text: string, choice: boolean) => void;
}

export function QuestionCard({ question, answer, disabled = false, focusOnMount = false, onAnswer }: QuestionCardProps) {
  const { t } = useI18n();
  const id = useId();
  const card = useRef<HTMLFieldSetElement>(null);
  /** Read once: a later render must not take the focus back. */
  const focusFirst = useRef(focusOnMount && answer === undefined);
  const [draft, setDraft] = useState("");
  const locked = answer !== undefined;
  const off = locked || disabled || !onAnswer;
  const freeAnswer = locked && !question.choices.includes(answer);

  // Focus moves to the card once, when it appears, so a keyboard or screen reader user lands on it.
  useEffect(() => {
    if (focusFirst.current) card.current?.focus({ preventScroll: true });
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim().slice(0, LIMITS.messageChars);
    if (!text || off) return;
    onAnswer?.(text, false);
    setDraft("");
  };

  return (
    <div className={styles.question} data-locked={locked || undefined}>
      <fieldset ref={card} className={styles.group} tabIndex={-1}>
        <legend id={`${id}-text`} className={styles.text}>
          <MessageCircleQuestionMark className={styles.icon} size={18} strokeWidth={1.75} aria-hidden="true" />
          <span>{question.text}</span>
        </legend>
        {question.choices.length > 0 && (
          <ul className={styles.choices} aria-label={t.chat.question.choicesLabel}>
            {question.choices.map((choice) => {
              const chosen = locked && answer === choice;
              return (
                <li key={choice}>
                  <Button
                    variant={chosen ? "primary" : "secondary"}
                    size="md"
                    className={styles.choice}
                    data-chosen={chosen || undefined}
                    // A locked card keeps its buttons focusable and readable, with their state.
                    disabled={!locked && off}
                    aria-disabled={locked || undefined}
                    aria-pressed={locked ? chosen : undefined}
                    onClick={() => {
                      if (!off) onAnswer?.(choice, true);
                    }}
                  >
                    {chosen && <Check size={16} strokeWidth={2} aria-hidden="true" />}
                    {choice}
                    {chosen && <span className="sr-only"> ({t.chat.question.chosen})</span>}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        <form className={styles.other} onSubmit={submit}>
          <Input
            label={freeAnswer ? t.chat.question.yourAnswer : t.chat.question.other}
            className={styles.field}
            value={freeAnswer ? answer : locked ? "" : draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={LIMITS.messageChars}
            autoComplete="off"
            enterKeyHint="send"
            readOnly={locked}
            disabled={!locked && off}
          />
          <Button
            type="submit"
            variant="secondary"
            size="md"
            className={styles.send}
            aria-label={t.chat.question.send}
            disabled={off || !draft.trim()}
            style={locked ? { visibility: "hidden" } : undefined}
          >
            <SendHorizontal size={16} strokeWidth={1.75} aria-hidden="true" />
          </Button>
        </form>
      </fieldset>
    </div>
  );
}
