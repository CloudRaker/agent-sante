// Places and appointment links under a checked reply. The agent tools found them; the agent wrote
// only a short summary. Each card shows a map (Apple MapKit JS, when the Worker gives a token for
// this host) above a compact list. The list is the accessible main content; the map is an extra.
// A row opens to show the services and the official page, and selects its marker on the map; a
// marker selects its row. Appointments: places with free Clic Santé slots and a link to the Clic
// Santé results page, where the person books. Agent Santé never books.
// The cards are custom on Arc tokens (see ARC.md).
import { CalendarCheck, ChevronDown, ExternalLink, Maximize2, Minimize2 } from "lucide-react";
import { lazy, Suspense, useCallback, useContext, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { Lang } from "@shared/api";
import type { AppointmentLink, Attachments as AttachmentsData, PlaceItem } from "@shared/places";
import { useI18n } from "@/i18n";
import type { Dict } from "@/i18n/fr";
import { placeName } from "@/lib/placeName";
import { MapTokenContext } from "./MapToken";
import type { MapPoint } from "./PlacesMap";
import styles from "./places.module.css";

const PlacesMap = lazy(() => import("./PlacesMap").then((m) => ({ default: m.PlacesMap })));

const LOCALE: Record<Lang, string> = { fr: "fr-CA", en: "en-CA" };

/** Today in Québec, "2026-10-24". */
function quebecToday(now = Date.now()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** "aujourd'hui", "demain" or "lundi 26 octobre". */
export function dayLabel(date: string, lang: Lang, t: Dict, now = Date.now()): string {
  const today = quebecToday(now);
  if (date === today) return t.chat.places.today;
  const d = new Date(`${date}T12:00:00Z`);
  const tomorrow = new Date(`${today}T12:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  if (date === tomorrow.toISOString().slice(0, 10)) return t.chat.places.tomorrow;
  return new Intl.DateTimeFormat(LOCALE[lang], { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }).format(d);
}

/** "8 h 30" in French, "8:30 a.m." in English. */
export function timeLabel(hhmm: string, lang: Lang): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return hhmm;
  if (lang === "fr") return m[2] === "00" ? `${+m[1]!} h` : `${+m[1]!} h ${m[2]}`;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", hour: "numeric", minute: "2-digit" }).format(
    Date.UTC(2026, 0, 1, +m[1]!, +m[2]!),
  );
}

function km(value: number, lang: Lang): string {
  return new Intl.NumberFormat(LOCALE[lang], { maximumFractionDigits: value < 10 ? 1 : 0 }).format(value);
}

/** One row of a compact place list. */
interface Row extends MapPoint {
  distanceKm: number | null;
  /** Short status (open, closed, free slots), its full sentence for screen readers and the details, and its tone. */
  status: { text: string; full: string; tone: "open" | "closed" | "neutral" };
  /** Shown when the row opens. */
  details?: ReactNode;
}

function openingStatus(place: PlaceItem, t: Dict, lang: Lang): Row["status"] {
  const p = t.chat.places;
  if (!place.next) return { text: p.hoursShort, full: p.hoursUnknown, tone: "neutral" };
  if (place.next.now) return { text: p.openShort, full: p.openNow(timeLabel(place.next.closes, lang)), tone: "open" };
  return { text: p.closedNow, full: p.opens(dayLabel(place.next.date, lang, t), timeLabel(place.next.opens, lang)), tone: "closed" };
}

/** The map (when there is a token) and the compact list, with one selected row. */
function PlaceBrowser({ rows, listLabel, mapToken }: { rows: Row[]; listLabel: string; mapToken: string | null }) {
  const { t, lang } = useI18n();
  const p = t.chat.places;
  const [selected, setSelected] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [big, setBig] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);
  const baseId = useId();
  const points = useMemo<MapPoint[]>(() => rows.map(({ id, name, address, lat, lng }) => ({ id, name, address, lat, lng })), [rows]);

  // A marker picked on the map: select its row and bring it into view inside the list.
  const fromMap = useCallback((id: string) => {
    setSelected(id);
    const row = listRef.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"]`);
    row?.scrollIntoView({ block: "nearest", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, []);

  return (
    <div className={styles.browser}>
      {mapToken && (
        <div className={styles.mapBox} data-big={big || undefined}>
          <Suspense fallback={<div className={styles.mapCanvas} aria-hidden="true" />}>
            <PlacesMap token={mapToken} points={points} selected={selected} onSelect={fromMap} />
          </Suspense>
          <button type="button" className={styles.mapToggle} aria-pressed={big} onClick={() => setBig((b) => !b)}>
            {big ? <Minimize2 size={14} strokeWidth={1.75} aria-hidden="true" /> : <Maximize2 size={14} strokeWidth={1.75} aria-hidden="true" />}
            {big ? p.shrinkMap : p.expandMap}
          </button>
        </div>
      )}
      {/* The list scrolls inside the card. Each row is a button, so the keyboard reaches every row and the list scrolls to it. */}
      <ol ref={listRef} className={styles.rows} aria-label={listLabel}>
        {rows.map((row, i) => {
          const isOpen = open === row.id;
          const detailsId = `${baseId}-${i}`;
          return (
            <li key={row.id} data-row={row.id} className={styles.row} aria-current={selected === row.id || undefined}>
              <button
                type="button"
                className={styles.rowButton}
                aria-expanded={row.details ? isOpen : undefined}
                aria-controls={row.details ? detailsId : undefined}
                onClick={() => {
                  setSelected(row.id);
                  if (row.details) setOpen(isOpen ? null : row.id);
                }}
              >
                <span className={styles.pin} aria-hidden="true">
                  {i + 1}
                </span>
                <span className={styles.rowMain}>
                  <span className={styles.rowLine}>
                    <span className={styles.rowName}>{row.name}</span>
                    {row.distanceKm !== null && <span className={styles.rowDistance}>{p.distance(km(row.distanceKm, lang))}</span>}
                  </span>
                  <span className={styles.rowLine}>
                    <span className={styles.rowAddress}>{row.address}</span>
                    <span className={styles.rowStatus} data-tone={row.status.tone}>
                      <span aria-hidden="true">{row.status.text}</span>
                      <span className="sr-only">{row.status.full}</span>
                    </span>
                  </span>
                </span>
                {row.details && <ChevronDown className={styles.chevron} size={16} strokeWidth={1.75} aria-hidden="true" />}
              </button>
              {row.details && isOpen && (
                <div id={detailsId} className={styles.rowDetails}>
                  {row.details}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function PlacesView({ area, items }: { area: string; items: PlaceItem[] }) {
  const { t, lang } = useI18n();
  const token = useContext(MapTokenContext);
  const titleId = useId();
  const p = t.chat.places;
  const rows = useMemo<Row[]>(
    () =>
      items.map((place) => {
        const name = placeName(place.name);
        return {
          id: place.id,
          name,
          address: place.address,
          lat: place.lat,
          lng: place.lng,
          distanceKm: place.distanceKm,
          status: openingStatus(place, t, lang),
          details: (
            <>
              <p className={styles.services}>{openingStatus(place, t, lang).full}</p>
              {place.services.length > 0 && (
                <p className={styles.services} lang="fr">
                  {place.services.slice(0, 4).join(" · ")}
                </p>
              )}
              <a
                className={styles.link}
                href={place.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`${p.sourceLabel(name)} ${t.common.newTab}`}
              >
                {p.source}
                <ExternalLink size={14} strokeWidth={1.75} aria-hidden="true" />
              </a>
            </>
          ),
        };
      }),
    [items, t, lang, p],
  );
  if (!items.length) return null;
  return (
    <section className={styles.panel} aria-labelledby={titleId}>
      <header className={styles.panelHead}>
        <h3 id={titleId} className={styles.title}>
          {p.title(area)}
        </h3>
        <span className={styles.muted}>{p.count(items.length)}</span>
      </header>
      <PlaceBrowser rows={rows} listLabel={p.listLabel(area)} mapToken={token} />
      <p className={styles.note}>{p.note}</p>
    </section>
  );
}

export function AppointmentCard({ link }: { link: AppointmentLink }) {
  const { t, lang } = useI18n();
  const token = useContext(MapTokenContext);
  const a = t.chat.appointments;
  const titleId = useId();
  const service = link.name[lang];
  const rows = useMemo<Row[]>(
    () =>
      (link.places ?? []).map((place) => ({
        id: place.id,
        name: placeName(place.name),
        address: place.address,
        lat: place.lat,
        lng: place.lng,
        distanceKm: place.distanceKm,
        status: {
          text: a.slotsShort(place.slots.days7, place.slots.later),
          full: a.slots(place.slots.days7, place.slots.later),
          tone: place.slots.days7 > 0 ? "open" : "neutral",
        },
      })),
    [link.places, a],
  );
  return (
    <section className={styles.panel} aria-labelledby={titleId}>
      <header className={styles.panelHead}>
        <CalendarCheck size={18} strokeWidth={1.75} aria-hidden="true" className={styles.icon} />
        <h3 id={titleId} className={styles.title}>
          {a.title}
        </h3>
      </header>
      <p className={styles.service}>{service}</p>
      {link.area && <p className={styles.muted}>{a.area(link.area)}</p>}
      {rows.length > 0 && <PlaceBrowser rows={rows} listLabel={a.placesLabel(service)} mapToken={token} />}
      <a className={styles.cta} href={link.url} target="_blank" rel="noopener noreferrer">
        {link.serviceId !== null ? a.button : a.serviceButton}
        <ExternalLink size={16} strokeWidth={1.75} aria-hidden="true" />
        <span className="sr-only"> {t.common.newTab}</span>
      </a>
      <p className={styles.note}>{a.note}</p>
    </section>
  );
}

export function Attachments({ data }: { data?: AttachmentsData }) {
  if (!data) return null;
  return (
    <div className={styles.attachments}>
      {data.appointments?.map((link) => (
        <AppointmentCard key={link.slug} link={link} />
      ))}
      {data.places && <PlacesView area={data.places.area} items={data.places.items} />}
    </div>
  );
}
