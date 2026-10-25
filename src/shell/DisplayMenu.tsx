// Display options: dark theme, simple language (FALC) and large text. Arc switch.
// DisplayOptions is the list (in the phone menu); DisplayMenu puts it in an Arc popover (desktop).
import { ALargeSmall } from "lucide-react";
import { Button } from "@/components/arc/button/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/arc/popover/popover";
import { Switch } from "@/components/arc/switch/switch";
import { usePrefs } from "@/app/prefs";
import { useI18n } from "@/i18n";
import type { Theme } from "./theme";
import styles from "./shell.module.css";

export function DisplayOptions({ theme, onTheme, idPrefix }: { theme: Theme; onTheme: (next: Theme) => void; idPrefix: string }) {
  const { t } = useI18n();
  const p = t.prefs;
  const prefs = usePrefs();
  return (
    <div className={styles.prefList}>
      <div className={styles.prefRow}>
        <Switch label={p.dark} checked={theme === "dark"} onCheckedChange={(on) => onTheme(on ? "dark" : "light")} />
      </div>
      <div className={styles.prefRow}>
        <Switch label={p.simple} checked={prefs.simple} onCheckedChange={prefs.setSimple} aria-describedby={`${idPrefix}-simple-hint`} />
        <p id={`${idPrefix}-simple-hint`} className={styles.prefHint}>
          {p.simpleHint}
        </p>
      </div>
      <div className={styles.prefRow}>
        <Switch label={p.large} checked={prefs.largeText} onCheckedChange={prefs.setLargeText} aria-describedby={`${idPrefix}-large-hint`} />
        <p id={`${idPrefix}-large-hint`} className={styles.prefHint}>
          {p.largeHint}
        </p>
      </div>
    </div>
  );
}

export function DisplayMenu({ theme, onTheme }: { theme: Theme; onTheme: (next: Theme) => void }) {
  const { t } = useI18n();
  const prefs = usePrefs();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="md" className={styles.iconButton} aria-label={t.prefs.title} data-on={prefs.simple || prefs.largeText || undefined}>
          <ALargeSmall size={20} strokeWidth={1.75} aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className={styles.prefs} aria-labelledby="prefs-title">
        <h2 id="prefs-title" className={styles.menuTitle}>
          {t.prefs.title}
        </h2>
        <DisplayOptions theme={theme} onTheme={onTheme} idPrefix="pref" />
      </PopoverContent>
    </Popover>
  );
}
