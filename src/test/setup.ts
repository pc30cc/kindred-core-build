import "@testing-library/jest-dom";
import { transferableAbortController } from "node:util";

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

// jsdom puts its own AbortController in place of Node's, and Node 24's fetch
// (undici 7) takes no AbortSignal but Node's: server code that gives fetch a
// signal (server/services/widget/manifest.ts) threw "Expected signal to be an
// instance of AbortSignal" under jsdom (Node 22's undici took either). fetch
// gets a Node signal that aborts with the caller's.
if (typeof window !== "undefined") {
  const nodeFetch = globalThis.fetch;
  const NodeAbortSignal = transferableAbortController().signal.constructor;
  globalThis.fetch = ((input, init) => {
    const signal = init?.signal;
    if (!signal || signal instanceof NodeAbortSignal) return nodeFetch(input, init);
    const follower = transferableAbortController();
    if (signal.aborted) follower.abort(signal.reason);
    else signal.addEventListener("abort", () => follower.abort(signal.reason), { once: true });
    return nodeFetch(input, { ...init, signal: follower.signal });
  }) as typeof fetch;
}
