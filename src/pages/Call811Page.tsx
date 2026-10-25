// "Should I call 811?": prepare the call. Orientation only, never medical advice.
// Facts come from Québec.ca and Santé Québec; the "have ready" list is labelled as our own practical list.
import { ArrowLeft, ExternalLink, Phone } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Accordion } from "@/components/arc/accordion/accordion";
import { Alert } from "@/components/arc/alert/alert";
import { Checkbox } from "@/components/arc/checkbox/checkbox";
import { useI18n } from "@/i18n";
import { PAGE_PATHS } from "@/i18n/pages";
import { toolPages, SOURCES_811 } from "@/i18n/tool-pages";
import { frenchSpaces, mapStrings } from "@/lib/typography";
import styles from "./page.module.css";

export function Call811Page() {
  const { t, lang } = useI18n();
  const c = lang === "fr" ? mapStrings(toolPages.fr.call811, frenchSpaces) : toolPages.en.call811;
  const heading = useRef<HTMLHeadingElement>(null);
  const [ready, setReady] = useState<boolean[]>(() => c.ready.map(() => false));
  const done = ready.filter(Boolean).length;

  useEffect(() => {
    document.title = `${c.title} | ${t.common.appName}`;
    heading.current?.focus();
  }, [c.title, t.common.appName]);

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

      <Alert tone="danger" title={c.urgentTitle}>
        {c.urgent}{" "}
        <a href="tel:911" className={styles.inlineCall}>
          911
        </a>
      </Alert>

      <section className={styles.section}>
        <h2>{c.whatTitle}</h2>
        {c.what.map((p) => (
          <p key={p}>{p}</p>
        ))}
      </section>

      <section className={styles.section}>
        <h2>{c.optionsTitle}</h2>
        <Accordion defaultOpen={-1} items={c.options.map((o) => ({ title: o.title, content: <p>{o.text}</p> }))} />
      </section>

      <section className={styles.section}>
        <h2>{c.askTitle}</h2>
        <p>{c.askLead}</p>
        <ul>
          {c.ask.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
        <p className={styles.note}>{c.askNote}</p>
        <p>{c.askThen}</p>
      </section>

      <section className={styles.section} aria-labelledby="ready-title">
        <h2 id="ready-title">{c.readyTitle}</h2>
        <p>{c.readyLead}</p>
        <fieldset className={styles.checklist}>
          <legend className="sr-only">{c.readyTitle}</legend>
          {c.ready.map((item, i) => (
            <Checkbox
              key={item}
              label={item}
              checked={ready[i]}
              onCheckedChange={(v) => setReady((list) => list.map((x, j) => (j === i ? v === true : x)))}
            />
          ))}
        </fieldset>
        <p className={styles.count} aria-live="polite">
          {c.readyCount(done, c.ready.length)}
        </p>
      </section>

      <section className={styles.section}>
        <h2>{c.waitTitle}</h2>
        <ul>
          {c.wait.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      </section>

      <section className={styles.section}>
        <h2>{c.accessTitle}</h2>
        <ul>
          {c.access.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      </section>

      <section className={styles.section}>
        <h2>{c.sourcesTitle}</h2>
        <ul className={styles.links}>
          {c.sources.map((s) => (
            <li key={s.key}>
              <a href={SOURCES_811[s.key as keyof typeof SOURCES_811][lang]} target="_blank" rel="noopener noreferrer">
                {s.label}
                <ExternalLink size={14} strokeWidth={1.75} aria-hidden="true" />
                <span className="sr-only"> {t.common.newTab}</span>
              </a>
            </li>
          ))}
        </ul>
      </section>

      <div className={styles.ctaRow}>
        <a className={styles.cta} href="tel:811">
          <Phone size={18} strokeWidth={1.75} aria-hidden="true" />
          {c.call}
        </a>
        <a className={styles.ctaSecondary} href={PAGE_PATHS[lang].home}>
          {c.back}
        </a>
      </div>
    </article>
  );
}
