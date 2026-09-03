import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    // Server-side units (billing math, policy gates) are covered too — these
    // are pure modules, so the jsdom environment costs nothing here.
    include: ["src/**/*.{test,spec}.{ts,tsx}", "server/**/*.{test,spec}.ts"],

  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
