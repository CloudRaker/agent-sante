// "What it costs" on the costs and usage page: the fees by category, the averages, and a yearly
// projection for a share of the Info-Santé 811 calls. Sums only, from /api/stats.
// The Worker stores the costs in USD; the site shows CAD only (shared/money.ts).
import { useState } from "react";
import { MetricCard } from "@/components/arc/metric-card/metric-card";
import { Slider } from "@/components/arc/slider/slider";
import { COST_CATEGORIES, type Lang, type StatsResponse } from "@shared/api";
import { cadAffix, cadDecimals, formatCad, toCad } from "@shared/money";
import { CALLS_811_SOURCE, SHARE, averages, projectYear, totalUsd } from "@shared/projection";
import type { toolPages } from "@/i18n/tool-pages";
import { localeOf } from "@/lib/format";
import styles from "./page.module.css";

type Copy = (typeof toolPages)["en"]["costsPage"]["costs"];

export function CostsSection({ costs, lang, c }: { costs: StatsResponse["costs"]; lang: Lang; c: Copy }) {
  const locale = localeOf(lang);
  const [share, setShare] = useState<number>(SHARE.initial);
  const percent = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 });
  /** Props of a metric card for a CAD amount. */
  const money = (cad: number) => ({ ...cadAffix(lang), decimals: cadDecimals(cad), value: cad });

  const sums = costs?.totals;
  const totalUsdValue = sums ? totalUsd(sums) : 0;
  const total = toCad(totalUsdValue);
  const avgUsd = sums ? averages(sums) : { perConversation: null, perMessage: null };
  const perConversation = avgUsd.perConversation === null ? null : toCad(avgUsd.perConversation);
  const perMessage = avgUsd.perMessage === null ? null : toCad(avgUsd.perMessage);
  const projection = perConversation !== null ? projectYear(perConversation, share) : null;

  return (
    <section className={styles.section} aria-labelledby="costs-title">
      <h2 id="costs-title">{c.title}</h2>
      <p>{c.lead}</p>
      {!sums || sums.turns === 0 ? (
        <p>{c.none}</p>
      ) : (
        <>
          <div className={styles.metrics}>
            <MetricCard label={c.total.label} context={c.total.context} locale={locale} {...money(total)} />
            {perConversation !== null && (
              <MetricCard label={c.perConversation.label} context={c.perConversation.context} locale={locale} {...money(perConversation)} />
            )}
            {perMessage !== null && <MetricCard label={c.perMessage.label} context={c.perMessage.context} locale={locale} {...money(perMessage)} />}
          </div>

          <div className={styles.tableWrap}>
            <table className={`${styles.table} ${styles.costTable}`}>
              <caption className="sr-only">{c.tableCaption}</caption>
              <thead>
                <tr>
                  <th scope="col">{c.category}</th>
                  <th scope="col">{c.amount}</th>
                  <th scope="col">{c.share}</th>
                </tr>
              </thead>
              <tbody>
                {COST_CATEGORIES.map((k) => (
                  <tr key={k}>
                    <th scope="row">
                      <span className={styles.costName}>{c.categories[k].label}</span>
                      <span className={styles.costNote}>{c.categories[k].note}</span>
                    </th>
                    <td>{formatCad(toCad(sums.usd[k]), lang)}</td>
                    <td>{totalUsdValue > 0 ? percent.format(sums.usd[k] / totalUsdValue) : "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={styles.updatedInline}>{c.hosting}</p>
        </>
      )}

      <h3 className={styles.subTitle}>{c.projectionTitle}</h3>
      <p>
        {c.projectionLead}{" "}
        <a href={CALLS_811_SOURCE} rel="noopener noreferrer" target="_blank">
          {c.projectionSource}
        </a>
      </p>
      {projection ? (
        <>
          <div className={styles.slider}>
            <Slider
              label={c.shareLabel}
              value={share}
              onValueChange={setShare}
              min={SHARE.min}
              max={SHARE.max}
              step={SHARE.step}
              largeStep={5}
              marks={[
                { value: 1, label: percent.format(0.01) },
                { value: 25, label: percent.format(0.25) },
                { value: 50, label: percent.format(0.5) },
              ]}
              format={(v) => percent.format(v / 100)}
            />
          </div>
          <div className={styles.metrics} aria-live="polite">
            <MetricCard label={c.callsLabel.label} value={projection.conversations} context={c.callsLabel.context} locale={locale} />
            <MetricCard
              label={c.yearLabel.label}
              context={c.yearLabel.context}
              locale={locale}
              {...cadAffix(lang)}
              value={Math.round(projection.cost)}
            />
          </div>
        </>
      ) : (
        <p>{c.projectionNone}</p>
      )}
      <p className={styles.caveat}>{c.caveat}</p>
    </section>
  );
}
