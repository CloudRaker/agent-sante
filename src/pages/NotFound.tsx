import { useEffect, useRef } from "react";
import { Compass } from "lucide-react";
import { EmptyState } from "@/components/arc/empty-state/empty-state";
import { useI18n } from "@/i18n";
import { PAGE_PATHS } from "@/i18n/pages";
import styles from "./page.module.css";

export function NotFound() {
  const { t, lang } = useI18n();
  const heading = useRef<HTMLHeadingElement>(null);

  // Same as the other pages: a title in the page language, and focus on the heading.
  useEffect(() => {
    document.title = `${t.notFound.title} | ${t.common.appName}`;
    heading.current?.focus();
  }, [t.notFound.title, t.common.appName]);

  return (
    <div className={styles.page}>
      <h1 ref={heading} tabIndex={-1} className="sr-only">
        {t.notFound.title}
      </h1>
      <EmptyState
        icon={<Compass size={24} strokeWidth={1.75} />}
        title={t.notFound.title}
        description={t.notFound.text}
        action={
          <a className={styles.homeLink} href={PAGE_PATHS[lang].home}>
            {t.notFound.home}
          </a>
        }
      />
    </div>
  );
}
