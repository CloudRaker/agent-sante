# Agents

`shared/agents.json` lists the agents (id, language, name, one line, counterpart in the other language).
The file in this repo is a placeholder. Run `pnpm sync:agents` to copy the real file from
`../agent-sante-agents/agents.json`. The script checks the shape first. A handoff target must be in this file and
in the same language as the agent that asks.

## Direct routing

The first message of a conversation goes straight to a specialist when the routing call is clear
(`worker/safety/routing.ts`): one milliseconds `classify` call over the specialists of the language, with
an English description for each one (`ROUTE_DESCRIPTIONS`). A winner at 0.5 or more, or at 0.3 or more
with 2.5 times the second score, starts that specialist. A message that names a vaccine goes to the
vaccines agent with no call. Any other case starts the concierge. A new agent needs a router description.

## Run token

The Worker token (`RUN_TOKEN`) is limited to the agent ids. A new agent needs a new token: mint one with
`run,read,cancel` and every id of `agents.json`, set it with `wrangler secret put RUN_TOKEN`, then revoke
the old one.
