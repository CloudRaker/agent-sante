// Runs before the app: sets the theme and the page language, so the first paint is right.
// It reads only the saved theme, language and text size choices (never conversation data).
(function () {
  var root = document.documentElement;
  var theme = null;
  var lang = null;
  var large = null;
  try {
    theme = localStorage.getItem("agent-sante.theme");
    lang = localStorage.getItem("agent-sante.lang");
    large = localStorage.getItem("agent-sante.large-text");
  } catch {
    // Blocked storage: use the defaults.
  }
  if (theme !== "light" && theme !== "dark") {
    theme = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  root.dataset.theme = theme;
  if (large === "1") root.dataset.text = "large";
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "dark" ? "#08121F" : "#F4F7FC");
  var path = location.pathname;
  var english = path === "/en" || path.indexOf("/en/") === 0;
  // fr-CA is the default. A saved English choice moves the home page to /en.
  if (path === "/" && lang === "en") {
    history.replaceState(null, "", "/en");
    english = true;
  }
  root.lang = english ? "en-CA" : "fr-CA";
})();
