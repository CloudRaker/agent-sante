// Maps the Run `run.progress` work rows to activity steps for the browser.
// Run sends a row before and after each tool call: {text, tool, call_id, state, error?}.
// `text` is an English phrase from Run, for example
// "Searching knowledge for vaccin grippe" or "Read Fièvre chez l'enfant". The tool args are not
// in the event. We keep only a clean search query or document title from the phrase. The query
// comes from a message that passed the PII check; the person who wrote it may see it. Never log it.
// Run sends these rows only for agents with `work_session: true`.
import type { ActivityKind, ActivityParams, ActivityState } from "../shared/activity";

/** Max length of a query or a title that we show. Longer text is dropped, not cut. */
export const MAX_PARAM_CHARS = 80;

/** Letters, digits, spaces and plain punctuation only. No URL, no markup, no control characters. */
const CLEAN = /^[\p{L}\p{M}\p{N} '’,.?!:;()«»"&/-]+$/u;

/** A phrase part that is safe and short enough to show, or undefined. */
export function cleanParam(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const v = value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["«“]\s*|\s*["»”]$/g, "");
  if (!v || v.length > MAX_PARAM_CHARS || !CLEAN.test(v) || /https?:|www\./i.test(v)) return undefined;
  return v;
}

const TOOL_NAME = /^[a-z][a-z0-9_]{0,47}$/;

export interface ToolRow {
  callId: string;
  kind: ActivityKind;
  state: ActivityState;
  params?: ActivityParams;
}

/**
 * A Run `run.progress` data object to a tool step, or null when it is not a tool row
 * (a heartbeat, "Stopped", a row without a tool, an `emit_*` tool: the custom events
 * handoff and switch_language come as their own events, and Run sends no row for them; or
 * `call_api`, shown by its operation instead).
 */
export function toolRow(data: Record<string, unknown>): ToolRow | null {
  const tool = typeof data.tool === "string" ? data.tool : "";
  const callId = typeof data.call_id === "string" && data.call_id ? data.call_id : "";
  const state = data.state === "running" || data.state === "done" || data.state === "failed" ? data.state : null;
  if (!tool || !callId || !state || data.heartbeat === true || tool.startsWith("emit_")) return null;
  // `call_api` reaches our own tools: their step (places, appointments, drugs) comes from the
  // "Called <operation>" event (toolStepKind), so this generic row would only repeat it.
  if (tool === "call_api") return null;
  const text = typeof data.text === "string" ? data.text : "";
  if (tool === "knowledge_search") {
    const query = cleanParam(/\bknowledge for (.+)$/i.exec(text)?.[1]);
    return { callId, kind: "search", state, ...(query ? { params: { query } } : {}) };
  }
  if (tool === "knowledge_read") {
    const raw = /^(?:Reading|Read|Could not read|Tried to read) (.+)$/.exec(text)?.[1];
    const title = raw && raw.toLowerCase() !== "knowledge" ? cleanParam(raw) : undefined;
    return { callId, kind: "read", state, ...(title ? { params: { title } } : {}) };
  }
  return { callId, kind: "tool", state, params: TOOL_NAME.test(tool) ? { tool } : {} };
}

/** True for the Run heartbeat row (a model call open for more than 30 s). */
export const isHeartbeat = (data: Record<string, unknown>): boolean => data.heartbeat === true;

/** Our tools (`_apis/agent-sante-tools.yaml` operations) and their step kind. */
const PLACE_TOOLS: Record<string, "places" | "appointments" | "drugs"> = {
  places_search: "places",
  drug_search: "drugs",
  drug_info: "drugs",
  appointments_services: "appointments",
  appointments_link: "appointments",
  appointments_search: "appointments",
};

/**
 * Run sends `run.progress {text: "Called <operation>"}` after each `_apis` call.
 * Returns the step kind for our place tools, else null.
 */
export function toolStepKind(data: Record<string, unknown>): "places" | "appointments" | "drugs" | null {
  const op = typeof data.text === "string" ? /^Called ([a-z_]{1,48})$/.exec(data.text)?.[1] : undefined;
  return (op && PLACE_TOOLS[op]) || null;
}
