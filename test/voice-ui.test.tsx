// @vitest-environment jsdom
// Voice messages in the browser: record, the audio bubble, its replacement by the transcript, the
// normal chat path (PII block goes to the composer), failure and retry, and accessibility.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Chat } from "../src/chat/Chat";
import { pickMimeType, waveform } from "../src/chat/recorder";
import { I18nProvider } from "../src/i18n";

const SPOKEN = "Où me faire vacciner contre la grippe ?";

async function violations() {
  const result = await axe.run(document.body, { rules: { "color-contrast": { enabled: false } }, resultTypes: ["violations"] });
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const REPLY = {
  ended: false,
  reply: { text: "Allez dans une pharmacie.", sources: [] },
  agentId: "fr/concierge",
  lang: "fr",
  sessionToken: "t2",
  expiresAt: Date.now() + 600_000,
  transcript: [],
};

/** A MediaRecorder that hands back one small blob on stop. */
class FakeRecorder extends EventTarget {
  static isTypeSupported = (type: string) => type === "audio/webm;codecs=opus";
  state: "inactive" | "recording" = "inactive";
  mimeType: string;
  constructor(_stream: unknown, options?: { mimeType?: string }) {
    super();
    this.mimeType = options?.mimeType ?? "";
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.dispatchEvent(Object.assign(new Event("dataavailable"), { data: new Blob(["voice"], { type: this.mimeType }) }));
    this.dispatchEvent(new Event("stop"));
  }
}

type Gum = () => Promise<{ getTracks: () => { stop: () => void }[] }>;
let getUserMedia: ReturnType<typeof vi.fn<Gum>>;
let stopped: number;

beforeEach(() => {
  stopped = 0;
  getUserMedia = vi.fn<Gum>(async () => ({ getTracks: () => [{ stop: () => stopped++ }] }));
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
});

/** Fetch fake: /api/transcribe answers from the queue (a promise each), /api/chat with `chat`. */
function stubFetch(transcribe: (() => Promise<Response>)[], chat: () => Response = () => json(REPLY)) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async (url, init) => {
      calls.push({ url, init });
      if (url === "/api/transcribe") return transcribe.shift()!();
      if (url === "/api/chat") return chat();
      return json({});
    }),
  );
  return calls;
}

function renderChat() {
  render(
    <I18nProvider lang="fr">
      <main>
        <Chat
          session={{ sessionToken: "t", expiresAt: Date.now() + 600_000, agentId: "fr/concierge", lang: "fr", transcript: [] }}
          onLanguage={() => {}}
          onRestart={() => {}}
        />
      </main>
    </I18nProvider>,
  );
}

async function recordAndSend() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer un message vocal" }));
  });
  const send = await screen.findByRole("button", { name: "Envoyer le message vocal" });
  await act(async () => {
    fireEvent.click(send);
  });
}

function deferred() {
  let resolve!: (r: Response) => void;
  const promise = new Promise<Response>((r) => (resolve = r));
  return { promise, resolve };
}

describe("voice messages", () => {
  it("asks for the microphone only on the first tap", async () => {
    stubFetch([]);
    renderChat();
    const mic = screen.getByRole("button", { name: "Enregistrer un message vocal" });
    expect(getUserMedia).not.toHaveBeenCalled();
    // The button tells where the voice goes.
    expect(mic.getAttribute("aria-describedby")).toBe("voice-disclosure");
    expect(document.getElementById("voice-disclosure")!.textContent).toMatch(/rakeaudio, un modèle de CloudRaker/);
    await act(async () => {
      fireEvent.click(mic);
    });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("shows the audio bubble, replaces it with the transcript, then sends the text like typed text", async () => {
    const pending = deferred();
    const calls = stubFetch([() => pending.promise]);
    renderChat();
    await recordAndSend();
    // The bubble shows at once, before the text is back. The box waits.
    expect(screen.getByText(/Votre message vocal, 0:0\d/)).toBeTruthy();
    expect(screen.getByText("Transcription de votre message vocal en cours")).toBeTruthy();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(true);
    expect(stopped).toBe(1);
    const upload = calls.find((c) => c.url === "/api/transcribe")!;
    expect((upload.init.headers as Record<string, string>).authorization).toBe("Bearer t");
    expect((upload.init.headers as Record<string, string>)["content-type"]).toBe("audio/webm;codecs=opus");
    expect(upload.init.body).toBeInstanceOf(Blob);
    expect(calls.some((c) => c.url === "/api/chat")).toBe(false);

    await act(async () => pending.resolve(json({ text: SPOKEN, ms: 600 })));
    await screen.findByText("Allez dans une pharmacie.");
    expect(screen.getByText(SPOKEN)).toBeTruthy();
    expect(screen.queryByText(/Votre message vocal/)).toBeNull();
    const chat = calls.find((c) => c.url === "/api/chat")!;
    const body = JSON.parse(String(chat.init.body)) as { message: string; sessionToken: string };
    expect(body).toMatchObject({ message: SPOKEN, sessionToken: "t" });
    // The text row took the place of the bubble: one own row only.
    expect(document.querySelectorAll("[data-mine]").length).toBe(1);
  });

  it("puts a transcript that the PII check blocks in the composer, with the usual alert", async () => {
    const calls = stubFetch([async () => json({ text: "Je m'appelle Josée Tremblay", ms: 500 })], () =>
      json({ error: "pii", kinds: ["person_name"] }, 422),
    );
    renderChat();
    await recordAndSend();
    await screen.findByText("Renseignements personnels détectés");
    await waitFor(() => expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Je m'appelle Josée Tremblay"));
    // Nothing stays in the thread: no bubble, no message.
    // The row leaves with a short exit animation.
    await waitFor(() => expect(document.querySelectorAll("[data-mine]").length).toBe(0));
    expect(calls.filter((c) => c.url === "/api/chat").length).toBe(1);
  });

  it("shows an error on the bubble, with Retry and Type instead", async () => {
    const calls = stubFetch([async () => json({ error: "unavailable" }, 503), async () => json({ text: SPOKEN, ms: 500 })]);
    renderChat();
    await recordAndSend();
    await screen.findByText("La transcription n'a pas fonctionné.");
    expect(screen.getByRole("button", { name: "Retirer le message vocal et écrire votre message" })).toBeTruthy();
    expect(await violations()).toEqual([]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Réessayer la transcription" }));
    });
    await screen.findByText("Allez dans une pharmacie.");
    expect(calls.filter((c) => c.url === "/api/transcribe").length).toBe(2);
    expect(JSON.parse(String(calls.find((c) => c.url === "/api/chat")!.init.body)).message).toBe(SPOKEN);
  });

  it("Type instead removes the bubble and gives the box back", async () => {
    stubFetch([async () => json({ text: "", ms: 300 })]);
    renderChat();
    await recordAndSend();
    // Silence: no Retry (the same audio gives the same result).
    await screen.findByText(/Nous n'avons rien entendu/);
    expect(screen.queryByRole("button", { name: "Réessayer la transcription" })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retirer le message vocal et écrire votre message" }));
    });
    await waitFor(() => expect(document.querySelectorAll("[data-mine]").length).toBe(0));
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(box.disabled).toBe(false);
    expect(document.activeElement).toBe(box);
  });

  it("is keyboard operable: focus on Send while recording, Escape cancels and says so", async () => {
    const calls = stubFetch([]);
    renderChat();
    const mic = screen.getByRole("button", { name: "Enregistrer un message vocal" });
    await act(async () => {
      fireEvent.click(mic);
    });
    const send = await screen.findByRole("button", { name: "Envoyer le message vocal" });
    expect(document.activeElement).toBe(send);
    // The recording is announced, the group is named, and the page passes axe.
    expect(screen.getByRole("group", { name: "Enregistrement" })).toBeTruthy();
    expect(screen.getByText(/Enregistrement en cours/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Annuler le message vocal" })).toBeTruthy();
    expect(await violations()).toEqual([]);
    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Enregistrer un message vocal" })));
    expect(screen.getByText("Message vocal annulé.")).toBeTruthy();
    expect(stopped).toBe(1);
    expect(calls).toEqual([]);
  });

  it("tells the person when the microphone is blocked", async () => {
    getUserMedia.mockRejectedValueOnce(Object.assign(new Error("no"), { name: "NotAllowedError" }));
    stubFetch([]);
    renderChat();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Enregistrer un message vocal" }));
    });
    expect(screen.getAllByText(/Le micro est bloqué pour ce site/).length).toBeGreaterThan(0);
  });

  it("hides the mic when the browser cannot record", () => {
    vi.stubGlobal("MediaRecorder", undefined);
    stubFetch([]);
    renderChat();
    expect(screen.queryByRole("button", { name: "Enregistrer un message vocal" })).toBeNull();
  });
});

describe("recorder helpers", () => {
  it("picks Opus first, then Safari AAC in MP4", () => {
    expect(pickMimeType((t) => t.startsWith("audio/webm"))).toBe("audio/webm;codecs=opus");
    expect(pickMimeType((t) => t.startsWith("audio/mp4"))).toBe("audio/mp4;codecs=mp4a.40.2");
    expect(pickMimeType(() => false)).toBe("");
  });

  it("draws a static waveform scaled to the loudest part", () => {
    const bars = waveform([0, 0.1, 0.5, 0.25, 0, 0, 0.5, 0.1], 4);
    expect(bars).toEqual([0.2, 1, 0.12, 1]);
    expect(waveform([], 3)).toEqual([0.15, 0.15, 0.15]);
  });

  it("moves only when the person allows motion", () => {
    const css = readFileSync(join(process.cwd(), "src/chat/voice.module.css"), "utf8");
    const motion = css.indexOf("@media (prefers-reduced-motion: no-preference)");
    expect(motion).toBeGreaterThan(0);
    // Every animation and transition sits inside the motion query.
    const outside = ["animation:", "transition:"].filter((word) => css.slice(0, motion).includes(word));
    expect(outside).toEqual([]);
    expect(css.slice(motion)).toContain("animation:");
  });
});
