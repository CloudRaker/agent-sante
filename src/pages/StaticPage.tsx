import { ArrowLeft, ExternalLink } from "lucide-react";
import { useEffect, useRef } from "react";
import { useI18n } from "@/i18n";
import { frenchSpaces, mapStrings } from "@/lib/typography";
import { PAGE_PATHS, pages, type PageId } from "@/i18n/pages";
import styles from "./page.module.css";

/** About, privacy and terms. Plain semantic prose: Arc has no article item (see ARC.md). */
export function StaticPage({ id }: { id: PageId }) {
  const { t, lang } = useI18n();
  const page = lang === "fr" ? mapStrings(pages.fr[id], frenchSpaces) : pages.en[id];
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    document.title = `${page.title} | ${t.common.appName}`;
    heading.current?.focus();
  }, [page.title, t.common.appName]);
  return (
    <article className={styles.page}>
      <a className={styles.back} href={PAGE_PATHS[lang].home}>
        <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
        {t.common.backToChat}
      </a>
      <header className={styles.head}>
        <h1 ref={heading} tabIndex={-1} className={styles.title}>
          {page.title}
        </h1>
        <p className={styles.lead}>{page.lead}</p>
        <p className={styles.updated}>
          {pages[lang].updatedLabel}
          {lang === "fr" ? " : " : ": "}
          {page.updated}
        </p>
      </header>
      {page.sections.map((section) => (
        <section key={section.heading} className={styles.section}>
          <h2>{section.heading}</h2>
          {section.paragraphs.map((p) => (
            <p key={p}>{p}</p>
          ))}
          {section.list && (
            <ul>
              {section.list.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
          {section.links && (
            <ul className={styles.links}>
              {section.links.map((link) => (
                <li key={link.href}>
                  <a href={link.href} target="_blank" rel="noopener noreferrer">
                    {link.label}
                    <ExternalLink size={14} strokeWidth={1.75} aria-hidden="true" />
                    <span className="sr-only"> {t.common.newTab}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </article>
  );
}
