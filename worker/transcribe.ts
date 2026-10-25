// milliseconds rakeaudio client (plain fetch) for voice messages, and the local fake.
// API: POST https://api.milliseconds.ai/v1/rakeaudio/transcribe, the audio bytes as the raw body,
// content-type audio/*. Synchronous: the answer holds the whole transcript.
// Privacy: this module never logs or keeps the audio or the text. The caller logs sizes and times only.
import type { Lang } from "../shared/api";

export const RAKEAUDIO_URL = "https://api.milliseconds.ai/v1/rakeaudio/transcribe";

export interface Transcript {
  text: string;
  /** Audio duration in seconds, from the API. */
  duration: number;
  inputTokens?: number;
  inferenceMs?: number;
}

/** Speech to text. The fake upstream and the tests replace it. */
export interface Transcriber {
  transcribe(audio: ArrayBuffer, type: string, lang: Lang): Promise<Transcript>;
}

/**
 * `code` is what the route returns to the browser: "timeout", "unsupported_audio" (the API cannot
 * decode the audio) or "unavailable" (any other failure).
 */
export class TranscribeError extends Error {
  constructor(
    readonly status: number,
    readonly code: "timeout" | "unsupported_audio" | "unavailable",
  ) {
    super(`rakeaudio ${status} ${code}`);
  }
}

const num = (value: string | null) => (value && Number.isFinite(Number(value)) ? Number(value) : undefined);

export class RakeAudio implements Transcriber {
  constructor(
    private readonly apiKey: string,
    private readonly url = RAKEAUDIO_URL,
    private readonly fetcher: typeof fetch = (...args) => fetch(...args),
    /** Budget for all attempts of one voice message. */
    private readonly timeoutMs = 15_000,
  ) {}

  async transcribe(audio: ArrayBuffer, type: string): Promise<Transcript> {
    const deadline = AbortSignal.timeout(this.timeoutMs);
    // One retry for an overloaded or failed runner (502, 503, 529), inside the same budget.
    for (let attempt = 0; attempt < 2; attempt++) {
      let res: Response;
      try {
        res = await this.fetcher(`${this.url}?diarize=false`, {
          method: "POST",
          headers: { "content-type": type, authorization: `Bearer ${this.apiKey}` },
          body: audio,
          signal: deadline,
        });
      } catch (error) {
        const timeout = deadline.aborted || (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"));
        if (!timeout && attempt === 0) continue;
        throw new TranscribeError(0, timeout ? "timeout" : "unavailable");
      }
      if (res.ok) {
        const out = (await res.json().catch(() => null)) as { text?: unknown; duration?: unknown } | null;
        if (!out || typeof out.text !== "string") throw new TranscribeError(res.status, "unavailable");
        return {
          text: out.text,
          duration: typeof out.duration === "number" ? out.duration : 0,
          inputTokens: num(res.headers.get("x-input-tokens")),
          inferenceMs: num(res.headers.get("x-inference-ms")),
        };
      }
      // 400 invalid_audio, audio_too_long; 415 unsupported_media_type: the same bytes fail again.
      if (res.status === 400 || res.status === 415) throw new TranscribeError(res.status, "unsupported_audio");
      if (attempt === 0 && (res.status === 502 || res.status === 503 || res.status === 529)) {
        await new Promise((r) => setTimeout(r, 300));
        if (!deadline.aborted) continue;
        throw new TranscribeError(res.status, "timeout");
      }
      throw new TranscribeError(res.status, "unavailable");
    }
    throw new TranscribeError(0, "unavailable");
  }
}

/**
 * Local fake for FAKE_UPSTREAMS=1. It cannot read the audio, so it returns one fixed question
 * in the session language after a short delay (the real call takes 0.5 to 1.2 s; the fake waits
 * longer, so the "Transcription" state shows).
 */
export function fakeTranscriber(options: { delayMs?: number } = {}): Transcriber {
  return {
    async transcribe(audio, _type, lang) {
      await new Promise((r) => setTimeout(r, options.delayMs ?? 1800));
      // About 4 kB per second of Opus at 32 kbit/s.
      const duration = Math.max(1, Math.round(audio.byteLength / 4000));
      return {
        text: lang === "en" ? "Where can I get a flu shot near me?" : "Où me faire vacciner contre la grippe près de chez moi ?",
        duration,
      };
    },
  };
}
