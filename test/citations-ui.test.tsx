// @vitest-environment jsdom
// The official quote card: plain text only, line breaks kept, accessible blockquote with cite.
import { cleanup, fireEvent, render } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it } from "vitest";
import { AssistantReply, splitCitations } from "../src/chat/AssistantReply";
import { I18nProvider } from "../src/i18n";
import type { Citation } from "../shared/api";

afterEach(cleanup);

const SRC = "https://www.quebec.ca/sante/conseils-et-prevention/fievre-enfant";

function show(text: string, citations: Citation[], lang: "fr" | "en" = "fr") {
  return render(
    <I18nProvider lang={lang}>
      <AssistantReply text={text} meta={{ sources: [], citations }} />
    </I18nProvider>,
  );
}

describe("citation card", () => {
  it("renders the exact text as plain text, with its label, line breaks and source link", async () => {
    const citation: Citation = {
      src: SRC,
      text: "Ligne 1 <b>pas gras</b>\nLigne 2 <script>alert(1)</script>",
      verified: true,
      retrieved: "2026-10-23",
    };
    const { container } = show("Avant.\n\n[[citation:0]]\n\nAprès.", [citation]);
    const quote = container.querySelector("blockquote");
    expect(quote?.textContent).toBe(citation.text);
    expect(quote?.getAttribute("cite")).toBe(SRC);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("blockquote b")).toBeNull();
    expect(container.querySelector("figcaption")?.textContent).toContain("Extrait officiel");
    const link = container.querySelector(`figure a[href="${SRC}"]`);
    expect(link?.textContent).toContain("quebec.ca");
    expect(link?.getAttribute("rel")).toContain("noopener");
    // Order: text, card, text.
    const parts = Array.from(container.querySelectorAll("figure, p")).map((n) => n.textContent ?? "");
    expect(parts.findIndex((t) => t.includes("Avant"))).toBeLessThan(parts.findIndex((t) => t.includes("Ligne 1")));
    const result = await axe.run(container, { rules: { "color-contrast": { enabled: false } }, resultTypes: ["violations"] });
    expect(result.violations.map((v) => v.id)).toEqual([]);
  });

  it("uses the English label", () => {
    const { container } = show("[[citation:0]]", [{ src: SRC, text: "Official text here.", verified: true }], "en");
    expect(container.querySelector("figcaption")?.textContent).toContain("Official excerpt");
  });

  it("a marker with no citation shows nothing, and each citation shows once", () => {
    const parts = splitCitations("A\n[[citation:0]]\n[[citation:0]]\n[[citation:5]]\nB", [{ src: SRC, text: "x", verified: true }]);
    expect(parts.map((p) => p.kind)).toEqual(["text", "citation", "text"]);
  });

  it("a non-official source shows as text, not as a link", () => {
    const { container } = show("[[citation:0]]", [{ src: "https://example.com/a", text: "Texte.", verified: true }]);
    expect(container.querySelector("figure a")).toBeNull();
    expect(container.querySelector("blockquote")?.hasAttribute("cite")).toBe(false);
  });
});

describe("translated citation card", () => {
  const FR = "En cas de doute, appelez Info-Santé 811 avant de vous rendre à l'urgence.";
  const EN = "When in doubt, call Info-Santé 811 before you go to the emergency room.";
  const translated: Citation = { src: SRC, text: FR, verified: true, lang: "fr", translation: { text: EN, lang: "en" } };

  it("shows the translation first with its label, then the original in a disclosure, each with its lang", async () => {
    const { container, getByRole } = show("Here is the official text.\n\n[[citation:0]]", [translated], "en");
    expect(container.querySelector("figcaption")?.textContent).toContain("Machine translation of official text");
    const quotes = Array.from(container.querySelectorAll("blockquote"));
    expect(quotes.map((q) => q.textContent)).toEqual([EN, FR]);
    expect(quotes.map((q) => q.getAttribute("lang"))).toEqual(["en", "fr"]);
    // Only the original carries the cite address: it is the official text.
    expect(quotes[0]?.hasAttribute("cite")).toBe(false);
    expect(quotes[1]?.getAttribute("cite")).toBe(SRC);
    const trigger = getByRole("button", { name: "Original text (French)" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(`figure a[href="${SRC}"]`)).not.toBeNull();
    const result = await axe.run(container, { rules: { "color-contrast": { enabled: false } }, resultTypes: ["violations"] });
    expect(result.violations.map((v) => v.id)).toEqual([]);
  });

  it("uses the French labels for an English quote in a French conversation", () => {
    const citation: Citation = { src: SRC, text: EN, verified: true, lang: "en", translation: { text: FR, lang: "fr" } };
    const { container, getByRole } = show("[[citation:0]]", [citation], "fr");
    expect(container.querySelector("figcaption")?.textContent).toContain("Traduction automatique d'un texte officiel");
    expect(getByRole("button", { name: "Texte original (anglais)" })).toBeTruthy();
    expect(Array.from(container.querySelectorAll("blockquote")).map((q) => q.getAttribute("lang"))).toEqual(["fr", "en"]);
  });

  it("untranslated: the original only, with its lang and the note", () => {
    const { container, queryByRole } = show(
      "[[citation:0]]",
      [{ src: SRC, text: FR, verified: true, lang: "fr", untranslated: true }],
      "en",
    );
    const quotes = container.querySelectorAll("blockquote");
    expect(quotes).toHaveLength(1);
    expect(quotes[0]?.getAttribute("lang")).toBe("fr");
    expect(container.textContent).toContain("Text available in French only");
    expect(container.querySelector("figcaption")?.textContent).toContain("Official excerpt");
    expect(queryByRole("button")).toBeNull();
  });

  it("a quote in the conversation language has that lang and no note", () => {
    const { container } = show("[[citation:0]]", [{ src: SRC, text: FR, verified: true, lang: "fr" }], "fr");
    expect(container.querySelector("blockquote")?.getAttribute("lang")).toBe("fr");
    expect(container.textContent).not.toContain("seulement");
  });
});
