import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/app/App";
import { PrefsProvider } from "@/app/prefs";
import { RouterProvider } from "@/app/router";
import "@/styles/app.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider>
      <PrefsProvider>
        <App />
      </PrefsProvider>
    </RouterProvider>
  </StrictMode>,
);
