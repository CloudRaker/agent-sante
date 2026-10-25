# Analytics and costs

The Worker writes two Workers Analytics Engine datasets (`analytics_engine_datasets` in `wrangler.jsonc`;
a dataset is created on its first write). Code: `worker/costs.ts` (prices and math), `worker/analytics.ts`
(data points), `recordTurn` in `worker/app.ts`. No data point holds message text, an IP address, a postal
code or the session id. The index is `sessionKey(sid)`: the first 32 hex characters of
SHA-256(`"agent-sante:" + sid`), where `sid` is the random session id of the token (128 random bits, not
derived from the person). A blob is a catalog agent id, a model id, a language or a fixed word; any other
value becomes `unknown`. A failed write logs `analytics_write_failed` and never fails a request.
Analytics Engine keeps data 3 months.

**`agent_sante_costs` (binding `COSTS`)**: one data point per chat message (`/api/chat` that reached the
pipeline), one per voice message (`route = voice`), and one when the person ends a conversation and Run
settled more usage after the last turn (`route = end`). A message that used nothing (a refused transcript,
a block by the regex layer) writes no cost point.

| Field | Value |
| --- | --- |
| `index1` | Session key (hash, see above) |
| `blob1` | Agent id of the reply (`fr/grippe`) |
| `blob2` | Language (`fr`, `en`) |
| `blob3` | Model id from `run.started.data.model` (the model that really answered, for example `openai/gpt-6-luna`); `rakeaudio` for a voice point; `unknown` when no run started |
| `blob4` | Route: `direct` (first message, classify or keyword picked a specialist), `concierge` (first message to the concierge), `handoff` (an agent handed off in this message), `answer` (the answer to an agent question), `turn` (any other message), `blocked` (PII block after a milliseconds call), `voice`, `end` |
| `double1` | Turn number in the conversation (1 = first message) |
| `double2` to `double5` | Run `input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_tokens` of this message |
| `double6` | `model_cost_usd`: raw provider cost (AI Gateway), from Run |
| `double7` | `run_credits`: Run platform credits of this message |
| `double8` | `run_fee_usd` = credits x USD 0.001 |
| `double9` | `ms_calls`: milliseconds calls (PII `entities`, routing `classify`, medical-advice `yes-no` with rewrites, status-line checks) |
| `double10` | `ms_cost_usd` |
| `double11` | `transcription_seconds` (voice points) |
| `double12` | `transcription_cost_usd` |
| `double13` | `translation_tokens` (Workers AI, input + output) |
| `double14` | `translation_cost_usd` |
| `double15` | `total_usd` = double6 + double8 + double10 + double12 + double14 |
| `double16` | `turn_ms`: time of the request in the Worker |

Run usage is cumulative per run (`GET /_run/{id}`, field `usage`). After each message the Worker reads the
usage of each run the message touched (the run of the token, new runs after a handoff, a language switch
or a rewrite restart) and the session guard Durable Object returns the part that is new since the last read
of that run (`settle` in `worker/guard-core.ts`). The guard keeps the totals per run (the larger value of
each field) for the last 12 runs of the session, 15 minutes after the last use, also after `/api/end`.
So a turn writes only its own share, a handoff counts the old run once and the new run from zero, and a
late or out-of-order read never counts twice. Run settles some credits (run minutes) after the turn: the
next read of the same run, or the `end` point, gets them. Credits that Run settles after the end read are
not counted.

**`agent_sante_usage` (binding `USAGE`)**: one data point (`double1 = 1`) per agent call (each run start or
turn, handoffs and rewrites included) and per counted event. The day is the data point timestamp.

| Field | Value |
| --- | --- |
| `index1` | Session key |
| `blob1` | Agent id |
| `blob2` | Big topic of the agent: `orientation` (concierge), `access-to-care`, `flu`, `gastro`, `vaccination`, `seniors`, `mental-health`, `pregnancy-children`, `illness-medication`, `prevention`, `sexual-health` |
| `blob3` | Language of the agent |
| `blob4` | How. Agent calls: `direct`, `concierge`, `handoff`, `answer`, `turn`, `language` (switch to the other language), `rewrite` (medical-advice rewrite). Events: `pii_block`, `medical_rewrite` (one per removed reply), `question` (the agent asked a question), `ended_medical_advice`, `ended_too_long`, `ended_by_person`, `voice` |
| `blob5` | Turns bucket of the conversation: `1`, `2-3`, `4-6`, `7+` |
| `blob6` | Latency bucket of the agent call: `<5s`, `5-10s`, `10-20s`, `20s+`; `none` for an event |
| `double1` | 1 |

**Prices**:

| Cost | Price | Source |
| --- | --- | --- |
| Language model | Raw provider cost, `usage.model_cost_usd` from Run (AI Gateway cost, no markup; billed from the Run AI wallet at cost, 1 AI credit = USD 0.01) | [CloudRaker Run](https://run.cloudraker.com), limits and pricing |
| Run platform fee | 1 credit = **USD 0.001**. 10 credits per started run minute, 2 per `knowledge_search` call | [CloudRaker Run](https://run.cloudraker.com), limits and pricing |
| milliseconds decision-machine-1 | USD 0.04 per million billed input tokens, output free. Billed tokens from `x-input-tokens` (there is no cost header). A call with no header counts 400 tokens | [docs.milliseconds.ai](https://docs.milliseconds.ai/llms.txt) |
| Transcription (rakeaudio, no speakers) | USD 0.10 per audio hour (2,500,000 tokens at USD 0.04 per million). Billed tokens from `x-input-tokens` when present, else seconds x 0.10 / 3600 | milliseconds docs `rakeaudio/pricing` |
| Translation (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) | USD 0.293 per million input tokens, USD 2.253 per million output tokens. Tokens from the `usage` of the answer, else about 4 characters a token | [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) |

Hosting (Workers, Durable Objects, D1, Analytics Engine) is not in the sums: the site runs on a Cloudflare
plan that CloudRaker already pays.

**Transparency page.** The same costs go to the `StatsCounter` Durable Object (keys `k:<day>`): USD per
category (`model`, `run`, `milliseconds`, `transcription`, `translation`), `conversations` (conversations
that got a first reply) and `turns` (handled messages). `GET /api/stats` returns them as `costs`, so the page
needs no Cloudflare API token. The page shows the total, the averages per conversation and per message
with their base, and a projection: about 2 million Info-Santé 811 calls a year
([CTV News, 2026](https://www.ctvnews.ca/montreal/article/nearly-90-minute-wait-to-speak-with-a-nurse-at-info-sante-811/)),
a share from 1 % to 50 % (Arc `slider`), at the current average cost per conversation (`shared/projection.ts`).

**Query with the SQL API.** Use an API token with "Account Analytics: Read":

```sh
curl "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/analytics_engine/sql" \
  -H "Authorization: Bearer $CF_API_TOKEN" --data "SELECT ... FORMAT JSON"
```

Analytics Engine samples data at high volume: multiply by `_sample_interval` in sums and counts.

```sql
-- Cost per day and category
SELECT toDate(timestamp) AS day,
       SUM(_sample_interval * double6)  AS model_usd,
       SUM(_sample_interval * double8)  AS run_usd,
       SUM(_sample_interval * double10) AS ms_usd,
       SUM(_sample_interval * double12) AS transcription_usd,
       SUM(_sample_interval * double14) AS translation_usd,
       SUM(_sample_interval * double15) AS total_usd
FROM agent_sante_costs
WHERE timestamp > NOW() - INTERVAL '30' DAY
GROUP BY day ORDER BY day;

-- Cost per session (conversation), most expensive first
SELECT index1 AS session, SUM(double15) AS total_usd, MAX(double1) AS turns,
       SUM(double2) AS input_tokens, SUM(double4) AS output_tokens
FROM agent_sante_costs
WHERE timestamp > NOW() - INTERVAL '7' DAY
GROUP BY session ORDER BY total_usd DESC LIMIT 50;

-- Calls per agent per day (agent calls only, no events)
SELECT toDate(timestamp) AS day, blob1 AS agent, blob2 AS topic, SUM(_sample_interval) AS calls
FROM agent_sante_usage
WHERE blob4 IN ('direct', 'concierge', 'handoff', 'answer', 'turn', 'language', 'rewrite')
  AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY day, agent, topic ORDER BY day, calls DESC;

-- Events per day (PII blocks, rewrites, ended conversations, voice messages)
SELECT toDate(timestamp) AS day, blob4 AS event, SUM(_sample_interval) AS n
FROM agent_sante_usage
WHERE blob4 IN ('pii_block', 'medical_rewrite', 'question', 'ended_medical_advice', 'ended_too_long', 'ended_by_person', 'voice')
GROUP BY day, event ORDER BY day;

-- Which model really answered
SELECT blob3 AS model, COUNT() AS turns, SUM(double6) AS model_usd
FROM agent_sante_costs WHERE timestamp > NOW() - INTERVAL '1' DAY GROUP BY model;
```

Local check: with `FAKE_UPSTREAMS=1`, each data point also goes to the log as `{"event":"ae_point", ...}`.
The fake Run reports made-up usage (9,000 input tokens, USD 0.0048 and 12 credits per turn).
`node scripts/cost-shots.mjs` takes screenshots of the cost section (run `scripts/smoke.mjs` first).
