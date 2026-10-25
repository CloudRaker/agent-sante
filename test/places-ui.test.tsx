// @vitest-environment jsdom
// Places and appointment links under a reply: map, compact list, link to Clic Santé, fr and en.
import { cleanup, fireEvent, render } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it } from "vitest";
import { stepLabel } from "../src/chat/ActivityTimeline";
import { AssistantReply } from "../src/chat/AssistantReply";
import { dayLabel, timeLabel } from "../src/chat/Attachments";
import { MapTokenContext } from "../src/chat/MapToken";
import { dicts, I18nProvider } from "../src/i18n";
import { placeName } from "../src/lib/placeName";
import type { Attachments } from "../shared/places";

afterEach(cleanup);

const DATA: Attachments = {
  places: {
    area: "H2X (Montréal)",
    items: [
      {
        id: "1",
        name: "CLSC des Faubourgs",
        address: "1705, rue de la Visitation, Montréal",
        city: "Montréal",
        lat: 45.52,
        lng: -73.55,
        distanceKm: 1.4,
        services: ["Vaccination"],
        next: { date: "2026-10-26", opens: "08:30", closes: "17:00", now: false },
        sourceUrl: "https://sante.gouv.qc.ca/repertoire-ressources/ressource/?nofiche=1",
      },
      {
        id: "2",
        name: "Pharmacie du Plateau",
        address: "100, avenue du Mont-Royal Est, Montréal",
        city: "Montréal",
        lat: 45.52,
        lng: -73.58,
        distanceKm: 2.2,
        services: [],
        next: null,
        sourceUrl: "https://sante.gouv.qc.ca/repertoire-ressources/ressource/?nofiche=2",
      },
    ],
  },
  appointments: [
    {
      serviceId: 3161,
      slug: "vaccination-virus-respiratoires",
      name: {
        fr: "Vaccination contre les virus respiratoires (grippe et COVID-19)",
        en: "Respiratory virus vaccination (flu and COVID-19)",
      },
      area: "H2X (Montréal)",
      url: "https://portal3.clicsante.ca/?serviceId=3161&latitude=45.51&longitude=-73.57&fees=0&performSearch=true",
    },
  ],
};

function show(lang: "fr" | "en" = "fr", token: string | null = null) {
  return render(
    <I18nProvider lang={lang}>
      <MapTokenContext.Provider value={token}>
        <AssistantReply text="J'ai trouvé des lieux près de votre secteur." meta={{ sources: [], attachments: DATA }} />
      </MapTokenContext.Provider>
    </I18nProvider>,
  );
}

const step = (kind: "location" | "places" | "appointments", params = {}) => ({ id: kind, kind, state: "done" as const, start: 0, params });

describe("attachments under a reply", () => {
  it("shows the Clic Santé card with a link that opens the list page, and the places list", async () => {
    const { container, getByText } = show("fr");
    const cta = getByText("Voir les disponibilités sur Clic Santé").closest("a")!;
    expect(cta.getAttribute("href")).toBe(DATA.appointments![0]!.url);
    expect(cta.getAttribute("target")).toBe("_blank");
    expect(cta.getAttribute("rel")).toContain("noopener");
    expect(container.textContent).toContain("Vous choisissez et réservez vous-même sur Clic Santé");
    expect(container.textContent).toContain("Autour du secteur H2X (Montréal)");
    expect(container.textContent).toContain("Établissements près de H2X (Montréal)");
    const items = container.querySelectorAll("ol li");
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain("CLSC des Faubourgs");
    expect(items[0]!.textContent).toContain("1,4 km");
    expect(items[1]!.textContent).toContain("Heures non indiquées");
    for (const a of container.querySelectorAll("a")) expect(a.getAttribute("rel")).toContain("noopener");
    // No token: no map switch.
    expect(container.querySelector("[role=radiogroup], [role=tablist]")).toBeNull();
    const result = await axe.run(container, { rules: { "color-contrast": { enabled: false } }, resultTypes: ["violations"] });
    expect(result.violations.map((v) => v.id)).toEqual([]);
  });

  it("uses English copy", () => {
    const { container, getByText } = show("en");
    expect(getByText("See available times on Clic Santé").closest("a")).not.toBeNull();
    expect(container.textContent).toContain("Places near H2X (Montréal)");
    expect(container.textContent).toContain("Respiratory virus vaccination");
  });

  it("shows the map above the list with a MapKit token, and the list stays", async () => {
    const { container, getAllByText } = show("fr", "token");
    expect(getAllByText("Agrandir la carte").length).toBeGreaterThan(0);
    expect(container.querySelectorAll("ol li")).toHaveLength(2);
    // No List/Map switch: the map is always there.
    expect(container.querySelector("[role=radiogroup], [role=tablist]")).toBeNull();
    const result = await axe.run(container, { rules: { "color-contrast": { enabled: false } }, resultTypes: ["violations"] });
    expect(result.violations.map((v) => v.id)).toEqual([]);
  });

  it("opens a row to show its services and official page, and marks it as the current row", () => {
    const { container } = show("fr");
    const rows = container.querySelectorAll<HTMLButtonElement>("ol li > button");
    expect(rows[0]!.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("Fiche officielle");
    fireEvent.click(rows[0]!);
    expect(rows[0]!.getAttribute("aria-expanded")).toBe("true");
    expect(rows[0]!.closest("li")!.getAttribute("aria-current")).toBe("true");
    expect(container.textContent).toContain("Fiche officielle");
  });

  it("shows directory names in capitals as title case", () => {
    expect(placeName("PHARMACIE JEAN-COUTU (BOUL. CARTIER)")).toBe("Pharmacie Jean-Coutu (Boul. Cartier)");
    expect(placeName("AIRE OUVERTE CLSC SAINT-HENRI")).toBe("Aire Ouverte CLSC Saint-Henri");
    expect(placeName("CENTRE D'HÉBERGEMENT DE SAINT-HENRI")).toBe("Centre d'Hébergement de Saint-Henri");
    expect(placeName("CHSLD L'ÎLE-DES-SOEURS")).toBe("CHSLD L'Île-des-Soeurs");
    expect(placeName("Clinique du Quartier")).toBe("Clinique du Quartier");
  });

  it("formats days and times for Québec", () => {
    const t = dicts.fr;
    const now = Date.parse("2026-10-24T16:00:00Z");
    expect(dayLabel("2026-10-24", "fr", t, now)).toBe("aujourd'hui");
    expect(dayLabel("2026-10-25", "fr", t, now)).toBe("demain");
    expect(dayLabel("2026-10-26", "fr", t, now)).toBe("lundi 26 octobre");
    expect(timeLabel("08:30", "fr")).toBe("8 h 30");
    expect(timeLabel("17:00", "fr")).toBe("17 h");
    expect(timeLabel("17:00", "en")).toMatch(/5:00/);
  });

  it("labels the new activity steps", () => {
    expect(stepLabel(step("location", { area: "H2X 1Y4" }), dicts.fr)).toBe("Recherche autour de H2X 1Y4");
    expect(stepLabel(step("places"), dicts.fr)).toBe("Recherche d'établissements à proximité");
    expect(stepLabel(step("appointments"), dicts.fr)).toBe("Recherche de rendez-vous sur Clic Santé");
    expect(stepLabel(step("appointments"), dicts.en)).toBe("Looking for appointments on Clic Santé");
  });
});
