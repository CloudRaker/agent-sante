# Features

## Pages

**"Should I call 811?"** `/appeler-le-811`, `/en/calling-811`. Orientation only: the 811 options, what the nurse
asks, a practical list to have ready (labelled as ours, not official), and the official sources.

**Transparency.** `/transparence`, `/en/transparency`, data from `GET /api/stats`. The `StatsCounter` Durable
Object (one global instance, `worker/stats.ts`) keeps counts per Québec day: `conversations`, `messages`,
`piiBlocks`, `adviceBlocks` (each removed reply), `adviceEnded` (conversations ended after 3 removed replies),
`transcriptions` (voice messages with a non-empty transcript).
It keeps no text, no session id and no IP address. It also keeps the cost sums per day
(see "Analytics and costs"). The counts are in a Durable Object, not in Analytics Engine, because the
page reads the totals back, and a Durable Object gives exact, atomic counts with no SQL API token.

## In the chat

**Display options.** The display menu (navbar, or the phone menu) has three switches: dark theme, large text and simple language. They stay in `localStorage`.

- Large text: `data-text="large"` on `<html>` sets the root font size to 125 %. All Arc sizes are in `rem`.
- Simple language (FALC): the browser sends `simple: true` with each message. The Worker adds one line before
  the first message of a new run, and before a turn when the mode changes. The agent prompts must follow it.
  The lines are (`worker/pipeline.ts`, `withMode`):
  - fr on: `[Mode langage simple activé. Répondez en français facile à lire et à comprendre (FALC) : phrases courtes, mots courants, une idée par phrase. Gardez les liens vers les sources.]`
  - fr off: `[Mode langage simple désactivé. Répondez comme d'habitude.]`
  - en on: `[Simple language mode on. Answer in easy-to-read English: short sentences, common words, one idea per sentence. Keep the source links.]`
  - en off: `[Simple language mode off. Answer as usual.]`

  The token claim `simple` holds the mode that the live run knows. The PII check and the transcript see only
  the message, never this line.
- Voice messages (milliseconds rakeaudio, see "Voice messages" below).

**Voice messages.** The mic button sits in the message box. The flow:

1. Tap the mic. The browser asks for the microphone on the first tap only, never on page load
   (`Permissions-Policy` allows the microphone for our own origin only). `MediaRecorder` records the
   best type the browser has: Opus in WebM (Chrome, Edge), Opus in Ogg (Firefox), AAC in MP4 (Safari),
   at 32 kbit/s. While it records, a bar takes the place of the box: cancel, the time out of 1:00, live
   level bars and Send. Focus goes to Send; Escape cancels. The line under the box says where the voice
   goes. The recording stops by itself at 60 s.
2. On Send, the thread shows an audio bubble at once (duration, a static waveform from the recorded
   levels, "Transcription…"). The box waits, so the messages stay in order.
3. The browser posts the audio to `POST /api/transcribe`: raw body, an allowed `audio/*` type,
   `authorization: Bearer <session token>`. The Worker checks the token (signature and expiry), the IP
   and session chat limits plus `RL_TRANSCRIBE` (6 per minute per session), the type allow list
   (`AUDIO_TYPES` in `shared/api.ts`) and a 3 MB cap (read as a stream, it stops at the cap). It sends
   the bytes to milliseconds rakeaudio (`MS_AUDIO_URL`, `diarize=false`) with a 15 s budget and one
   retry on 502, 503 or 529. It answers `{text, ms}`. Errors: `401 session_expired`,
   `415 unsupported_audio` (type), `422 unsupported_audio` (the audio does not decode), `413 audio_too_large`
   (over 3 MB, or over 63 s), `429 rate_limited`, `504 timeout`, `503 unavailable`.
4. The transcript takes the row of the bubble (same message id) and goes through `/api/chat` like typed
   text: PII check (names too), routing, model, medical-advice check. The transcribe route itself never
   calls a model or Run. If the PII check blocks it, the text goes into the box with the usual alert, and
   nothing reaches a model.
5. A failed transcription shows on the bubble with Retry and "Type instead". Silence (an empty text),
   a file too large or an audio type the API cannot read has no Retry.

Privacy: the audio and the text stay in memory only, in the browser and in the Worker. The Worker logs
`transcribe` with `status`, `bytes`, `duration`, `type`, `ms`, `inferenceMs` and `inputTokens`, never the
audio or the text. The transparency counter `transcriptions` counts each non-empty transcript.

The mic shows always (where the browser can record), with no display option to turn it on. The audio
goes to our own service, and the person sees where at the moment of recording (the line under the
bar, the mic button description, the gate, the privacy page and the press kit). The mic has no
press-and-hold mode: it does not work with a keyboard or a screen reader, and it is easy to drop by
mistake on a phone.

milliseconds rakeaudio: `POST https://api.milliseconds.ai/v1/rakeaudio/transcribe`,
synchronous, the audio file as the raw body (mp3, m4a, wav, ogg, opus, flac, webm), up to 60 minutes and
100 MB, 25 European languages detected in the audio (`language` is always `null`, so the route does not
send or return a language). Price: USD 0.10 per audio hour without speakers (2,500,000 input tokens per
hour), so a 10 s message costs about USD 0.0003.

Local fake: with `FAKE_UPSTREAMS=1`, the transcriber waits 1.8 s and returns one fixed question in the
session language. `node scripts/voice-shots.mjs` takes the voice screenshots (it gives the page a
synthetic microphone, because headless Chromium does not answer `getUserMedia`).

## Press kit

**Press kit.** `/presse`, `/en/press`: facts, an inline SVG architecture diagram (theme tokens, light and dark),
the data flow, the symbol and a contact. `PRESS_EMAIL` in
`src/i18n/tool-pages.ts` is `null` until CloudRaker confirms a press address.

## Guardrails

- Kill switch: set `KILL_SWITCH` to `"1"` and deploy. `/api/config` says `maintenance: true` and the app shows the
  maintenance page with the help numbers. `/api/end` still works, so open conversations cancel their runs.
  Every other route answers `503 {error: "maintenance"}`.
- Daily cap: Run has no wallet cap, so the Worker counts each Run call (start or turn, handoffs and rewrites
  included) per Québec day in `StatsCounter`. A message that the PII check blocks uses no unit. At the cap,
  `/api/session` and `/api/chat` answer `503 {error: "at_capacity"}`. The app shows "Agent Santé has reached its
  limit for today. Call 811." The cap fails open if the Durable Object fails (it is a cost guardrail, not a
  safety check), and logs `stats_take_failed` with `alert: true`.
- Error-rate alert: `StatsCounter` keeps 1-minute buckets of `/api/session` and `/api/chat` statuses. When the last
  5 minutes have 10 or more 5xx and 25 % or more of requests, the Worker posts once to `INCIDENT_WEBHOOK_URL`
  (incident.io HTTP alert source body: `title`, `description`, `deduplication_key`, `status: "firing"`,
  `metadata` with counts). It posts `status: "resolved"` when the rate falls under 5 %. It waits 30 minutes
  before it fires again. To set it up: create an HTTP alert source in incident.io, then
  `wrangler secret put INCIDENT_WEBHOOK_URL` and `wrangler secret put INCIDENT_WEBHOOK_TOKEN`.

## Search engines and AI assistants

`worker/seo.ts` rewrites the HTML of each app page (Workers `HTMLRewriter`): `lang`, title, description,
canonical link, `hreflang` alternates (fr-CA, en-CA), Open Graph tags and JSON-LD (`Organization`,
`WebSite`, `WebApplication` free of charge, `WebPage` or `AboutPage`). The content pages (about, privacy,
terms, "Should I call 811?", press kit) also get their text inside `#root`, from the same i18n data as
the app, so a crawler that does not run JavaScript reads the page. React replaces `#root` when it starts.
`public/llms.txt`, `public/sitemap.xml` and `public/robots.txt` list the pages for crawlers and AI tools.

## Recap PDF

"Terminer" first offers a PDF recap. The browser sends `/api/chat` with `recap: true`, the fixed app
message `RECAP_MESSAGE[lang]` (anything else is refused) and `shown`, the places and Clic Santé links
that the conversation showed (`shownAttachments`, cleaned by `cleanShown`: official links only).

- The app message skips the PII check: it holds no text of the person. The agent writes the recap in 4
  fixed sections (the shared agent rules describe them). The reply goes through the medical-advice check
  and the quote verification like any reply. A recap that keeps a flag after the rewrites answers
  `422 recap_unavailable`, and the conversation goes on with the last token (it never ends the
  conversation).
- `worker/recap.ts` builds the Markdown (title, date, the agent sections, each verified quote with its
  source and the pharmacist notice for a leaflet, the places, a notice) and renders it with
  markdowntopdf.dev (logo, header, footer with the page numbers). The answer carries the PDF as base64
  (`recap`); the browser saves it and shows a card to download it again. A render failure answers
  `503 recap_failed`.
- The agents mention the recap when the person seems to have what they need.

## Follow-up links

An agent can end a reply with an action link whose address is the next message:
`[Trouver une pharmacie près de chez vous](agentsante://Trouver une pharmacie près de chez moi)`
(`shared/followups.ts`). The browser rewrites these links before Markdown (the address can hold
spaces), shows them inline with a chat bubble icon, and a click sends the text as the person's next
message, through the normal path (PII check included). They are inactive while a turn runs, and
plain text in the PDF recap. They never carry a web address.
