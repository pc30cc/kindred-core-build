import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import fs from "fs";
import { createHash } from "crypto";
import { componentTagger } from "lovable-tagger";

/**
 * Generates dist/sw.js (the PWA service worker) from
 * scripts/pwa/service-worker-template.js at build time, substituting the
 * real hashed asset list for this build and a content-hash build id — see
 * that template file's header comment for why both substitutions matter.
 *
 * Hand-rolled instead of a bundler PWA plugin package: this repo's network
 * policy (in some deployment/dev environments) blocks installing new
 * dependencies from a private registry mirror, so the service worker is
 * built entirely from Node's stdlib (fs/crypto), zero new dependencies.
 * Build-only (`apply: 'build'`) -- no service worker in dev, matching the
 * decision to keep the dev workflow free of stale-cache surprises.
 */
function pwaBuild(): Plugin {
  const PRECACHE_EXT = /\.(js|css|woff2?|ttf|otf|svg|png|jpe?g|webp|ico)$/i;
  return {
    name: "pwa-build",
    apply: "build",
    generateBundle(_options, bundle) {
      const urls: string[] = ["/", "/index.html"];
      for (const fileName of Object.keys(bundle)) {
        if (PRECACHE_EXT.test(fileName)) urls.push(`/${fileName}`);
      }
      urls.sort();

      const templatePath = path.resolve(__dirname, "scripts/pwa/service-worker-template.js");
      const template = fs.readFileSync(templatePath, "utf8");
      const buildId = createHash("sha256").update(urls.join(",")).digest("hex").slice(0, 12);
      const source = template
        .replace(/__BUILD_ID__/g, buildId)
        .replace(/__PRECACHE_URLS__/g, JSON.stringify(urls));

      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}

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
    plugins: [
      react(),
      pwaBuild(),
      mode === "development" && componentTagger(),
      // Dev parity with nginx.conf.template: /widget/* assets (loader,
      // runtime, presentation CSS and its self-hosted font files) are always
      // fetched cross-origin by embedding sites. Fonts additionally require
      // CORS on the file itself, otherwise the shadow-root @font-face is
      // blocked and the widget falls back to a system font in dev only.
      {
        name: 'widget-assets-cors',
        configureServer(server: any) {
          server.middlewares.use((req: any, res: any, next: any) => {
            if (req.url && req.url.startsWith('/widget/')) {
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
            }
            next();
          });
        },
      },
    ].filter(Boolean),

    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
        // Push is native-only; keep the optional Firebase web SDK out of the
        // web bundle (the Capacitor plugin's web fallback imports it statically).
        "firebase/messaging": path.resolve(__dirname, "./src/lib/push/firebaseMessagingWebStub.ts"),
      },
      dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime", "@tanstack/react-query", "@tanstack/query-core"],
    },
  };
});
