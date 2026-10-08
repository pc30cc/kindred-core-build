import { defineConfig, loadEnv, type HtmlTagDescriptor, type Plugin, type HttpProxy, type ViteDevServer } from "vite";
import type { IncomingMessage, ServerResponse } from "http";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import fs from "fs";
import { createHash } from "crypto";
import { componentTagger } from "lovable-tagger";
import { vendorChunk } from "./scripts/build/vendorChunks.mjs";
import { precompressFiles } from "./scripts/build/precompress.mjs";

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
 *
 * What is precached at install: the app's CORE only — the entry script and
 * everything it imports statically (frame, providers, vendor files), all
 * stylesheets, the locale files, and fonts/images up to PRECACHE_MAX_ASSET
 * bytes. That is what any screen needs to start, offline included. Page
 * files (one per page since src/App.tsx splits them) are NOT precached:
 * downloading all ~150 of them on a first visit would compete with the
 * pages actually being opened. They are listed separately (LAZY_URLS): the
 * worker caches each one the first time it is fetched (cache-first under
 * /assets/), and once a signed-in user's app is idle it fetches the rest of
 * that list in the background (warmServiceWorkerCache, src/lib/perf/prefetch.ts).
 * That keeps a tab open across a deploy able to open its own build's pages.
 */
function pwaBuild(): Plugin {
  const ASSET_EXT = /\.(woff2?|ttf|otf|svg|png|jpe?g|webp|ico)$/i;
  const PRECACHE_MAX_ASSET = 256 * 1024;
  const LOCALE_MODULE = /\/src\/i18n\/locales\/[a-z]{2}\.ts$/;
  return {
    name: "pwa-build",
    apply: "build",
    generateBundle(_options, bundle) {
      const core = new Set<string>();
      const addWithImports = (fileName: string) => {
        if (core.has(fileName)) return;
        const output = bundle[fileName];
        if (!output || output.type !== "chunk") return;
        core.add(fileName);
        for (const imported of output.imports) addWithImports(imported);
      };
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        if (output.isEntry) addWithImports(output.fileName);
        else if (output.facadeModuleId && LOCALE_MODULE.test(output.facadeModuleId)) addWithImports(output.fileName);
      }

      const urls: string[] = ["/", "/index.html"];
      const lazyUrls: string[] = [];
      for (const output of Object.values(bundle)) {
        const { fileName } = output;
        if (output.type === "chunk") {
          (core.has(fileName) ? urls : lazyUrls).push(`/${fileName}`);
        } else if (fileName.endsWith(".css")) {
          urls.push(`/${fileName}`);
        } else if (ASSET_EXT.test(fileName)) {
          const size = typeof output.source === "string" ? output.source.length : output.source.byteLength;
          if (size <= PRECACHE_MAX_ASSET) urls.push(`/${fileName}`);
        }
      }
      urls.sort();
      lazyUrls.sort();

      // The build id covers EVERY emitted file, not only the precached ones:
      // sw.js must change whenever any page file does, or browsers would keep
      // the old worker (and its cache name) across a deploy.
      const allFiles = Object.keys(bundle).sort();
      const templatePath = path.resolve(__dirname, "scripts/pwa/service-worker-template.js");
      const template = fs.readFileSync(templatePath, "utf8");
      const buildId = createHash("sha256").update(allFiles.join(",")).digest("hex").slice(0, 12);
      const source = template
        .replace(/__BUILD_ID__/g, buildId)
        .replace(/__PRECACHE_URLS__/g, JSON.stringify(urls))
        .replace(/__LAZY_URLS__/g, JSON.stringify(lazyUrls));

      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}

/**
 * Build-only <head> hints, which need this build's hashed file names:
 *  - preload of the IRANSans files every screen draws with (regular, medium,
 *    bold — src/index.css). Without it the browser only discovers them once
 *    React has rendered text, so the first frame shows the fallback font and
 *    then jumps;
 *  - modulepreload of the locale file the app is about to load (src/main.tsx
 *    awaits it before the first render). Without it that request only starts
 *    after the whole entry script has downloaded and run. The choice mirrors
 *    getStoredLocale() in src/i18n/index.tsx. The small script that picks it
 *    goes right after runtime-config.js (it reads the default locale from
 *    there), ahead of the stylesheet: an inline script after a stylesheet
 *    waits for that stylesheet to download, and so would the preload.
 */
const RUNTIME_CONFIG_TAG = '<script src="/runtime-config.js"></script>';

function bootHints(): Plugin {
  const PRELOAD_FONT = /^assets\/iransans-(?:400|500|700)-[\w-]+\.woff2$/;
  const LOCALE_MODULE = /\/src\/i18n\/locales\/([a-z]{2})\.ts$/;
  return {
    name: "boot-hints",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        const bundle = ctx.bundle;
        if (!bundle) return html;
        const locales: Record<string, string> = {};
        const fonts: string[] = [];
        for (const output of Object.values(bundle)) {
          if (output.type === "chunk") {
            const match = output.facadeModuleId ? LOCALE_MODULE.exec(output.facadeModuleId) : null;
            if (match) locales[match[1]] = `/${output.fileName}`;
          } else if (PRELOAD_FONT.test(output.fileName)) {
            fonts.push(`/${output.fileName}`);
          }
        }
        const tags: HtmlTagDescriptor[] = fonts.sort().map((href) => ({
          tag: "link",
          attrs: { rel: "preload", as: "font", type: "font/woff2", href, crossorigin: "" },
          injectTo: "head",
        }));
        if (Object.keys(locales).length > 0) {
          const script =
            "(function(){try{var m=" + JSON.stringify(locales) + ",ok={en:1,fa:1,tr:1},l=null;" +
            "try{l=localStorage.getItem('app-locale')}catch(e){}" +
            "if(!ok[l]){var c=window.Capacitor,n=!!(c&&(c.isNativePlatform?c.isNativePlatform():c.isNative));" +
            "var d=(window.__APP_RUNTIME_CONFIG__||{}).defaultLocale;l=n?'en':(ok[d]?d:'en')}" +
            "if(m[l]){var k=document.createElement('link');k.rel='modulepreload';k.href=m[l];k.crossOrigin='';document.head.appendChild(k)}" +
            "}catch(e){}})();";
          if (html.includes(RUNTIME_CONFIG_TAG)) {
            html = html.replace(RUNTIME_CONFIG_TAG, () => `${RUNTIME_CONFIG_TAG}\n    <script>${script}</script>`);
          } else {
            tags.push({ tag: "script", injectTo: "head-prepend", children: script });
          }
        }
        return { html, tags };
      },
    },
  };
}

/** gzip copies of the build output for nginx's gzip_static (scripts/build/precompress.mjs). */
function precompress(): Plugin {
  return {
    name: "precompress",
    apply: "build",
    async writeBundle(options, bundle) {
      const outDir = options.dir ?? path.resolve(__dirname, "dist");
      const files = Object.keys(bundle)
        .filter((fileName) => fileName.startsWith("assets/"))
        .map((fileName) => path.join(outDir, fileName));
      const { written, rawBytes, gzipBytes } = await precompressFiles(files);
      this.info(`gzip: ${written} files, ${(rawBytes / 1024).toFixed(0)} KB -> ${(gzipBytes / 1024).toFixed(0)} KB`);
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // Preview/dev only: when VITE_API_BASE_URL is empty (same-origin build),
  // there is no local Express to answer /api, so login 404s inside the
  // Lovable preview while the deployed site works through nginx. Fall back
  // to VITE_DEV_API_PROXY_TARGET so the dev server proxies /api to the real
  // backend. Never affects production bundles (proxy is dev-server only).
  const apiTarget = (env.VITE_API_BASE_URL?.trim() || env.VITE_DEV_API_PROXY_TARGET?.trim() || '').replace(/\/+$/, '');

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
                configure: (proxy: HttpProxy.Server) => {
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
                  proxy.on('proxyReq', (proxyReq) => {
                    proxyReq.setHeader('origin', trustedOrigin);
                    proxyReq.setHeader('referer', `${trustedOrigin}/`);
                  });
                  proxy.on('proxyRes', (proxyRes) => {
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
      bootHints(),
      precompress(),
      mode === "development" && componentTagger(),
      // Dev parity with nginx.conf.template: /widget/* assets (loader,
      // runtime, presentation CSS and its self-hosted font files) are always
      // fetched cross-origin by embedding sites. Fonts additionally require
      // CORS on the file itself, otherwise the shadow-root @font-face is
      // blocked and the widget falls back to a system font in dev only.
      {
        name: 'widget-assets-cors',
        configureServer(server: ViteDevServer) {
          server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
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
      alias: [
        { find: "@", replacement: path.resolve(__dirname, "./src") },
        // Push is native-only; keep the optional Firebase web SDK out of the
        // web bundle (the Capacitor plugin's web fallback imports it statically).
        { find: "firebase/messaging", replacement: path.resolve(__dirname, "./src/lib/push/firebaseMessagingWebStub.ts") },
        // Every Loader2 spinner draws the brand's two arcs (src/lib/lucide).
        // Exact match only: that module reaches the real package by file path.
        { find: /^lucide-react$/, replacement: path.resolve(__dirname, "./src/lib/lucide/index.ts") },
      ],
      dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime", "@tanstack/react-query", "@tanstack/query-core"],
    },

    build: {
      rollupOptions: {
        output: {
          // Third-party code in a few stable, separately cached files
          // (scripts/build/vendorChunks.mjs): an app deploy leaves them as
          // they are, so returning browsers re-download only the app's own
          // files. The English strings (src/i18n/locales/en.ts, the fallback
          // every locale reads) are over half of the app's own start-up
          // code; in a file of their own they download in parallel with the
          // entry and stay cached through deploys that do not change them.
          manualChunks: (id, meta) => (/\/src\/i18n\/locales\/en\.ts$/.test(id) ? "locale-en" : vendorChunk(id, meta)),
        },
      },
    },
  };
});
