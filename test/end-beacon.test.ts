// End of chat and tab close: the browser ends the session with navigator.sendBeacon.
import { afterEach, describe, expect, it, vi } from "vitest";
import { endSession } from "../src/lib/api";

afterEach(() => vi.unstubAllGlobals());

describe("endSession", () => {
  it("uses sendBeacon with a text/plain body that holds only the token", async () => {
    const beacon = vi.fn<(url: string, body: Blob) => boolean>(() => true);
    vi.stubGlobal("navigator", { sendBeacon: beacon });
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    endSession("tok.en.sig");
    expect(beacon).toHaveBeenCalledOnce();
    const [url, body] = beacon.mock.calls[0]!;
    expect(url).toBe("/api/end");
    expect(body.type).toBe("text/plain");
    expect(JSON.parse(await body.text())).toEqual({ sessionToken: "tok.en.sig" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("falls back to a keepalive fetch when the beacon is refused", () => {
    vi.stubGlobal("navigator", { sendBeacon: () => false });
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal("fetch", fetcher);
    endSession("t");
    expect(fetcher).toHaveBeenCalledWith("/api/end", expect.objectContaining({ keepalive: true, method: "POST" }));
  });
});
