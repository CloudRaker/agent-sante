// Browser APIs that jsdom lacks. Only applied in the jsdom environment.
if (typeof window !== "undefined") {
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  const w = window as unknown as Record<string, unknown>;
  w.ResizeObserver ??= RO;
  w.IntersectionObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  window.scrollTo = () => {};
  Element.prototype.scrollTo = function () {};
  Element.prototype.scrollIntoView = function () {};
}
