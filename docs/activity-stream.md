# Activity stream

The browser sends `/api/chat` with `Accept: text/event-stream` and reads the body with `fetch`
(Cloudflare does not buffer `text/event-stream`). Errors before the turn starts (bad token, busy
session, rate limit) still come back as plain JSON with their status. After the session guard takes
the turn, the Worker sends:

- `event: activity` frames while the turn runs: `{id, kind, state, t, params?}`. `id` is stable across
  the updates of one step, `state` is `running`, `done` or `failed`, `t` is milliseconds since the
  request started. Kinds: `privacy` (PII check), `routing` (first message: `agent`, `via` direct or
  concierge), `agent` (an agent at work), `search` and `read` (Run work rows, with a clean `query` or
  `title` when the row phrase gives one), `tool` (any other tool, with its name), `handoff` (target
  `agent` only, never the model's reason), `language`, `safety` (medical-advice check), `rewrite`
  (`attempt` n of `of`), `waiting` (Run heartbeat: a model call open more than 30 s), `agent_status`
  (the agent says what it does, `text`, see below), `question` (the agent asks a clarifying question,
  shown as "Question de l'agent") and `answer` (the person's answer goes to the agent, `via` `choice` or
  `text`, shown as "Votre réponse").
- one `event: result` frame at the end: `{status, body}`, the same status and body as the JSON answer.

Agent status lines: each leaf agent has a custom event `status` (tool `emit_status`, `{text}`, 3 to 100
characters) that it calls in the same step as a search, a read, a place search or a handoff. The Worker
checks each line (`worker/status.ts`): plain text with no link or markup, the dose guard (`hasDose`), then
one milliseconds medical-advice call (same hint and threshold as the reply check, no rewrite) in a 300 ms
budget. A line that passes goes to the browser as an `agent_status` step. A line that fails, errs or is
late is dropped silently, and the Worker logs `status_dropped` with the reason only. At most 8 lines per
request. A status line never goes into the reply or the transcript.

Rules: apart from a checked `agent_status` line, a step never carries agent text. The reply text is only in the `result` frame, after
both checks passed. The Worker never logs step params. The logs and the error-rate counter use the
status of the `result` frame (`request` log with `stream: true`). When the browser closes the stream,
the Worker stops the Run read, cancels the live run and releases the session lease.

Thresholds: PII 0.7, medical advice 0.5. Both checks fail closed: an error, a bad answer or a timeout (3 s per
attempt, one retry) blocks the message (check A) or hides the reply and cancels the run (check B).
The logs keep scores only: `pii_score` (layer, best score, threshold, kept and dropped span types),
`advice_score` (score, threshold, attempt) and `ms_call` (route, status, `x-input-tokens`, `x-inference-ms`).
