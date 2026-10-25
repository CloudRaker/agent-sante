// What the Worker tells the browser while a turn runs. Each step has structured params only:
// never agent message text, never a reason that the model wrote.
import type { ApiError, ChatResponse, Lang } from "./api";

export const ACTIVITY_KINDS = [
  /** PII check of the person's message. */
  "privacy",
  /** First message: which agent answers first (direct to a specialist, or the concierge). */
  "routing",
  /** An agent works on the answer. */
  "agent",
  /** Run tool row: knowledge_search. */
  "search",
  /** Run tool row: knowledge_read. */
  "read",
  /** Run tool row: any other tool. */
  "tool",
  /** The conversation goes to another agent. */
  "handoff",
  /** The conversation goes to the other language. */
  "language",
  /** Medical-advice check of the reply. */
  "safety",
  /** The reply went back to the agent for a rewrite. */
  "rewrite",
  /** Run heartbeat: a model call is open for more than 30 s. */
  "waiting",
  /** A postal code left the message: the Worker keeps its area as the session place. */
  "location",
  /** Tool: health directory search near the session place. */
  "places",
  /** Tool: Clic Santé services and links. */
  "appointments",
  /** Tool: Health Canada drug search or product leaflet. */
  "drugs",
  /** The agent says what it does (custom event status), after the Worker checked the line. */
  "agent_status",
  /** The agent asks a clarifying question (Run ask), after the medical-advice check. */
  "question",
  /** The person's answer to that question goes to the agent (a suggested answer, or free text). */
  "answer",
] as const;

export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export type ActivityState = "running" | "done" | "failed";

export interface ActivityParams {
  /** Agent id (the browser shows its name from the catalog). */
  agent?: string;
  /** Routing: the first agent is a specialist ("direct") or the concierge. Answer: a suggested answer ("choice") or free text ("text"). */
  via?: "direct" | "concierge" | "choice" | "text";
  /** Rewrite: number of the new attempt, and the max. */
  attempt?: number;
  of?: number;
  /** Search query, only when the Run work row gives a clean one. */
  query?: string;
  /** Title of the document read, only when the Run work row gives a clean one. */
  title?: string;
  /** Tool name for the generic tool row. */
  tool?: string;
  /** Language switch target. */
  lang?: Lang;
  /** Location: the FSA of the postal code ("H2X"), never the full code. */
  area?: string;
  /** agent_status: the checked status line of the agent (3 to 100 characters). */
  text?: string;
}

export interface Activity {
  /** Stable id: each update of a step uses the same id. */
  id: string;
  kind: ActivityKind;
  state: ActivityState;
  /** Milliseconds since the Worker got the request. */
  t: number;
  params?: ActivityParams;
}

/** The last event of a streamed /api/chat: the same status and body as the JSON answer. */
export interface ChatResult {
  status: number;
  body: ChatResponse | ApiError;
}

/** One frame of a text/event-stream body. */
export interface SseFrame {
  event: string;
  data: string;
}

function parseFrame(frame: string): SseFrame | null {
  let event = "message";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  return data.length ? { event, data: data.join("\n") } : null;
}

/** Parses a text/event-stream body into frames. Frames without a data line are skipped. */
export async function* readSseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const f of frames) {
        const frame = parseFrame(f);
        if (frame) yield frame;
      }
    }
    const last = parseFrame(buffer + decoder.decode());
    if (last) yield last;
  } finally {
    reader.releaseLock();
  }
}
