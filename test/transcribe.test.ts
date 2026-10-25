// /api/transcribe: session token, rate limits, type and size checks, the counter, and no text or
// audio in the logs. Plus the rakeaudio client (raw body, retry, error mapping) with a fake fetch.
import { describe, expect, it, vi } from "vitest";
import { LIMITS } from "../shared/api";
import type { Limiter } from "../worker/app";
import { RakeAudio, TranscribeError, type Transcriber } from "../worker/transcribe";
import { ORIGIN, makeApp, scriptedModel, scriptedRun, session } from "./helpers";

const SPOKEN = "Où me faire vacciner contre la grippe à Rosemont ?";
/** Marker bytes: the test checks that they never reach a log line. */
const AUDIO = new TextEncoder().encode("OggS-voice-bytes-0123456789");

function fakeTranscriber(behaviour: (audio: ArrayBuffer, type: string) => Promise<{ text: string; duration: number }> | never) {
  const calls: { bytes: number; type: string }[] = [];
  const transcriber: Transcriber = {
    async transcribe(audio, type) {
      calls.push({ bytes: audio.byteLength, type });
      return behaviour(audio, type);
    },
  };
  return { transcriber, calls };
}

const refuse: Limiter = { limit: async () => ({ success: false }) };

async function setup(overrides: Parameters<typeof makeApp>[2] = {}) {
  const t = fakeTranscriber(async () => ({ text: `  ${SPOKEN}\n`, duration: 4.2 }));
  const { run } = scriptedRun(() => ({ text: "ok" }));
  const { model } = scriptedModel({});
  const made = makeApp(run, model, { transcriber: t.transcriber, ...overrides });
  const { state } = await session(made.post);
  const send = (init: { token?: string | null; type?: string; body?: BodyInit; headers?: Record<string, string> } = {}) =>
    made.app.request("/api/transcribe", {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": init.type ?? "audio/webm;codecs=opus",
        ...(init.token === null ? {} : { authorization: `Bearer ${init.token ?? state.token}` }),
        ...init.headers,
      },
      body: init.body ?? AUDIO,
      // A stream body needs half duplex in undici.
      ...(init.body instanceof ReadableStream ? { duplex: "half" } : {}),
    } as RequestInit);
  return { ...made, ...t, send, state };
}

describe("POST /api/transcribe", () => {
  it("returns the text, counts one transcription, and logs no text and no audio", async () => {
    const { send, calls, logs, app } = await setup();
    const res = await send();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text: string; ms: number };
    expect(body.text).toBe(SPOKEN);
    expect(typeof body.ms).toBe("number");
    expect(calls).toEqual([{ bytes: AUDIO.byteLength, type: "audio/webm" }]);
    const line = logs.find((l) => l.event === "transcribe")!;
    expect(line).toMatchObject({ status: 200, bytes: AUDIO.byteLength, duration: 4.2, type: "audio/webm" });
    const all = JSON.stringify(logs);
    expect(all).not.toMatch(/vacciner|Rosemont|OggS|voice-bytes/);
    const stats = (await (await app.request("/api/stats")).json()) as { totals: Record<string, number> };
    expect(stats.totals.transcriptions).toBe(1);
    expect(JSON.stringify(stats)).not.toMatch(/vacciner/);
  });

  it("does not run the PII check or Run: the text goes back through /api/chat", async () => {
    const run = scriptedRun(() => ({ text: "ok" }));
    const model = scriptedModel({});
    const t = fakeTranscriber(async () => ({ text: SPOKEN, duration: 3 }));
    const made = makeApp(run.run, model.model, { transcriber: t.transcriber });
    const { state } = await session(made.post);
    const res = await made.app.request("/api/transcribe", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "audio/mp4", authorization: `Bearer ${state.token}` },
      body: AUDIO,
    });
    expect(res.status).toBe(200);
    expect(model.seen).toEqual([]);
    expect(run.calls).toEqual([]);
  });

  it("refuses a missing, forged or expired session token", async () => {
    const { send, calls, deps } = await setup();
    expect((await send({ token: null })).status).toBe(401);
    expect((await send({ token: "abc.def.ghi" })).status).toBe(401);
    const real = deps.now;
    deps.now = () => real() + LIMITS.sessionMs + 60_000;
    expect((await send()).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("refuses a token of a conversation that ended", async () => {
    const { send, calls, post, state } = await setup();
    expect((await send()).status).toBe(200);
    await post("/api/end", { sessionToken: state.token });
    const res = await send();
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "session_expired" });
    expect(calls).toHaveLength(1);
  });

  it("refuses another origin", async () => {
    const { send } = await setup();
    expect((await send({ headers: { origin: "https://evil.example" } })).status).toBe(403);
  });

  it("applies the IP, session and voice limits", async () => {
    for (const limiters of [{ chatIp: refuse }, { chatSession: refuse }, { transcribe: refuse }]) {
      const { send, calls } = await setup({ limiters });
      const res = await send();
      expect(res.status).toBe(429);
      expect(await res.json()).toMatchObject({ error: "rate_limited" });
      expect(calls).toEqual([]);
    }
  });

  it("accepts audio types only", async () => {
    const { send, calls } = await setup();
    for (const type of ["text/plain", "application/json", "video/webm", "application/octet-stream", ""]) {
      const res = await send({ type });
      expect(res.status).toBe(415);
      expect(await res.json()).toEqual({ error: "unsupported_audio" });
    }
    for (const type of ["audio/ogg;codecs=opus", "audio/mp4", "AUDIO/WAV"]) expect((await send({ type })).status).toBe(200);
    expect(calls.map((c) => c.type)).toEqual(["audio/ogg", "audio/mp4", "audio/wav"]);
  });

  it("refuses a body over the byte cap, also without a content-length", async () => {
    const { send, calls } = await setup();
    const big = new Uint8Array(LIMITS.audioBytes + 1);
    expect((await send({ body: big })).status).toBe(413);
    const chunks = [new Uint8Array(LIMITS.audioBytes), new Uint8Array(10)];
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const chunk of chunks) c.enqueue(chunk);
        c.close();
      },
    });
    const res = await send({ body: stream, headers: { "content-length": "" } });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "audio_too_large" });
    expect(calls).toEqual([]);
  });

  it("refuses an empty body and audio over the duration limit", async () => {
    const { send } = await setup();
    expect((await send({ body: new Uint8Array(0) })).status).toBe(400);
    const long = fakeTranscriber(async () => ({ text: SPOKEN, duration: LIMITS.audioSeconds + 10 }));
    const s = await setup({ transcriber: long.transcriber });
    const res = await s.send();
    expect(res.status).toBe(413);
    expect(JSON.stringify(await res.json())).not.toMatch(/vacciner/);
  });

  it("gives an empty text for silence, and does not count it", async () => {
    const silent = fakeTranscriber(async () => ({ text: "   ", duration: 2 }));
    const { send, app } = await setup({ transcriber: silent.transcriber });
    expect(await (await send()).json()).toMatchObject({ text: "" });
    const stats = (await (await app.request("/api/stats")).json()) as { totals: Record<string, number> };
    expect(stats.totals.transcriptions).toBe(0);
  });

  it("maps upstream failures to errors the UI can show", async () => {
    for (const [error, status, code] of [
      [new TranscribeError(0, "timeout"), 504, "timeout"],
      [new TranscribeError(400, "unsupported_audio"), 422, "unsupported_audio"],
      [new TranscribeError(503, "unavailable"), 503, "unavailable"],
      [new Error("boom"), 503, "unavailable"],
    ] as const) {
      const failing = fakeTranscriber(async () => {
        throw error;
      });
      const { send, logs } = await setup({ transcriber: failing.transcriber });
      const res = await send();
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error: code });
      expect(logs.find((l) => l.event === "transcribe")).toMatchObject({ status });
    }
  });

  it("answers 503 maintenance when the kill switch is on", async () => {
    const { send, deps } = await setup();
    deps.maintenance = true;
    expect((await send()).status).toBe(503);
  });

  it("caps the text at the message length", async () => {
    const chatty = fakeTranscriber(async () => ({ text: "mot ".repeat(600), duration: 59 }));
    const { send } = await setup({ transcriber: chatty.transcriber });
    const body = (await (await send()).json()) as { text: string };
    expect(body.text.length).toBe(LIMITS.messageChars);
  });
});

const ok = (text: string) =>
  new Response(JSON.stringify({ text, duration: 3.7, language: null, segments: [] }), {
    headers: { "content-type": "application/json", "x-input-tokens": "2602", "x-inference-ms": "205" },
  });

describe("RakeAudio client", () => {
  it("sends the raw audio with its type and the key, without speaker labels", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => ok("Hello"));
    const out = await new RakeAudio("prod_sk-test", "https://ms.example/v1/rakeaudio/transcribe", fetcher).transcribe(
      AUDIO.buffer,
      "audio/webm",
    );
    expect(out).toEqual({ text: "Hello", duration: 3.7, inputTokens: 2602, inferenceMs: 205 });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://ms.example/v1/rakeaudio/transcribe?diarize=false");
    expect(init!.headers).toEqual({ "content-type": "audio/webm", authorization: "Bearer prod_sk-test" });
    expect(init!.body).toBe(AUDIO.buffer);
  });

  it("retries once on 529, never on 400", async () => {
    const busy = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("", { status: 529 }))
      .mockResolvedValueOnce(ok("Bonjour"));
    expect((await new RakeAudio("k", undefined, busy).transcribe(AUDIO.buffer, "audio/ogg")).text).toBe("Bonjour");
    expect(busy).toHaveBeenCalledTimes(2);
    const bad = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: { code: "invalid_audio" } }), { status: 400 }));
    await expect(new RakeAudio("k", undefined, bad).transcribe(AUDIO.buffer, "audio/ogg")).rejects.toMatchObject({
      code: "unsupported_audio",
    });
    expect(bad).toHaveBeenCalledTimes(1);
  });

  it("fails with timeout when the budget runs out", async () => {
    const slow = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("t", "TimeoutError")))),
    );
    await expect(new RakeAudio("k", undefined, slow, 50).transcribe(AUDIO.buffer, "audio/ogg")).rejects.toMatchObject({ code: "timeout" });
  });

  it("fails closed on a bad body or an auth error", async () => {
    const shape = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ nope: 1 }), { status: 200 }));
    await expect(new RakeAudio("k", undefined, shape).transcribe(AUDIO.buffer, "audio/ogg")).rejects.toMatchObject({ code: "unavailable" });
    const auth = vi.fn<typeof fetch>(async () => new Response("{}", { status: 401 }));
    await expect(new RakeAudio("k", undefined, auth).transcribe(AUDIO.buffer, "audio/ogg")).rejects.toMatchObject({
      code: "unavailable",
      status: 401,
    });
  });
});
