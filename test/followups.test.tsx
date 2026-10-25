// @vitest-environment jsdom
// Follow-up links: the agent offers a next step; a click sends it as the person's next message.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { followUpMessage, normalizeFollowUps, stripFollowUps } from "../shared/followups";
import { AssistantReply } from "../src/chat/AssistantReply";
import { I18nProvider } from "../src/i18n";

afterEach(cleanup);

describe("follow-up links", () => {
  it("reads the message from the address, with spaces or encoded, or from the link text", () => {
    const t = normalizeFollowUps("Voir [les pharmacies](agentsante://Trouver les pharmacies près de chez moi) ou [la suite](agentsante://).");
    expect(t).toContain("(agentsante:ask?m=Trouver%20les%20pharmacies%20pr%C3%A8s%20de%20chez%20moi)");
    expect(t).toContain("[la suite](agentsante:ask?m=la%20suite)");
    expect(followUpMessage("agentsante:ask?m=Trouver%20une%20clinique")).toBe("Trouver une clinique");
    expect(followUpMessage("agentsante://Trouver%20une%20clinique")).toBe("Trouver une clinique");
    expect(followUpMessage("https://www.quebec.ca")).toBeNull();
  });

  it("keeps only plain text in the message", () => {
    expect(followUpMessage(`agentsante:ask?m=${encodeURIComponent("**Trouver** <b>x</b>")}`)).toBe("Trouver bx/b");
  });

  it("strips the links for the PDF", () => {
    expect(stripFollowUps("Voir [les pharmacies](agentsante://Trouver les pharmacies).")).toBe("Voir les pharmacies.");
  });

  it("shows an inline button with a chat icon that sends the message", () => {
    const send = vi.fn<(text: string) => void>();
    render(
      <I18nProvider lang="fr">
        <AssistantReply text="Voulez-vous [trouver une pharmacie](agentsante://Trouver les pharmacies près de chez moi) ?" followUp={{ send, disabled: false }} />
      </I18nProvider>,
    );
    const button = screen.getByRole("button", { name: /^Envoyer\s:\sTrouver les pharmacies près de chez moi$/u });
    expect(button.querySelector("svg")).not.toBeNull();
    fireEvent.click(button);
    expect(send).toHaveBeenCalledWith("Trouver les pharmacies près de chez moi");
  });

  it("is plain text when nothing can be sent", () => {
    render(
      <I18nProvider lang="fr">
        <AssistantReply text="[trouver une pharmacie](agentsante://Trouver)" />
      </I18nProvider>,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("trouver une pharmacie")).toBeTruthy();
  });
});
