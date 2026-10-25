// The agent catalog. `pnpm sync:agents` copies `agents.json` from the repo of the Run agents.
import catalogJson from "./agents.json";
import type { Lang } from "./api";

export interface AgentInfo {
  /** Run agent id, the folder path in the Run repo, for example "fr/concierge". */
  id: string;
  lang: Lang;
  /** Display name in the agent language. */
  name: string;
  /** One line on what the agent covers. */
  description: string;
  /** The agent with the same job in the other language. */
  counterpart: string;
}

export interface AgentCatalog {
  version: 1;
  /** True while this file is the placeholder of the web repo, not the real list. */
  placeholder?: boolean;
  /** First agent of each language. */
  entry: Record<Lang, string>;
  agents: AgentInfo[];
}

const SEGMENT = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Checks the shape and the cross references. Returns a list of problems (empty when valid). */
export function validateCatalog(value: unknown): string[] {
  const problems: string[] = [];
  const c = value as Partial<AgentCatalog>;
  if (!c || typeof c !== "object") return ["catalog is not an object"];
  if (c.version !== 1) problems.push("version must be 1");
  if (!Array.isArray(c.agents) || c.agents.length === 0) return [...problems, "agents must be a non-empty list"];
  const ids = new Map<string, AgentInfo>();
  for (const a of c.agents) {
    if (!a || typeof a.id !== "string") {
      problems.push("agent without id");
      continue;
    }
    if (!a.id.split("/").every((s) => SEGMENT.test(s))) problems.push(`${a.id}: bad id segment`);
    if (a.lang !== "fr" && a.lang !== "en") problems.push(`${a.id}: lang must be fr or en`);
    if (!a.id.startsWith(`${a.lang}/`)) problems.push(`${a.id}: id must start with its lang`);
    if (typeof a.name !== "string" || !a.name) problems.push(`${a.id}: name missing`);
    if (typeof a.description !== "string") problems.push(`${a.id}: description missing`);
    if (ids.has(a.id)) problems.push(`${a.id}: duplicate id`);
    ids.set(a.id, a);
  }
  for (const a of ids.values()) {
    const other = ids.get(a.counterpart);
    if (!other) problems.push(`${a.id}: counterpart ${a.counterpart} not found`);
    else if (other.lang === a.lang) problems.push(`${a.id}: counterpart must be in the other language`);
  }
  for (const lang of ["fr", "en"] as const) {
    const id = c.entry?.[lang];
    if (!id || ids.get(id)?.lang !== lang) problems.push(`entry.${lang} must be an agent of that language`);
  }
  return problems;
}

export class Agents {
  readonly byId: ReadonlyMap<string, AgentInfo>;
  constructor(readonly catalog: AgentCatalog) {
    const problems = validateCatalog(catalog);
    if (problems.length) throw new Error(`agents.json is not valid: ${problems.join("; ")}`);
    this.byId = new Map(catalog.agents.map((a) => [a.id, a]));
  }
  get(id: string): AgentInfo | undefined {
    return this.byId.get(id);
  }
  entry(lang: Lang): string {
    return this.catalog.entry[lang];
  }
  /** The agent of the other language with the same job, or the entry agent of that language. */
  counterpart(id: string, lang: Lang): string {
    const c = this.byId.get(id)?.counterpart;
    return c && this.byId.get(c)?.lang === lang ? c : this.entry(lang);
  }
  /** A handoff target must exist and use the same language as the agent that asks. */
  isValidHandoff(from: string, to: unknown): to is string {
    if (typeof to !== "string" || to === from) return false;
    const a = this.byId.get(from),
      b = this.byId.get(to);
    return !!a && !!b && a.lang === b.lang;
  }
}

export const agents = new Agents(catalogJson as AgentCatalog);
