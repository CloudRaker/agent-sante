# Security policy

## Report a problem

Do not open a public issue for a security problem.
Use GitHub private vulnerability reporting on this repository (Security tab, "Report a vulnerability").

Tell us:

- what you found and where (URL, file, route);
- the steps to see the problem again;
- what an attacker can do with it.

Do not send personal health information, and do not test with the data of real people.
We answer within 3 business days. We tell you when the fix is live.

## Scope

In scope: this web app (agentsante.ca and www.agentsante.ca) and its API under `/api`.
The agent prompts are in the repo CloudRaker/agent-sante-agents.

Out of scope: denial of service by volume, reports from automated scanners with no proof,
and problems in Cloudflare, CloudRaker Run or milliseconds themselves (report those to their owners).

## Design rules we keep

- Secrets (`RUN_TOKEN`, `MS_API_KEY`, `TURNSTILE_SECRET`, `SESSION_SECRET`) exist only as Worker secrets.
- The browser never gets a Run token, a Run read token or a usable run id. It holds a signed session token in memory only.
- Each session token is single use: the server accepts only the latest one, and one turn at a time.
- The transcript that the browser sends back must match a hash in the token, so a changed transcript is refused.
- Messages with personal information are blocked before they reach a language model. The checks fail closed.
- The server never logs message text.
- A strict Content Security Policy allows only our own scripts and Cloudflare Turnstile.
- `FAKE_UPSTREAMS=1` (local development) is refused when `ENVIRONMENT` is `production` or the host is not local.
