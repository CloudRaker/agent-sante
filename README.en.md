# Agent Santé

[Français](README.md)

Agent Santé helps Quebecers find official health information: where to go, how to book an appointment,
vaccination, over-the-counter medications, seniors, mental health and more. Every answer quotes its
official source and gives the link. It is a volunteer, open-source project by CloudRaker, in Montréal.
It is not a Government of Québec service and not an emergency service.

Site: [agentsante.ca](https://agentsante.ca). This repository is the website: a Vite + React app and a
Hono API in one Cloudflare Worker. The agents (prompts and official sources) are in
[CloudRaker/agent-sante-agents](https://github.com/CloudRaker/agent-sante-agents).

## How it works

1. The person accepts the terms in the conversation. An invisible bot check (Cloudflare Turnstile) gives
   a signed session token.
2. Each message goes through a personal information filter (regular expressions, then
   Decision-machine-1, a CloudRaker model hosted in Montréal). A blocked message never reaches a language
   model.
3. The message goes to the agents on CloudRaker Run. The reply is checked (no personal medical advice)
   before it shows. Quotes of official text are verified word for word.
4. The messages are deleted about 10 minutes after the conversation ends. The server never logs message
   text.

## Run it locally

```sh
pnpm install
cp .dev.vars.example .dev.vars    # then set SESSION_SECRET to a random string
pnpm dev                          # http://localhost:5173, with fake Run and milliseconds services
```

Checks: `pnpm check` (types, lint, tests and build).

## Documentation

- [Architecture](docs/architecture.md): how a message moves, the checks, the session token
- [Activity stream](docs/activity-stream.md): the steps shown while a reply runs
- [Configuration](docs/configuration.md): local development, checks, Worker settings
- [Features](docs/features.md): pages, display options, voice messages, guardrails, search engines
- [Agent tools](docs/tools.md): places, Clic Santé appointments and drugs
- [Citations](docs/citations.md): quotes of official text and of drug leaflets
- [Agents](docs/agents.md): catalog, direct routing, Run token
- [Analytics and costs](docs/analytics.md): Analytics Engine, prices, SQL queries

See also [`ARC.md`](ARC.md) (Arc components) and [`SECURITY.md`](SECURITY.md) (report a security
problem).

## License

Apache-2.0 (see [`LICENSE`](LICENSE)). Arc components in `src/components/arc` are MIT.
