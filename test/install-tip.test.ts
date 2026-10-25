// The home screen tip shows only on iPhone and iPad, outside the installed app.
import { describe, expect, it } from "vitest";
import { showInstallTip } from "../src/shell/InstallTip";

const nav = (userAgent: string, extra: Record<string, unknown> = {}) => ({ userAgent, platform: "", maxTouchPoints: 0, ...extra }) as unknown as Navigator;
const win = (standalone: boolean) => ({ matchMedia: () => ({ matches: standalone }) }) as unknown as Window;
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";

describe("home screen tip", () => {
  it("shows on iPhone in the browser", () => expect(showInstallTip(nav(IPHONE), win(false))).toBe(true));
  it("shows on iPad, which reports a Mac with touch", () =>
    expect(showInstallTip(nav("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", { platform: "MacIntel", maxTouchPoints: 5 }), win(false))).toBe(true));
  it("hides inside the installed app", () => {
    expect(showInstallTip(nav(IPHONE, { standalone: true }), win(false))).toBe(false);
    expect(showInstallTip(nav(IPHONE), win(true))).toBe(false);
  });
  it("hides on Android and on a desktop Mac", () => {
    expect(showInstallTip(nav("Mozilla/5.0 (Linux; Android 15; Pixel 9)"), win(false))).toBe(false);
    expect(showInstallTip(nav("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", { platform: "MacIntel" }), win(false))).toBe(false);
  });
});
