import "@testing-library/jest-dom";

// Node-environment suites (server/worker contracts) share this setup file.
if (typeof window === "undefined") {
  // nothing to stub outside a DOM
} else
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  }),
});
