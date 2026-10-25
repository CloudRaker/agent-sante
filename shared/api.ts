// Types shared by the browser app and the Worker API.
import type { Citation } from "./kb";
import type { Attachments } from "./places";

export type { Citation } from "./kb";

export type Lang = "fr" | "en";

export const LANGS: readonly Lang[] = ["fr", "en"];

export const isLang = (value: unknown): value is Lang => value === "fr" || value === "en";

/** The kinds of personal information that the PII check can find. */
export const PII_KINDS = [
  "person_name",
  "health_insurance_number",
  "street_address",
  "postal_code",
  "phone_number",
  "email_address",
  "date_of_birth",
  "file_number",
  "other_identifier",
] as const;

export type PiiKind = (typeof PII_KINDS)[number];

/** One checked entry of the conversation. The client holds the list and sends it back as is. */
export interface TranscriptEntry {
  role: "user" | "agent";
  text: string;
  /** Agent id that wrote (or received) the entry. */
  agent: string;
}

export interface Source {
  url: string;
  title: string;
  domain: string;
}

export interface ConfigResponse {
  turnstileSiteKey: string;
  /** True only in local development with fake upstreams. */
  fake: boolean;
  /** Kill switch (Worker var KILL_SWITCH): the app shows the maintenance page. */
  maintenance: boolean;
  /** Apple MapKit JS token (origin-restricted, public by design). Null: no map, list only. */
  mapkitToken: string | null;
  /** True when the Clic Santé read API is on (slot counts per place). */
  appointmentsApi: boolean;
}

/** Aggregate counters only (no content), for the transparency page. */
export const COUNTERS = ["conversations", "messages", "piiBlocks", "adviceBlocks", "adviceEnded", "transcriptions"] as const;
export type Counter = (typeof COUNTERS)[number];

/** Cost categories of the transparency page. "model": the language model (provider cost). "run": the CloudRaker Run platform fee. */
export const COST_CATEGORIES = ["model", "run", "milliseconds", "transcription", "translation"] as const;
export type CostCategory = (typeof COST_CATEGORIES)[number];

/** Cost sums in USD, and what they cover. */
export interface CostSums {
  usd: Record<CostCategory, number>;
  /** Conversations that got at least one reply (the base of the average per conversation). */
  conversations: number;
  /** Chat messages that the Worker handled (the base of the average per message), blocked ones included. */
  turns: number;
}

/** Big topics of the agents (one per specialist, "orientation" for the concierge). */
export const TOPICS = [
  "orientation",
  "access-to-care",
  "flu",
  "gastro",
  "vaccination",
  "seniors",
  "mental-health",
  "pregnancy-children",
  "illness-medication",
  "prevention",
  "sexual-health",
  "other",
] as const;
export type Topic = (typeof TOPICS)[number];

/** Conversation length, in handled messages. */
export const TURNS_BUCKETS = ["1", "2-3", "4-6", "7+"] as const;
export type TurnsBucket = (typeof TURNS_BUCKETS)[number];

/** Time from a message to its checked reply. */
export const LATENCY_BUCKETS = ["<5s", "5-10s", "10-20s", "20s+"] as const;
export type LatencyBucket = (typeof LATENCY_BUCKETS)[number];

/** Usage counts for the costs and usage page. Counts only: no text, no session id. */
export interface UsageSummary {
  /** Agent calls (run starts and turns, handoffs and rewrites included). */
  calls: number;
  /** Agent calls by big topic, all days. */
  topics: Record<Topic, number>;
  /** Agent calls by big topic, the last 7 days (today included). */
  topicsWeek: Record<Topic, number>;
  /** Agent calls by agent id ("fr/grippe"). */
  agents: Record<string, number>;
  /** Conversations by length (messages that got a reply). */
  turns: Record<TurnsBucket, number>;
  /** Replies by response time. */
  latency: Record<LatencyBucket, number>;
  /** Conversations started per day, the last 14 days, oldest first, days with no data at 0. */
  perDay: { day: string; conversations: number }[];
}

export interface StatsResponse {
  totals: Record<Counter, number>;
  /** Last days first, Québec dates ("2026-10-23"). */
  days: { day: string; counts: Record<Counter, number> }[];
  since: string | null;
  /** Cost sums since the cost analytics started. Absent from an older Worker. */
  costs?: {
    totals: CostSums;
    /** Last days first. */
    days: ({ day: string } & CostSums)[];
    /** First day with cost data. */
    since: string | null;
  };
  /** Usage counts. Absent from an older Worker. */
  usage?: UsageSummary;
}

export interface SessionRequest {
  turnstileToken: string;
  lang: Lang;
}

export interface SessionResponse {
  sessionToken: string;
  /** Epoch milliseconds when the token stops working. */
  expiresAt: number;
  agentId: string;
  lang: Lang;
  transcript: TranscriptEntry[];
}

/**
 * A clarifying question of the agent (Run `ask`), after the medical-advice check. The text and
 * the choices are plain text. The person clicks a choice or writes another answer.
 */
export interface AgentQuestion {
  text: string;
  /** Up to 3 suggested answers. Empty: the person writes the answer. */
  choices: string[];
}

export interface ChatRequest {
  sessionToken: string;
  /** One id per user message. It makes network retries safe. */
  messageId: string;
  message: string;
  /** The language the person uses now. A change starts the agent of that language. */
  lang: Lang;
  transcript: TranscriptEntry[];
  /** Simple-language mode (FALC). The Worker tells the agent in a message prefix. */
  simple?: boolean;
  /**
   * The message is a suggested answer that the person clicked. The Worker checks it against the
   * choices in the session token. A value that is not one of them is free text (PII check).
   */
  choice?: boolean;
  /**
   * The person asked for a recap. `message` must then be exactly RECAP_MESSAGE[lang]: it is app
   * text, not the person's, so it skips the PII check. The answer carries the PDF.
   */
  recap?: boolean;
  /** With `recap`: the places and Clic Santé links shown in the conversation, for the PDF. */
  shown?: Attachments;
}

/** The app message that asks the agent for the recap (the agent prompts describe the format). */
export const RECAP_MESSAGE: Record<Lang, string> = {
  fr: "[Récapitulatif demandé] Écrivez le récapitulatif de la conversation, dans le format prévu.",
  en: "[Recap requested] Write the recap of the conversation, in the planned format.",
};

export interface ChatReply {
  ended: false;
  /**
   * `text` is Markdown. A line `[[citation:N]]` holds the place of `citations[N]`, a verified
   * verbatim quote of official text (see shared/kb.ts).
   */
  reply: {
    text: string;
    sources: Source[];
    citations?: Citation[];
    /** Places and appointment links that the agent tools found in this turn (shared/places.ts). */
    attachments?: Attachments;
    /** The agent asks a clarifying question. The next message is the answer. */
    question?: AgentQuestion;
  };
  agentId: string;
  lang: Lang;
  sessionToken: string;
  expiresAt: number;
  transcript: TranscriptEntry[];
  /** Set when an agent handed the conversation to another agent in this request. */
  handoff?: { from: string; to: string };
  /** Set when the conversation moved to the other language in this request. */
  languageSwitched?: boolean;
  /** With a recap request: the PDF (base64) and its file name. */
  recap?: { pdf: string; filename: string };
}

export type EndReason = "medical_advice" | "too_long";

export interface ChatEnded {
  ended: true;
  reason: EndReason;
}

export type ChatResponse = ChatReply | ChatEnded;

export type ApiErrorCode =
  | "pii"
  | "invalid_request"
  | "turnstile_failed"
  | "session_expired"
  | "transcript_mismatch"
  | "busy"
  | "rate_limited"
  | "unavailable"
  | "timeout"
  | "forbidden_origin"
  | "misconfigured"
  | "maintenance"
  | "at_capacity"
  /** /api/transcribe: the content type is not an allowed audio type, or the audio does not decode. */
  | "unsupported_audio"
  /** /api/transcribe: the body is over LIMITS.audioBytes, or the audio is over LIMITS.audioSeconds. */
  | "audio_too_large"
  /** Recap: the medical-advice check did not pass after the rewrites. The conversation goes on. */
  | "recap_unavailable"
  /** Recap: the PDF could not be made. The conversation goes on. */
  | "recap_failed";

export interface ApiError {
  error: ApiErrorCode;
  /** Only with error "pii". */
  kinds?: PiiKind[];
  /** Seconds, with "rate_limited" and "busy". */
  retryAfter?: number;
  requestId?: string;
}

export const LIMITS = {
  /** Max characters in one user message. */
  messageChars: 1000,
  /** Max entries in the transcript (user and agent together). */
  transcriptEntries: 60,
  /** Max size of the transcript JSON in bytes. */
  transcriptBytes: 96_000,
  /** Max characters of an agent question. A longer question is cut. */
  questionChars: 300,
  /** Max characters of one suggested answer. A longer choice is dropped. */
  choiceChars: 80,
  /** Max suggested answers of one question. */
  choices: 3,
  /** Session token lifetime in milliseconds (sliding: each answer gives a new token). */
  sessionMs: 10 * 60_000,
  /** Max length of a voice message. The browser stops the recording at this length. */
  audioSeconds: 60,
  /** Max size of a voice message upload. 60 s of Opus at 32 kbit/s is about 240 kB; Safari AAC is larger. */
  audioBytes: 3_000_000,
} as const;

/** Audio types that /api/transcribe accepts (the type before any ";codecs=" parameter). */
export const AUDIO_TYPES: readonly string[] = [
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/aac",
  "audio/x-m4a",
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
];

/** The answer of POST /api/transcribe. The text has not passed the PII check yet: it goes back through /api/chat. */
export interface TranscribeResponse {
  text: string;
  /** Server time of the request, in milliseconds. */
  ms: number;
}
