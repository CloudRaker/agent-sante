// A ranked list of counts with a bar each (topics, agents, length and time buckets).
// Arc has no free bar list. The list is the text equivalent: each row says its label, its count
// and its share; the bar is decoration (aria-hidden).
import type { Lang } from "@shared/api";
import { localeOf } from "@/lib/format";
import styles from "./barlist.module.css";

export interface BarItem {
  key: string;
  label: string;
  value: number;
  /** Language of the label, when it is not the page language (an agent name). */
  lang?: Lang;
  /** A short note after the label (the agent language). */
  note?: string;
}

export function BarList({
  items,
  lang,
  label,
  share,
  sort = true,
}: {
  items: BarItem[];
  lang: Lang;
  /** Accessible name of the list. */
  label: string;
  share: (percent: string) => string;
  /** Largest first. False keeps the order (buckets). */
  sort?: boolean;
}) {
  const number = new Intl.NumberFormat(localeOf(lang));
  const percent = new Intl.NumberFormat(localeOf(lang), { style: "percent", maximumFractionDigits: 0 });
  const rows = sort ? items.toSorted((a, b) => b.value - a.value || a.label.localeCompare(b.label)) : items;
  const total = rows.reduce((sum, r) => sum + r.value, 0);
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className={styles.list} aria-label={label}>
      {rows.map((r) => (
        <li key={r.key} className={styles.row}>
          <span className={styles.label}>
            <span lang={r.lang ? localeOf(r.lang) : undefined}>{r.label}</span>
            {r.note && <span className={styles.note}> · {r.note}</span>}
          </span>
          <span className={styles.value}>
            {number.format(r.value)}
            <span className="sr-only"> ({share(percent.format(total > 0 ? r.value / total : 0))})</span>
          </span>
          <span className={styles.track} aria-hidden="true">
            {/* Zero draws no bar at all: an empty track, not a sliver. */}
            {r.value > 0 && <span className={styles.bar} data-some style={{ inlineSize: `${(r.value / max) * 100}%` }} />}
          </span>
        </li>
      ))}
    </ul>
  );
}
