// What crawlers and AI assistants see without JavaScript: metadata and static text per app page.
import { describe, expect, it } from "vitest";
import { findPage, jsonLdText, pageMeta } from "../worker/seo";

describe("page metadata", () => {
  it("finds every app page in both languages", () => {
    expect(findPage("/")).toEqual({ lang: "fr", page: "home" });
    expect(findPage("/en/")).toEqual({ lang: "en", page: "home" });
    expect(findPage("/a-propos")).toEqual({ lang: "fr", page: "about" });
    expect(findPage("/en/calling-811")).toEqual({ lang: "en", page: "call811" });
    expect(findPage("/nope")).toBeNull();
  });

  it("gives each page a title, a description, a canonical URL and both language alternates", () => {
    const m = pageMeta("fr", "about");
    expect(m.title).toBe("À propos d'Agent Santé · Agent Santé");
    expect(m.canonical).toBe("https://agentsante.ca/a-propos");
    expect(m.alternates).toEqual({ fr: "https://agentsante.ca/a-propos", en: "https://agentsante.ca/en/about" });
    expect(m.body).toContain("<h1>À propos d'Agent Santé</h1>");
  });

  it("puts the static text of the content pages in the HTML, and none for the live pages", () => {
    expect(pageMeta("fr", "privacy").body).toContain("Vos échanges sont effacés environ 10 minutes après la fin de la conversation.");
    expect(pageMeta("en", "call811").body).toContain("https://www.quebec.ca/en/health/finding-a-resource/info-sante-811");
    expect(pageMeta("fr", "home").body).toBe("");
    expect(pageMeta("fr", "costs").body).toBe("");
  });

  it("describes the site as a free health application by CloudRaker", () => {
    const graph = (pageMeta("fr", "home").jsonLd[0] as { "@graph": { "@type": string; isAccessibleForFree?: boolean }[] })["@graph"];
    expect(graph.map((n) => n["@type"])).toEqual(["Organization", "WebSite", "WebApplication", "WebPage"]);
    expect(graph.find((n) => n["@type"] === "WebApplication")?.isAccessibleForFree).toBe(true);
  });

  it("escapes HTML in the text and in the JSON-LD", () => {
    expect(jsonLdText({ a: "</script>" })).toBe('{"a":"\\u003c/script>"}');
    expect(pageMeta("fr", "terms").body).not.toMatch(/<script/i);
  });
});
