import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/app/App";
import { PrefsProvider } from "@/app/prefs";
import { RouterProvider } from "@/app/router";
import "@/styles/app.css";

// The service worker keeps the static files and an offline page with the help numbers. Never in dev.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider>
      <PrefsProvider>
        <App />
      </PrefsProvider>
    </RouterProvider>
  </StrictMode>,
);
