# Storage URLs are derived, never stored

_Companion to `docs/STORAGE_ARCHITECTURE_AUDIT.md` (ownership + key shape) and
`docs/STORAGE_COUNTER_ARCHITECTURE.md` (quota). This document covers one thing:
what the database records about a file the platform owns, and where its public
link comes from._

## The product rule

A workspace user, operator or admin **cannot type a media/file URL and have
it persisted**. There is exactly one path for a file WebYar manages:

```
upload / ingest  ->  WebYar storage  ->  canonical key in the DB
                 ->  URL derived at read time
```

and explicitly not:

```
workspace API  ->  arbitrary https://...  ->  persisted *_url
```

Every request schema that once allowed the second shape has had the field
removed, and each is `.strict()` so a stale client gets a 400 naming the
field rather than a silent drop. See **Closed inputs** below.

## The invariant

For every file WebYar stores, the database persists **the canonical storage
key and nothing else**:

```
workspace/<workspaceId>/...     users/<userId>/...     platform/...
```

A key is identical on every storage vendor — it is what the platform writes,
everywhere. A public URL is not: it names one vendor's hostname. A row that
persists a URL is therefore pinned to whichever provider happened to be primary
when it was written, and promoting a new primary would mean rewriting every
such row before anything rendered correctly again.

So no row keeps one. **Links are derived at read time**, from whichever
provider is resolved at that moment.

The property this buys, and the one to protect:

> **Promoting a new storage provider rewrites zero rows. The first API request
> after the promotion already produces the new provider's URLs.**

That is asserted directly in `src/test/storage/keyOnlyUrlDerivation.test.ts`.

## The one derivation layer

`server/services/storage/urlResolver.ts` is the only place a stored key becomes
a link outside the storage service itself (a structural test enforces this).

```ts
const resolver = createStorageUrlResolver(serverConfig);

await resolver.workspace(workspaceId, row.avatar_storage_key);  // workspace/<id>/...
await resolver.user(userId, profile.avatar_storage_key);        // users/<id>/...
await resolver.platform(settings.ringback_music_path);          // platform/...
```

Three properties it is responsible for:

1. **No N+1 provider resolution.** A resolver memoizes the provider lookup per
   workspace, and once globally for user- and platform-owned objects.
   Serializing a page of 500 rows for one workspace performs exactly one
   provider resolution. `prewarmWorkspaces()` / `prewarmGlobal()` exist for
   loops that want it resolved up front.
2. **Derivation is pure.** Once a provider config is in hand, turning a key
   into a URL is string construction: no provider HTTP, no usage metering, no
   quota accounting, no replication events, no per-row logging. Read paths run
   on every page load and must never generate write traffic.
3. **Ownership is validated first.** `.workspace(id, key)` derives a link only
   for a key that genuinely belongs to that workspace; a key naming another
   owner returns `null`. A serializer that mixes up two rows produces a missing
   avatar, never a cross-tenant one. The two legacy key shapes
   (`avatars/<userId>/`, `branding/<workspaceId>/`) carry their owner id in the
   same position and are validated just as strictly.

**Scope a resolver to one request** (or one worker job / broadcast). Never hold
one across requests: a promotion must take effect on the very next request, and
a process-lifetime cache would keep serving the retired vendor.

For the common case — a batch of rows going straight to a client — use the
hydration helpers, which replace `avatar_url` with the derived link and delete
the key so it never reaches the browser:

```ts
await hydrateUserAvatars(config, profileRows);            // profiles
await hydrateContactAvatars(config, workspaceId, rows);   // contacts
```

## What is NOT served this way

Private objects keep their authenticated proxy routes, which stream bytes after
an access check: chat and email attachments, call recordings, privacy exports.
Nothing about them changes — they already stored only keys.

This document is about public, CDN-served assets — avatars and logos — where
proxying every byte through the API would be strictly worse than handing out
the CDN URL.

## Migration map

Every column that holds or held a file reference, with what actually writes and
reads it. "External" means the value is supplied by an integrator or operator
and is not an object we store.

| Table.column | Owner | Writer | Key lives in | URL persisted? | Externally supplied? | Action taken |
|---|---|---|---|---|---|---|
| `conversation_attachments.storage_path` | workspace | `conversationAttachments.ts`, `widgetAttachments.ts`, `internalChannels.ts`, telegram `mediaIngest.ts` | this column | no | no | none needed — key only, served by the proxy route |
| `email_attachments.storage_key` | workspace | `services/email/inbox.ts` | this column | no | no | none needed |
| `call_recordings.storage_path` | workspace | LiveKit webhook | this column | no | no | none needed |
| `privacy_jobs.artifact_storage_key` | workspace/user | `services/privacy/worker.ts` | this column | no | no | none needed |
| `profiles.avatar_url` | user | `routes/account.ts` | `avatar_storage_key` | **was yes** | no | writer now stores the key and clears the URL; ~15 read paths derive |
| `workspace_branding.logo_url` | workspace | `routes/account.ts`, legacy migration | `logo_storage_key` | **was yes** | operator may type one | writer stores the key and clears the URL; `routes/workspaces.ts` and the widget derive |
| `call_center_settings.avatar_url` | workspace | `routes/callCenter.ts` | `avatar_storage_path` | **was yes** | settings PATCH may set one | upload writes the key and clears the URL; GET/PUT and the call widget derive |
| `ai_agent_settings.agent_logo_url` | workspace | `routes/ai-agent/assistant.ts` | `metadata.ai_avatar_storage_key` | **was yes** | settings PATCH may set one | upload writes the key and clears the URL; `resolveAgentLogoUrl()` derives |
| `contacts.avatar_url` | workspace | telegram `mediaIngest.ts` only | `avatar_storage_key` (**new, migration 190**) | **was yes** | **no longer** | ingest writes the key and clears the URL; `avatar_url` removed from the create / bulk / update schemas; legacy values are read-only |
| `widget_settings.fab_image_url` | workspace | `widgetSettings.ts` fab-image endpoint | `fab_image_storage_key` (**new, migration 190**) | **was yes** | **no longer** | the browser no longer uploads and PATCHes a URL back; a dedicated server-side endpoint stores the key and clears the URL |
| `conversation_messages.metadata.agent_logo_url` | workspace | `services/ai-agent/responder.ts` | — | **was yes** | no | no longer snapshotted; readers derive the agent logo from its key |
| `platform_call_center_settings.ringback_music_url` | platform | `routes/callCenter.ts` | `ringback_music_path` | **was yes** | no | upload clears it; admin GET and the call widget derive from the path |
| `platform_call_center_settings.ringback_announcement_audio_path` / `ringback_queue_audio_paths` | platform | `routes/callCenter.ts` | these columns | no | no | already key-only; read path now uses the resolver |
| `platform_branding.logo_url` / `favicon_url` / `pwa_icon_url` | platform | `routes/adminManagement.ts` (typed by a PLATFORM admin) | — | n/a | **yes** | **documented exception** — see below |
| `widget_settings.logo_url` | workspace | nothing (dead column; the widget reads `workspace_branding`) | — | n/a | n/a | removed from the PATCH schema's reachable surface by `.strict()`; no writer |
| `email_settings.email_logo_url` | platform | `routes/adminManagement.ts` (typed by a PLATFORM admin) | — | n/a | **yes** | **documented exception** — see below |
| `workspace_branding.favicon_url` / `social_image_url` | workspace | no writer | — | n/a | n/a | stripped from the branding PATCH, so a workspace admin can no longer set one; needs an upload endpoint if the product wants them back |
| `commerce_products.image_url`, `commerce_product_variants.image_url` | workspace | commerce sync from the merchant's platform | — | n/a | **yes** | **documented exception** — third-party integration data, see below |

### Closed inputs

Each of these was a workspace-writable media URL. All are gone from their
request schemas, and each schema is `.strict()`:

| Surface | Field removed | The only way to change that image now |
|---|---|---|
| `POST /api/contacts`, `POST /api/contacts/bulk`, `PATCH /api/contacts/:id` | `avatar_url` | channel ingest (`persistContactAvatar`) |
| `PUT /api/ai-agent/settings` | `agent_logo_url` | `POST` / `DELETE /api/ai-agent/settings/avatar` |
| `PUT /api/call-center/settings` | `avatar_url` (and `avatar_storage_path`, never settable) | `POST` / `DELETE /api/call-center/settings/avatar` |
| `PATCH /api/widget-settings/:workspaceId` | `fab_image_url` | `POST` / `DELETE /api/widget-settings/:workspaceId/fab-image` |
| `PATCH /api/workspaces/:id/branding` | `logo_url`, `favicon_url`, `social_image_url`, `logo_storage_key` | `POST /api/account/workspace-icon` (logo); none yet for the other two |

### Legacy read fallbacks (deprecated)

A row written before this change may still hold a URL and no key. Those
values keep rendering so images do not break mid-rollout, and every such
branch is marked `@deprecated LEGACY READ FALLBACK` at its source:

- `resolveContactAvatarUrl()` — `contacts.avatar_url`
- `resolveCallCenterAvatarUrl()` — `call_center_settings.avatar_url`
- `resolveAgentLogoUrl()` — `ai_agent_settings.agent_logo_url`
- `withDerivedFabImageUrl()` and the widget bootstrap — `widget_settings.fab_image_url`
- `withDerivedLogoUrl()` — `workspace_branding.logo_url`

They are **read-only**. Nothing creates a new value for any of them: a key
always wins, every writer clears the URL column, and no schema accepts one.
They are removed together with the columns in the later cleanup migration.

### Documented exceptions

Two kinds of URL legitimately remain:

1. **Platform-operator branding** — `platform_branding.logo_url` /
   `favicon_url` / `pwa_icon_url` and `email_settings.email_logo_url`. These
   are typed by a PLATFORM admin (`requirePlatformAdmin`), not by a
   workspace user, and there is no upload endpoint for them anywhere in the
   repo. They are outside the workspace tenancy model this rule is about.
   Giving them the same upload → key → derived treatment is the obvious next
   step if the platform wants a single model everywhere; until then this is
   a deliberate, named gap, not an oversight.
2. **Third-party integration data** — `commerce_products.image_url` and
   `commerce_product_variants.image_url`. These come from the merchant's own
   platform through the WooCommerce connector
   (`services/commerce/connectors/woocommerce.ts`); they reference the
   merchant's CDN, are not manually supplied by a workspace user, and are not
   files WebYar stores. They stay as they are.

Not media at all, despite looking like it: `call_center_departments.icon` and
`knowledge_base_categories.icon` hold icon NAMES, not URLs.

## Migration 190

`database/migrations/190_storage_key_ownership.sql` (mirrored to
`supabase/migrations/20260916093000_storage_key_ownership.sql`) does two things:

1. Adds `contacts.avatar_storage_key` and `widget_settings.fab_image_storage_key`.
   The contact key is backfilled **conservatively and
   per-row workspace-scoped**: a key is recovered only when the stored URL
   contains that row's OWN workspace id under the exact prefix the ingest
   writes. A generic `workspace/<any-uuid>/` match is deliberately not used —
   `contacts.avatar_url` is also written by the CRM import API, and a URL that
   merely mentions some workspace id must never be adopted as this row's key.
   Query strings and fragments are stripped. Anything unprovable stays `NULL`,
   which every reader already handles. The launcher image gets **no
   backfill at all**: the browser used to choose its object key, so nothing
   in the stored URL proves which key belongs to this workspace. Those rows
   keep rendering from the legacy URL until an operator re-uploads.
2. Adds ownership `CHECK` constraints, so a key naming another tenant is
   unrepresentable in the schema and not only in the resolver. The two new
   columns' constraints are validated (`contacts` because the backfill
   provably satisfies it, `widget_settings` because it starts empty); the
   pre-existing key columns get `NOT VALID` constraints, which still enforce
   the rule on every new INSERT/UPDATE while the legacy-migration job works
   through historical rows.

It deliberately does **not** clear the now-derived `*_url` columns. Deployment
order is `189 → 190 → backend → frontend`, so for the length of the deploy the
old code is still reading them. Dropping them is a separate, later migration,
once no running code reads a stored URL.

## Promotion requires a URL-capable vendor

Because no row holds a URL, a primary that cannot express one would blank every
avatar and logo platform-wide, with nothing left to repair. So a vendor is kept
out of the primary slot unless `describeUrlCapability()` — a real probe of the
same derivation the read paths use — produces an absolute `http(s)` URL. This
is **not** bypassable with `force`: `force` trades away completeness of the
mirrored data for availability, while this would trade away the links
themselves.

Today that means `gcs` and `azure_blob` (routed to the S3 upload handler for
interop, but with no URL builder) and a `local` provider with no `public_url`
cannot be promoted. They may still be configured as mirrors. The pool listing
exposes `canServePublicUrls` so the admin screen can say so up front.

## If you are adding an upload

1. Build the key with a builder in `server/services/storage/keys.ts`. Never
   interpolate a path yourself.
2. Persist **the key**. If the table has a legacy `*_url` column, write `null`
   to it in the same statement.
3. Derive the link for the response and for every read path through
   `createStorageUrlResolver()`, scoped to the request.
4. Do NOT add a URL field to the feature's settings schema. The upload
   endpoint is the only mutation; the settings schema stays `.strict()` and
   image-free.
5. Add the column to the migration map above, and to the forbidden-assignment
   and closed-input lists in `src/test/storage/keyOnlyStructuralGuard.test.ts`.
