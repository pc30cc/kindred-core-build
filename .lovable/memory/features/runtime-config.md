---
name: Runtime Config Architecture
description: Platform-level config resolver, locale-aware identity, site mode, domain/URL management
type: feature
---

## Runtime Configuration Architecture

### Resolution Order
workspace localized → workspace generic → platform localized → platform generic → internal fallback

### Database Tables (new)
- `platform_settings` — site_mode, default_locale, active_locales, timezone
- `platform_branding` — logo, favicon, colors (non-localized)
- `platform_branding_localized` — per-locale text identity (platform_name, meta_title, footer, etc.)
- `platform_domains` — all runtime URLs (canonical, public, app, api, widget, asset, help, email)
- `email_settings` — sender_email, reply_to, logo (workspace_id nullable = platform default)
- `email_settings_localized` — per-locale sender_name, footer_text
- `workspace_settings` — per-workspace site_mode/locale overrides
- `workspace_branding_localized` — per-workspace per-locale identity overrides
- `workspace_domains_extended` — per-workspace URL overrides

### Backend
- `server/services/config/resolver.ts` — central resolver with 30s cache
- `server/routes/config.ts` — GET /api/config/resolve + admin CRUD endpoints
- Email auth-sender uses resolver (no hardcoded brand names)

### Frontend
- `src/lib/config-api.ts` — API client for config endpoints
- `src/features/config/RuntimeConfigContext.tsx` — single provider for all identity
- BrandingContext delegates to RuntimeConfig
- usePublicBranding delegates to RuntimeConfig
- PublicLayout uses RuntimeConfig for site mode, language switcher visibility

### Admin UI
- `/admin/platform-settings` — General, Branding, Localized Identity, Domains, Email, SEO tabs
