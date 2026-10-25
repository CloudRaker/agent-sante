// Voice messages waiting for their transcript. Each one shows as an audio bubble in the thread.
// When the text comes back, the caller removes the bubble and sends the text through the normal
// chat path (PII check, routing, model) with the same message id, so the row stays in place.
// The audio stays in memory only, and only until the transcript comes back or the person drops it.
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiFailure, transcribeAudio } from "@/lib/api";
import type { Recording } from "./recorder";
import { newId } from "./useChat";

export type VoiceError = "failed" | "no_speech" | "too_large" | "unsupported" | "busy" | "offline";

export interface VoiceItem {
  id: string;
  createdAt: Date;
  durationMs: number;
  levels: number[];
  state: "transcribing" | "failed";
  error?: VoiceError;
}

/** Errors that the same audio cannot fix: no Retry button. */
export const FINAL_ERRORS: ReadonlySet<VoiceError> = new Set(["no_speech", "too_large", "unsupported"]);

interface Options {
  /** The current session token. */
  token: () => string;
  /** The transcript is ready. The caller replaces the bubble with the text and sends it. */
  onText: (id: string, text: string) => void;
  /** The session ended or expired while the audio was out. */
  onExpired: () => void;
}

export function useVoice({ token, onText, onExpired }: Options) {
  const [items, setItems] = useState<VoiceItem[]>([]);
  const audio = useRef(new Map<string, Blob>());
  const aborts = useRef(new Map<string, AbortController>());
  const handlers = useRef({ token, onText, onExpired });
  useEffect(() => {
    handlers.current = { token, onText, onExpired };
  }, [token, onText, onExpired]);

  // Leaving the chat stops the uploads and drops the audio.
  useEffect(() => {
    const pending = aborts.current;
    const blobs = audio.current;
    return () => {
      for (const ctrl of pending.values()) ctrl.abort();
      blobs.clear();
    };
  }, []);

  const patch = useCallback(
    (id: string, change: Partial<VoiceItem>) => setItems((list) => list.map((v) => (v.id === id ? { ...v, ...change } : v))),
    [],
  );

  const remove = useCallback((id: string) => {
    aborts.current.get(id)?.abort();
    aborts.current.delete(id);
    audio.current.delete(id);
    setItems((list) => list.filter((v) => v.id !== id));
  }, []);

  const upload = useCallback(
    async (id: string) => {
      const blob = audio.current.get(id);
      if (!blob) return;
      patch(id, { state: "transcribing", error: undefined });
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        patch(id, { state: "failed", error: "offline" });
        return;
      }
      const ctrl = new AbortController();
      aborts.current.set(id, ctrl);
      try {
        const res = await transcribeAudio(blob, handlers.current.token(), ctrl.signal);
        if (ctrl.signal.aborted) return;
        const text = res.text.trim();
        if (!text) {
          patch(id, { state: "failed", error: "no_speech" });
          return;
        }
        // The audio is no longer needed. The bubble goes in the same render as the text message
        // that takes its row (same id), so the thread does not jump.
        audio.current.delete(id);
        setItems((list) => list.filter((v) => v.id !== id));
        handlers.current.onText(id, text);
      } catch (error) {
        if (ctrl.signal.aborted) return;
        const code = error instanceof ApiFailure ? error.body.error : "unavailable";
        if (code === "session_expired") {
          remove(id);
          handlers.current.onExpired();
          return;
        }
        patch(id, {
          state: "failed",
          error:
            code === "audio_too_large"
              ? "too_large"
              : code === "unsupported_audio"
                ? "unsupported"
                : code === "rate_limited"
                  ? "busy"
                  : "failed",
        });
      } finally {
        if (aborts.current.get(id) === ctrl) aborts.current.delete(id);
      }
    },
    [patch, remove],
  );

  /** Adds the audio bubble at once, then uploads. Earlier failed bubbles go away. */
  const add = useCallback(
    (recording: Recording) => {
      const id = newId();
      audio.current.set(id, recording.blob);
      setItems((list) => {
        for (const v of list) if (v.state === "failed") audio.current.delete(v.id);
        return [
          ...list.filter((v) => v.state !== "failed"),
          { id, createdAt: new Date(), durationMs: recording.durationMs, levels: recording.levels, state: "transcribing" },
        ];
      });
      void upload(id);
      return id;
    },
    [upload],
  );

  /** Drops the failed bubbles, for example when the person sends a typed message. */
  const clearFailed = useCallback(() => {
    setItems((list) => {
      for (const v of list) if (v.state === "failed") audio.current.delete(v.id);
      return list.filter((v) => v.state !== "failed");
    });
  }, []);

  return {
    items,
    /** A transcript is on its way: the composer waits, so the messages stay in order. */
    busy: items.some((v) => v.state === "transcribing"),
    add,
    retry: upload,
    remove,
    clearFailed,
  };
}
