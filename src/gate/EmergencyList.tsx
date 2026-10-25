import { Phone } from "lucide-react";
import { useI18n } from "@/i18n";
import styles from "./gate.module.css";

/** The help numbers as tel: links. Used in the gate and the ended state. */
export function EmergencyList({ compact = false, headingLevel = 2 }: { compact?: boolean; headingLevel?: 2 | 3 }) {
  const { t } = useI18n();
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <section className={styles.help} data-compact={compact || undefined} aria-labelledby="help-title">
      <Heading id="help-title" className={styles.helpTitle}>
        {t.emergency.title}
      </Heading>
      <ul className={styles.helpList}>
        {t.emergency.lines.map((l) => (
          <li key={l.id}>
            <a className={styles.helpLink} href={`tel:${l.tel}`} data-urgent={l.id === "911" || undefined}>
              <Phone size={16} strokeWidth={1.75} aria-hidden="true" className={styles.helpIcon} />
              <span className={styles.helpText}>
                <span className={styles.helpLabel}>{l.label}</span>
                {!compact && <span className={styles.helpDetail}>{l.detail}</span>}
              </span>
              <span className={styles.helpNumber}>{l.number}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
