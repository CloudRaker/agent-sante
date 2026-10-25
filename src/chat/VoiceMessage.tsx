// Voice message parts: the mic button in the composer, the recording bar that takes the place of
// the composer while the person speaks, and the audio bubble that waits for the transcript.
// Arc has no free recorder (voice-recorder is Pro), so these parts are custom, on Arc tokens and
// the Arc button. See ARC.md.
import { ArrowUp, Keyboard, Mic, RotateCw, X } from "lucide-react";
import { useEffect, useRef, useState, type Ref } from "react";
import { Button } from "@/components/arc/button/button";
import { TextShimmer } from "@/components/arc/text-shimmer/text-shimmer";
import { LIMITS } from "@shared/api";
import { useI18n } from "@/i18n";
import { clock, LIVE_BARS_MAX, waveform } from "./recorder";
import { FINAL_ERRORS, type VoiceItem } from "./useVoice";
import styles from "./voice.module.css";

export const VOICE_DISCLOSURE_ID = "voice-disclosure";

/** The mic button, before the text box. Its description is the privacy line under the composer. */
export function MicButton({
  onClick,
  disabled,
  busy,
  ref,
}: {
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  ref?: Ref<HTMLButtonElement>;
}) {
  const { t } = useI18n();
  return (
    <Button
      ref={ref}
      variant="ghost"
      size="md"
      className={styles.mic}
      aria-label={t.voice.recordLabel}
      aria-describedby={VOICE_DISCLOSURE_ID}
      disabled={disabled}
      loading={busy}
      onClick={onClick}
    >
      <Mic size={20} strokeWidth={1.75} aria-hidden="true" />
    </Button>
  );
}

/** Live bars of the last levels, newest on the right. */
/** Live bar size in px (voice.module.css .liveBar and .live gap). */
const BAR_WIDTH = 3;
const BAR_GAP = 2;

function LiveBars({ levels }: { levels: number[] }) {
  // As many bars as fit: the level history fills the space between the time and Send.
  const box = useRef<HTMLSpanElement>(null);
  const [count, setCount] = useState(32);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? 0;
      setCount(Math.max(8, Math.min(LIVE_BARS_MAX, Math.floor((width + BAR_GAP) / (BAR_WIDTH + BAR_GAP)))));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const bars = Array.from({ length: count }, (_, i) => levels[levels.length - count + i] ?? 0);
  return (
    <span ref={box} className={styles.live} aria-hidden="true">
      {bars.map((v, i) => (
        <span key={i} className={styles.liveBar} style={{ transform: `scaleY(${Math.max(0.08, v)})` }} />
      ))}
    </span>
  );
}

/**
 * Takes the place of the composer while the person speaks: cancel, the time, the live level and
 * send. Focus goes to Send; Escape cancels. One polite line announces the recording.
 */
export function RecordingBar({
  elapsedMs,
  levels,
  onSend,
  onCancel,
}: {
  elapsedMs: number;
  levels: number[];
  onSend: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const v = t.voice;
  const send = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // Keep the focus on Send for keyboard and screen reader users, but show no ring after a tap or
    // a click on the mic (Arc rule: no focus ring on pointer focus).
    send.current?.focus({ focusVisible: false } as FocusOptions);
  }, []);
  const maxMs = LIMITS.audioSeconds * 1000;
  const soon = elapsedMs >= maxMs - 10_000;
  // Escape cancels from anywhere on the page while the bar shows.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <fieldset className={styles.bar}>
      <legend className={styles.srOnly}>{v.recording}</legend>
      <Button variant="ghost" size="md" className={styles.cancel} aria-label={v.cancel} onClick={onCancel}>
        <X size={20} strokeWidth={1.75} aria-hidden="true" />
      </Button>
      <div className={styles.track}>
        <span className={styles.dot} aria-hidden="true" />
        <span className={styles.time} aria-hidden="true">
          {clock(elapsedMs)}
          <span className={styles.max}> / {clock(maxMs)}</span>
        </span>
        <span className={styles.srOnly}>{v.elapsed(clock(elapsedMs), clock(maxMs))}</span>
        <LiveBars levels={levels} />
        <button ref={send} type="button" className={styles.send} aria-label={v.send} onClick={onSend}>
          <ArrowUp size={16} strokeWidth={2.25} aria-hidden="true" />
        </button>
      </div>
      <output className={styles.srOnly}>{soon ? v.soon : v.started}</output>
    </fieldset>
  );
}

/** The person's audio bubble: duration and a static waveform from the recorded levels, then the transcription state. */
export function VoiceBubble({ item, onRetry, onType }: { item: VoiceItem; onRetry: () => void; onType: () => void }) {
  const { t } = useI18n();
  const v = t.voice;
  const bars = waveform(item.levels);
  const duration = clock(item.durationMs);
  const failed = item.state === "failed";
  const error = item.error ?? "failed";
  const width = bars.length * 4;
  return (
    <div className={styles.voiceMessage} data-failed={failed || undefined}>
      <p className={styles.bubble}>
        <span className={styles.srOnly}>{v.bubbleLabel(duration)}</span>
        <Mic size={16} strokeWidth={1.75} aria-hidden="true" className={styles.bubbleIcon} />
        <svg className={styles.wave} viewBox={`0 0 ${width} 24`} width={width} height={24} aria-hidden="true" focusable="false">
          {bars.map((h, i) => {
            const bar = Math.max(3, h * 22);
            return <rect key={i} x={i * 4 + 0.5} y={(24 - bar) / 2} width={2.5} height={bar} rx={1.25} />;
          })}
        </svg>
        <span className={styles.duration} aria-hidden="true">
          {duration}
        </span>
      </p>
      <output className={styles.state}>
        {failed ? (
          <span className={styles.error}>{v.errors[error]}</span>
        ) : (
          <>
            <span aria-hidden="true">
              <TextShimmer className={styles.transcribing}>{v.transcribing}</TextShimmer>
            </span>
            <span className={styles.srOnly}>{v.transcribingLabel}</span>
          </>
        )}
      </output>
      {failed && (
        <div className={styles.actions}>
          {!FINAL_ERRORS.has(error) && (
            <Button variant="secondary" size="sm" aria-label={v.retryLabel} onClick={onRetry}>
              <RotateCw size={14} strokeWidth={2} aria-hidden="true" />
              {v.retry}
            </Button>
          )}
          <Button variant="ghost" size="sm" aria-label={v.typeLabel} onClick={onType}>
            <Keyboard size={14} strokeWidth={2} aria-hidden="true" />
            {v.type}
          </Button>
        </div>
      )}
    </div>
  );
}
