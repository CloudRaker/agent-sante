// Navigation bar: the brand, two menus (help numbers, project pages and source code), the
// language and the display options. On a phone they all move into one menu drawer.
// Arc popover (desktop menus), Arc drawer (phone menu), Arc segmented control, Arc button.
import { ChevronDown, ExternalLink, Menu, MessageCircleHeart, Phone } from "lucide-react";
import { Button } from "@/components/arc/button/button";
import { Drawer, DrawerContent, DrawerTrigger } from "@/components/arc/drawer/drawer";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/arc/popover/popover";
import SegmentedControl from "@/components/arc/segmented-control/segmented-control";
import type { Lang } from "@shared/api";
import { useI18n } from "@/i18n";
import { LINKS, PAGE_PATHS, pages } from "@/i18n/pages";
import { DisplayMenu, DisplayOptions } from "./DisplayMenu";
import { InstallTip } from "./InstallTip";
import type { Theme } from "./theme";
import styles from "./shell.module.css";

interface NavLink {
  label: string;
  href: string;
  detail?: string;
  /** Opens in a new tab: the conversation lives only in this page. */
  external?: boolean;
  urgent?: boolean;
}

function useNavGroups(): { help: NavLink[]; project: NavLink[]; source: NavLink[] } {
  const { t, lang } = useI18n();
  const paths = PAGE_PATHS[lang];
  return {
    help: t.emergency.lines.map((l) => ({ label: l.label, detail: l.number, href: `tel:${l.tel}`, urgent: l.id === "911" })),
    project: [
      { label: t.nav.call811, href: paths.call811, external: true },
      { label: pages[lang].about.title, href: paths.about, external: true },
      { label: t.nav.transparency, href: paths.transparency, external: true },
      { label: t.nav.costs, href: paths.costs, external: true },
      { label: t.nav.press, href: paths.press, external: true },
      { label: pages[lang].privacy.title, href: paths.privacy, external: true },
      { label: pages[lang].terms.title, href: paths.terms, external: true },
    ],
    source: [
      { label: t.footer.webRepo, href: LINKS.webRepo, external: true },
      { label: t.footer.agentsRepo, href: LINKS.agentsRepo, external: true },
    ],
  };
}

function LinkList({ links, label }: { links: NavLink[]; label?: string }) {
  const { t } = useI18n();
  return (
    <ul className={styles.linkList} aria-label={label}>
      {links.map((l) => (
        <li key={l.href}>
          <a
            className={styles.menuLink}
            data-urgent={l.urgent || undefined}
            href={l.href}
            {...(l.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
          >
            {l.href.startsWith("tel:") && <Phone size={16} strokeWidth={1.75} aria-hidden="true" className={styles.menuIcon} />}
            <span className={styles.menuLabel}>{l.label}</span>
            {l.detail && <span className={styles.menuDetail}>{l.detail}</span>}
            {l.external && (
              <>
                <ExternalLink size={14} strokeWidth={1.75} aria-hidden="true" className={styles.menuIcon} />
                <span className="sr-only"> {t.common.newTab}</span>
              </>
            )}
          </a>
        </li>
      ))}
    </ul>
  );
}

function NavMenu({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="md" className={styles.navTrigger}>
          {label}
          <ChevronDown size={16} strokeWidth={1.75} aria-hidden="true" className={styles.chevron} />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className={styles.menuPanel}>
        {children}
      </PopoverContent>
    </Popover>
  );
}

export function Header({ theme, onTheme, onLang }: { theme: Theme; onTheme: (next: Theme) => void; onLang: (lang: Lang) => void }) {
  const { t, lang } = useI18n();
  const groups = useNavGroups();
  const language = (
    <SegmentedControl
      label={t.common.languageLabel}
      value={lang}
      onValueChange={(value) => onLang(value as Lang)}
      options={[
        { value: "fr", label: "Français", lang: "fr-CA" },
        { value: "en", label: "English", lang: "en-CA" },
      ]}
    />
  );
  return (
    <header className={styles.header}>
      <a className={styles.brand} href={PAGE_PATHS[lang].home} aria-label={t.common.homeLink}>
        <MessageCircleHeart size={24} strokeWidth={1.75} aria-hidden="true" className={styles.mark} />
        <span className={styles.brandName}>{t.common.appName}</span>
      </a>

      {/* Wide screens: menus and tools in the bar. */}
      <nav className={styles.navWide} aria-label={t.nav.label}>
        <NavMenu label={t.nav.help}>
          <LinkList links={groups.help} label={t.nav.help} />
        </NavMenu>
        <NavMenu label={t.nav.project}>
          <LinkList links={groups.project} label={t.nav.project} />
          <p className={styles.menuGroupTitle}>{t.nav.source}</p>
          <LinkList links={groups.source} label={t.nav.source} />
        </NavMenu>
      </nav>
      <div className={styles.toolsWide}>
        {language}
        <DisplayMenu theme={theme} onTheme={onTheme} />
      </div>

      {/* Phones: one menu button opens a drawer with everything. */}
      <Drawer>
        <DrawerTrigger asChild>
          <Button variant="ghost" size="md" className={`${styles.iconButton} ${styles.menuButton}`} aria-label={t.nav.menuOpen}>
            <Menu size={22} strokeWidth={1.75} aria-hidden="true" />
          </Button>
        </DrawerTrigger>
        <DrawerContent side="right" title={t.nav.menu} className={styles.drawer}>
          <nav className={styles.drawerBody} aria-label={t.nav.label}>
            <InstallTip />
            <section className={styles.drawerSection}>
              <h2 className={styles.menuGroupTitle}>{t.common.languageLabel}</h2>
              {language}
            </section>
            <section className={styles.drawerSection}>
              <h2 className={styles.menuGroupTitle}>{t.nav.help}</h2>
              <LinkList links={groups.help} />
            </section>
            <section className={styles.drawerSection}>
              <h2 className={styles.menuGroupTitle}>{t.nav.display}</h2>
              <DisplayOptions theme={theme} onTheme={onTheme} idPrefix="drawer-pref" />
            </section>
            <section className={styles.drawerSection}>
              <h2 className={styles.menuGroupTitle}>{t.nav.project}</h2>
              <LinkList links={groups.project} />
            </section>
            <section className={styles.drawerSection}>
              <h2 className={styles.menuGroupTitle}>{t.nav.source}</h2>
              <LinkList links={groups.source} />
            </section>
            <p className={styles.drawerNote}>{t.footer.tagline}</p>
          </nav>
        </DrawerContent>
      </Drawer>
    </header>
  );
}
