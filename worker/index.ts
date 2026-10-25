// Worker entry: builds the request dependencies from the env, and exports the
// session guard Durable Object.
import { agents } from "../shared/agents";
import { isAppPath } from "../shared/paths";
import { findPage, pageMeta, rewritePage } from "./seo";
import { createApp, type AppDeps } from "./app";
import { assetsKb, withLeaflets } from "./citations";
import { readLeaflet } from "./drugs";
import { md2pdf, type PdfRenderer } from "./recap";
import type { DirectoryDeps } from "./places/directory";
import { fakeModel } from "./fake/model";
import { fakeRun } from "./fake/run";
import { fakePostal } from "./fake/postal";
import { jsonCache } from "./places/cache";
import { d1Postal, type D1Like } from "./places/postal";
import { memoryPlaces } from "./places/store-core";
import { durablePlaces, SessionPlaces } from "./places/store";
import { createTools, TOOLS_HEADER, type ToolsDeps } from "./tools";
import { durableGuard, SessionGuard } from "./guard";
import { sendAlert } from "./alert";
import { durableStats, StatsCounter } from "./stats";
import { Analytics, type DataPointWriter } from "./analytics";
import { TurnMeter } from "./costs";
import { RunClient } from "./run/client";
import { Milliseconds } from "./safety/milliseconds";
import { fakeTranscriber, RakeAudio, RAKEAUDIO_URL } from "./transcribe";
import { fakeTranslator, isolateTranslationCache, workersAiTranslator, type AiRunner } from "./translate";
import { verifyTurnstile } from "./turnstile";

export { SessionGuard, SessionPlaces, StatsCounter };

/** Bindings, vars and secrets. Secrets are set with `wrangler secret put`. */
export interface WorkerEnv {
  ENVIRONMENT: string;
  RUN_BASE_URL: string;
  RUN_BASE: string;
  RUN_EXPECTED_MODEL: string;
  MS_BASE_URL: string;
  /** milliseconds rakeaudio endpoint for voice messages. Default: RAKEAUDIO_URL. */
  MS_AUDIO_URL?: string;
  TURNSTILE_SITE_KEY: string;
  ALLOWED_HOSTNAMES: string;
  FAKE_UPSTREAMS?: string;
  RUN_TOKEN?: string;
  MS_API_KEY?: string;
  TURNSTILE_SECRET?: string;
  SESSION_SECRET?: string;
  /** "1" turns on the maintenance page and makes the API answer 503. */
  KILL_SWITCH?: string;
  /** Max agent turns per Québec day. "0" or unset means no cap. */
  DAILY_TURN_CAP?: string;
  /** Optional secret: incident.io HTTP alert source URL (or any webhook) for the error-rate alert. */
  INCIDENT_WEBHOOK_URL?: string;
  /** Optional secret: bearer token for that webhook. */
  INCIDENT_WEBHOOK_TOKEN?: string;
  ASSETS: { fetch(request: Request): Promise<Response> };
  /** Workers AI: translates verified official quotes (worker/translate.ts). Remote only. */
  AI?: AiRunner;
  SESSIONS: DurableObjectNamespace<SessionGuard>;
  STATS: DurableObjectNamespace<StatsCounter>;
  RL_SESSION?: RateLimit;
  RL_CHAT_IP?: RateLimit;
  RL_CHAT_SESSION?: RateLimit;
  /** Voice messages per session (on top of RL_CHAT_IP and RL_CHAT_SESSION). */
  RL_TRANSCRIBE?: RateLimit;
  /** D1 postal code positions (ISQ CP Territoires). scripts/build-postal-d1.mjs loads it. */
  POSTAL?: D1Like;
  /** Place state of each session (position, area, tool results of the turn). */
  PLACES: DurableObjectNamespace<SessionPlaces>;
  /** Secret: the agents send it in the x-agent-sante-tools header (Run network template). */
  TOOLS_SECRET?: string;
  /** Secret: Apple MapKit JS token. Absent: no map. */
  MAPKIT_JS_TOKEN?: string;
  MAPKIT_JS_TOKEN_APEX?: string;
  /** Health directory API base URL. */
  DIRECTORY_BASE_URL?: string;
  /** "on" turns on the Clic Santé read API (off until Clic Santé gives written permission). */
  CLICSANTE_API?: string;
  /** Global rate limit of the Clic Santé read API. */
  RL_CLICSANTE?: RateLimit;
  /** Analytics Engine dataset agent_sante_costs: one point per turn (worker/analytics.ts). */
  COSTS?: DataPointWriter;
  /** Analytics Engine dataset agent_sante_usage: one point per agent call or counted event. */
  USAGE?: DataPointWriter;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** A machine on the local network by its mDNS name (for example mymac.local). Cloudflare never serves these names. */
const isLocalHost = (hostname: string) => LOCAL_HOSTS.has(hostname) || hostname.endsWith(".local");

/** One fake upstream per isolate, so a dev conversation keeps its fake runs. */
let fakes:
  | { run: ReturnType<typeof fakeRun>; model: ReturnType<typeof fakeModel>; transcriber: ReturnType<typeof fakeTranscriber> }
  | undefined;
/** The fake Run calls the tools in the same isolate. */
let fakeTools: ((op: string, body: Record<string, unknown>) => Promise<unknown>) | undefined;
/** Postal blocks stay in isolate memory (public data). */
let postalLookup: ReturnType<typeof d1Postal> | undefined;

/** Fake mode: a tiny valid PDF, so the recap flow works with no network. */
const fakePdf: PdfRenderer = async () =>
  new TextEncoder().encode("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");


const cacheApi = (): Cache | undefined => (typeof caches === "undefined" ? undefined : (caches as unknown as { default: Cache }).default);

/** Fake mode uses a few fixed FSAs (the local D1 is empty unless you load it with --local). */
function postalFor(env: WorkerEnv, fake: boolean) {
  if (fake) return fakePostal();
  return env.POSTAL ? (postalLookup ??= d1Postal(env.POSTAL)) : undefined;
}

function directoryDeps(env: WorkerEnv, cache = jsonCache(cacheApi())): DirectoryDeps {
  // Secret DIRECTORY_BASE_URL. Without it, the place and drug tools answer "unavailable".
  return { baseUrl: env.DIRECTORY_BASE_URL ?? "", fetcher: (...a) => fetch(...a), cache, now: Date.now, log };
}

export function buildToolsDeps(env: WorkerEnv): ToolsDeps {
  const fake = env.FAKE_UPSTREAMS === "1" && env.ENVIRONMENT !== "production";
  const cache = jsonCache(cacheApi());
  return {
    secret: env.TOOLS_SECRET ?? "",
    places: durablePlaces(env.PLACES),
    directory: directoryDeps(env, cache),
    clicsante:
      env.CLICSANTE_API === "on" ? { fetcher: (...a) => fetch(...a), cache, limiter: env.RL_CLICSANTE, now: Date.now, log } : undefined,
    postal: postalFor(env, fake),
    now: Date.now,
    log,
  };
}

const log = (event: Record<string, unknown>) => console.log(JSON.stringify({ app: "agent-sante", ...event }));

/**
 * Local development (fake upstreams): each data point also goes to the log, so a local run shows
 * what production writes. The points hold catalog ids and numbers only.
 */
function devDataset(name: string, inner?: DataPointWriter): DataPointWriter {
  return {
    writeDataPoint(point) {
      log({ event: "ae_point", dataset: name, ...point });
      inner?.writeDataPoint(point);
    },
  };
}

export function buildDeps(env: WorkerEnv, url: URL, ctx?: { waitUntil(work: Promise<unknown>): void }): AppDeps {
  const wantsFake = env.FAKE_UPSTREAMS === "1";
  const local = isLocalHost(url.hostname);
  const production = env.ENVIRONMENT === "production";
  let misconfigured: string | undefined;
  // Fake upstreams are for local development only. Production refuses them.
  if (wantsFake && (production || !local)) misconfigured = "fake_upstreams_refused";
  const fake = wantsFake && !misconfigured;
  const missing = (fake ? ["SESSION_SECRET"] : ["SESSION_SECRET", "RUN_TOKEN", "MS_API_KEY", "TURNSTILE_SECRET"]).filter(
    (k) => !env[k as keyof WorkerEnv],
  );
  if (!misconfigured && missing.length) misconfigured = `missing_${missing.join("_")}`;
  // Without the real public widget key, Turnstile cannot render and nobody can start a session.
  const siteKey = env.TURNSTILE_SITE_KEY?.trim() ?? "";
  if (!misconfigured && !fake && (!siteKey || siteKey.startsWith("REPLACE_"))) misconfigured = "turnstile_site_key_placeholder";

  // About 3 s per fake turn, so the live activity steps show (a real turn takes 5 to 20 s).
  if (fake)
    fakes ??= {
      run: fakeRun({ delayMs: 2700, tools: (op, body) => fakeTools?.(op, body) ?? Promise.resolve({}) }),
      model: fakeModel(),
      transcriber: fakeTranscriber(),
    };
  if (fake && env.TOOLS_SECRET) {
    fakeTools = async (op, body) => {
      const res = await tools.fetch(
        new Request(`${url.origin}/tools/v1/${op}`, {
          method: "POST",
          headers: { "content-type": "application/json", [TOOLS_HEADER]: env.TOOLS_SECRET! },
          body: JSON.stringify(body),
        }),
        env,
      );
      return res.json();
    };
  }
  // One meter per request: the milliseconds client gives it the billed tokens of each answer.
  const meter = new TurnMeter();
  const allowedHosts = env.ALLOWED_HOSTNAMES.split(",")
    .map((h) => h.trim())
    .filter(Boolean);

  return {
    agents,
    secret: env.SESSION_SECRET ?? "",
    now: () => Date.now(),
    log,
    expectedModel: env.RUN_EXPECTED_MODEL,
    run: fake ? fakes!.run : new RunClient({ token: env.RUN_TOKEN ?? "", origin: env.RUN_BASE_URL, base: env.RUN_BASE }),
    model: fake
      ? fakes!.model
      : new Milliseconds(env.MS_API_KEY ?? "", env.MS_BASE_URL, undefined, (meta) => {
          log({ event: "ms_call", ...meta, alert: [401, 403].includes(meta.status) || undefined });
          if (meta.status === 200) meter.msResponse(meta.inputTokens);
        }),
    guard: durableGuard(env.SESSIONS),
    // Knowledge assets, plus the leaflets of non-prescription drugs (directory API).
    pdf: fake ? fakePdf : md2pdf(),
    kb: withLeaflets(assetsKb(env.ASSETS), async (code, lang) => {
      const leaflet = await readLeaflet(directoryDeps(env), code, lang);
      return leaflet ? { otc: leaflet.drug.otc, text: leaflet.text } : null;
    }),
    translator: fake ? fakeTranslator() : env.AI ? workersAiTranslator(env.AI) : undefined,
    translationCache: isolateTranslationCache(),
    turnstileSiteKey: env.TURNSTILE_SITE_KEY,
    verifyTurnstile: fake
      ? async (token) => token.length > 0
      : (token, ip) => verifyTurnstile({ secret: env.TURNSTILE_SECRET ?? "", token, ip, hostnames: allowedHosts }),
    limiters: { session: env.RL_SESSION, chatIp: env.RL_CHAT_IP, chatSession: env.RL_CHAT_SESSION, transcribe: env.RL_TRANSCRIBE },
    transcriber: fake ? fakes!.transcriber : new RakeAudio(env.MS_API_KEY ?? "", env.MS_AUDIO_URL || RAKEAUDIO_URL),
    allowedHosts,
    fake,
    misconfigured,
    stats: durableStats(env.STATS),
    maintenance: env.KILL_SWITCH === "1",
    dailyTurnCap: Math.max(0, Number(env.DAILY_TURN_CAP ?? "0") || 0),
    alert: env.INCIDENT_WEBHOOK_URL
      ? (action, info) => sendAlert({ url: env.INCIDENT_WEBHOOK_URL!, token: env.INCIDENT_WEBHOOK_TOKEN, action, info, host: url.hostname })
      : undefined,
    defer: ctx ? (work) => ctx.waitUntil(work) : undefined,
    postal: postalFor(env, fake),
    places: env.PLACES ? durablePlaces(env.PLACES) : fake ? memoryPlaces() : undefined,
    mapkitTokens: { wildcard: env.MAPKIT_JS_TOKEN || undefined, apex: env.MAPKIT_JS_TOKEN_APEX || undefined },
    appointmentsApi: env.CLICSANTE_API === "on",
    meter,
    analytics: new Analytics(
      fake ? devDataset("agent_sante_costs", env.COSTS) : env.COSTS,
      fake ? devDataset("agent_sante_usage", env.USAGE) : env.USAGE,
      () => log({ event: "analytics_write_failed" }),
    ),
  };
}

const app = createApp((c) => buildDeps(c.env as WorkerEnv, new URL(c.req.url), c.executionCtx));
const tools = createTools((c) => buildToolsDeps(c.env as WorkerEnv));

/**
 * Security headers of public/_headers for the "/*" rule. The _headers rules do not apply to a
 * response from the Worker (run_worker_first), so the Worker sets them. A test keeps both equal.
 */
export const PAGE_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' https://challenges.cloudflare.com https://cdn.apple-mapkit.com; frame-src https://challenges.cloudflare.com; connect-src 'self' https://*.apple-mapkit.com https://*.geo.apple.com https://*.ls.apple.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.apple-mapkit.com https://*.geo.apple.com; worker-src blob:; child-src blob:; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(self), geolocation=(), payment=(), usb=(), interest-cohort=(), browsing-topics=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "X-Frame-Options": "DENY",
};

/**
 * Static files and app pages come from Workers assets. The single-page fallback answers
 * index.html for any path; for a path that is not an app page, the status becomes 404.
 * securityHeaders is false only on the Vite dev server.
 */
export async function serveAsset(
  request: Request,
  assets: { fetch(request: Request): Promise<Response> },
  securityHeaders = true,
): Promise<Response> {
  const res = await assets.fetch(request);
  const url = new URL(request.url);
  const html = (res.headers.get("content-type") ?? "").includes("text/html");
  const notFound = res.status === 200 && html && !isAppPath(url.pathname);
  const out = new Response(res.body, {
    status: notFound ? 404 : res.status,
    statusText: notFound ? "Not Found" : res.statusText,
    headers: res.headers,
  });
  if (securityHeaders) for (const [k, v] of Object.entries(PAGE_HEADERS)) out.headers.set(k, v);
  // Text files are UTF-8 (llms.txt, robots.txt, sitemap.xml). Without a charset, a browser reads them as Windows-1252.
  const type = out.headers.get("content-type") ?? "";
  if (/^(text\/|application\/(xml|json|javascript))/.test(type) && !/charset=/i.test(type)) {
    out.headers.set("content-type", `${type}; charset=utf-8`);
  }
  // App pages get their metadata and static text for crawlers (worker/seo.ts). Not on the Vite dev server.
  const found = res.status === 200 && html && securityHeaders ? findPage(url.pathname) : null;
  return found ? rewritePage(out, pageMeta(found.lang, found.page)) : out;
}

export default {
  fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === "/api" || pathname.startsWith("/api/")) return app.fetch(request, env, ctx);
    if (pathname.startsWith("/tools/")) return tools.fetch(request, env, ctx);
    // The Vite dev server injects inline scripts that the CSP blocks; built code gets the headers.
    return serveAsset(request, env.ASSETS, !import.meta.env.DEV);
  },
} satisfies ExportedHandler<WorkerEnv>;
