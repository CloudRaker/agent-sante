// Press kit: facts, architecture diagram (inline SVG on theme tokens, so it follows light and dark),
// data flow, the logo and a contact. No open letter.
import { ArrowLeft, Download } from "lucide-react";
import { useEffect, useRef } from "react";
import { useI18n } from "@/i18n";
import { PAGE_PATHS } from "@/i18n/pages";
import { toolPages, PRESS_EMAIL, type ToolPages } from "@/i18n/tool-pages";
import { frenchSpaces, mapStrings } from "@/lib/typography";
import styles from "./page.module.css";

type Nodes = ToolPages["press"]["nodes"];

/** One node of the diagram. */
function box(x: number, y: number, w: number, label: string, note: string, accent = false) {
return (
  <g>
    <rect x={x} y={y} width={w} height={52} rx={10} className={accent ? styles.dNodeAccent : styles.dNode} />
    <text x={x + w / 2} y={y + 22} textAnchor="middle" className={styles.dLabel}>
      {label}
    </text>
    <text x={x + w / 2} y={y + 39} textAnchor="middle" className={styles.dNote}>
      {note}
    </text>
  </g>
);
}

/** Vertical flow, so it reads at phone width. Colors come from CSS tokens (page.module.css .diagram). */
function Architecture({ n, title, desc }: { n: Nodes; title: string; desc: string }) {
  return (
    // An inline SVG needs role="img" with its title and desc to be read as one image.
    // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
    <svg className={styles.diagram} viewBox="0 0 400 430" role="img" aria-labelledby="arch-title" aria-describedby="arch-desc">
      <title id="arch-title">{title}</title>
      <desc id="arch-desc">{desc}</desc>
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" className={styles.dHead} />
        </marker>
      </defs>
      {/* Montréal region */}
      <rect x={226} y={110} width={166} height={142} rx={14} className={styles.dRegion} />
      {/* Browser */}
      {box(20, 12, 190, n.browser, n.browserNote)}
      {/* Worker */}
      {box(20, 120, 190, n.worker, n.workerNote)}
      {/* milliseconds */}
      {box(236, 148, 146, n.ms, n.msNote, true)}
      {/* Run and models */}
      {box(20, 252, 190, n.run, n.runNote)}
      {box(20, 362, 190, n.models, n.modelsNote)}
      {/* 1. message down */}
      <line x1={60} y1={66} x2={60} y2={116} className={styles.dLine} markerEnd="url(#arrow)" />
      <text x={66} y={96} className={styles.dStep}>
        {n.step1}
      </text>
      {/* 5. checked reply up */}
      <line x1={170} y1={118} x2={170} y2={68} className={styles.dLineAccent} markerEnd="url(#arrow)" />
      <text x={176} y={96} className={styles.dStep}>
        {n.step5}
      </text>
      {/* 2 and 4: checks */}
      <line x1={212} y1={160} x2={232} y2={160} className={styles.dLine} markerEnd="url(#arrow)" />
      <line x1={232} y1={186} x2={212} y2={186} className={styles.dLine} markerEnd="url(#arrow)" />
      <text x={309} y={222} textAnchor="middle" className={styles.dStep}>
        {n.step2}
      </text>
      <text x={309} y={238} textAnchor="middle" className={styles.dStep}>
        {n.step4}
      </text>
      {/* 3. clean message to Run, and back */}
      <line x1={60} y1={174} x2={60} y2={248} className={styles.dLine} markerEnd="url(#arrow)" />
      <line x1={170} y1={248} x2={170} y2={176} className={styles.dLine} markerEnd="url(#arrow)" />
      <text x={66} y={216} className={styles.dStep}>
        {n.step3}
      </text>
      {/* Run to models */}
      <line x1={115} y1={306} x2={115} y2={358} className={styles.dLine} markerEnd="url(#arrow)" markerStart="url(#arrow)" />
    </svg>
  );
}

function Bullets({ items }: { items: readonly string[] }) {
  return (
    <ul>
      {items.map((i) => (
        <li key={i}>{i}</li>
      ))}
    </ul>
  );
}

export function PressPage() {
  const { t, lang } = useI18n();
  const c = lang === "fr" ? mapStrings(toolPages.fr.press, frenchSpaces) : toolPages.en.press;
  const heading = useRef<HTMLHeadingElement>(null);

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

      <section className={styles.section}>
        <h2>{c.factsTitle}</h2>
        <Bullets items={c.facts} />
      </section>

      <section className={styles.section}>
        <h2>{c.diagramTitle}</h2>
        <figure className={styles.figure}>
          <Architecture n={c.nodes} title={c.diagramTitle} desc={c.diagramDesc} />
          <figcaption>{c.diagramDesc}</figcaption>
        </figure>
      </section>

      <section className={styles.section}>
        <h2>{c.flowTitle}</h2>
        <div className={styles.flow}>
          <div className={styles.flowCard} data-tone="accent">
            <h3>{c.montrealTitle}</h3>
            <Bullets items={c.montreal} />
          </div>
          <div className={styles.flowCard}>
            <h3>{c.modelsTitle}</h3>
            <Bullets items={c.models} />
          </div>
          <div className={styles.flowCard}>
            <h3>{c.nowhereTitle}</h3>
            <Bullets items={c.nowhere} />
          </div>
        </div>
      </section>

      <section className={styles.section}>
        <h2>{c.logosTitle}</h2>
        <div className={styles.logo}>
          <img src="/favicon.svg" alt="" width={56} height={56} />
          <div>
            <a href="/favicon.svg" download="agent-sante-symbole.svg" className={styles.download}>
              <Download size={16} strokeWidth={1.75} aria-hidden="true" />
              {c.logoAgent}
            </a>
            <p className={styles.count}>{c.logoNote}</p>
          </div>
        </div>
      </section>

      <section className={styles.section}>
        <h2>{c.contactTitle}</h2>
        <p>{c.contact}</p>
        <p>
          <a href={`mailto:${PRESS_EMAIL}`}>{PRESS_EMAIL}</a>
        </p>
      </section>
    </article>
  );
}
