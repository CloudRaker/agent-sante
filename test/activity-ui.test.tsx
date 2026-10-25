// @vitest-environment jsdom
// The activity steps in the browser: stream parsing, step updates, the live list and the summary.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Activity } from "../shared/activity";
import { applyActivity, livePhase, settleSteps, type ActivityStep } from "../src/chat/activity";
import { ActivityList, ActivitySummary } from "../src/chat/ActivityTimeline";
import { Chat } from "../src/chat/Chat";
import { I18nProvider } from "../src/i18n";
import { ApiFailure, sendChatStream } from "../src/lib/api";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const REQ = { sessionToken: "t", messageId: "message000001", message: "allo", lang: "fr" as const, transcript: [] };

function sse(frames: [string, unknown][]): Response {
  const text = frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  // Split in odd chunks, like a network does.
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7));
      c.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

const a = (id: string, kind: Activity["kind"], state: Activity["state"], t: number, params?: Activity["params"]): Activity => ({
  id,
  kind,
  state,
  t,
  ...(params ? { params } : {}),
});

describe("sendChatStream", () => {
  it("gives each step, then returns the reply of the result event", async () => {
    const reply = {
      ended: false,
      reply: { text: "ok", sources: [] },
      agentId: "fr/concierge",
      lang: "fr",
      sessionToken: "n",
      expiresAt: 1,
      transcript: [],
    };
    const fetcher = vi.fn<typeof fetch>(async () =>
      sse([
        ["activity", a("privacy", "privacy", "running", 0)],
        ["activity", a("privacy", "privacy", "done", 40)],
        ["result", { status: 200, body: reply }],
      ]),
    );
    vi.stubGlobal("fetch", fetcher);
    const seen: Activity[] = [];
    const res = await sendChatStream(REQ, (x) => seen.push(x));
    expect(res).toEqual(reply);
    expect(seen.map((x) => x.state)).toEqual(["running", "done"]);
    expect((fetcher.mock.calls[0]![1]!.headers as Record<string, string>).accept).toBe("text/event-stream");
  });

  it("throws the error of the result event", async () => {
    vi.stubGlobal("fetch", async () => sse([["result", { status: 422, body: { error: "pii", kinds: ["phone_number"] } }]]));
    const error = await sendChatStream(REQ, () => {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiFailure);
    expect(error).toMatchObject({ status: 422, body: { error: "pii" } });
  });

  it("reads a plain JSON error, and fails when the stream ends without a result", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ error: "busy", retryAfter: 5 }), { status: 409, headers: { "content-type": "application/json" } }),
    );
    await expect(sendChatStream(REQ, () => {})).rejects.toMatchObject({ status: 409, body: { error: "busy" } });
    vi.stubGlobal("fetch", async () => sse([["activity", a("privacy", "privacy", "running", 0)]]));
    await expect(sendChatStream(REQ, () => {})).rejects.toMatchObject({ status: 0, body: { error: "unavailable" } });
  });
});

describe("steps", () => {
  it("updates a step by id and keeps its params", () => {
    let steps: ActivityStep[] = [];
    steps = applyActivity(steps, a("x", "search", "running", 100, { query: "vaccin" }));
    steps = applyActivity(steps, a("x", "search", "done", 900));
    expect(steps).toEqual([{ id: "x", kind: "search", state: "done", params: { query: "vaccin" }, start: 100, end: 900 }]);
  });

  it("gives a coarse phase for the screen reader", () => {
    let steps: ActivityStep[] = [];
    expect(livePhase(steps)).toBe("checking");
    steps = applyActivity(steps, a("privacy", "privacy", "running", 0));
    expect(livePhase(steps)).toBe("checking");
    steps = applyActivity(steps, a("privacy", "privacy", "done", 10));
    steps = applyActivity(steps, a("agent:1", "agent", "running", 10, { agent: "fr/concierge" }));
    steps = applyActivity(steps, a("agent:1.t1", "search", "running", 20));
    expect(livePhase(steps)).toBe("working");
    steps = applyActivity(steps, a("safety:1", "safety", "running", 30));
    expect(livePhase(steps)).toBe("reviewing");
    expect(settleSteps(steps).every((s) => s.state !== "running")).toBe(true);
  });
});

const STEPS: ActivityStep[] = [
  { id: "privacy", kind: "privacy", state: "done", params: {}, start: 0, end: 300 },
  { id: "routing", kind: "routing", state: "done", params: { agent: "fr/concierge", via: "concierge" }, start: 300, end: 300 },
  { id: "agent:1", kind: "agent", state: "done", params: { agent: "fr/concierge" }, start: 300, end: 5400 },
  { id: "agent:1.wait", kind: "waiting", state: "done", params: {}, start: 2000, end: 3000 },
  { id: "agent:1.t1", kind: "search", state: "done", params: { query: "vaccin grippe" }, start: 1200, end: 1900 },
  { id: "safety:1", kind: "safety", state: "failed", params: {}, start: 5400, end: 6000 },
];

describe("ActivityList and ActivitySummary", () => {
  it("summarizes the steps in French and opens to the list with durations", async () => {
    render(
      <I18nProvider lang="fr">
        <main>
          <ActivitySummary activity={{ steps: STEPS, totalMs: 7240 }} />
        </main>
      </I18nProvider>,
    );
    // The heartbeat does not count as a step.
    const trigger = screen.getByRole("button", { name: /5 étapes · 7,2 s/ });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    // The panel opens on a spring; jsdom does not run it, so the query includes hidden nodes.
    expect(document.querySelector('ol[aria-label="Étapes de la réponse"]')?.children).toHaveLength(STEPS.length);
    expect(screen.getByText(/«\s?vaccin grippe\s?»/)).toBeTruthy();
    expect(screen.getAllByText(/, échec/)).toHaveLength(1);
    expect(screen.getByText("5,1 s")).toBeTruthy();
    const result = await axe.run(document.body, { rules: { "color-contrast": { enabled: false } }, resultTypes: ["violations"] });
    expect(result.violations.map((v) => v.id)).toEqual([]);
  });

  it("says it in English too", () => {
    render(
      <I18nProvider lang="en">
        <ActivitySummary activity={{ steps: STEPS.slice(0, 1), totalMs: 1000 }} />
      </I18nProvider>,
    );
    expect(screen.getByRole("button", { name: /1 step · 1.0 s/ })).toBeTruthy();
  });

  it("shows the running step live, with its state for screen readers", () => {
    render(
      <I18nProvider lang="fr">
        <ActivityList live steps={[{ id: "r", kind: "rewrite", state: "running", params: { attempt: 2, of: 3 }, start: 0 }]} />
      </I18nProvider>,
    );
    expect(screen.getByText(/essai 2 sur 3/)).toBeTruthy();
    expect(screen.getByText(/, en cours/)).toBeTruthy();
  });
});

describe("Chat with a streamed answer", () => {
  it("shows the live steps while the turn runs, then the summary under the reply", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    const enc = new TextEncoder();
    const frame = (event: string, data: unknown) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    vi.stubGlobal("fetch", async () => {
      const body = new ReadableStream<Uint8Array>({
        async start(c) {
          c.enqueue(frame("activity", a("privacy", "privacy", "done", 100)));
          c.enqueue(frame("activity", a("agent:1", "agent", "running", 120, { agent: "fr/concierge" })));
          c.enqueue(frame("activity", a("agent:1.t1", "search", "running", 300, { query: "joindre le 811" })));
          await gate;
          c.enqueue(frame("activity", a("agent:1.t1", "search", "done", 900)));
          c.enqueue(frame("activity", a("agent:1", "agent", "done", 2000)));
          c.enqueue(
            frame("result", {
              status: 200,
              body: {
                ended: false,
                reply: { text: "Appelez le 811.", sources: [] },
                agentId: "fr/concierge",
                lang: "fr",
                sessionToken: "t2",
                expiresAt: Date.now() + 600_000,
                transcript: [],
              },
            }),
          );
          c.close();
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    });
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
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "Comment joindre le 811 ?" } });
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });
    // Live: the steps show, and the screen reader gets one summary line.
    await screen.findByText(/joindre le 811\s?»/);
    expect(screen.getByRole("status").textContent).toBe("Recherche dans les sources officielles");
    await act(async () => finish());
    // Done: the reply, and the steps fold into one summary button.
    await screen.findByText("Appelez le 811.");
    await waitFor(() => expect(screen.getByRole("button", { name: /3 étapes · / })).toBeTruthy());
  });
});
