// Places and appointments that the agents find with the Worker tools (/tools/v1).
// The Worker keeps the results of a turn and sends them with the checked reply as
// `attachments`. The model sees only a short summary, never these lists.

/** One establishment from the health directory (sante.gouv.qc.ca répertoire). */
export interface PlaceItem {
  id: string;
  name: string;
  /** Street and city, one line. */
  address: string;
  city: string | null;
  lat: number;
  lng: number;
  /** Distance from the session location, in km, when known. */
  distanceKm: number | null;
  /** Up to 4 services of the place (French text from the directory). */
  services: string[];
  /** Next opening in the next 7 days (local time of Québec), when the directory knows it. */
  next: PlaceOpening | null;
  /** The official directory page of the place. */
  sourceUrl: string;
}

export interface PlaceOpening {
  /** "2026-10-26" */
  date: string;
  /** "08:30" */
  opens: string;
  /** "17:00" */
  closes: string;
  /** True when the place is open now. */
  now: boolean;
}

/** A link to the Clic Santé list page of one service near the person. We never book. */
export interface AppointmentLink {
  /** Clic Santé service template id, when known. */
  serviceId: number | null;
  /** French slug of the service in the Clic Santé catalog. */
  slug: string;
  name: { fr: string; en: string };
  /** "H2X (Montréal)": the area the list page searches around (FSA centroid). */
  area: string | null;
  /** The Clic Santé portal list page (or the service page when the service has no known id). */
  url: string;
  /**
   * Places with free slot counts. Only when the Worker var CLICSANTE_API is "on"
   * (it is off until Clic Santé gives written permission).
   */
  places?: AppointmentPlace[];
}

export interface AppointmentPlace {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  distanceKm: number | null;
  /** Free slot counts: next 2 days, next 7 days, after 7 days. */
  slots: { days2: number; days7: number; later: number };
}

export interface Attachments {
  places?: {
    /** "H2X (Montréal)" */
    area: string;
    items: PlaceItem[];
  };
  appointments?: AppointmentLink[];
}

export const isEmptyAttachments = (a: Attachments | undefined): boolean => !a || (!a.places?.items.length && !a.appointments?.length);
