// The health directory writes most names in capitals ("PHARMACIE JEAN-COUTU CARLA CHIRINIAN").
// For display, a name that is mostly capitals becomes title case in French typography:
// small words stay in lower case, known acronyms stay in capitals.

const SMALL = new Set(["de", "du", "des", "la", "le", "les", "et", "à", "au", "aux", "en", "sur", "pour", "d", "l", "of", "the", "and"]);
const ACRONYMS = new Set([
  "CLSC", "GMF", "GMF-U", "CHSLD", "CHU", "CHUM", "CHUS", "CUSM", "CDL", "RPA", "IPS", "CIUSSS", "CISSS", "UMF",
  "CSSS", "CRDS", "PFSI", "VIH", "ITSS", "DPJ", "RI", "RTF", "OBNL", "CPE", "II", "III", "IV", "QC", "MD",
]);

/** True when the letters of the name are mostly capitals. */
function shouting(name: string): boolean {
  const letters = name.replace(/[^\p{L}]/gu, "");
  if (letters.length < 4) return false;
  const upper = letters.replace(/[^\p{Lu}]/gu, "").length;
  return upper / letters.length > 0.7;
}

const cap = (w: string) => (w ? w.charAt(0).toLocaleUpperCase("fr-CA") + w.slice(1) : w);

/** "PHARMACIE JEAN-COUTU (BOUL. CARTIER)" to "Pharmacie Jean-Coutu (Boul. Cartier)". */
export function placeName(name: string): string {
  const clean = name.replace(/\s+/g, " ").trim();
  if (!shouting(clean)) return clean;
  let first = true;
  let afterSmall = false;
  return clean.replace(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu, (word) => {
    const atStart = first;
    const lowerElision = afterSmall;
    first = false;
    if (ACRONYMS.has(word.toUpperCase())) {
      afterSmall = false;
      return word.toUpperCase();
    }
    // Elisions: D'ARCY, L'ÎLE, D’YOUVILLE. Hyphens: SAINT-HENRI, ÎLE-DES-SOEURS.
    const parts = word.toLocaleLowerCase("fr-CA").split(/(['’-])/);
    const out = parts
      .map((p, i) => {
        if (p === "'" || p === "’" || p === "-") return p;
        if (ACRONYMS.has(p.toUpperCase())) return p.toUpperCase();
        const elided = (p === "d" || p === "l") && (parts[i + 1] === "'" || parts[i + 1] === "’");
        // "Centre d'Hébergement", "de l'Est", but "CHSLD L'Île" and "L'Île" at the start.
        if (elided) return p === "d" || (lowerElision && !atStart) ? p : cap(p);
        if (!(atStart && i === 0) && SMALL.has(p)) return p;
        return cap(p);
      })
      .join("");
    afterSmall = SMALL.has(word.toLocaleLowerCase("fr-CA"));
    return out;
  });
}
