// Public costs and usage page: what Agent Santé costs (CAD) and how people use it.
// Sums and counts only, from /api/stats (the StatsCounter Durable Object). No content.
import { ArrowLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { BarChart } from "@/components/arc/bar-chart/bar-chart";
import { Skeleton } from "@/components/arc/skeleton/skeleton";
import { agents } from "@shared/agents";
import { LATENCY_BUCKETS, TOPICS, TURNS_BUCKETS, type Lang, type StatsResponse, type UsageSummary } from "@shared/api";
import { useI18n } from "@/i18n";
import { PAGE_PATHS } from "@/i18n/pages";
import { toolPages } from "@/i18n/tool-pages";
import { getStats } from "@/lib/api";
import { formatDay, localeOf } from "@/lib/format";
import { frenchSpaces, mapStrings } from "@/lib/typography";
import { BarList, type BarItem } from "./BarList";
import { CostsSection } from "./CostsSection";
import styles from "./page.module.css";

type UsageCopy = (typeof toolPages)["en"]["costsPage"]["usage"];

const sum = (values: Record<string, number>) => Object.values(values).reduce((a, b) => a + b, 0);

function UsageSection({ usage, lang, u, topics }: { usage: UsageSummary | undefined; lang: Lang; u: UsageCopy; topics: Record<string, string> }) {
  const number = new Intl.NumberFormat(localeOf(lang));
  const hasData = !!usage && (usage.calls > 0 || usage.perDay.some((d) => d.conversations > 0));
  if (!usage || !hasData) {
    return (
      <section className={styles.section} aria-labelledby="usage-title">
        <h2 id="usage-title">{u.title}</h2>
        <p>{u.none}</p>
      </section>
    );
  }
  const topicItems: BarItem[] = TOPICS.filter((k) => usage.topics[k] > 0).map((k) => ({ key: k, label: topics[k] ?? k, value: usage.topics[k] }));
  const agentItems: BarItem[] = Object.entries(usage.agents)
    .filter(([, n]) => n > 0)
    .map(([id, n]) => {
      const info = agents.get(id);
      const agentLang: Lang = id.startsWith("en/") ? "en" : "fr";
      return {
        key: id,
        label: info?.name ?? id,
        value: n,
        note: agentLang === "fr" ? u.langFr : u.langEn,
        ...(agentLang !== lang ? { lang: agentLang } : {}),
      };
    });
  const turnItems: BarItem[] = TURNS_BUCKETS.map((k) => ({ key: k, label: u.turns[k], value: usage.turns[k] }));
  const latencyItems: BarItem[] = LATENCY_BUCKETS.map((k) => ({ key: k, label: u.latency[k], value: usage.latency[k] }));
  const days = usage.perDay;

  const block = (id: string, title: string, lead: string | null, items: BarItem[], total: number, sort = true) => (
    <div className={styles.usageBlock}>
      <h3 id={id} className={styles.subTitle}>
        {title}
      </h3>
      {lead && <p className={styles.updatedInline}>{lead}</p>}
      {total > 0 ? <BarList items={items} lang={lang} label={title} share={u.share} sort={sort} /> : <p>{u.empty}</p>}
    </div>
  );

  return (
    <section className={styles.section} aria-labelledby="usage-title">
      <h2 id="usage-title">{u.title}</h2>
      {days.length > 0 && (
        <div className={styles.usageBlock}>
          <h3 className={styles.subTitle}>{u.perDayTitle}</h3>
          <BarChart
            data={days.map((d) => ({
              key: d.day,
              label: formatDay(d.day, lang, false),
              axisLabel: String(Number(d.day.slice(8))),
              value: d.conversations,
            }))}
            label={u.perDayLabel}
            period={u.perDayPeriod(formatDay(days[0]!.day, lang, false), formatDay(days.at(-1)!.day, lang, false))}
            averageLabel={u.perDayAverage}
            valueLabel={u.perDayValue}
            categoryLabel={u.perDayCategory}
            formatValue={(v) => number.format(v)}
            text={u.chartText}
          />
        </div>
      )}
      {block("topics-title", u.topicsTitle, u.topicsLead, topicItems, sum(usage.topics))}
      {block("agents-title", u.agentsTitle, u.agentsLead, agentItems, sum(usage.agents))}
      {block("turns-title", u.turnsTitle, u.turnsLead, turnItems, sum(usage.turns), false)}
      {block("latency-title", u.latencyTitle, u.latencyLead, latencyItems, sum(usage.latency), false)}
    </section>
  );
}

export function CostsPage() {
  const { t, lang } = useI18n();
  const c = lang === "fr" ? mapStrings(toolPages.fr.costsPage, frenchSpaces) : toolPages.en.costsPage;
  const heading = useRef<HTMLHeadingElement>(null);
  const [stats, setStats] = useState<StatsResponse | null | "error">(null);

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
      </header>

      {stats === null ? (
        <section className={styles.section}>
          <Skeleton lines={6} label={c.loading} />
        </section>
      ) : stats === "error" ? (
        <section className={styles.section}>
          <p>{c.unavailable}</p>
        </section>
      ) : (
        <>
          <CostsSection costs={stats.costs} lang={lang} c={c.costs} />
          <UsageSection usage={stats.usage} lang={lang} u={c.usage} topics={t.topics} />
        </>
      )}

      <section className={styles.section}>
        <h2>{c.howTitle}</h2>
        {c.how.map((p) => (
          <p key={p}>{p}</p>
        ))}
        <p>
          <a href={PAGE_PATHS[lang].transparency}>{c.transparency}</a>
        </p>
      </section>
    </article>
  );
}
