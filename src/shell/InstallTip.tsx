// Home screen tip for iPhone and iPad. iOS has no install prompt: the person adds the app with
// Share, then "Add to Home Screen". Shown only on iOS, and never inside the installed app.
import { Share, SquarePlus } from "lucide-react";
import { useI18n } from "@/i18n";
import styles from "./shell.module.css";

/** True on iPhone and iPad (iPadOS reports a Mac with touch), outside the installed app. */
export function showInstallTip(nav: Navigator = navigator, win: Window = window): boolean {
  const ios = /iPhone|iPad|iPod/.test(nav.userAgent) || (nav.platform === "MacIntel" && nav.maxTouchPoints > 1);
  const installed = (nav as Navigator & { standalone?: boolean }).standalone === true || win.matchMedia?.("(display-mode: standalone)").matches === true;
  return ios && !installed;
}

export function InstallTip() {
  const { t } = useI18n();
  if (typeof navigator === "undefined" || !showInstallTip()) return null;
  return (
    <section className={styles.drawerSection} aria-labelledby="install-title">
      <h2 id="install-title" className={styles.menuGroupTitle}>
        {t.install.title}
      </h2>
      <div className={styles.installTip}>
        <img src="/icons/icon-192.png" alt="" width={40} height={40} className={styles.installIcon} />
        <p className={styles.installText}>
          {t.install.before}
          <Share size={16} strokeWidth={1.75} aria-hidden="true" className={styles.installGlyph} />
          <span className="sr-only">{t.install.shareName}</span>
          {t.install.middle}
          <SquarePlus size={16} strokeWidth={1.75} aria-hidden="true" className={styles.installGlyph} />
          {t.install.after}
        </p>
      </div>
    </section>
  );
}
