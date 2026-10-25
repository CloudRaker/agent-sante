// Agent status lines (Run custom event `status`): checked fast, streamed as agent_status steps,
// dropped silently when the check fails, errs or is slow. They never reach the reply text.
import { describe, expect, it } from "vitest";
import { readSseFrames, type Activity, type ChatResult } from "../shared/activity";
import type { ChatResponse } from "../shared/api";
import type { CallOptions, Reply, RunApi, RunEvent } from "../worker/run/client";
import type { DecisionModel } from "../worker/safety/milliseconds";
import { checkStatus, statusText } from "../worker/status";
import { makeApp, mid, ORIGIN } from "./helpers";

const REPLY = "Voici la page officielle : [Québec.ca](https://www.quebec.ca/sante/problemes-de-sante/grippe-rhume-et-gastro).";
const STATUS = "Je cherche dans les pages de Québec.ca sur la grippe";

/** A Run fake that plays one status event, waits, then answers. */
function statusRun(text: string, waitMs = 30): RunApi {
  let n = 0;
  const play = async (options?: CallOptions): Promise<Reply> => {
    const runId = `run_${++n}`;
    options?.onEvent?.({ seq: 2, type: "event.status", run_id: runId, data: { text } } as RunEvent);
    await new Promise((r) => setTimeout(r, waitMs));
    return { runId, status: "waiting", lastSeq: 3, text: REPLY };
  };
  return { start: (_a, _i, _k, o) => play(o), turn: (_r, _i, _k, o) => play(o), cancel: async () => {} };
}

/** A model fake: the status line gets `statusScore` (a number, a delay or an error), the reply 0.01. */
function model(statusScore: number | "slow" | "error"): DecisionModel & { checked: string[] } {
  const checked: string[] = [];
  return {
    checked,
    entities: async () => [],
    async yesNoHint(text) {
      checked.push(text);
      if (text !== STATUS && !text.startsWith("Je donne")) return 0.01;
      if (statusScore === "error") throw new Error("down");
      if (statusScore === "slow") return new Promise<number>((r) => setTimeout(() => r(0.01), 1000));
      return statusScore;
    },
  };
}

async function turn(run: RunApi, m: DecisionModel) {
  const app = makeApp(run, m);
  const s = await app.post("/api/session", { turnstileToken: "ok", lang: "fr" });
  const res = await app.app.request("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, accept: "text/event-stream" },
    body: JSON.stringify({ sessionToken: s.json.sessionToken, messageId: mid(), message: "Je pense que j'ai la grippe", lang: "fr", transcript: [] }),
  });
  const frames: { event: string; data: string }[] = [];
  for await (const f of readSseFrames(res.body!)) frames.push(f);
  const activities = frames.filter((f) => f.event === "activity").map((f) => JSON.parse(f.data) as Activity);
  const result = JSON.parse(frames.find((f) => f.event === "result")!.data) as ChatResult;
  // Let a late check finish, so its log line is in.
  await new Promise((r) => setTimeout(r, 400));
  return { activities, result, logs: app.logs };
}

const statusSteps = (list: Activity[]) => list.filter((a) => a.kind === "agent_status");

describe("agent status lines", () => {
  it("streams a status line that passes the check, and keeps it out of the reply", async () => {
    const m = model(0.05);
    const { activities, result, logs } = await turn(statusRun(STATUS), m);
    expect(statusSteps(activities)).toEqual([expect.objectContaining({ kind: "agent_status", state: "done", params: { text: STATUS } })]);
    expect(m.checked).toContain(STATUS);
    const body = result.body as ChatResponse & { ended: false };
    expect(result.status).toBe(200);
    expect(body.reply.text).not.toContain(STATUS);
    expect(JSON.stringify(body.transcript)).not.toContain(STATUS);
    expect(logs.some((l) => l.event === "status_dropped")).toBe(false);
  });

  it("drops a flagged status line and logs the reason only", async () => {
    const { activities, result, logs } = await turn(statusRun(STATUS), model(0.8));
    expect(statusSteps(activities)).toEqual([]);
    expect(result.status).toBe(200);
    expect(logs).toContainEqual(expect.objectContaining({ event: "status_dropped", reason: "flagged" }));
    expect(JSON.stringify(logs)).not.toContain("Je cherche");
  });

  it("drops a status line when the check takes more than 300 ms", async () => {
    const { activities, logs } = await turn(statusRun(STATUS, 600), model("slow"));
    expect(statusSteps(activities)).toEqual([]);
    expect(logs).toContainEqual(expect.objectContaining({ event: "status_dropped", reason: "timeout" }));
  });

  it("drops a status line when the check fails", async () => {
    const { activities, logs } = await turn(statusRun(STATUS), model("error"));
    expect(statusSteps(activities)).toEqual([]);
    expect(logs).toContainEqual(expect.objectContaining({ event: "status_dropped", reason: "error" }));
  });

  it("drops a status line with a dose before any model call", async () => {
    const dose = "Je donne 500 mg d'acétaminophène toutes les 6 heures";
    const m = model(0.01);
    const { activities, logs } = await turn(statusRun(dose), m);
    expect(statusSteps(activities)).toEqual([]);
    expect(m.checked).not.toContain(dose);
    expect(logs).toContainEqual(expect.objectContaining({ event: "status_dropped", reason: "dose" }));
  });

  it("refuses a status line with a link, markup or a bad length", async () => {
    expect(statusText({ text: "Je lis https://www.quebec.ca" })).toBeNull();
    expect(statusText({ text: "<b>Je cherche</b>" })).toBeNull();
    expect(statusText({ text: "ok" })).toBeNull();
    expect(statusText({ text: "x".repeat(101) })).toBeNull();
    expect(statusText({ text: "  Je cherche   la page  " })).toBe("Je cherche la page");
    expect(await checkStatus(model(0.01), { text: 3 })).toEqual({ ok: false, reason: "invalid" });
  });
});
