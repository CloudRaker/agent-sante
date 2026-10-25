// Error-rate alert. The Stats Durable Object decides when (worker/stats-core.ts, ALERT); this file sends it.
// The body follows the incident.io HTTP alert source format, so INCIDENT_WEBHOOK_URL can be an
// incident.io alert source URL. Any webhook that takes JSON also works. The body has counts only.
import { ALERT } from "./stats-core";

export interface AlertArgs {
  url: string;
  token?: string;
  action: "fire" | "resolve";
  info: { total: number; errors: number };
  host: string;
  fetcher?: typeof fetch;
}

export function alertBody(a: Pick<AlertArgs, "action" | "info" | "host">) {
  const pct = a.info.total ? Math.round((a.info.errors / a.info.total) * 100) : 0;
  return {
    title: "Agent Santé: high API error rate",
    description:
      a.action === "fire"
        ? `${a.info.errors} of ${a.info.total} API requests (${pct} %) returned a server error in the last ${ALERT.windowMinutes} minutes.`
        : `The API error rate is back under ${ALERT.resolveRatio * 100} %.`,
    deduplication_key: `agent-sante-5xx-${a.host}`,
    status: a.action === "fire" ? "firing" : "resolved",
    metadata: { host: a.host, errors: a.info.errors, total: a.info.total, window_minutes: ALERT.windowMinutes },
  };
}

export async function sendAlert(a: AlertArgs): Promise<void> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (a.token) headers.authorization = `Bearer ${a.token}`;
  await (a.fetcher ?? fetch)(a.url, {
    method: "POST",
    headers,
    body: JSON.stringify(alertBody(a)),
    signal: AbortSignal.timeout(5000),
  });
}
