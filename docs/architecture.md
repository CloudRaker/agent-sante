# Architecture

How a message goes from the browser to the agents and back, and how the session is bound.

## How a message moves

1. The person accepts the gate: the consents come as agent messages, one « J'accepte » button each, with an invisible Cloudflare Turnstile check. `POST /api/session` checks
   Turnstile with Siteverify and returns a signed session token (HS256, 10 minutes, sliding).
2. `POST /api/chat` takes the token, the message, the language and the checked transcript. The Worker:
   - checks that the transcript matches the hash in the token, and that the token is the latest one
     (a Durable Object per session gives single use and one turn at a time);
   - runs the PII check: a regex layer in the Worker first (email, phone, postal code, RAMQ, SIN,
     birth date, file number, a name in a self-introduction or a signature such as "moi c'est ...",
     "my name is ..." or "Merci, Jean"), then milliseconds `entities` (hosted in Montréal). A message with personal
     information returns `422 {error: "pii", kinds}` and never goes to a model;
   - on the first message only, routes it with one milliseconds `classify` call over the specialists
     of the language, in parallel with `entities` (no call when the regex layer fires; the result is
     dropped when PII is found). A winner at 0.5 or more, or at 0.3 or more with 2.5 times the second
     score, starts that specialist directly. A message that names a vaccine goes to the vaccines agent
     with no classify call. Any other case, or a classify failure, starts the concierge (`worker/safety/routing.ts`);
   - sends the turn to CloudRaker Run (or starts a run), reads the reply and the custom events
     (`handoff`, `switch_language`), and starts the target agent with the transcript when needed.
     The read stops at a handoff event that the Worker follows: it cancels that run and starts the
     target at the same time, with no wait for the rest of the turn;
   - runs the medical-advice check (milliseconds `yes-no` with a hint pair). The check starts when the
     reply text arrives, and the Worker uses it only when that text is the final reply. A flagged reply goes back
     to the agent with a rewrite request. After 3 flagged attempts the run is cancelled and the
     conversation ends (`{ended: true, reason: "medical_advice"}`);
   - returns the checked reply, its official sources and a new token.

   Clarifying questions: an agent can call the Run `ask` tool with a short question and up to 3 suggested
   answers (`choices`). The turn ends with reason `question`. The Worker cleans the question to plain text
   (`worker/question.ts`: no markup, no link, a choice over 80 characters or a duplicate is dropped, 3 at
   most). When the last paragraph of the reply text ends with the question, the Worker drops that paragraph:
   the card shows the question once. Then it runs the medical-advice check on the reply text, the question
   and the choices together. A
   flagged question takes the rewrite path, with the same 3-strike rule. The answer carries
   `reply.question {text, choices}`, and the new token holds the open question (claim `q`: the Run
   question id and the choices). The question and its choices join the agent entry of the transcript, so
   the hash chain covers them. The next message answers it:
   - a click on a suggested answer sends `choice: true`. The Worker accepts it as a choice only when the
     message is exactly one of the choices in the signed token. A choice skips the PII check: it is the
     agent's own text, which passed the medical-advice check. A value that is not a stored choice is free
     text (log `choice_unmatched`);
   - free text (the "Other answer" field or the main box) goes through the PII check and the names rule
     like any message;
   - the Worker sends Run `{answer: {question_id, value}}`. If Run answers `question_mismatch`, it sends a
     plain turn. After a run change (handoff, language switch, run gone), the answer is plain text in the
     transcript of the new run.

   With `Accept: text/event-stream`, the answer streams (see "Activity stream" below). Without it, the
   answer is one JSON body.
3. `POST /api/end` cancels the current run, so its short retention clock starts. The browser calls it with
   `navigator.sendBeacon` when the person ends the chat or closes the tab.

The person never sees an unchecked reply. The server never logs message text.

## Session binding

The browser holds one thing: a session token in memory (a JWT, HS256, signed with the Worker secret
`SESSION_SECRET`). It never gets the Run token, a Run read token or a run id it can use.

| Claim   | What                                                                       |
| ------- | -------------------------------------------------------------------------- |
| `sid`   | Random session id                                                          |
| `run`   | Current Run run id, or empty when the next message starts a new run        |
| `agent` | Current agent id                                                           |
| `lang`  | Current language                                                           |
| `th`    | Hash chain of the checked transcript: `th(n) = SHA-256(th(n-1), entry n)`  |
| `n`     | Number of accepted user messages                                           |
| `q`     | Open question of the agent: `{id, c}` (Run question id, suggested answers). Absent when no question is open |
| `iat`, `exp`, `jti` | Issued at, expiry (10 minutes, sliding), token id              |

Rules:

- `/api/chat` and `/api/end` read the run id from the verified claims only. A `run` or `agent` field in the
  body is ignored. A token signed with another key, an expired token or an old token gets `401` on `/api/chat`.
- `/api/end` accepts any valid token of the session, also an older one (a tab can close while a turn commits).
  It cancels the run id that the session guard stored at the last commit, never a run id from the token.
- One turn in flight per session. Each flight has its own id, and only that flight can commit or release the
  session. All Run calls of one message share a 150 s budget, which is shorter than the 240 s lease.
- Each reply returns a new token with the new `run`, `agent`, `th` and `jti`, and a new 10 minute expiry.
- The browser sends the transcript back with each message (a new run needs it after a handoff or a language
  switch). The Worker recomputes the hash chain and refuses a transcript that does not match `th` (`409`),
  before the PII check and before Run. So a forged transcript cannot carry text that skipped the PII check.
- Single flight: one Durable Object per `sid` (`SessionGuard`, `worker/guard.ts`). Each Durable Object runs
  its calls one at a time, so `begin` is atomic: it accepts only the latest `jti` and takes a lease for
  one turn (`409 busy` for a second turn). `commit` stores the new `jti`. `end` deletes the state, so every
  older token of the session stops working. The object stores only ids and forgets the session 15 minutes
  after its last use (alarm). The guard is a Durable Object because a KV write is not atomic and is
  eventually consistent across locations, and an in-isolate lock does not hold across isolates.
- If the person closes the tab while a turn runs, `/api/end` deletes the guard state. The turn then cannot
  commit: the Worker cancels the run it started and returns `401`.
