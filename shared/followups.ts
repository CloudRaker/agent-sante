// Follow-up links: an agent can offer a next step as a Markdown link whose address is the next
// message, `[Trouver les pharmacies près de chez moi](agentsante://Trouver les pharmacies près de chez moi)`.
// The chat shows it as an inline link with a chat icon; a click sends that text as the person's
// next message (it goes through the PII check like typed text). Never a web address.

export const FOLLOW_UP_SCHEME = "agentsante:";
/** Max characters of the message a follow-up link sends. */
export const FOLLOW_UP_CHARS = 200;

const LINK = /\[([^\]\n]{1,160})\]\(\s*<?agentsante:(?:\/\/)?([^)>\n]{0,400})>?\s*\)/gi;

const plain = (s: string) =>
  s
    .replace(/[*_`<>[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, FOLLOW_UP_CHARS);

function decode(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    return raw;
  }
}

/** The message of a follow-up address, or null for any other address. */
export function followUpMessage(href: string | undefined): string | null {
  if (!href || !href.toLowerCase().startsWith(FOLLOW_UP_SCHEME)) return null;
  const m = /^agentsante:ask\?m=(.*)$/i.exec(href);
  const message = plain(decode(m ? m[1]! : href.slice(FOLLOW_UP_SCHEME.length).replace(/^\/\//, "")));
  return message || null;
}

/**
 * Rewrites follow-up links to a form the Markdown parser keeps (no spaces in the address).
 * An empty address sends the link text.
 */
export function normalizeFollowUps(text: string): string {
  return text.replace(LINK, (_all, label: string, raw: string) => {
    const message = plain(decode(raw)) || plain(label);
    return message ? `[${label}](agentsante:ask?m=${encodeURIComponent(message)})` : label;
  });
}

/** Removes follow-up links and keeps their text (for the PDF recap). */
export function stripFollowUps(text: string): string {
  return text.replace(LINK, (_all, label: string) => label);
}
