// Writes shared/clicsante-catalog.json from the Clic Santé portal sitemap (slug pairs, fr and en).
// Usage: node scripts/sync-clicsante.mjs path/to/sitemap-services.tsv
// Source: the sitemap of the portal3.clicsante.ca services, as a TSV file of slug pairs.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
if (!process.argv[2]) {
  console.error("Usage: node scripts/sync-clicsante.mjs path/to/sitemap-services.tsv");
  process.exit(1);
}
const source = resolve(process.argv[2]);
const rows = readFileSync(source, "utf8")
  .trim()
  .split("\n")
  .slice(1)
  .map((l) => l.split("\t"));
const SLUG = /^[\p{Ll}0-9_-]{1,120}$/u;
const services = rows.filter(([fr, en]) => SLUG.test(fr ?? "") && SLUG.test(en ?? "")).map(([fr, en]) => ({ fr, en }));
writeFileSync(
  resolve(here, "../shared/clicsante-catalog.json"),
  `${JSON.stringify({ source: "https://portal3.clicsante.ca/sitemap.xml", retrieved: new Date().toISOString().slice(0, 10), services }, null, 1)}\n`,
);
console.log(`Wrote ${services.length} services.`);
