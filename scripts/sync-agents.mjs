// Copies agents.json from the Run repo into shared/agents.json after a shape check.
// Usage: pnpm sync:agents [path/to/agents.json]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(process.argv[2] ?? resolve(here, "../../agent-sante-agents/agents.json"));
const target = resolve(here, "../shared/agents.json");

if (!existsSync(source)) {
  console.error(`No file at ${source}. Build the Run repo first, or give the path as an argument.`);
  process.exit(1);
}
const catalog = JSON.parse(readFileSync(source, "utf8"));
const SEGMENT = /^[a-z0-9][a-z0-9-]{0,62}$/;
const problems = [];
if (catalog.version !== 1) problems.push("version must be 1");
const ids = new Map((catalog.agents ?? []).map((a) => [a.id, a]));
for (const a of ids.values()) {
  if (
    !String(a.id)
      .split("/")
      .every((s) => SEGMENT.test(s))
  )
    problems.push(`${a.id}: bad id segment`);
  if (!["fr", "en"].includes(a.lang)) problems.push(`${a.id}: bad lang`);
  if (!a.name) problems.push(`${a.id}: name missing`);
  const other = ids.get(a.counterpart);
  if (!other || other.lang === a.lang) problems.push(`${a.id}: bad counterpart ${a.counterpart}`);
}
for (const lang of ["fr", "en"]) if (ids.get(catalog.entry?.[lang])?.lang !== lang) problems.push(`entry.${lang} is not valid`);
if (problems.length) {
  console.error(`agents.json is not valid:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
delete catalog.placeholder;
writeFileSync(target, `${JSON.stringify(catalog, null, 2)}\n`);
console.log(`Copied ${ids.size} agents from ${source} to shared/agents.json.`);
