// How a checked agent reply shows: a small Markdown subset, verified official quotes as citation
// cards, then the official sources as link chips. Only links to official domains are clickable;
// any other link shows as plain text.
import { ArrowRightLeft, ExternalLink, FileText, Languages, MessageCircle, Pill, Quote } from "lucide-react";
import { createContext, useContext, type ReactNode } from "react";
import Markdown, { defaultUrlTransform, type Components } from "react-markdown";
import { Accordion } from "@/components/arc/accordion/accordion";
import { Badge } from "@/components/arc/badge/badge";
import { agents } from "@shared/agents";
import type { Citation, Source } from "@shared/api";
import { CITATION_MARKER } from "@shared/kb";
import { followUpMessage, normalizeFollowUps, FOLLOW_UP_SCHEME } from "@shared/followups";
import { officialDomain } from "@shared/sources";
import { Button } from "@/components/arc/button/button";
import { useI18n } from "@/i18n";
import { downloadPdf } from "@/lib/download";
import { formatDay } from "@/lib/format";
import { ActivitySummary } from "./ActivityTimeline";
import { Attachments } from "./Attachments";
import { QuestionCard } from "./QuestionCard";
import { frenchSpaces } from "@/lib/typography";
import type { ReplyMeta } from "./useChat";
import styles from "./chat.module.css";

/** Drops a last "Source(s) :" paragraph when the chips below already list its links. */
export function stripSourcesLine(text: string, sources: Source[]): string {
  if (!sources.length) return text;
  const paragraphs = text.trim().split(/\n{2,}/);
  const last = paragraphs.at(-1) ?? "";
  if (/^\s*\**sources?\**\s*:/i.test(last)) {
    const urls = [...last.matchAll(/https:\/\/[^\s)\]]+/g)].map((m) => m[0].replace(/[.,;]+$/, ""));
    if (urls.every((u) => sources.some((s) => s.url === u))) return paragraphs.slice(0, -1).join("\n\n");
  }
  return text;
}

/** Sends a follow-up message. Absent or disabled (a turn runs, the conversation ended): plain text. */
const FollowUpContext = createContext<{ send?: (text: string) => void; disabled: boolean }>({ disabled: true });

/* eslint-disable jsx-a11y/anchor-is-valid, jsx-a11y/prefer-tag-over-role -- an inline action inside a
   sentence: a <button> is an inline block and cannot wrap with the text, so this is a link element with
   the button role, keyboard support (Enter, Space) and aria-disabled. */
/** A follow-up link of the agent: a click sends its text as the person's next message. */
function FollowUpLink({ message, children }: { message: string; children?: ReactNode }) {
  const { t } = useI18n();
  const { send, disabled } = useContext(FollowUpContext);
  if (!send) return <span>{children}</span>;
  // An inline link element (a <button> becomes an inline block when it wraps), with the button role.
  const go = (event: React.SyntheticEvent) => {
    event.preventDefault();
    if (!disabled) send(message);
  };
  return (
    <a
      href="#"
      role="button"
      className={styles.followUp}
      aria-disabled={disabled || undefined}
      aria-label={t.chat.followUp(message)}
      onClick={go}
      onKeyDown={(event) => {
        if (event.key === " ") go(event);
      }}
    >
      {children}
      <MessageCircle size={14} strokeWidth={1.75} aria-hidden="true" className={styles.followUpIcon} />
    </a>
  );
}
/* eslint-enable jsx-a11y/anchor-is-valid, jsx-a11y/prefer-tag-over-role */

/** Keeps follow-up addresses (react-markdown drops unknown schemes); other addresses as usual. */
const urlTransform = (url: string) => (url.toLowerCase().startsWith(FOLLOW_UP_SCHEME) ? url : defaultUrlTransform(url));

/** A link renders only when it points to an official domain, or when it is a follow-up. */
function OfficialLink({ href, children }: { href?: string; children?: ReactNode }) {
  const { t } = useI18n();
  const followUp = followUpMessage(href);
  if (followUp) return <FollowUpLink message={followUp}>{children}</FollowUpLink>;
  if (!href || !officialDomain(href)) return <span>{children}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <span className="sr-only"> {t.common.newTab}</span>
    </a>
  );
}

/** Agent headings sit under the reply, so they are level 3 at most. */
function SubHeading({ children }: { children?: ReactNode }) {
  return <h3>{children}</h3>;
}

const COMPONENTS: Components = { a: OfficialLink, h1: SubHeading, h2: SubHeading };

const ALLOWED = ["p", "strong", "em", "ul", "ol", "li", "a", "br", "h3", "h4", "blockquote", "code"];

type Part = { kind: "text"; text: string } | { kind: "citation"; citation: Citation; index: number };

/**
 * Splits the reply at its `[[citation:N]]` lines. Each verified citation shows once, at its
 * first marker. A marker with no citation is dropped.
 */
export function splitCitations(text: string, citations: Citation[] = []): Part[] {
  const parts: Part[] = [];
  const shown = new Set<number>();
  let buffer: string[] = [];
  const flush = () => {
    const t = buffer.join("\n").trim();
    if (t) parts.push({ kind: "text", text: t });
    buffer = [];
  };
  for (const line of text.split("\n")) {
    const m = CITATION_MARKER.exec(line.trim());
    if (!m) {
      buffer.push(line);
      continue;
    }
    const index = Number(m[1]);
    const citation = citations[index];
    if (!citation || shown.has(index)) continue;
    flush();
    shown.add(index);
    parts.push({ kind: "citation", citation, index });
  }
  flush();
  return parts;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

/**
 * One verified quote of official text. The text renders as plain text (React escapes it, no
 * Markdown, no HTML), with its line breaks kept. Arc has no quote item (free or Pro): see ARC.md.
 * A quote in the other language shows its machine translation first, then the original in an
 * Arc accordion. Each text block carries its own `lang`, so a screen reader reads it right.
 */
export function CitationCard({ citation }: { citation: Citation }) {
  const { t, lang } = useI18n();
  const official = officialDomain(citation.src);
  const host = official ?? hostOf(citation.src);
  const sourceLang = citation.lang ?? lang;
  const translation = citation.translation;
  const original = (
    <blockquote className={styles.citationText} cite={official ? citation.src : undefined} lang={sourceLang}>
      {citation.text}
    </blockquote>
  );
  return (
    <figure className={styles.citation}>
      <figcaption className={styles.citationLabel}>
        {translation ? (
          <Languages size={14} strokeWidth={1.75} aria-hidden="true" />
        ) : (
          <Quote size={14} strokeWidth={1.75} aria-hidden="true" />
        )}
        {translation ? t.chat.citationTranslated : citation.kind === "leaflet" ? t.chat.leafletLabel : t.chat.citationLabel}
      </figcaption>
      {translation ? (
        <>
          <blockquote className={styles.citationText} lang={translation.lang}>
            {translation.text}
          </blockquote>
          <div className={styles.citationOriginal}>
            <Accordion defaultOpen={-1} items={[{ title: t.chat.citationOriginal(sourceLang), content: original }]} />
          </div>
        </>
      ) : (
        <>
          {original}
          {citation.untranslated && (
            <p className={styles.citationNote}>
              <Languages size={14} strokeWidth={1.75} aria-hidden="true" />
              {t.chat.citationOnlyIn(sourceLang)}
            </p>
          )}
        </>
      )}
      {citation.kind === "leaflet" && (
        <p className={styles.leafletNotice}>
          <Pill size={14} strokeWidth={1.75} aria-hidden="true" />
          {t.chat.leafletNotice}
        </p>
      )}
      <p className={styles.citationSource}>
        <span>{t.chat.citationSource}</span>
        {official ? (
          <a className={styles.citationLink} href={citation.src} target="_blank" rel="noopener noreferrer">
            <Badge tone="info" size="sm">
              {host}
            </Badge>
            <ExternalLink size={14} strokeWidth={1.75} aria-hidden="true" className={styles.sourceIcon} />
            <span className="sr-only">{t.common.newTab}</span>
          </a>
        ) : (
          <span>{host}</span>
        )}
        {citation.retrieved && <span className={styles.citationDate}>{t.chat.citationRetrieved(formatDay(citation.retrieved, lang))}</span>}
      </p>
    </figure>
  );
}

/** What the question card of a reply needs from the chat. */
export interface AskProps {
  /** Nothing can be sent now (a turn runs, or the conversation ended). */
  disabled: boolean;
  /** This reply holds the newest open question: focus moves to its card. */
  focus: boolean;
  onAnswer: (text: string, choice: boolean) => void;
}

export function AssistantReply({
  text,
  meta,
  ask,
  followUp,
}: {
  text: string;
  meta?: ReplyMeta;
  ask?: AskProps;
  /** Follow-up links: `send` sends the message like the composer; `disabled` while a turn runs. */
  followUp?: { send: (text: string) => void; disabled: boolean };
}) {
  const { t, lang } = useI18n();
  const sources = meta?.sources ?? [];
  const handoffName = meta?.handoffTo ? agents.get(meta.handoffTo)?.name : undefined;
  // A reply that is only a question carries the question as its text: the card shows it.
  const questionOnly = meta?.question !== undefined && text === meta.question.text;
  const parts = questionOnly ? [] : splitCitations(stripSourcesLine(text, sources), meta?.citations);
  const links = followUp ?? { disabled: true };
  return (
    <FollowUpContext.Provider value={links}>
    <div className={styles.reply}>
      {handoffName && (
        <p className={styles.note}>
          <ArrowRightLeft size={14} strokeWidth={1.75} aria-hidden="true" />
          {t.chat.handoff(handoffName)}
        </p>
      )}
      {meta?.languageSwitched && (
        <p className={styles.note}>
          <Languages size={14} strokeWidth={1.75} aria-hidden="true" />
          {t.chat.languageSwitched}
        </p>
      )}
      {parts.map((part, i) =>
        part.kind === "citation" ? (
          <CitationCard key={`c${part.index}`} citation={part.citation} />
        ) : (
          <div key={`t${i}`} className={styles.markdown}>
            <Markdown allowedElements={[...ALLOWED, "h1", "h2"]} unwrapDisallowed skipHtml components={COMPONENTS} urlTransform={urlTransform}>
              {normalizeFollowUps(lang === "fr" ? frenchSpaces(part.text) : part.text)}
            </Markdown>
          </div>
        ),
      )}
      {meta?.question && (
        <QuestionCard
          question={meta.question}
          answer={meta.answer}
          disabled={ask?.disabled ?? true}
          focusOnMount={ask?.focus ?? false}
          onAnswer={ask?.onAnswer}
        />
      )}
      <Attachments data={meta?.attachments} />
      {meta?.recap && <RecapCard file={meta.recap} />}
      {sources.length > 0 && (
        <div className={styles.sources}>
          <h3 className={styles.sourcesTitle}>{t.chat.sourcesTitle}</h3>
          <ul className={styles.sourceList}>
            {sources.map((s) => (
              <li key={s.url}>
                <a className={styles.source} href={s.url} target="_blank" rel="noopener noreferrer">
                  <Badge tone="info" size="sm">
                    {s.domain}
                  </Badge>
                  <span className={styles.sourceTitle}>{s.title}</span>
                  <ExternalLink size={14} strokeWidth={1.75} aria-hidden="true" className={styles.sourceIcon} />
                  <span className="sr-only">{t.common.newTab}</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
      {meta?.activity && <ActivitySummary activity={meta.activity} />}
    </div>
    </FollowUpContext.Provider>
  );
}

/** Under a recap reply: the PDF, to download again (it stays in memory only). */
function RecapCard({ file }: { file: { pdf: string; filename: string } }) {
  const { t } = useI18n();
  return (
    <div className={styles.recapCard}>
      <FileText size={20} strokeWidth={1.75} aria-hidden="true" className={styles.recapIcon} />
      <div className={styles.recapText}>
        <p className={styles.recapTitle}>{t.recap.card}</p>
        <p className={styles.recapName}>{file.filename}</p>
      </div>
      <Button variant="secondary" size="sm" onClick={() => downloadPdf(file.pdf, file.filename)}>
        {t.recap.again}
      </Button>
    </div>
  );
}
