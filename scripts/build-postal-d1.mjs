// Builds the postal code database (D1 `agent-sante-postal`, binding POSTAL) from the ISQ file
// "CP Territoires" (Institut de la statistique du Québec, CC-BY 4.0).
// https://www.donneesquebec.ca/recherche/dataset/1a6267da-82ed-4ea0-b35d-9e9618a58ce7
//
// Usage:
//   node scripts/build-postal-d1.mjs            download (when missing) and write the SQL files
//   node scripts/build-postal-d1.mjs --load     also load them with `wrangler d1 execute --remote`
//   node scripts/build-postal-d1.mjs --local    load into the local D1 of `wrangler dev` instead
//
// The source has several rows per postal code (one per municipality piece, with PRC_REP, the
// percent of the code in that piece). We keep one row per code: the position and the names of
// the row with the highest PRC_REP. Codes with an active row skip their retired rows. The FSA
// table (first 3 characters) holds the centroid of its active codes, weighted by address units.
// It is the fallback for a code that is not in the file.
import { createReadStream, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const dataDir = resolve(root, ".data/postal");
const csvPath = resolve(dataDir, "cp_territoires.csv");
const sqlDir = resolve(dataDir, "sql");
const SOURCE =
  "https://www.donneesquebec.ca/recherche/dataset/1a6267da-82ed-4ea0-b35d-9e9618a58ce7/resource/bbd5521c-120f-494b-b2a3-a6a682d8d458/download/cp_territoires.csv";
const DB = "agent-sante-postal";
const ROWS_PER_INSERT = 250;
const ROWS_PER_FILE = 25_000;

const args = new Set(process.argv.slice(2));
const CODE = /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z]\d[ABCEGHJ-NPRSTV-Z]\d$/;

/** Splits one CSV line. Fields can be quoted; a quote inside a quoted field is doubled. */
export function parseCsvLine(line) {
  const out = [];
  let i = 0;
  while (i <= line.length) {
    if (line[i] === '"') {
      let value = "";
      i++;
      for (;;) {
        const q = line.indexOf('"', i);
        if (q < 0) throw new Error("Unclosed quote");
        value += line.slice(i, q);
        if (line[q + 1] === '"') {
          value += '"';
          i = q + 2;
        } else {
          i = q + 1;
          break;
        }
      }
      out.push(value);
      i++; // the comma
    } else {
      const c = line.indexOf(",", i);
      const end = c < 0 ? line.length : c;
      out.push(line.slice(i, end));
      i = end + 1;
    }
  }
  return out;
}

async function download() {
  if (existsSync(csvPath)) return;
  mkdirSync(dataDir, { recursive: true });
  console.log(`Downloading ${SOURCE}`);
  const res = await fetch(SOURCE);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  writeFileSync(csvPath, Buffer.from(await res.arrayBuffer()));
}

async function reduce() {
  const lines = createInterface({ input: createReadStream(csvPath, "utf8"), crlfDelay: Infinity });
  let header;
  /** cp -> best row so far: {active, prc, lat, lng, units, mun, mrc, ra, clscCode, clsc} */
  const best = new Map();
  let rows = 0;
  for await (const raw of lines) {
    const line = raw.replace(/^﻿/, "");
    if (!line) continue;
    const f = parseCsvLine(line);
    if (!header) {
      header = Object.fromEntries(f.map((name, i) => [name, i]));
      for (const k of ["CP", "PRC_REP", "NB_UNITE_CP", "NOM_MUN", "NOM_MRC", "NOM_RA", "CO_CLSC", "NOM_CLSC", "LAT", "LONG", "RET_DATE"]) {
        if (!(k in header)) throw new Error(`Column ${k} is missing`);
      }
      continue;
    }
    rows++;
    const cp = f[header.CP].replace(/\s/g, "").toUpperCase();
    const lat = Number(f[header.LAT]);
    const lng = Number(f[header.LONG]);
    if (!CODE.test(cp) || !Number.isFinite(lat) || !Number.isFinite(lng) || lat === 0 || lng === 0) continue;
    const row = {
      active: !f[header.RET_DATE],
      prc: Number(f[header.PRC_REP]) || 0,
      units: Number(f[header.NB_UNITE_CP]) || 0,
      lat,
      lng,
      mun: f[header.NOM_MUN] || null,
      mrc: f[header.NOM_MRC] || null,
      ra: f[header.NOM_RA] || null,
      clscCode: f[header.CO_CLSC] || null,
      clsc: f[header.NOM_CLSC] || null,
    };
    const prev = best.get(cp);
    // An active row beats a retired row; then the highest share of the code wins.
    if (!prev || (row.active && !prev.active) || (row.active === prev.active && row.prc > prev.prc)) best.set(cp, row);
  }
  return { best, rows };
}

const top = (m) => [...m.entries()].toSorted((a, b) => b[1] - a[1])[0]?.[0] ?? null;
const sql = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replaceAll("'", "''")}'`);
const round = (n) => Math.round(n * 1e6) / 1e6;

function writeSql(best) {
  rmSync(sqlDir, { recursive: true, force: true });
  mkdirSync(sqlDir, { recursive: true });
  const files = [];
  const schema = `DROP TABLE IF EXISTS postal;
DROP TABLE IF EXISTS fsa;
CREATE TABLE postal (cp TEXT PRIMARY KEY, lat REAL NOT NULL, lng REAL NOT NULL, mun TEXT, mrc TEXT, ra TEXT, clsc_code TEXT, clsc TEXT, retired INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID;
CREATE TABLE fsa (fsa TEXT PRIMARY KEY, lat REAL NOT NULL, lng REAL NOT NULL, codes INTEGER NOT NULL, mun TEXT, ra TEXT) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
`;
  writeFileSync(resolve(sqlDir, "000-schema.sql"), schema);
  files.push("000-schema.sql");

  const entries = [...best.entries()].toSorted(([a], [b]) => a.localeCompare(b));
  let n = 0;
  for (let start = 0; start < entries.length; start += ROWS_PER_FILE) {
    const part = entries.slice(start, start + ROWS_PER_FILE);
    const statements = [];
    for (let i = 0; i < part.length; i += ROWS_PER_INSERT) {
      const values = part
        .slice(i, i + ROWS_PER_INSERT)
        .map(
          ([cp, r]) => `(${[cp, round(r.lat), round(r.lng), r.mun, r.mrc, r.ra, r.clscCode, r.clsc, r.active ? 0 : 1].map(sql).join(",")})`,
        );
      statements.push(`INSERT INTO postal (cp,lat,lng,mun,mrc,ra,clsc_code,clsc,retired) VALUES\n${values.join(",\n")};`);
    }
    const name = `${String(++n).padStart(3, "0")}-postal.sql`;
    writeFileSync(resolve(sqlDir, name), `${statements.join("\n")}\n`);
    files.push(name);
  }

  // FSA centroids over the active codes, weighted by address units (at least 1 per code).
  const fsa = new Map();
  for (const [cp, r] of entries) {
    if (!r.active) continue;
    const key = cp.slice(0, 3);
    const w = Math.max(1, r.units);
    const acc = fsa.get(key) ?? { lat: 0, lng: 0, w: 0, codes: 0, mun: new Map(), ra: new Map() };
    acc.lat += r.lat * w;
    acc.lng += r.lng * w;
    acc.w += w;
    acc.codes++;
    if (r.mun) acc.mun.set(r.mun, (acc.mun.get(r.mun) ?? 0) + w);
    if (r.ra) acc.ra.set(r.ra, (acc.ra.get(r.ra) ?? 0) + w);
    fsa.set(key, acc);
  }
  const fsaRows = [...fsa.entries()].map(
    ([key, a]) => `(${[key, round(a.lat / a.w), round(a.lng / a.w), a.codes, top(a.mun), top(a.ra)].map(sql).join(",")})`,
  );
  const fsaStatements = [];
  for (let i = 0; i < fsaRows.length; i += ROWS_PER_INSERT) {
    fsaStatements.push(`INSERT INTO fsa (fsa,lat,lng,codes,mun,ra) VALUES\n${fsaRows.slice(i, i + ROWS_PER_INSERT).join(",\n")};`);
  }
  const meta = `INSERT OR REPLACE INTO meta (k, v) VALUES ('source', ${sql(SOURCE)}), ('license', 'CC-BY 4.0, Institut de la statistique du Québec, CP Territoires'), ('built_at', ${sql(new Date().toISOString())}), ('codes', ${sql(String(entries.length))});`;
  writeFileSync(resolve(sqlDir, "900-fsa.sql"), `${fsaStatements.join("\n")}\n${meta}\n`);
  files.push("900-fsa.sql");
  return { files, codes: entries.length, fsas: fsa.size };
}

function load(files, remote) {
  for (const file of files) {
    console.log(`Loading ${file} (${remote ? "remote" : "local"})`);
    execFileSync("npx", ["wrangler", "d1", "execute", DB, remote ? "--remote" : "--local", "--yes", `--file=${resolve(sqlDir, file)}`], {
      cwd: root,
      stdio: ["ignore", "inherit", "inherit"],
    });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await download();
  const { best, rows } = await reduce();
  const { files, codes, fsas } = writeSql(best);
  console.log(`Read ${rows} rows: ${codes} postal codes, ${fsas} FSAs. SQL in ${sqlDir}.`);
  if (args.has("--load")) load(files, true);
  else if (args.has("--local")) load(files, false);
}
