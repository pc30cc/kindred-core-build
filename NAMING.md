# Naming Audit (Documentation Only)

> **Read carefully.** This is a documentation-layer audit. **No code,
> file, route, env var, log label, package name, or build artifact has
> been renamed.** All findings below describe the current state as it
> exists in the repository. Resolution is documentation-only.

---

## 1. Canonical internal platform name

- **Documentation-level canonical name:** `Kindred Core`.
- This is an **internal** identifier used in documentation, ADRs, and
  team communication. It is **not** a customer-facing brand.
- Customer-facing branding is dynamic per deployment / tenant. It is
  resolved at runtime from the database, not from code:
  - `platform_branding` (per-deployment)
  - `workspace_branding` (per-tenant)
  - Resolved into the SPA via `src/features/branding/BrandingContext.tsx`
    and `src/hooks/usePlatformBranding.ts`.
  - Drives `<title>`, favicon, meta description, OG image, canonical
    URL — all overrideable by an admin without a code change.
- Defaults shipped in code are intentionally **generic**:
  - `index.html` `<title>` = `Platform`
  - `index.html` meta description = `Self-hosted platform`
  - `BrandingContext` default `platformName` = `'Platform'`

These generic defaults exist so the unbranded image is safe to ship to
any tenant. They are **not** the canonical internal name and should
remain generic.

---

## 2. Inventory of names found in the codebase

### 2.1 Package names

| Where | Name | Notes |
|---|---|---|
| `package.json` (root) | `vite_react_shadcn_ts` | Default Lovable Vite template name. Never appears in user-visible UI. |
| `server/package.json` | `growth-suite-server` | Legacy internal identifier for the Express server. Never user-visible. |
| `worker/` | *(no `package.json`)* | The worker piggy-backs on the root package; selected by `WORKER_KIND` env var. |

### 2.2 Documentation titles / headings

| File | Heading | Notes |
|---|---|---|
| `SELF_HOST_GUIDE.md` | `Growth Suite — Self-Host Deployment Guide` | Legacy doc title. Path/filename preserved for backward links. |
| `COOLIFY_DEPLOY.md` | `Coolify Deployment Guide — Multi-Domain Production` | Generic. |
| `DEPLOY_CENTRIFUGO_COOLIFY.md` | (Centrifugo deploy) | Generic. |
| `docs/*.md` | Various | Generic / feature-scoped. |

### 2.3 Widget-runtime internal identifiers (legacy `gs-` prefix)

These are **internal symbols** baked into the widget's Shadow DOM
contract. Renaming them would break every customer's embedded snippet
across the cache horizon and is explicitly out of scope.

| Symbol | Location | Purpose |
|---|---|---|
| `window.__gs_runtime` | `public/widget/runtime.js` | Runtime module global |
| `<gs-widget>` (custom element host) | `public/widget/loader.js` | Shadow root host element |
| `.gs-launcher`, `.shell`, `.panel` (CSS) | `public/widget/runtime.css` | Internal class names |
| `data-template="<slug>"` | `public/widget/runtime.js`, `runtime.css` | Template scoping attribute |
| `LOADER_VERSION = "2026-04-22-token-bus-v1"` | `public/widget/loader.js` | Cache-busting / diagnostics |

### 2.4 Log labels found in code

| Prefix | Where | Notes |
|---|---|---|
| `[Widget Runtime]` | `public/widget/runtime.js` | Visitor browser console |
| `[Loader …]` | `public/widget/loader.js` | Visitor browser console |
| `[call-widget]` | `public/call-widget/l.js` | Visitor browser console |
| `[widget-hash]` | `scripts/widget-hash.js` | Build output |
| `[worker]` | `worker/index.ts` | Worker container logs |
| `[realtime/operator-connect]`, `[realtime/operator-subscribe]`, `[realtime/operator-inbox-subscribe]`, `[realtime/operator-visitors-subscribe]`, `[realtime/admin/control GET]`, `[realtime/admin/control PUT]` | `server/routes/realtime.ts`, `server/routes/realtimeControl.ts` | Backend logs |
| `[widget-typing-rl]` | `server/services/widget/typingRateLimit.ts` | Backend logs |

These labels are stable and used by ops dashboards / log filters.
They should not be renamed without coordinated rollout.

### 2.5 Other observed strings

| String | Where | Status |
|---|---|---|
| `ila`, `IRANYekanXILACHAT`, `ILA Style`, `ila.chat` | (no occurrences in active source) | Removed from active source (final occurrence — `IRANYekanXILACHAT` in `public/widget/runtime.css` font-family — was dropped in the recent safe pass). A single migration (`supabase/migrations/20260619064502_*.sql`) performs `DELETE FROM public.widget_templates WHERE slug = 'ila'` to clean up legacy production rows; this is intentional and must remain. |
| `Kindred Core` | This file + README + DEPLOYMENT | Documentation-only canonical name. |

### 2.6 Additional brand-string findings (precise citations)

Strings reviewed in this audit. The table is split between items that
were safely cleaned in the recent pass and items intentionally
preserved for compatibility.

**Cleaned in the recent safe pass** (no behavior or contract change):

| String | File | Resolution |
|---|---|---|
| `Adapted from WebYar Growth Suite widget system.` | `server/routes/widget.ts` | Source comment removed. |
| `Adapted from WebYar Growth Suite security model:` | `server/services/widget/security.ts` | Source comment removed. |
| `WebYar-inspired` / `WebYar-quality` | `src/index.css` | Comments rewritten to neutral wording. |
| `IRANYekanXILACHAT` (font-family fallback) | `public/widget/runtime.css` | Removed from the template2 font stack; falls back to `Vazirmatn`. |
| `ila.chat` / `ila-style` (comments) | `public/widget/runtime.css`, `public/widget/loader.js` | Comments rewritten. |
| i18n `account.subtitle` brand placeholder | `src/pages/app/settings/ProfilePage.tsx` | Now reads `useBrandingContext().platformName` instead of a hardcoded literal. |

**Intentionally preserved for compatibility** (renaming would break ops dashboards, deployed embed snippets, or external links):

| String | Location | Why kept |
|---|---|---|
| `Growth Suite server running on port ${config.port}` | `server/index.ts` | Backend startup log; ops dashboards may grep for it. |
| `Growth Suite — Self-Host Deployment Guide` | `SELF_HOST_GUIDE.md` (heading) | Backward link compatibility. |
| `<title>Platform</title>`, `og:title`, `og:description` | `index.html` | Intentionally generic white-label defaults. |
| `Platform preview` (alt text) | `src/pages/auth/LoginPage.tsx` | Generic white-label fallback. |
| Default email `from_name` = `'Platform'` | `server/services/email/index.ts` | Generic fallback when no branding row is present. |
| Auth fallback brand label `'App'` | `src/pages/auth/ForgotPasswordPage.tsx`, `ResetPasswordPage.tsx` | Generic fallback before branding loads. |
| `window.__gs` queue array on login-page snippet | `index.html`, `SELF_HOST_GUIDE.md` | Public widget embed contract. |

### 2.7 Additional server log prefixes (extends §2.4)

Found in `server/**/*.ts` — used by ops dashboards, must not be
renamed without coordinated rollout:

`[worker]`, `[ai-kb worker]`, `[regression-worker]`, `[startup]`,
`[gate-bypass]`, `[FeatureGating]`, `[ModuleGating]`, `[AICredits]`,
`[UsageTracking]`, `[security]`, `[account]`, `[ai]`, `[ai-agent]`,
`[learn]`, `[auth-email]`, `[auth]`, `[call_center]`, `[call-widget]`,
`[call-widget/bootstrap]`, `[call-widget/calls/request]`,
`[call-widget/callbacks]`, `[calls]`, `[cdn]`, plus the
`[realtime/...]` family already listed in §2.4.

### 2.8 Additional widget-runtime log prefixes (extends §2.4)

`[Widget]` (`public/widget/loader.js:50,56`), `[Widget Runtime]`
(`public/widget/runtime.js:49,55`), `[Widget AI Agent]`
(`public/widget/runtime.js:2259,5435,5442,5455,5489,5518,5524`),
`[Widget KB]` (`public/widget/runtime.js:3308`).

### 2.9 Branding resolution — two parallel layers

The runtime brand string is **not** a single value. It is resolved
from two independent tables in this priority order:

1. **Workspace-level** (`workspace_branding`, +
   `workspace_branding_localized`) — fetched by
   `src/hooks/useBranding.ts` and provided to
   `src/features/branding/BrandingContext.tsx`. Drives `<title>`,
   favicon, meta description, OG image, canonical URL.
   - `WorkspaceBranding` shape: `src/types/models.ts:66–79`.
   - `<title>` priority chain: `branding.meta_title` →
     `branding.platform_name` → hardcoded `'Platform'`
     (`BrandingContext.tsx:12,25`, `index.html:6`).
2. **Platform-level** (`platform_branding`,
   `platform_branding_localized`, `platform_domains`) — fetched by
   `src/hooks/usePlatformBranding.ts` and the per-locale variant in
   `src/hooks/usePublicBranding.ts`. Used by public-facing surfaces
   (auth pages, public site, knowledge base) and carries fields like
   `widget_display_name`, `legal_company_display_name`,
   `browser_title_format`, etc.
   - Auth fallback brand label is hardcoded `'App'` when no row is
     present (`ForgotPasswordPage.tsx:22`, `ResetPasswordPage.tsx:29`).

No `brand_label` / `brandLabel` column exists anywhere in the
codebase. The brand label flows exclusively through the two layers
above.

---

## 3. Naming inconsistencies and likely reasons

| # | Observation | Likely reason | Maintenance risk |
|---|---|---|---|
| 1 | Root `package.json` name is `vite_react_shadcn_ts` (template default), not project-specific. | Project bootstrapped from a Lovable Vite template; never renamed because npm name has no runtime effect for a private app. | Low. Confusing to new contributors only. |
| 2 | Server package is `growth-suite-server`. | Earlier internal codename. Preserved across refactors to avoid Docker-image / lockfile churn. | Low. Internal-only identifier. |
| 3 | `SELF_HOST_GUIDE.md` opens with "Growth Suite — Self-Host Deployment Guide". | Same legacy codename. | Low. Cosmetic — confusing if read in isolation. |
| 4 | Widget runtime uses `gs-` / `__gs_` prefixes. | Originates from "Growth Suite". Now part of the public widget contract baked into the customer-deployed snippet. | **High** if renamed. Breaking change for every embedded customer. None as-is. |
| 5 | UI defaults to the literal label `Platform`. | Intentional generic placeholder for a white-label product. Real label comes from `platform_branding` / `workspace_branding`. | Low. Feature, not bug. |
| 6 | Two migration directories (`database/migrations/` and `supabase/migrations/`). | `database/` is the numbered self-host bootstrap; `supabase/` is the Supabase CLI's incremental migration log. | Medium. Documented in README and `database/README.md`. |
| 7 | Worker `package.json` script `worker:intelligence:legacy` still ships. | Backwards compatibility for older Coolify services that built directly from `worker/intelligence/index.ts`. Documented in `worker/index.ts`. | Low. Comment in source. |

---

## 4. Documentation-only resolution

The following text is suitable as-is for a "Naming" section in the
README and ADRs:

> **Canonical internal platform name:** Kindred Core.
>
> Customer-facing brands may vary by deployment. Branding is resolved
> at runtime from the `platform_branding` and `workspace_branding`
> tables and applied to document title, favicon, meta tags, OG image,
> and canonical URL via `BrandingContext`.
>
> Several legacy internal identifiers remain in the code for
> compatibility with already-deployed widget snippets, Docker images,
> and ops dashboards:
>
> - npm package names: `vite_react_shadcn_ts` (root) and
>   `growth-suite-server` (server)
> - widget DOM/JS prefixes: `__gs_runtime`, `<gs-widget>`,
>   `.gs-launcher`
> - log prefixes: `[Widget Runtime]`, `[Loader …]`, `[call-widget]`,
>   `[widget-hash]`, `[worker]`, `[realtime/...]`
> - documentation title: "Growth Suite — Self-Host Deployment Guide"
>
> No implementation rename is being performed at this stage. Future
> rename proposals must be submitted as ADRs that explicitly account
> for: deployed widget snippet compatibility, Docker image
> name/lockfile churn, log/alert filter migration, and customer comms.

---

## 5. Out of scope

The following are deliberately **not** changed by this audit:

- File or directory renames
- Package name changes (`package.json`, `server/package.json`)
- Route changes
- Env var renames
- Log prefix changes
- Widget DOM / global / class renames
- Asset path or build output changes

If a rename is later requested, it will be tracked as a separate,
coordinated migration with explicit deprecation windows.

---

## 6. Confirmation

No implementation rename or refactor has been performed as part of
this audit. The codebase remains identical apart from documentation
files (`README.md`, `NAMING.md`, `DEPLOYMENT.md`).

---

## 7. Migration-readiness package

Coordinated future migration is governed by:

- [`docs/adr/ADR-001-canonical-internal-naming.md`](docs/adr/ADR-001-canonical-internal-naming.md)
- [`docs/adr/ADR-002-legacy-identifier-migration-policy.md`](docs/adr/ADR-002-legacy-identifier-migration-policy.md)
- [`docs/LEGACY_IDENTIFIER_INVENTORY.md`](docs/LEGACY_IDENTIFIER_INVENTORY.md)
- [`docs/LEGACY_MIGRATION_PLAN.md`](docs/LEGACY_MIGRATION_PLAN.md)
- [`docs/LEGACY_NAMING_DECISION_MATRIX.md`](docs/LEGACY_NAMING_DECISION_MATRIX.md)

Any rename of a contract-bearing legacy identifier requires explicit
approval per ADR-002 — no silent renames.