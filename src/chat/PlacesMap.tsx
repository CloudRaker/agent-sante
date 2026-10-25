// Map of the places with Apple MapKit JS. It shows above the list when the Worker gives a MapKit
// JS token for this host (wrangler vars MAPKIT_JS_TOKEN and MAPKIT_JS_TOKEN_APEX, one per origin).
// The map gets the positions of the places only, never the position of the person. The list
// stays the accessible main content; the map is an extra (hidden from screen readers).
// The box has a fixed height before MapKit loads, so nothing moves when the map comes in.
// CSP: script-src https://cdn.apple-mapkit.com; connect-src and img-src *.apple-mapkit.com,
// *.geo.apple.com, *.ls.apple.com; worker-src and child-src blob: (worker/index.ts, public/_headers).
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/i18n";
import styles from "./places.module.css";

const SCRIPT = "https://cdn.apple-mapkit.com/mk/5.x.x/mapkit.core.js";

/** One marker on the map. */
export interface MapPoint {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
}

// Minimal types: only what this file uses.
interface Annotation {
  selected: boolean;
  coordinate: unknown;
  addEventListener(type: string, listener: () => void): void;
}
interface MapKitMap {
  showItems(items: unknown[], options?: { animate?: boolean; padding?: unknown }): void;
  setCenterAnimated(coordinate: unknown, animate?: boolean): void;
  destroy(): void;
  colorScheme: string;
}
interface MapKit {
  init(options: { authorizationCallback: (done: (token: string) => void) => void; language?: string }): void;
  Map: new (element: HTMLElement, options?: Record<string, unknown>) => MapKitMap;
  MarkerAnnotation: new (coordinate: unknown, options?: Record<string, unknown>) => Annotation;
  Coordinate: new (lat: number, lng: number) => unknown;
  Padding: new (top: number, right: number, bottom: number, left: number) => unknown;
  addEventListener?(type: string, listener: (event: unknown) => void): void;
}

declare global {
  interface Window {
    mapkit?: MapKit;
    agentSanteMapKitReady?: () => void;
  }
}

let loading: Promise<MapKit> | null = null;

/** Loads MapKit JS once per page and initializes it with the token. */
export function loadMapKit(token: string, language: string): Promise<MapKit> {
  if (loading) return loading;
  loading = new Promise<MapKit>((resolve, reject) => {
    window.agentSanteMapKitReady = () => {
      const mk = window.mapkit;
      if (!mk) return reject(new Error("mapkit_missing"));
      mk.init({ authorizationCallback: (done) => done(token), language });
      mk.addEventListener?.("error", () => reject(new Error("mapkit_auth")));
      resolve(mk);
    };
    const script = document.createElement("script");
    script.src = SCRIPT;
    script.async = true;
    script.crossOrigin = "anonymous";
    script.dataset.callback = "agentSanteMapKitReady";
    script.dataset.libraries = "map,annotations";
    script.addEventListener("error", () => reject(new Error("mapkit_load")));
    document.head.append(script);
  });
  loading.catch(() => {
    loading = null; // A later try can load it again.
  });
  return loading;
}

const scheme = () => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");

export function PlacesMap({
  token,
  points,
  selected,
  onSelect,
}: {
  token: string;
  points: MapPoint[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const mapRef = useRef<MapKitMap | null>(null);
  const markers = useRef(new Map<string, Annotation>());
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    let map: MapKitMap | null = null;
    let cancelled = false;
    loadMapKit(token, t.meta.locale)
      .then((mk) => {
        if (cancelled || !ref.current) return;
        map = new mk.Map(ref.current, { colorScheme: scheme(), showsPointsOfInterest: false, isRotationEnabled: false });
        mapRef.current = map;
        const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#1f4fcc";
        const list = points.map((p, i) => {
          const marker = new mk.MarkerAnnotation(new mk.Coordinate(p.lat, p.lng), {
            title: p.name,
            subtitle: p.address,
            glyphText: String(i + 1),
            color: accent,
            // Names show in the list only. On the map, many labels overlap and become unreadable.
            titleVisibility: "hidden",
            subtitleVisibility: "hidden",
          });
          // A tap on a marker selects the row of the list.
          marker.addEventListener("select", () => onSelectRef.current(p.id));
          markers.current.set(p.id, marker);
          return marker;
        });
        map.showItems(list, { animate: false, padding: new mk.Padding(32, 24, 32, 24) });
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    // The theme can change while the map shows.
    const observer = new MutationObserver(() => {
      if (map) map.colorScheme = scheme();
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const all = markers.current;
    return () => {
      cancelled = true;
      observer.disconnect();
      all.clear();
      mapRef.current = null;
      map?.destroy();
    };
  }, [token, points, t.meta.locale]);

  // A row picked in the list: highlight its marker and bring it to the centre.
  useEffect(() => {
    if (!selected) return;
    const marker = markers.current.get(selected);
    if (!marker || !mapRef.current) return;
    if (!marker.selected) marker.selected = true;
    mapRef.current.setCenterAnimated(marker.coordinate, !window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }, [selected]);

  return (
    <div ref={ref} className={styles.mapCanvas} aria-hidden="true">
      {failed && <p className={styles.mapMessage}>{t.chat.places.mapFailed}</p>}
    </div>
  );
}
