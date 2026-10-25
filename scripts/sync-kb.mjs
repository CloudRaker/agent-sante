// Builds the knowledge assets that the Worker uses to verify verbatim citations.
// Reads the Markdown files of the Run repo knowledge folder, and writes:
//   public/kb/<hash>.txt   the normalized text of one knowledge file (or of one bundle section)
//   public/kb/index.json   normalized source URL -> its text files and its retrieval date, and
//                          text file -> the language of its knowledge file (front matter lang)
// The text is public government content. The Worker reads it through env.ASSETS.
//
// Usage: pnpm sync:kb [path/to/knowledge]
// Default path: the env var AGENT_SANTE_KB, else ../agent-sante-agents/knowledge (next to this repo).
// With --if-present (used by `pnpm build`): when the knowledge folder is not there, keep the
// committed public/kb and only check that its index exists.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { kbLang, normalizeSourceUrl, normalizeText } from "../shared/kb.ts";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const ifPresent = args.includes("--if-present");
const pathArg = args.find((a) => !a.startsWith("--"));
const source = resolve(pathArg ?? process.env.AGENT_SANTE_KB ?? resolve(here, "../../agent-sante-agents/knowledge"));
const out = resolve(here, "../public/kb");

// Workers static assets limits: 20,000 files per version (Free plan) and 25 MiB per file.
// Stay far under both: the app itself has few files.
const MAX_FILES = 15_000;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

if (!existsSync(source) || !statSync(source).isDirectory()) {
  if (ifPresent && existsSync(join(out, "index.json"))) {
    console.log(`kb: no knowledge folder at ${source}. The committed public/kb stays as it is.`);
    process.exit(0);
  }
  console.error(`No knowledge folder at ${source}. Give the path as an argument or set AGENT_SANTE_KB.`);
  process.exit(1);
}

function walk(dir) {
  return readdirSync(dir)
    .toSorted()
    .flatMap((name) => {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) return walk(p);
      return /\.(md|markdown)$/i.test(name) ? [p] : [];
    });
}

const unquote = (v) => {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
};

/** Reads the small YAML front matter subset of the crawl: scalars and one level of lists. */
function parseFile(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return { meta: {}, body: raw };
  const meta = {};
  let listKey = null;
  for (const line of m[1].split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) {
      meta[listKey].push(unquote(item[1]));
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    if (kv[2] === "") {
      listKey = kv[1];
      meta[listKey] = [];
    } else {
      listKey = null;
      meta[kv[1]] = unquote(kv[2]);
    }
  }
  return { meta, body: raw.slice(m[0].length) };
}

/** A bundle section starts at `## Title (https://...)`. */
const SECTION = /^##\s+.*\((https?:\/\/[^\s)]+)\)\s*$/;

const texts = new Map(); // file name -> normalized text
const langs = new Map(); // file name -> "fr" | "en"
const index = {}; // url -> { files: Set, retrieved }
let skipped = 0;

function add(url, text, retrieved, lang) {
  const key = normalizeSourceUrl(url);
  const norm = normalizeText(text);
  if (!key || !norm) {
    skipped++;
    return;
  }
  const name = `${createHash("sha256").update(norm).digest("hex").slice(0, 20)}.txt`;
  texts.set(name, norm);
  if (lang) langs.set(name, lang);
  const entry = (index[key] ??= { files: new Set(), retrieved: undefined });
  entry.files.add(name);
  if (retrieved && (!entry.retrieved || retrieved > entry.retrieved)) entry.retrieved = retrieved;
}

// Sorted so that the parts of a split bundle come in order.
// Parts of a split bundle: a part starts with the rest of the last section of the part before.
const carry = new Map(); // bundle base path -> section URL open at the end of the last part
const partOf = (p) => {
  const m = /^(.*)-part-(\d+)\.md$/i.exec(p);
  return m ? { base: m[1], n: Number(m[2]) } : { base: p.replace(/\.md$/i, ""), n: 0 };
};
const files = walk(source).toSorted((a, b) => {
  const pa = partOf(a);
  const pb = partOf(b);
  return pa.base === pb.base ? pa.n - pb.n : a < b ? -1 : 1;
});

for (const file of files) {
  const { meta, body } = parseFile(readFileSync(file, "utf8"));
  const retrieved = /^\d{4}-\d{2}-\d{2}$/.test(meta.retrieved ?? "") ? meta.retrieved : undefined;
  const lang = kbLang(meta.lang);
  if (meta.kind === "bundle") {
    const { base } = partOf(file);
    let url = carry.get(base) ?? null;
    let lines = [];
    const flush = () => {
      if (url && lines.length) add(url, lines.join("\n"), retrieved, lang);
      lines = [];
    };
    for (const line of body.split(/\r?\n/)) {
      const s = SECTION.exec(line);
      if (s) {
        flush();
        url = s[1];
      }
      // The H1 and the intro line of the bundle repeat in each part: they belong to no section.
      if (url) lines.push(line);
    }
    flush();
    carry.set(base, url);
    continue;
  }
  const urls = [meta.source_url, ...(Array.isArray(meta.source_urls) ? meta.source_urls : [])].filter((u) => typeof u === "string" && u);
  if (!urls.length) {
    console.log(`no source_url: ${relative(source, file)}`);
    skipped++;
    continue;
  }
  for (const u of new Set(urls)) add(u, body, retrieved, lang);
}

if (texts.size + 1 > MAX_FILES) {
  console.error(`Too many knowledge assets: ${texts.size} (limit ${MAX_FILES}).`);
  process.exit(1);
}
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
let bytes = 0;
for (const [name, text] of texts) {
  const size = Buffer.byteLength(text);
  if (size > MAX_FILE_BYTES) {
    console.error(`${name} is ${size} bytes (limit ${MAX_FILE_BYTES}).`);
    process.exit(1);
  }
  bytes += size;
  writeFileSync(join(out, name), text);
}
const urls = Object.fromEntries(
  Object.entries(index)
    .toSorted(([a], [b]) => (a < b ? -1 : 1))
    .map(([u, e]) => [u, { files: [...e.files].toSorted(), ...(e.retrieved ? { retrieved: e.retrieved } : {}) }]),
);
const langMap = Object.fromEntries([...langs].toSorted(([a], [b]) => (a < b ? -1 : 1)));
writeFileSync(join(out, "index.json"), JSON.stringify({ version: 1, urls, langs: langMap }));
console.log(
  `kb: ${files.length} Markdown files -> ${texts.size} text assets (${(bytes / 1e6).toFixed(1)} MB), ${Object.keys(urls).length} source URLs, ${langs.size} with a language, ${skipped} skipped. Source: ${source}`,
);
