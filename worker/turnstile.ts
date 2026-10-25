// Cloudflare Turnstile Siteverify. The widget token is single use and valid for 300 s.
export const TURNSTILE_ACTION = "start-session";

export async function verifyTurnstile(args: {
  secret: string;
  token: string;
  ip?: string;
  hostnames: string[];
  fetcher?: typeof fetch;
}): Promise<boolean> {
  const form = new FormData();
  form.append("secret", args.secret);
  form.append("response", args.token);
  if (args.ip) form.append("remoteip", args.ip);
  form.append("idempotency_key", crypto.randomUUID());
  const res = await (args.fetcher ?? fetch)("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return false;
  const out = (await res.json()) as { success?: boolean; hostname?: string; action?: string };
  if (!out.success) return false;
  if (out.action && out.action !== TURNSTILE_ACTION) return false;
  return !out.hostname || args.hostnames.includes(out.hostname);
}
