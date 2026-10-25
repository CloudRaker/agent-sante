// Voice message recording in the browser: MediaRecorder with the best type the browser supports,
// and a level meter (Web Audio analyser) for the live bars and the static waveform of the bubble.
// The audio stays in memory only. The microphone is asked for on the first tap, never on load.
import { useCallback, useEffect, useRef, useState } from "react";

/** Best first. Chrome, Edge and Firefox record Opus (WebM or Ogg); Safari records AAC in MP4. */
const TYPES = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/webm"];

/** One level sample every TICK_MS while recording. */
export const TICK_MS = 80;

export interface Recording {
  blob: Blob;
  durationMs: number;
  /** Levels from 0 to 1, one per TICK_MS. */
  levels: number[];
}

export type RecorderError = "denied" | "no_mic" | "failed";

/** The browser can record audio at all. It calls nothing and asks for nothing. */
export function canRecord(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.MediaRecorder === "function" &&
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function"
  );
}

export function pickMimeType(isSupported: (type: string) => boolean = (t) => MediaRecorder.isTypeSupported?.(t) ?? false): string {
  for (const type of TYPES) {
    try {
      if (isSupported(type)) return type;
    } catch {
      // An old browser can throw on an unknown type.
    }
  }
  return "";
}

/** Most live bars the recording bar can show (a wide desktop bar). */
export const LIVE_BARS_MAX = 200;

/** Reduces the levels to `count` bars (the loudest sample of each part), scaled so the loudest bar is 1. */
export function waveform(levels: number[], count = 28): number[] {
  if (!levels.length) return Array.from({ length: count }, () => 0.15);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const from = Math.floor((i * levels.length) / count);
    const to = Math.max(from + 1, Math.floor(((i + 1) * levels.length) / count));
    out.push(Math.max(...levels.slice(from, to)));
  }
  const top = Math.max(...out, 0.05);
  return out.map((v) => Math.max(0.12, Math.min(1, v / top)));
}

/** "0:07", "1:00". */
export function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

type State = "idle" | "starting" | "recording";

interface Options {
  maxMs: number;
  onDone: (recording: Recording) => void;
  onError: (error: RecorderError) => void;
}

export function useRecorder({ maxMs, onDone, onError }: Options) {
  const [state, setState] = useState<State>("idle");
  const [elapsedMs, setElapsed] = useState(0);
  /** The last levels, for the live bars. */
  const [live, setLive] = useState<number[]>([]);
  const handlers = useRef({ onDone, onError });
  useEffect(() => {
    handlers.current = { onDone, onError };
  }, [onDone, onError]);
  const run = useRef<{
    stream: MediaStream;
    recorder: MediaRecorder;
    chunks: Blob[];
    levels: number[];
    started: number;
    timer: number;
    audio?: AudioContext;
    keep: boolean;
    /** performance.now() when the person stopped. */
    ended: number;
  } | null>(null);

  const release = useCallback(() => {
    const r = run.current;
    if (!r) return;
    window.clearInterval(r.timer);
    for (const track of r.stream.getTracks()) track.stop();
    void r.audio?.close().catch(() => {});
  }, []);

  const finish = useCallback(
    (keep: boolean) => {
      const r = run.current;
      if (!r) return;
      r.keep = keep;
      r.ended = performance.now();
      window.clearInterval(r.timer);
      if (r.recorder.state !== "inactive") r.recorder.stop();
      else release();
      setState("idle");
    },
    [release],
  );

  const start = useCallback(async () => {
    if (run.current || state !== "idle") return;
    setState("starting");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
    } catch (error) {
      setState("idle");
      const name = error instanceof Error ? error.name : "";
      handlers.current.onError(
        name === "NotAllowedError" || name === "SecurityError" ? "denied" : name === "NotFoundError" ? "no_mic" : "failed",
      );
      return;
    }
    let recorder: MediaRecorder;
    try {
      const mimeType = pickMimeType();
      recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 32_000 } : undefined);
    } catch {
      for (const track of stream.getTracks()) track.stop();
      setState("idle");
      handlers.current.onError("failed");
      return;
    }
    let analyser: AnalyserNode | undefined;
    let audio: AudioContext | undefined;
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (Ctx) {
        audio = new Ctx();
        analyser = audio.createAnalyser();
        analyser.fftSize = 512;
        audio.createMediaStreamSource(stream).connect(analyser);
      }
    } catch {
      analyser = undefined; // No meter: the bubble shows a flat waveform.
    }
    const samples = analyser ? new Uint8Array(analyser.fftSize) : undefined;
    const r = {
      stream,
      recorder,
      chunks: [] as Blob[],
      levels: [] as number[],
      started: performance.now(),
      timer: 0,
      audio,
      keep: false,
      ended: 0,
    };
    run.current = r;
    recorder.addEventListener("dataavailable", (e) => {
      if (e.data.size) r.chunks.push(e.data);
    });
    recorder.addEventListener("stop", () => {
      release();
      run.current = null;
      if (!r.keep) return;
      const durationMs = Math.min(maxMs, (r.ended || performance.now()) - r.started);
      const blob = new Blob(r.chunks, { type: recorder.mimeType || r.chunks[0]?.type || "audio/webm" });
      handlers.current.onDone({ blob, durationMs, levels: r.levels });
    });
    r.timer = window.setInterval(() => {
      const elapsed = performance.now() - r.started;
      let level = 0;
      if (analyser && samples) {
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const v of samples) sum += ((v - 128) / 128) ** 2;
        // Square root of the RMS: quiet speech still shows as a visible bar.
        level = Math.min(1, Math.sqrt(Math.sqrt(sum / samples.length)) * 1.6);
      }
      r.levels.push(level);
      setElapsed(elapsed);
      setLive(r.levels.slice(-LIVE_BARS_MAX));
      if (elapsed >= maxMs) finish(true);
    }, TICK_MS);
    try {
      recorder.start(1000);
    } catch {
      release();
      run.current = null;
      setState("idle");
      handlers.current.onError("failed");
      return;
    }
    setElapsed(0);
    setLive([]);
    setState("recording");
  }, [state, maxMs, release, finish]);

  // Leaving the chat stops the microphone and drops the recording.
  useEffect(
    () => () => {
      const r = run.current;
      if (!r) return;
      r.keep = false;
      if (r.recorder.state !== "inactive") r.recorder.stop();
      release();
    },
    [release],
  );

  return {
    state,
    elapsedMs,
    live,
    start,
    /** Stops and hands the recording to onDone. */
    stop: useCallback(() => finish(true), [finish]),
    /** Stops and drops the recording. */
    cancel: useCallback(() => finish(false), [finish]),
  };
}
