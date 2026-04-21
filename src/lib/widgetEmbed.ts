/**
 * Widget Embed — single source of truth for embed snippet generation
 * and computed widget URL previews.
 *
 * Used by:
 *  - /admin/widget-settings → Deployment & URLs tab (preview + embed code)
 *  - /app/.../widget        → Install tab (workspace embed snippet)
 *  - Any future workspace/admin install code generator
 *
 * Backed by `widget_platform_settings` (loader/asset/public/api base URLs).
 * Never read these URLs from `platform_domains` or `workspace_branding` —
 * those columns are deprecated.
 */

export interface WidgetUrlSources {
  widget_loader_base_url: string | null;
  widget_asset_base_url: string | null;
  widget_public_base_url: string | null;
  widget_api_base_url: string | null;
}

export interface ResolvedWidgetUrls {
  loaderBase: string;
  assetBase: string;
  publicBase: string;
  apiBase: string;
  loaderUrl: string;
  manifestUrl: string;
  runtimeBase: string;
  stylesheetUrl: string;
  bootstrapUrl: string;
  /** True when one of the base URLs is missing/falling back to a default. */
  hasMissing: boolean;
  /** Origins that disagree (e.g. loader vs asset on different hosts). */
  mismatches: WidgetMismatch[];
}

export interface WidgetMismatch {
  kind: 'loader_vs_asset' | 'asset_vs_public' | 'api_same_host';
  message: string;
  detail: string;
}

const FALLBACK_PLACEHOLDER = 'https://widget.example.com';
const FALLBACK_API = 'https://api.example.com';

function trim(value: string | null | undefined) {
  return (value || '').trim().replace(/\/+$/, '');
}

function originOf(url: string): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Resolve all widget URLs from the central widget_platform_settings row.
 * Falls back gracefully (with placeholder hosts) when fields are unset so
 * the admin UI can still render previews.
 */
export function resolveWidgetUrls(
  sources: Partial<WidgetUrlSources> | null | undefined,
  fallbackOrigin?: string,
): ResolvedWidgetUrls {
  const loader = trim(sources?.widget_loader_base_url);
  const asset = trim(sources?.widget_asset_base_url);
  const pub = trim(sources?.widget_public_base_url);
  const api = trim(sources?.widget_api_base_url);
  const fb = trim(fallbackOrigin) || FALLBACK_PLACEHOLDER;

  // Resolution order: explicit field → next most-specific field → fallback.
  const loaderBase = loader || pub || asset || fb;
  const assetBase = asset || loader || pub || fb;
  const publicBase = pub || loader || asset || fb;
  const apiBase = api || FALLBACK_API;

  const loaderUrl = `${loaderBase}/widget/loader.js`;
  const manifestUrl = `${assetBase}/widget/widget-manifest.json`;
  const runtimeBase = `${assetBase}/widget/`;
  const stylesheetUrl = `${assetBase}/widget/runtime.css`;
  const bootstrapUrl = `${apiBase}/api/widget/bootstrap`;

  const hasMissing =
    !sources?.widget_loader_base_url ||
    !sources?.widget_asset_base_url ||
    !sources?.widget_public_base_url ||
    !sources?.widget_api_base_url;

  const mismatches: WidgetMismatch[] = [];
  const loaderOrigin = originOf(loaderBase);
  const assetOrigin = originOf(assetBase);
  const publicOrigin = originOf(publicBase);
  const apiOrigin = originOf(apiBase);

  if (loaderOrigin && assetOrigin && loaderOrigin !== assetOrigin) {
    mismatches.push({
      kind: 'loader_vs_asset',
      message: 'Loader and asset origins do not match',
      detail: `Loader: ${loaderOrigin} · Asset: ${assetOrigin}. The loader will load runtime assets from a different origin — make sure CORS and CDN are configured.`,
    });
  }
  if (assetOrigin && publicOrigin && assetOrigin !== publicOrigin) {
    mismatches.push({
      kind: 'asset_vs_public',
      message: 'Asset and public origins do not match',
      detail: `Asset: ${assetOrigin} · Public: ${publicOrigin}. Embed previews will show ${publicOrigin} but assets are served from ${assetOrigin}.`,
    });
  }
  if (apiOrigin && assetOrigin && apiOrigin === assetOrigin && apiBase !== FALLBACK_API) {
    // Not strictly an error — same-origin API+asset is a common single-host setup.
    // We only warn when the user clearly entered the *app* domain as both.
  }

  return {
    loaderBase,
    assetBase,
    publicBase,
    apiBase,
    loaderUrl,
    manifestUrl,
    runtimeBase,
    stylesheetUrl,
    bootstrapUrl,
    hasMissing,
    mismatches,
  };
}

export interface BuildEmbedOptions {
  variant: 'window' | 'script';
  workspaceId: string | null | undefined;
  /** Optional comment rendered above the <script> tag. Multi-line allowed. */
  headerComment?: string | null;
  /** Optional comment rendered below the <script> tag. Multi-line allowed. */
  footerComment?: string | null;
}

/** Wrap a free-form admin string as a safe HTML comment block. */
function asHtmlComment(raw: string | null | undefined): string {
  const text = (raw || '').trim();
  if (!text) return '';
  // Neutralize any embedded "-->" so the comment can't be broken out of.
  const safe = text.replace(/-->/g, '--&gt;');
  return `<!--\n${safe}\n-->`;
}

/**
 * Build the final HTML snippet a webmaster pastes onto their site.
 * MUST be the only place in the codebase that generates embed code.
 */
export function buildWidgetEmbedSnippet(
  urls: ResolvedWidgetUrls,
  opts: BuildEmbedOptions,
): string {
  const ws = opts.workspaceId || 'YOUR_WORKSPACE_ID';
  const header = asHtmlComment(opts.headerComment);
  const footer = asHtmlComment(opts.footerComment);

  let core: string;
  if (opts.variant === 'window') {
    core = `<script type="text/javascript">
  /* Idempotent: safe even if this snippet is included multiple times or the
     host page is a SPA that re-renders. */
  if (!window.__gs_loaded && !window.__gs_loader_injected) {
    window.__gs_loader_injected = true;
    window.__gs = window.__gs || [];
    window.__gs_id = "${ws}";
    window.__gs_api_base = "${urls.apiBase}";
    (function(){
      var d = document;
      if (d.getElementById("gs-widget-loader")) return;
      var s = d.createElement("script");
      s.id = "gs-widget-loader";
      s.src = "${urls.loaderUrl}";
      s.setAttribute("data-asset-base", "${urls.assetBase}");
      s.async = 1;
      d.getElementsByTagName("head")[0].appendChild(s);
    })();
  }
</script>`;
  } else {
    core = `<script
  id="gs-widget-loader"
  src="${urls.loaderUrl}"
  data-workspace-id="${ws}"
  data-api-base="${urls.apiBase}"
  data-asset-base="${urls.assetBase}"
  async
></script>`;
  }

  return [header, core, footer].filter(Boolean).join('\n');
}
