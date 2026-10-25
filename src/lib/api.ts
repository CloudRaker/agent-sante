// Browser side of the API. Same origin only. Nothing here touches storage.
import { readSseFrames, type Activity, type ChatResult } from "@shared/activity";
import type {
  ApiError,
  ChatRequest,
  ChatResponse,
  ConfigResponse,
  Lang,
  SessionResponse,
  StatsResponse,
  TranscribeResponse,
} from "@shared/api";

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError,
  ) {
    super(body.error);
  }
}

async function post<T>(path: string, body: unknown, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "omit",
      cache: "no-store",
      ...init,
    });
  } catch {
    throw new ApiFailure(0, { error: "unavailable" });
  }
  const data = (await res.json().catch(() => ({ error: "unavailable" }))) as T | ApiError;
  if (!res.ok) throw new ApiFailure(res.status, data as ApiError);
  return data as T;
}

export async function getConfig(): Promise<ConfigResponse> {
  const res = await fetch("/api/config", { credentials: "omit", cache: "no-store" });
  if (!res.ok) throw new ApiFailure(res.status, { error: "unavailable" });
  return (await res.json()) as ConfigResponse;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: "omit", cache: "no-store" });
  if (!res.ok) throw new ApiFailure(res.status, { error: "unavailable" });
  return (await res.json()) as T;
}

/** Aggregate counters, cost sums and usage counts (transparency page, costs page, home strip). */
export const getStats = () => getJson<StatsResponse>("/api/stats");

export const startSession = (turnstileToken: string, lang: Lang) => post<SessionResponse>("/api/session", { turnstileToken, lang });

export const sendChat = (req: ChatRequest, signal?: AbortSignal) => post<ChatResponse>("/api/chat", req, { signal });

/**
 * Sends a message and reads the streamed answer: `onActivity` gets each step while the turn
 * runs, and the promise gets the checked reply (the last event). An error before the stream
 * (a bad token, a busy session) comes back as plain JSON, as with sendChat.
 */
export async function sendChatStream(
  req: ChatRequest,
  onActivity: (activity: Activity) => void,
  signal?: AbortSignal,
): Promise<ChatResponse> {
  let res: Response;
  try {
    res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(req),
      credentials: "omit",
      cache: "no-store",
      signal,
    });
  } catch {
    throw new ApiFailure(0, { error: "unavailable" });
  }
  if (!(res.headers.get("content-type") ?? "").includes("text/event-stream") || !res.body) {
    const data = (await res.json().catch(() => ({ error: "unavailable" }))) as ChatResponse | ApiError;
    if (!res.ok) throw new ApiFailure(res.status, data as ApiError);
    return data as ChatResponse;
  }
  try {
    for await (const frame of readSseFrames(res.body)) {
      if (frame.event === "activity") {
        try {
          onActivity(JSON.parse(frame.data) as Activity);
        } catch {
          // A bad step is skipped; the result still comes.
        }
      } else if (frame.event === "result") {
        const result = JSON.parse(frame.data) as ChatResult;
        if (result.status >= 400) throw new ApiFailure(result.status, result.body as ApiError);
        return result.body as ChatResponse;
      }
    }
  } catch (error) {
    if (error instanceof ApiFailure) throw error;
    throw new ApiFailure(0, { error: "unavailable" });
  }
  // The stream closed without a result.
  throw new ApiFailure(0, { error: "unavailable" });
}

/**
 * Sends a recorded voice message for transcription. The body is the audio itself, the session
 * token goes in the authorization header. The text comes back to the browser only; the browser
 * then sends it with sendChatStream like typed text, so the PII check applies.
 */
export async function transcribeAudio(audio: Blob, sessionToken: string, signal?: AbortSignal): Promise<TranscribeResponse> {
  let res: Response;
  try {
    res = await fetch("/api/transcribe", {
      method: "POST",
      headers: { "content-type": audio.type || "audio/webm", authorization: `Bearer ${sessionToken}` },
      body: audio,
      credentials: "omit",
      cache: "no-store",
      signal,
    });
  } catch {
    throw new ApiFailure(0, { error: "unavailable" });
  }
  const data = (await res.json().catch(() => ({ error: "unavailable" }))) as TranscribeResponse | ApiError;
  if (!res.ok || typeof (data as TranscribeResponse).text !== "string") {
    throw new ApiFailure(res.status, res.ok ? { error: "unavailable" } : (data as ApiError));
  }
  return data as TranscribeResponse;
}

/**
 * Ends the session on the server, so the run is cancelled and its short retention period starts.
 * sendBeacon survives a closed tab. The body is text/plain (a CORS-safe type); the Worker parses it.
 */
export function endSession(sessionToken: string): void {
  const body = JSON.stringify({ sessionToken });
  try {
    if (typeof navigator !== "undefined" && navigator.sendBeacon?.("/api/end", new Blob([body], { type: "text/plain" }))) return;
  } catch {
    // Fall back to fetch below.
  }
  void fetch("/api/end", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body,
    credentials: "omit",
    keepalive: true,
  }).catch(() => {});
}
