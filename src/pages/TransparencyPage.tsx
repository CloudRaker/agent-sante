// Public transparency page: the safety counters only (no content), from /api/stats.
// The costs and the usage are on the costs page (CostsPage.tsx).
import { ArrowLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { MetricCard } from "@/components/arc/metric-card/metric-card";
import { Skeleton } from "@/components/arc/skeleton/skeleton";
import { COUNTERS, type StatsResponse } from "@shared/api";
import { useI18n } from "@/i18n";
import { PAGE_PATHS } from "@/i18n/pages";
import { toolPages } from "@/i18n/tool-pages";
import { getStats } from "@/lib/api";
import { formatDay, localeOf } from "@/lib/format";
import { frenchSpaces, mapStrings } from "@/lib/typography";
import styles from "./page.module.css";

export function TransparencyPage() {
  const { t, lang } = useI18n();
  const c = lang === "fr" ? mapStrings(toolPages.fr.transparency, frenchSpaces) : toolPages.en.transparency;
  const heading = useRef<HTMLHeadingElement>(null);
  const [stats, setStats] = useState<StatsResponse | null | "error">(null);
  const number = new Intl.NumberFormat(localeOf(lang));

  useEffect(() => {
    document.title = `${c.title} | ${t.common.appName}`;
    heading.current?.focus();
  }, [c.title, t.common.appName]);

  useEffect(() => {
    let alive = true;
    getStats().then(
      (s) => alive && setStats(s),
      () => alive && setStats("error"),
    );
    return () => {
      alive = false;
    };
  }, []);

  return (
    <article className={styles.page}>
      <a className={styles.back} href={PAGE_PATHS[lang].home}>
        <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
        {t.common.backToChat}
      </a>
      <header className={styles.head}>
        <h1 ref={heading} tabIndex={-1} className={styles.title}>
          {c.title}
        </h1>
        <p className={styles.lead}>{c.lead}</p>
        <p className={styles.costsLink}>
          <a className={styles.homeLink} href={PAGE_PATHS[lang].costs}>
            {c.costsLink}
          </a>
        </p>
      </header>

      <section className={styles.section} aria-labelledby="totals-title">
        <h2 id="totals-title">{c.totalsTitle}</h2>
        {stats === null ? (
          <Skeleton lines={4} label={c.loading} />
        ) : stats === "error" ? (
          <p>{c.unavailable}</p>
        ) : (
          <>
            <div className={styles.metrics}>
              {COUNTERS.map((k) => (
                <MetricCard
                  key={k}
                  label={c.counters[k].label}
                  value={stats.totals[k]}
                  context={c.counters[k].context}
                  locale={localeOf(lang)}
                />
              ))}
            </div>
          </>
        )}
      </section>

      {stats && stats !== "error" && (
        <section className={styles.section} aria-labelledby="days-title">
          <h2 id="days-title">{c.tableTitle}</h2>
          {stats.days.length === 0 ? (
            <p>{c.empty}</p>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <caption className="sr-only">{c.tableCaption}</caption>
                <thead>
                  <tr>
                    <th scope="col">{c.day}</th>
                    {COUNTERS.map((k) => (
                      <th key={k} scope="col">
                        {c.counters[k].label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {stats.days.map((d) => (
                    <tr key={d.day}>
                      <th scope="row">{formatDay(d.day, lang, false)}</th>
                      {COUNTERS.map((k) => (
                        <td key={k}>{number.format(d.counts[k])}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {/* Stacked phone view: six columns do not fit 390 px, so each day is a short list. */}
              <ul className={styles.dayList}>
                {stats.days.map((d) => (
                  <li key={d.day}>
                    <p className={styles.dayName}>{formatDay(d.day, lang, false)}</p>
                    <dl>
                      {COUNTERS.map((k) => (
                        <div key={k}>
                          <dt>{c.counters[k].label}</dt>
                          <dd>{number.format(d.counts[k])}</dd>
                        </div>
                      ))}
                    </dl>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      <section className={styles.section}>
        <h2>{c.howTitle}</h2>
        {c.how.map((p) => (
          <p key={p}>{p}</p>
        ))}
      </section>
    </article>
  );
}
