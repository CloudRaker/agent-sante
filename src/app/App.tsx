import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Alert } from "@/components/arc/alert/alert";
import { Skeleton } from "@/components/arc/skeleton/skeleton";
import type { ConfigResponse, Lang, SessionResponse } from "@shared/api";
import type { ChatMessage } from "@/components/arc/chat-thread/chat-thread";
import { Chat, type ChatHandle } from "@/chat/Chat";
import { MapTokenContext } from "@/chat/MapToken";
import { Gate } from "@/gate/Gate";
import { Maintenance } from "@/home/Maintenance";
import { I18nProvider, dicts, saveLang } from "@/i18n";
import { getConfig } from "@/lib/api";
import { Header } from "@/shell/Header";
import { applyTheme, currentTheme, type Theme } from "@/shell/theme";
import shell from "@/shell/shell.module.css";
import { parsePath, pathFor, useRouter } from "./router";
import styles from "./app.module.css";

// The chat (Markdown renderer) and the static pages load on demand: the gate paints first.
const StaticPage = lazy(() => import("@/pages/StaticPage").then((m) => ({ default: m.StaticPage })));
const NotFound = lazy(() => import("@/pages/NotFound").then((m) => ({ default: m.NotFound })));
const Call811Page = lazy(() => import("@/pages/Call811Page").then((m) => ({ default: m.Call811Page })));
const TransparencyPage = lazy(() => import("@/pages/TransparencyPage").then((m) => ({ default: m.TransparencyPage })));
const CostsPage = lazy(() => import("@/pages/CostsPage").then((m) => ({ default: m.CostsPage })));
const PressPage = lazy(() => import("@/pages/PressPage").then((m) => ({ default: m.PressPage })));

export function App() {
  const { path, navigate } = useRouter();
  const route = parsePath(path);
  const lang = route.lang;
  const t = dicts[lang];
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [configError, setConfigError] = useState(false);
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [intro, setIntro] = useState<ChatMessage[]>([]);
  const [round, setRound] = useState(0);
  const chat = useRef<ChatHandle>(null);
  const isHome = route.page === "home";

  useEffect(() => {
    getConfig().then(setConfig, () => setConfigError(true));
  }, []);

  useEffect(() => {
    if (isHome) document.title = t.meta.title;
    document.querySelector('meta[name="description"]')?.setAttribute("content", t.meta.description);
  }, [isHome, t]);

  const changeLang = useCallback(
    (next: Lang) => {
      saveLang(next);
      navigate(pathFor({ ...route, lang: next }));
    },
    [navigate, route],
  );

  const onTheme = (next: Theme) => {
    applyTheme(next);
    setTheme(next);
  };

  const startChat = (next: SessionResponse, introMessages: ChatMessage[]) => {
    setIntro(introMessages);
    setSession(next);
  };

  const restart = () => {
    setSession(null);
    setIntro([]);
    setRound((r) => r + 1);
  };

  // The home screen is the conversation (the consent steps are its first messages): one viewport high.
  const chatting = isHome && !config?.maintenance && (!!session || !!config);

  return (
    <I18nProvider lang={lang}>
      <div className={styles.screen} data-chat={chatting || undefined}>
        <a className={shell.skip} href="#main">
          {t.common.skipToMain}
        </a>
        {chatting && session && (
          <a
            className={shell.skip}
            href="#composer"
            onClick={(event) => {
              event.preventDefault();
              chat.current?.focusComposer();
            }}
          >
            {t.common.skipToComposer}
          </a>
        )}
        <Header theme={theme} onTheme={onTheme} onLang={changeLang} />
        <main id="main" tabIndex={-1} className={styles.main}>
          {/* The home screen stays mounted on other pages, so a conversation survives a visit to the privacy page. */}
          <div className={styles.home} hidden={!isHome}>
            {/* The home is the conversation: its title is for screen readers only. */}
            {!config?.maintenance && <h1 className="sr-only">{t.common.appName}</h1>}
            {config?.maintenance ? (
              <div className={styles.gutter}>
                <Maintenance />
              </div>
            ) : session ? (
              /* Loaded with the page, not lazily: the gate hands over to the chat in the same frame, with no blank screen. */
              <MapTokenContext.Provider value={config?.mapkitToken ?? null}>
                <Chat key={round} handle={chat} session={session} intro={intro} onLanguage={changeLang} onRestart={restart} />
              </MapTokenContext.Provider>
            ) : config ? (
              <Gate key={round} siteKey={config.turnstileSiteKey} theme={theme} onStarted={startChat} />
            ) : configError ? (
              <div className={styles.gutter}>
                <div className={styles.loading}>
                  <Alert tone="warning" title={t.gate.confirm.startFailed} />
                </div>
              </div>
            ) : (
              <div className={styles.gutter}>
                <div className={styles.loading}>
                  <Skeleton lines={5} label={t.gate.confirm.humanWait} />
                </div>
              </div>
            )}
          </div>
          <Suspense fallback={null}>
            {route.page === "about" || route.page === "privacy" || route.page === "terms" ? (
              <div className={styles.gutter}>
                <StaticPage id={route.page} />
              </div>
            ) : route.page === "call811" ? (
              <div className={styles.gutter}>
                <Call811Page />
              </div>
            ) : route.page === "transparency" ? (
              <div className={styles.gutter}>
                <TransparencyPage />
              </div>
            ) : route.page === "costs" ? (
              <div className={styles.gutter}>
                <CostsPage />
              </div>
            ) : route.page === "press" ? (
              <div className={styles.gutter}>
                <PressPage />
              </div>
            ) : route.page === "notFound" ? (
              <div className={styles.gutter}>
                <NotFound />
              </div>
            ) : null}
          </Suspense>
        </main>
      </div>
    </I18nProvider>
  );
}
