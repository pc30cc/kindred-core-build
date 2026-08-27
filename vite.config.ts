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
                // The Lovable preview renders the app inside a cross-site
                // iframe. The backend issues `gs_session` as SameSite=Lax,
                // and browsers never send a Lax cookie from a third-party
                // frame — so login succeeded while every following request
                // came back 401 "Not authenticated". Re-stamp the cookie as
                // SameSite=None; Secure for the dev proxy ONLY; production
                // keeps its stricter Lax cookie untouched.
                configure: (proxy: any) => {
                  // The backend also runs a CSRF origin check on every
                  // mutating request (POST/PUT/PATCH/DELETE) against
                  // CORS_ORIGINS. The preview's lovableproject.com origin is
                  // not in that list, so POSTs like
                  // /api/visitor-intel/network/batch came back
                  // 403 "Origin not allowed" while GETs worked. Present the
                  // proxied request as coming from the app origin the API
                  // already trusts — dev proxy ONLY, production untouched.
                  const trustedOrigin =
                    env.VITE_PREVIEW_PROXY_ORIGIN?.trim() ||
                    apiTarget.replace('://api.', '://app.');
                  proxy.on('proxyReq', (proxyReq: any) => {
                    proxyReq.setHeader('origin', trustedOrigin);
                    proxyReq.setHeader('referer', `${trustedOrigin}/`);
                  });
                  proxy.on('proxyRes', (proxyRes: any) => {
                    const setCookie = proxyRes.headers['set-cookie'];
                    if (!Array.isArray(setCookie)) return;
                    proxyRes.headers['set-cookie'] = setCookie.map((cookie: string) => {
                      let next = cookie.replace(/;\s*SameSite=(Lax|Strict|None)/gi, '');
                      if (!/;\s*Secure/i.test(next)) next += '; Secure';
                      return `${next}; SameSite=None`;
                    });
                  });
                },

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
