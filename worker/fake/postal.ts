// Fake postal lookup for local development (FAKE_UPSTREAMS=1) and tests. A few FSAs only.
import type { GeoPoint, PostalLookup } from "../places/postal";

const FSAS: Record<string, Omit<GeoPoint, "fsa" | "precision" | "lat" | "lng" | "clsc">> = {
  H2X: { fsaLat: 45.511247, fsaLng: -73.569393, municipality: "Montréal", region: "Montréal" },
  H1V: { fsaLat: 45.556, fsaLng: -73.545, municipality: "Montréal", region: "Montréal" },
  G1R: { fsaLat: 46.8113, fsaLng: -71.2163, municipality: "Québec", region: "Capitale-Nationale" },
  J4K: { fsaLat: 45.5371, fsaLng: -73.5101, municipality: "Longueuil", region: "Montérégie" },
};

/** Known full codes (position of the code and its CLSC territory). */
const CODES: Record<string, { lat: number; lng: number; clsc: string }> = {
  H2X1Y4: { lat: 45.509536, lng: -73.569346, clsc: "Montréal–Centre-Ville" },
  G1R4S9: { lat: 46.8125, lng: -71.2148, clsc: "Haute-Ville-des-Rivières" },
};

export function fakePostal(): PostalLookup & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async lookup(code) {
      const clean = code.replace(/[\s-]/g, "").toUpperCase();
      const fsa = clean.slice(0, 3);
      calls.push(fsa);
      const f = FSAS[fsa];
      if (!f) return null;
      const c = CODES[clean];
      return { ...f, fsa, lat: c?.lat ?? f.fsaLat, lng: c?.lng ?? f.fsaLng, clsc: c?.clsc ?? null, precision: c ? "code" : "fsa" };
    },
  };
}
