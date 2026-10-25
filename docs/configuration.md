# Configuration and local development

## Requirements

- Node 26, pnpm 11.
- For a real deploy: the CloudRaker production Cloudflare account, the `agentsante.ca` zone,
  a Turnstile widget for `agentsante.ca`, a Run token, a milliseconds key.

## Run it locally with fake upstreams

```sh
pnpm install
cp .dev.vars.example .dev.vars    # then set SESSION_SECRET to a random string (openssl rand -base64 48)
pnpm dev                          # http://localhost:5173 (Vite + Worker), fake Run and milliseconds
```

`FAKE_UPSTREAMS=1` replaces Run, milliseconds and Turnstile Siteverify with local fakes.
The Worker refuses it when `ENVIRONMENT` is `production` or the host is not local.
Try the fake agents with: "Où aller si mon enfant fait de la fièvre ?", "Où me faire vacciner contre
la grippe ?" (handoff), "Can we talk in English?" (language switch), "demo-conseil" (one rewrite),
"demo-trois" (the conversation ends), "demo-lent" (a heartbeat) and "J'ai de la fièvre, où aller ?"
(a clarifying question with 3 suggested answers). A fake turn takes about 3 s and plays
a knowledge search and a read as Run work rows, so the activity steps show.

To run the production build in `wrangler dev`:

```sh
pnpm preview                      # http://localhost:8788, with the real security headers (CSP)
```

## Checks

```sh
pnpm typecheck
pnpm lint                         # oxlint
pnpm test                         # vitest: safety pipeline, i18n parity, axe on gate and chat
pnpm build
node scripts/smoke.mjs            # API smoke test against a running dev server
node scripts/screenshots.mjs      # screenshots at 390x844 and 1280x800, light and dark
node scripts/question-shots.mjs   # the question card, open and answered
```

## Worker settings

`wrangler.jsonc` targets the CloudRaker production account with custom domains `agentsante.ca` and
`www.agentsante.ca`.

| Name                 | Kind   | What                                                             |
| -------------------- | ------ | ---------------------------------------------------------------- |
| `RUN_BASE_URL`       | var    | `https://agent-sante.cloudraker.run`                              |
| `RUN_BASE`           | var    | Base path of the Run repo, `agent-sante`                         |
| `RUN_EXPECTED_MODEL` | var    | A different model in `run.started` logs an alert                 |
| `MS_BASE_URL`        | var    | milliseconds `decision-machine-1` endpoint                       |
| `MS_AUDIO_URL`       | var    | milliseconds rakeaudio endpoint (voice messages, same key)       |
| `TURNSTILE_SITE_KEY` | var    | Public Turnstile widget key. The Worker refuses the placeholder. |
| `ALLOWED_HOSTNAMES`  | var    | Hosts allowed in `Origin` and in the Turnstile answer            |
| `RUN_TOKEN`          | secret | `crr_` token, scopes `run,read,cancel`, limited to the agent ids |
| `MS_API_KEY`         | secret | milliseconds production key                                      |
| `TURNSTILE_SECRET`   | secret | Turnstile secret key                                             |
| `SESSION_SECRET`     | secret | 32 characters or more, signs the session tokens                  |
| `KILL_SWITCH`        | var    | `"1"`: maintenance page, the API answers `503 maintenance`       |
| `DAILY_TURN_CAP`     | var    | Max Run calls (starts and turns) per Québec day (`"0"`: no cap)  |
| `INCIDENT_WEBHOOK_URL`   | secret, optional | Error-rate alert target (incident.io HTTP alert source URL) |
| `INCIDENT_WEBHOOK_TOKEN` | secret, optional | Bearer token for that URL                                  |
| `AI`                 | binding | Workers AI: translates a verified quote in the other language (remote only) |
| `POSTAL`             | D1      | Postal code positions (`agent-sante-postal`, see "Places and appointments") |
| `PLACES`             | DO      | `SessionPlaces`: the place and the tool results of a session |
| `TOOLS_SECRET`       | secret | The agents send it in `x-agent-sante-tools` to call `/tools/v1` |
| `MAPKIT_JS_TOKEN`    | var              | Apple MapKit JS token, public and restricted by Apple to `*.agentsante.ca`. Empty: the places show as a list only |
| `MAPKIT_JS_TOKEN_APEX` | var          | Apple MapKit JS token for the origin `agentsante.ca`. `/api/config` gives each host its own token, and none to another host (list only) |
| `DIRECTORY_BASE_URL` | secret | Directory API: health places (sante.gouv.qc.ca répertoire) and drugs (Health Canada). The tools send it a rounded position only |
| `CLICSANTE_API`      | var    | `"on"` turns on the Clic Santé read API (needs written permission). Any other value turns it off |
| `RL_CLICSANTE`       | binding | Rate limit of the Clic Santé read API (10 per 10 s, one key) |
| `RL_TRANSCRIBE`      | binding | Voice messages per session (6 per minute), on top of the chat limits |
| `COSTS`              | Analytics Engine | Dataset `agent_sante_costs`: the cost of each message (see "Analytics and costs") |
| `USAGE`              | Analytics Engine | Dataset `agent_sante_usage`: each agent call and counted event |

Set each secret with `wrangler secret put NAME`. Never put a secret in the repo.
Rate limits use the Workers rate limiting binding (per IP and per session).
