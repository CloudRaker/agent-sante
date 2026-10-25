// Session token: a JWT signed with HS256 (Worker secret SESSION_SECRET).
// The browser holds it in memory only. The Worker reads the run id from the
// verified claims, never from the request body.
import type { Lang, TranscriptEntry } from "../shared/api";
import { LIMITS, isLang } from "../shared/api";

export interface SessionClaims {
  /** Random session id. */
  sid: string;
  /** Current Run run id, or "" when the next message starts a new run. */
  run: string;
  /** Current agent id. */
  agent: string;
  lang: Lang;
  /** Hash of the checked transcript so far. */
  th: string;
  /** Number of user messages accepted so far. */
  n: number;
  /** Simple-language mode (FALC) that the current run was told about. */
  simple?: boolean;
  /** The session has a place (a postal code position in the place store). */
  place?: boolean;
  /**
   * The open question of the agent: the Run question id and the suggested answers that passed
   * the medical-advice check. A message that equals one of `c` and comes as a choice skips the
   * PII check (it is the agent's own checked text). The signature stops a client from adding a choice.
   */
  q?: { id: string; c: string[] };
  iat: number;
  exp: number;
  /** Token id. The session guard accepts only the latest one. */
  jti: string;
}

const enc = new TextEncoder();

const b64url = (bytes: ArrayBuffer | Uint8Array): string => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of view) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

const fromB64url = (text: string): Uint8Array<ArrayBuffer> => {
  const s = atob(text.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((text.length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

const keys = new Map<string, Promise<CryptoKey>>();
function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    keys.set(secret, key);
  }
  return key;
}

export function randomId(bytes = 16): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function signSession(
  secret: string,
  claims: Omit<SessionClaims, "iat" | "exp" | "jti">,
  nowMs: number,
): Promise<{ token: string; claims: SessionClaims }> {
  if (!secret || secret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
  const iat = Math.floor(nowMs / 1000);
  const full: SessionClaims = { ...claims, iat, exp: iat + LIMITS.sessionMs / 1000, jti: randomId(12) };
  const head = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(enc.encode(JSON.stringify(full)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(`${head}.${body}`));
  return { token: `${head}.${body}.${b64url(sig)}`, claims: full };
}

/** Returns the claims of a valid, unexpired token, else null. */
export async function verifySession(secret: string, token: unknown, nowMs: number): Promise<SessionClaims | null> {
  if (typeof token !== "string" || token.length > 4096) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts as [string, string, string];
  try {
    const header = JSON.parse(new TextDecoder().decode(fromB64url(head))) as { alg?: string };
    if (header.alg !== "HS256") return null;
    const ok = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      fromB64url(sig) as Uint8Array<ArrayBuffer>,
      enc.encode(`${head}.${body}`),
    );
    if (!ok) return null;
    const c = JSON.parse(new TextDecoder().decode(fromB64url(body))) as SessionClaims;
    if (typeof c.exp !== "number" || c.exp * 1000 <= nowMs) return null;
    if (typeof c.sid !== "string" || typeof c.jti !== "string" || typeof c.agent !== "string") return null;
    if (typeof c.run !== "string" || typeof c.th !== "string" || !isLang(c.lang)) return null;
    if (typeof c.n !== "number") return null;
    if (c.simple !== undefined && typeof c.simple !== "boolean") return null;
    if (c.place !== undefined && typeof c.place !== "boolean") return null;
    if (c.q !== undefined && !isOpenQuestion(c.q)) return null;
    return c;
  } catch {
    return null;
  }
}

function isOpenQuestion(q: unknown): q is { id: string; c: string[] } {
  const v = q as { id?: unknown; c?: unknown } | null;
  return (
    !!v &&
    typeof v === "object" &&
    typeof v.id === "string" &&
    v.id.length <= 64 &&
    Array.isArray(v.c) &&
    v.c.length <= LIMITS.choices &&
    v.c.every((x) => typeof x === "string" && x.length <= LIMITS.choiceChars)
  );
}

/** Start of the transcript hash chain (empty transcript). */
const CHAIN_SEED = "agent-sante.th.v1";

/** One link of the chain: th(n) = SHA-256(th(n-1) || role || agent || text), base64url. */
export async function extendHash(previous: string, entry: TranscriptEntry): Promise<string> {
  const link = JSON.stringify([previous, entry.role, entry.agent, entry.text]);
  return b64url(await crypto.subtle.digest("SHA-256", enc.encode(link)));
}

/**
 * Hash chain of the checked transcript, bound into the token as `th`.
 * The Worker recomputes it from the transcript that the browser sends back,
 * so a changed, removed or added entry gives a different value and the request is refused.
 */
export async function transcriptHash(transcript: TranscriptEntry[]): Promise<string> {
  let th = await extendHash("", { role: "agent", agent: "", text: CHAIN_SEED });
  for (const entry of transcript) th = await extendHash(th, entry);
  return th;
}

/** Shape check of a transcript sent by the client. */
export function isTranscript(value: unknown): value is TranscriptEntry[] {
  return (
    Array.isArray(value) &&
    value.length <= LIMITS.transcriptEntries &&
    value.every(
      (e) =>
        e &&
        typeof e === "object" &&
        (e.role === "user" || e.role === "agent") &&
        typeof e.text === "string" &&
        typeof e.agent === "string",
    )
  );
}
