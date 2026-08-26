# GoTrue-Off Final Static Audit

Mechanical grep sweep of runtime source (`src/`, `server/`, `public/widget/`)
and both migration chains (`database/migrations/`, `supabase/migrations/`)
for every pattern named in the closure-pass instructions. `node_modules`
and `.d.ts`/vendor SDK files are excluded — those are the Supabase JS SDK's
own source, not this application's code, and are inert unless called.

Search commands used (repeated per pattern, with `--include="*.ts"
--include="*.tsx"`, `grep -v node_modules`, `grep -v "/test/"` for the
runtime-only pass, then a separate pass for `/test/` and `database
migrations|supabase/migrations`):

```
grep -rn "<pattern>" src server --include="*.ts" --include="*.tsx"
grep -rl "<pattern>" database/migrations supabase/migrations
```

## Classification key

- **RUNTIME-SAFE / COMMENT-ONLY** — the string appears only inside a
  comment, explaining why code was migrated away from it. No executable
  reference.
- **THIRD-PARTY** — belongs to an unrelated external system (OpenAI,
  LiveKit, a payment gateway, an email provider, Mapbox) that has its own
  independent Bearer/token scheme. Not Supabase Auth.
- **MIGRATION-ONLY** — appears in SQL migration source. One-time or
  structural; does not run as part of the live application request path.
- **FIXTURE-ONLY** — appears in a test file's fake-DB fixture data or mock
  setup, not in application code under test.
- **DEAD-BUT-SHIPPED** — a migration-defined DB object (RPC, table) that
  still physically exists because migrations are forward-only and not
  retroactively edited, but has zero runtime callers.

---

## `supabase.auth.*`

**Runtime (`src/`, `server/`, excluding tests):** 0 occurrences.

**Test files:** 1 file references the string in a mock/spy context
(exercising the throwing-Proxy negative control in
`goTrueOffSupabaseAuthThrows.test.ts` — FIXTURE-ONLY, deliberately proves
the absence).

**`public/widget/*.js`:** 0 occurrences.

Verdict: **closed.** Confirmed by `goTrueOffSupabaseAuthThrows.test.ts`,
which mocks both browser Supabase client import paths so `.auth` throws on
any property access, then calls 14 representative functions from the
item-8-migrated client modules — none touch it.

## `sb.auth.*`

5 occurrences, all in `server/`: `services/auth/impersonation.ts`,
`services/auth/identity.ts`, `lib/workspaceAuth.ts`, `routes/auth-email.ts`,
`routes/auth.ts`. Read each — all are comments stating the opposite
("`sb.auth.getUser()` / GoTrue is no longer this codebase's root of
trust", "No `sb.auth.admin.*` call anywhere in this path"). **RUNTIME-SAFE
/ COMMENT-ONLY.**

## `auth.users`

39 total occurrences (`src`/`server`/migrations combined).

- `server/` (4 files: `services/auth/identity.ts`, `routes/auth-email.ts`,
  `routes/account.ts`, `routes/auth.ts`) — all comments documenting that
  `auth.users` is NOT read/written at runtime. **RUNTIME-SAFE /
  COMMENT-ONLY.**
- `src/test/` (2 files) — `legacyEmailVerificationBackfill.test.ts` and
  `emailVerificationPolicy.test.ts` reference it as static-SQL-assertion
  text and fixture column names respectively. **FIXTURE-ONLY.**
- `database/migrations/` + `supabase/migrations/` (20 files across both
  chains) — two categories:
  - Schema-definition FKs (`001_core_tables.sql`, `002_workspace_features.sql`,
    `003_visitors_kb_config.sql`, `014_core_security_definer_acl_lockdown.sql`,
    `024_user_credentials.sql`, `027_profiles_phone.sql`, and hosted
    equivalents): `REFERENCES auth.users(id) ON DELETE CASCADE`.
    **MIGRATION-ONLY / SCHEMA-STRUCTURAL** — a Postgres foreign-key
    constraint against the `auth.users` table, which is part of the
    Postgres schema Supabase provisions and is independent of whether the
    GoTrue *service* (the auth API process) is running. Disabling GoTrue
    does not drop this table or these constraints.
  - One-time backfill/FK-repoint (`026_identity_root_profiles_not_auth_users.sql`,
    `029_backfill_legacy_email_verification.sql`, hosted equivalents):
    explicitly audited and documented as migration-time-only reads in the
    item-1 pass of this closure. **MIGRATION-ONLY**, exactly the kind the
    instructions call out as acceptable ("migration-time dependency is
    different from runtime dependency").

## `auth.sessions`

5 occurrences:

- `server/routes/account.ts` — **fixed in this pass**: line 468's comment
  was stale, claiming the route "read[s] directly from Supabase's managed
  `auth.sessions` table" when the code beneath it has read
  `public.auth_sessions` since item 3. Corrected to describe the actual
  first-party table.
- `src/pages/app/settings/SecurityPage.tsx` — **fixed in this pass**: same
  stale claim in the file header comment, corrected.
- `src/test/security/accountSessionsRoutes.test.ts` — describes, in a
  comment, what the route used to depend on before item 3's migration.
  **FIXTURE-ONLY / COMMENT.**
- `database/migrations/019_account_auth_session_rpcs.sql` +
  `supabase/migrations/20260811152457_....sql` — define
  `account_list_auth_sessions`/`account_revoke_auth_sessions`, RPCs that
  queried Supabase's `auth.sessions`. Grepped for callers
  (`account_list_auth_sessions|account_revoke_auth_sessions`) across
  `server/` and `src/`: zero runtime call sites remain (only comments and
  the auto-generated `src/integrations/supabase/types.ts` type
  declaration, which declares the RPC's TypeScript signature but invokes
  nothing). **DEAD-BUT-SHIPPED** — the RPCs still exist in the database
  because migrations are forward-only, but no code path calls them.

## `signInWithPassword`

0 occurrences in runtime `src/`/`server/` (excluding the deleted legacy
provider, which no longer exists in the tree).

## `onAuthStateChange`

4 occurrences, all first-party: the `AuthProvider` interface declaration
(`src/types/providers.ts`), a no-op warning stub for unimplemented
providers (`src/providers/stubs/index.ts`), the first-party
implementation — a plain in-memory `Set` of listeners with zero Supabase
involvement (`src/providers/selfHosted/auth.ts:142-145`) — and its sole
caller, `AuthContext.tsx`, which resolves the ACTIVE provider through
`useAuthProvider()`. Since item 9 deleted the 'supabase' auth
registration, the active provider can only ever be `self-hosted`.
**RUNTIME-SAFE / FIRST-PARTY.**

## `Authorization: Bearer`

22 files outside tests, all confirmed **THIRD-PARTY**: AI provider API
keys (`services/ai/index.ts`, `services/ai-agent/embeddings/openai.ts`),
CDN provider tokens (`services/cdn/index.ts`), LiveKit admin/webhook JWT
auth (`services/calls/livekitTwirp.ts`, `routes/livekitWebhook.ts` — the
explicitly-named exception in the closure instructions), 7 payment-gateway
providers (Stripe, PayPal, Paddle, LemonSqueezy, PayPing, Iranpardakht),
and 2 email providers (Resend, SendGrid). None reference Supabase.

## `access_token` / `refresh_token`

Combined 8 non-test files, all **THIRD-PARTY or generic**:
- Mapbox provider config field name (`features/providers/schemas.ts`,
  `VisitorIntelligenceSection.tsx`, `services/maptiles/index.ts`) —
  Mapbox's own API convention, unrelated to Supabase.
- PayPal OAuth token (`services/billing/providers/paypal.ts`).
- Generic URL/query-string secret-redaction allowlists
  (`services/ai-agent/retrievalHybrid.ts`, `routes/widget.ts`,
  `lib/redactSecrets.ts`) — these are defensive logging filters that strip
  *any* URL parameter matching common secret-token names before writing to
  logs; they don't read or depend on a Supabase session, they scrub for
  one generically alongside `password`, `client_secret`, etc.

## `auth.uid()`

121 total occurrences.

- `server/routes/*.ts` (9 files) and `src/hooks/*.ts` + 2 page files (11
  files) — every single occurrence is a comment explaining that a route or
  hook used to rely on `auth.uid()`-scoped RLS and was migrated to
  service_role + explicit authorization. **RUNTIME-SAFE / COMMENT-ONLY.**
- `src/test/` (5 files) — comment/fixture references describing the same
  history. **FIXTURE-ONLY.**
- `database/migrations/` + `supabase/migrations/` (95 occurrences) — RLS
  policy definitions (`USING (auth.uid() = ...)`, `has_role(auth.uid(),
  ...)`, etc.) throughout the schema. **MIGRATION-ONLY / DORMANT RLS** —
  these policies are still defined in Postgres but are inert for this
  application's traffic, because every runtime code path in `server/`
  uses `service_role` (which bypasses RLS entirely) rather than the anon/
  authenticated key with a real Supabase JWT. They remain as a defense-in-
  depth layer that would only matter if something somehow presented a
  live Supabase Auth JWT again — a path this closure pass has audited and
  closed (item 9). They are not deleted because dropping RLS policies is
  out of scope for an auth-migration pass and touches database security
  posture unrelated to GoTrue specifically.

## `auth.jwt()`

0 occurrences anywhere in the repository.

---

## Summary

| Pattern | Runtime app-auth dependency? |
|---|---|
| `supabase.auth.*` | **No** — zero occurrences, proven by a throwing-mock test |
| `sb.auth.*` | No — comments only |
| `auth.users` | No — comments + migration-only (schema FKs, one-time backfill) |
| `auth.sessions` | No — comments (2 stale ones fixed this pass) + dead-but-shipped RPCs |
| `signInWithPassword` | No — zero occurrences |
| `onAuthStateChange` | No — first-party implementation only |
| `Authorization: Bearer` | No — third-party systems only (AI, CDN, LiveKit, billing, email) |
| `access_token`/`refresh_token` | No — third-party (Mapbox, PayPal) + generic redaction filters |
| `auth.uid()` | No — comments + migration-only (dormant RLS, defense-in-depth) |
| `auth.jwt()` | No — zero occurrences |

No runtime application-authentication dependency on Supabase Auth/GoTrue
was found anywhere in `src/`, `server/`, or `public/widget/`. Every
migration-chain reference is either a structural schema FK (independent of
the GoTrue service being enabled), a one-time/backfill read explicitly
scoped and tested in item 1, or a dormant RLS policy that service_role
usage bypasses everywhere in this codebase.
