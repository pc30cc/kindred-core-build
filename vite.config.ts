import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiTarget = env.VITE_API_BASE_URL?.trim().replace(/\/+$/, '');

  return {
    server: {
      host: "::",
      port: 8080,
      hmr: {
        overlay: false,
      },
      ...(apiTarget
        ? {
            proxy: {
              '/api': {
                target: apiTarget,
                changeOrigin: true,
                secure: true,
                cookieDomainRewrite: '',
              },
            },
          }
        : {}),
    },
    plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
      dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime", "@tanstack/react-query", "@tanstack/query-core"],
    },
  };
});
