/**
 * WidgetLivePreview — mounts the REAL widget in preview mode.
 *
 * There is no parallel markup here any more. The iframe below:
 *   1. receives the canonical widget config (hashed runtime URLs) fetched by
 *      the parent from the authenticated `/api/widget-preview/config`,
 *   2. applies the operator's in-progress (unsaved) settings on top,
 *   3. sets `window.__gs_preview_config` and loads the production
 *      `/widget/loader.js`, which mounts the production `runtime.css` +
 *      hashed `runtime.js` inside a shadow root exactly like a visitor gets.
 *
 * The runtime detects `previewMode` and stubs ONLY its network seam
 * (see `ctx.fetchWith` in public/widget/runtime.js). Every pixel — header,
 * home surface, bubbles, composer, tabs, RTL — comes from the real runtime.
 */
import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { WidgetPrechatSettings } from '@/hooks/useWidgetIdentity';

export type PreviewView = 'home' | 'chat' | 'prechat' | 'offline' | 'kb';

export interface WidgetLivePreviewProps {
  settings: Record<string, any> | null | undefined;
  prechat?: WidgetPrechatSettings | null;
  brandName: string;
  view: PreviewView;
  workspaceId?: string | null;
}

function apiBase(): string {
  return (import.meta.env.VITE_API_BASE_URL as string) || window.location.origin;
}

const SEED: Record<string, { agent: string; visitor: string }> = {
  en: { agent: 'Hi! How can we help you today?', visitor: 'Hi, I have a question about pricing.' },
  fa: { agent: 'سلام! چطور می‌توانیم کمکتان کنیم؟', visitor: 'سلام، دربارهٔ تعرفه‌ها سؤال داشتم.' },
  tr: { agent: 'Merhaba! Size nasıl yardımcı olabiliriz?', visitor: 'Merhaba, fiyatlandırma hakkında bir sorum var.' },
};

export function WidgetLivePreview({ settings, prechat, brandName, view, workspaceId }: WidgetLivePreviewProps) {
  // The public `GET /api/widget/config` sits behind `enforceWidgetToken` and
  // only accepts visitor session tokens minted for an allow-listed embed
  // origin — the dashboard is not one, so calling it returns 401. The preview
  // therefore uses the authenticated operator endpoint
  // `GET /api/widget-preview/config`, which performs a workspace membership
  // check server-side and returns the IDENTICAL config document. The fetch
  // happens here (parent) so the operator JWT never enters the iframe.
  const wsId = workspaceId || (settings as any)?.workspace_id || '';
  const [cfg, setCfg] = useState<Record<string, any> | null>(null);
  const [cfgError, setCfgError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setCfg(null);
    setCfgError(null);
    if (!wsId) {
      setCfgError('workspace_unresolved');
      return;
    }
    (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        const token = data.session?.access_token;
        if (!token) throw new Error('unauthenticated');
        const res = await fetch(
          `${apiBase()}/api/widget-preview/config?workspace_id=${encodeURIComponent(wsId)}`,
          { headers: { Authorization: `Bearer ${token}` }, credentials: 'omit' },
        );
        if (!res.ok) throw new Error(`config_${res.status}`);
        const json = await res.json();
        if (!json || !json.runtimeUrl || !json.styleUrl) throw new Error('assets_unavailable');
        if (!cancelled) setCfg(json);
      } catch (e: any) {
        if (!cancelled) setCfgError(e?.message || 'unknown');
      }
    })();
    return () => { cancelled = true; };
  }, [wsId]);

  const srcDoc = useMemo(() => {
    const s = settings || {};
    const lang = String(s.widget_language && s.widget_language !== 'auto' ? s.widget_language : s.locale || 'en')
      .toLowerCase().split('-')[0];
    const seed = SEED[lang] || SEED.en;

    // View → runtime tab. `prechat`/`offline` are runtime states, not tabs:
    // they are driven by the overrides below, and the tab stays "chat".
    const previewView = view === 'kb' ? 'help' : view === 'home' ? 'home' : 'chat';

    // Overrides mirror the field mapping in server/routes/widget.ts so the
    // operator sees unsaved edits. Everything not listed keeps the value the
    // server computed.
    const overrides: Record<string, any> = {
      brandName,
      primaryColor: s.primary_color || undefined,
      secondaryColor: s.secondary_color || undefined,
      logoUrl: s.logo_url ?? undefined,
      launcherText: s.launcher_text ?? undefined,
      welcomeMessage: s.welcome_message ?? undefined,
      greetingMessage: s.greeting_message ?? undefined,
      placeholderText: s.placeholder_text ?? undefined,
      offlineMessage: s.offline_message ?? undefined,
      position: s.position || undefined,
      locale: s.locale || undefined,
      widgetLanguage: s.widget_language || undefined,
      showLogo: s.show_logo ?? undefined,
      theme: s.theme || undefined,
      supportMode: s.support_mode || undefined,
      fab: {
        icon: s.fab_icon || 'chat',
        helpIcon: s.fab_help_icon || 'help_circle',
        shape: s.fab_shape || 'circle',
        label: s.fab_label || '',
        chatLabel: s.fab_chat_label || '',
        helpLabel: s.fab_help_label || '',
        scale: s.fab_scale ?? 100,
        iconColor: s.fab_icon_color || '#ffffff',
        textColor: s.fab_text_color || '#ffffff',
        animation: s.fab_animation ?? true,
      },
      features: {
        chat: s.chat_enabled ?? true,
        knowledgeBase: s.kb_enabled ?? true,
        visitorTracking: false,
      },
      attachments: { enabled: s.attachments_enabled === true, maxSizeMb: s.attachments_max_size_mb ?? 10, maxCount: 1 },
      preChat: prechat ? { ...prechat, enabled: view === 'prechat' ? true : (prechat as any).enabled } : undefined,
      previewMode: true,
      previewView,
      previewSeed: {
        messages: view === 'chat'
          ? [
              { id: 'p1', sender_type: 'agent', content: seed.agent, created_at: new Date(Date.now() - 60000).toISOString() },
              { id: 'p2', sender_type: 'contact', content: seed.visitor, created_at: new Date().toISOString() },
            ]
          : [],
      },
    };
    if (view === 'offline') {
      overrides.availability = { state: 'offline', message: s.offline_message || '' };
    }

    const payload = JSON.stringify({ api: apiBase(), cfg, cfgError, overrides })
      .replace(/</g, '\\u003c');

    return `<!doctype html>
<html><head><meta charset="utf-8" />
<style>
  html,body{margin:0;height:100%;}
  body{background:#F1F5F9;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;}
  /* Preview-only sizing: the panel fills the preview frame (minus the launcher
     zone) and its edge lines up exactly with the floating launcher. */
  .panel{
    block-size: calc(100vh - 104px - 16px) !important;
    max-block-size: none !important;
    min-block-size: 0 !important;
    inline-size: min(400px, calc(100vw - 48px)) !important;
  }
  /* keep the pulse/hover scale from pushing the launcher past its anchored edge */
  .launcher.bottom-right{ transform-origin: bottom right !important; }
  .launcher.bottom-left{ transform-origin: bottom left !important; }
  .site{padding:22px;}
  .site .bar{height:12px;border-radius:6px;background:#E2E8F0;margin-bottom:10px;}
  .site .bar.w2{width:62%}.site .bar.w3{width:78%}.site .bar.w4{width:45%}
  .site .block{height:120px;border-radius:14px;background:#E2E8F0;margin:16px 0;}
  .site .cards{display:flex;gap:12px}.site .cards div{flex:1;height:64px;border-radius:12px;background:#E2E8F0}
  #err{position:fixed;inset-inline:16px;bottom:16px;padding:12px 14px;border-radius:12px;
    background:#FEF2F2;color:#991B1B;font-size:13px;line-height:1.5;border:1px solid #FECACA;display:none;}
</style></head>
<body>
  <div class="site" aria-hidden="true">
    <div class="bar w3"></div><div class="bar w2"></div><div class="bar w4"></div>
    <div class="block"></div>
    <div class="cards"><div></div><div></div><div></div></div>
  </div>
  <div id="err"></div>
<script>
(function () {
  var P = ${payload};
  function fail(msg) {
    var e = document.getElementById('err');
    e.textContent = msg;
    e.style.display = 'block';
  }
  function deepMerge(base, over) {
    var out = {};
    for (var k in base) out[k] = base[k];
    for (var k2 in over) {
      var v = over[k2];
      if (v === undefined) continue;
      if (v && typeof v === 'object' && !Array.isArray(v) && out[k2] && typeof out[k2] === 'object' && !Array.isArray(out[k2])) {
        out[k2] = deepMerge(out[k2], v);
      } else { out[k2] = v; }
    }
    return out;
  }
  if (P.cfgError || !P.cfg) {
    var m = P.cfgError || 'unknown';
    fail(m === 'workspace_unresolved'
      ? 'Preview unavailable: workspace not resolved.'
      : m === 'unauthenticated'
        ? 'Preview unavailable: your session expired — sign in again.'
        : m === 'assets_unavailable'
          ? 'Preview unavailable: the widget build manifest is not published yet.'
          : 'Preview unavailable: could not load widget configuration (' + m + ').');
    return;
  }
  var cfg = P.cfg;
  var merged = deepMerge(cfg, P.overrides);
  merged._apiBase = P.api;
  merged._assetBase = cfg.assetBase || P.api;
  merged._sessionToken = 'preview';
  window.__gs_preview_config = merged;
  var sc = document.createElement('script');
  // Loader must come from the ASSET base, not the API base — those are
  // different domains in split deployments. Prefer the explicit loaderUrl
  // the config returns; fall back to assetBase, then the API origin.
  sc.src = cfg.loaderUrl
    || ((cfg.assetBase || P.api) + '/widget/loader.js?v=' + encodeURIComponent(cfg.loaderVersion || 'preview'));
  sc.async = true;
  sc.onerror = function () { fail('Preview unavailable: widget loader could not be fetched.'); };
  document.body.appendChild(sc);
})();
</script>
</body></html>`;
  }, [settings, prechat, brandName, view, cfg, cfgError]);

  return (
    <div className="h-full w-full overflow-hidden rounded-xl border border-border bg-muted/20">
      <iframe
        title="widget-preview"
        srcDoc={srcDoc}
        className="h-full w-full border-0"
        sandbox="allow-scripts allow-same-origin"
      />
    </div>
  );
}
