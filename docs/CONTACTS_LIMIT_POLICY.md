# Contacts Limit Policy (`max_contacts`) — Readiness Audit

Status: **`max_contacts` still deferred — not added to the capability registry,
not enforced. The create/import boundary now exists as DB-side SECURITY
DEFINER RPCs and is wired up in the UI, ready to host the limit when it
is promoted in a follow-up phase.**

## Phase re-audit (Max Contacts Promotion + Enforcement — DB-first strict pass, with revoke approved)

The user explicitly approved a stricter pass: DB-first enforcement only,
with permission to `REVOKE INSERT ON public.contacts FROM authenticated`
if that is what's required to make enforcement bypass-safe. The
approval was conditional: "اگر در audit نهایی معلوم شد revoke کردن
authenticated INSERT یا enforce داخل RPC هنوز ambiguity یا ریسک بالایی
دارد، rollout ندهید و فقط readiness result برگردانید."

**Final audit outcome: still deferred.** The first blocker (direct DML
grant) is now removable by approval. The second blocker — absence of a
canonical SQL-side entitlement composer — remains, and is by itself
sufficient to block a bypass-safe, non-duplicating enforcement inside
the RPC. Promoting `max_contacts` and registering a resolver without
the consumer being wired into a single canonical composer would
advertise enforcement that is either (a) bypassable, (b) inconsistent
with the TypeScript composer, or (c) routed through a forbidden
architecture path. None of these meet the bar.

### Why a check inside the RPC cannot be made canonical in this phase

The effective entitlement composition for a workspace
(`billing_plans.entitlements/limits` → `workspace_subscriptions`
overrides → workspace-level overrides → registry defaults) is
implemented exclusively in TypeScript:

- `server/services/billing/index.ts` (plan lookup, free-plan fallback)
- `server/middleware/featureGating.ts` (`requireLimit`)
- `server/services/billing/usageResolvers.ts` (usage side)
- `server/services/calls/entitlementComposer.ts` (call-surface composer)

There is **no equivalent in SQL**. Migrations contain no
`effective_limit(...)` / `resolve_entitlement(...)` SQL function and no
view that produces a single composed `max_contacts` value per
workspace.

To enforce `max_contacts` inside `create_contact` /
`bulk_create_contacts`, the RPC would need to compute that value. Each
option violates a non-negotiable rule:

| Option | Violates |
| --- | --- |
| Reimplement plan + subscription + workspace-override resolution in PL/pgSQL | "هیچ second source of truth"; `docs/ENTITLEMENT_ARCHITECTURE.md` invariant that the composer is single-sourced. |
| Have the RPC call Express over HTTP from inside Postgres | DB→HTTP egress is not an approved architecture; brittle, hard to audit, opaque to the composer. |
| Move the chokepoint to a new Express contacts route and migrate the UI off PostgREST | "هیچ redesign برای … PostgREST architecture"; out of phase scope. |

Therefore the canonical, bypass-safe, single-chokepoint check that the
approval requires cannot be built in this phase without either
splitting the composer or doing redesign work that the same approval
explicitly forbids.

### Why revoke alone is not enough

`REVOKE INSERT ON public.contacts FROM authenticated` would close the
browser-side bypass and make the RPCs the only authenticated write
path. But on its own it does **not** enforce a numeric limit — it only
narrows the surface. Issuing the revoke without a real, canonical
enforcement consumer in the same phase would:

- promote `max_contacts` semantics into operator-visible plan UI while
  the value remains unenforced (advertised-but-not-enforced — the
  exact failure mode the approval forbids), or
- couple the revoke to a non-canonical check inside the RPC (the
  composer-splitting path above).

Both outcomes are strictly worse than the current state, which has a
single canonical creation chokepoint at the RPC layer and an honest
"deferred" status on the limit.

### Decisions locked in this phase (for the eventual promotion phase)

These decisions are recorded so a future approved phase does not have
to relitigate them:

- **Counting model**: live exact count, scoped by `workspace_id`,
  evaluated at the canonical enforcement point. No counter table, no
  second metric.
- **Bulk import semantics**: **all-or-nothing per `bulk_create_contacts`
  call**. If the post-insert count would exceed `max_contacts`, the
  entire batch is rejected with a structured error and zero rows
  inserted. Justification: matches existing `requireLimit(...)`
  semantics, avoids partial-success ambiguity inside a SECURITY
  DEFINER context, and produces a deterministic, machine-readable
  result (`{ inserted: 0, error: 'limit_exceeded', limit, current }`)
  that the import wizard can surface without a second counting path.
- **Free-on-delete**: hard delete of a `public.contacts` row
  immediately frees one unit of capacity. No grace period, no soft
  delete accounting.
- **Non-consuming operations**: edit, tag changes, note changes,
  attachments, and read operations do not consume capacity.
- **Internal flows**: service-role internal flows (privacy export
  anonymizer, widget identity merges, AI agent intro/spam-guard
  reads) are not user-driven create paths and do not bypass the limit
  by design — they either do not insert or they collapse existing
  rows. Any future internal flow that needs to insert MUST route
  through the same RPC (which `service_role` already has `EXECUTE`
  on) so a single check governs all create paths.

### What was NOT changed in this phase

- `CAPABILITY_REGISTRY` — no `max_contacts` entry added.
- `USAGE_BACKED_LIMIT_KEYS` / `usageResolvers.ts` — no resolver added.
- `create_contact` / `bulk_create_contacts` — no enforcement clause
  added; no migration created.
- `public.contacts` GRANTs — `INSERT` for `authenticated` is **not**
  revoked. Doing so without a canonical consumer would only narrow
  the surface, not deliver the limit, and would risk masking the
  composer-split problem.
- No SQL-side effective-limit resolver introduced.
- No UI soft check introduced.
- No second counter, second enforcement path, or parallel
  architecture introduced.

### Unblock checklist (single canonical path; in order)

The single architecturally-sound unblock path is to keep the composer
in TypeScript and route the create chokepoint through it:

1. Add a TypeScript resolver `resolveMaxContacts` (live `count(*)`
   via the service-role client, scoped by `workspace_id`) and
   register it in `usageResolvers.ts` + `USAGE_BACKED_LIMIT_KEYS`.
2. Add `max_contacts` to `CAPABILITY_REGISTRY` (group: `contacts`,
   type: `limit`, unit: `count`, occupancy semantics).
3. Introduce a thin Express endpoint
   (`POST /api/workspaces/:id/contacts` and `.../contacts/bulk`) that
   runs `requireLimit('max_contacts', usageFnForLimit('max_contacts'))`
   and then invokes `create_contact` / `bulk_create_contacts` via
   the service-role client. The RPCs remain the DB chokepoint; the
   Express route is the composer chokepoint.
4. Migrate `useCreateContact` / `useBulkCreateContacts` to call the
   new Express endpoints (replacing the direct `supabase.rpc(...)`
   calls). UI surface unchanged.
5. Only after (1)–(4): `REVOKE INSERT ON public.contacts FROM
   authenticated;` AND `REVOKE EXECUTE ON FUNCTION create_contact /
   bulk_create_contacts FROM authenticated;` so the Express route is
   the only authenticated create path.
6. Add tests: below-limit success, at-limit denial, bulk all-or-
   nothing rejection, registry/diagnostics alignment, and a closed-
   bypass assertion (direct PostgREST insert / direct RPC call from
   an authenticated JWT both fail).

Step (3)+(4) is a UI/architecture change and was therefore outside
the bounds of the current approval. It is the only path that
satisfies all four invariants simultaneously: real consumer,
bypass-safe, single canonical chokepoint, no parallel architecture.

## Phase re-audit (Max Contacts Promotion + Enforcement — RPC-Only Pass)

Re-evaluated whether `max_contacts` can now be promoted to a real
enforced limit using the RPC chokepoint. **Outcome: still deferred.**
Two independent blockers, either of which is sufficient on its own:

1. **Direct DML on `public.contacts` is still granted to
   `authenticated`.** Confirmed at audit time via `pg_class.relacl`
   (`authenticated=arwdDxtm/postgres`). A browser client holding a
   workspace-member JWT can call `supabase.from('contacts').insert(...)`
   directly under the existing RLS policies and bypass any check placed
   inside `create_contact` / `bulk_create_contacts`. The RPCs are the
   canonical path for the UI, but they are **not** the only reachable
   write path, so a check inside them is not bypass-safe.
2. **No canonical limit resolver is reachable from inside Postgres.**
   The effective-entitlement composer and `usageResolvers.ts` live in
   the TypeScript backend. There is no SQL-side equivalent. To enforce
   `max_contacts` inside the RPC we would have to re-implement
   `billing_plans.limits → workspace_subscriptions overrides → workspace
   overrides` resolution in PL/pgSQL. That would create a **second
   source of truth** for entitlement composition, which the architecture
   rules in `docs/ENTITLEMENT_ARCHITECTURE.md` explicitly forbid.

Either blocker alone forces a defer. Together they make a forced
rollout strictly worse than the current state (it would advertise
enforcement that is trivially bypassable and split the composer).

### What was therefore NOT done in this phase

- `max_contacts` was **not** added to `CAPABILITY_REGISTRY` — promoting
  a limit key without a real, bypass-safe consumer would violate the
  invariant "no registry limit without a real consumer".
- `max_contacts` was **not** added to `USAGE_BACKED_LIMIT_KEYS` and no
  resolver was added to `usageResolvers.ts` — without a consumer the
  resolver would be dead code, and registering it would silently change
  `normalizePlanLimitsForCreate` behaviour for new plans.
- No SQL effective-limit resolver was introduced — would split the
  entitlement composer.
- No `INSERT` revoke on `public.contacts` was issued — without (a) a
  resolver and (b) an enforced check in the RPC, revoking the grant
  would only narrow the surface without delivering the limit.
- No UI-side soft check was added — UI checks must never be the source
  of truth for a billing limit.

### Locked semantics for `max_contacts` (for the eventual promotion phase)

Recorded here so the next phase does not have to relitigate it:

- **Counts**: every row in `public.contacts` scoped by `workspace_id`,
  regardless of how it was created (UI RPC or service-role internal
  flow).
- **Does not count**: edits, tag changes, note changes, attachments,
  read operations.
- **Frees capacity**: hard delete of a `public.contacts` row.
- **Imports**: each successfully inserted row consumes one unit; rows
  rejected by validation do not consume.
- **Identity merges**: must not double-count. The merge path collapses
  rows; net change to `count(*)` is what counts.
- **Period**: occupancy (current row count), not monthly throughput.
  Group: `usage`. Unit: `count`.

### Counting model (decision recorded, not implemented)

When the blockers above are removed, the canonical model will be a
**live exact count inside the RPC**:

```sql
SELECT count(*) FROM public.contacts WHERE workspace_id = _workspace_id;
```

Justification: `public.contacts` is workspace-scoped and indexed on
`workspace_id`; expected cardinality (≤ plan default, e.g. low
thousands) makes an exact count cheap. A counter table would be a
second source of truth for an occupancy metric that is already exact in
the source table. Bulk import behaviour will be **all-or-nothing per
batch** (the entire `bulk_create_contacts` call is rejected if the
resulting count would exceed the limit) — this matches existing
`requireLimit(...)` semantics and avoids partial-success ambiguity in a
SECURITY DEFINER context.

### Bypass / internal-flow policy (decision recorded)

Service-role flows (privacy export anonymizer, widget identity merges,
AI agent intro/spam-guard reads) **do not** bypass `max_contacts` by
design — they either do not insert contacts, or they collapse existing
rows. If a future internal flow needs to insert, it will route through
the same RPC (which `service_role` already has `EXECUTE` on) so a
single check governs all create paths.

### Unblock checklist (in order, for a future approved phase)

1. Add a TypeScript-side `resolveMaxContacts` (live `count(*)` via the
   service-role client) and register it in `usageResolvers.ts`.
2. Add `max_contacts` to `CAPABILITY_REGISTRY` and to
   `USAGE_BACKED_LIMIT_KEYS`.
3. Make the `create_contact` / `bulk_create_contacts` RPCs call out to
   a single Express enforcement endpoint **or** introduce a thin Express
   contacts-create proxy that runs `requireLimit('max_contacts', ...)`
   before invoking the RPC. Decide that explicitly in the next phase —
   do not split the composer into SQL.
4. Only after (1)–(3): `REVOKE INSERT ON public.contacts FROM
   authenticated;` to close the bypass.
5. Surface in usage diagnostics.

## Boundary status (updated)

- `public.create_contact(...)` — SECURITY DEFINER RPC. Verifies
  `auth.uid()` and `is_workspace_member`. Inserts a single row into
  `public.contacts`.
- `public.bulk_create_contacts(_workspace_id, _contacts jsonb)` —
  SECURITY DEFINER RPC. Same auth/membership check. Returns
  `{ inserted }`.
- Both functions: `REVOKE ALL FROM PUBLIC`, `GRANT EXECUTE TO
  authenticated, service_role`. `search_path = public`.
- UI hooks `useCreateContact` and `useBulkCreateContacts` now call these
  RPCs. No other UI paths insert contacts.
- **Backward-compat**: existing `INSERT` GRANT on `public.contacts` is
  intentionally **not** revoked. Server-side flows (widget identity
  merge, callWidget continuity, privacy export, AI agent, spam guard)
  use the service-role client and are unaffected. A future phase, gated
  on explicit approval, may revoke the direct `INSERT` grant from
  `authenticated` to make the RPC the only path.

## Next-phase prerequisites for `max_contacts` promotion

1. Add `max_contacts` to `capabilityRegistry.ts` under the `contacts`
   group with a default that matches existing seeded plans.
2. Add the corresponding usage resolver: `SELECT count(*) FROM
   public.contacts WHERE workspace_id = $1` (delete frees capacity;
   edits/tags/notes do not consume; identity merges must not
   double-count).
3. Inside both RPCs, after the membership check, read effective
   entitlements for the workspace and reject with a structured error
   when the count would exceed `max_contacts`.
4. Surface in usage diagnostics alongside other usage-backed limits.
5. Only after (1)–(4) are in place, consider revoking direct `INSERT`
   on `public.contacts` from `authenticated`.

This document is the readiness result for promoting `max_contacts` from
an implied/legacy concept in plan seed data into a real, usage-backed,
enforceable plan limit. It records what was audited, what was decided,
and what remains for a future phase.

It is intentionally additive: no registry keys, routes, schema, env
vars, or middleware contracts were changed in this phase.

---

## 1. What a "contact" is in this repo

A **contact** is a single row in `public.contacts`, scoped by
`workspace_id`. The canonical entity is the row itself — there is no
parallel "contact" concept elsewhere in the codebase.

Distinct from:

- `visitor_sessions` / `visitor_presence` — anonymous tracked visitors,
  modeled by the separate `visitor_tracking` module and counted by the
  visitor limit path. **Visitors are not contacts.**
- `identity_merges` — widget-side identity reconciliation, not a
  user-facing contacts feature.
- `auth.users` / `profiles` — operator/admin accounts.

A contact is created exclusively through `INSERT INTO public.contacts`.
There is no other server-side write path that materializes a contact
row.

## 2. How contacts are created today

All contact creation happens **directly from the browser via PostgREST
/ supabase-js**, not through an Express route:

- `src/hooks/useContacts.ts`
  - `useCreateContact` → `supabase.from('contacts').insert(...)`
  - `useBulkCreateContacts` → bulk `insert([...])` (used by the CSV
    import wizard in `src/features/contacts/ContactImportWizard.tsx`)
- `useUpdateContact` / `useDeleteContact` / `useBulkDeleteContacts`
  also speak directly to PostgREST.

There is **no `server/routes/contacts.ts`**. Repo grep confirms zero
server routes touch `public.contacts` for create/update/delete on
behalf of operators.

The only server-side code that touches `public.contacts` is internal
plumbing (privacy export/anonymizer, widget identity merges, AI agent
intro/spam-guard reads). None of those are user-facing "create a
contact" flows in the operator product.

## 3. `max_contacts` semantics (definition only)

If/when promoted, `max_contacts` MUST be defined as:

> The maximum number of rows in `public.contacts` for a given
> `workspace_id` at a single point in time (current occupancy).

Concretely:

- Counts **current rows**, not cumulative lifetime inserts.
- **Deletion frees capacity.**
- **Edits, tag changes, note changes do NOT consume capacity.**
- **Imports** consume capacity strictly through the new rows they
  create (one row = one unit).
- Future merge/dedupe surfaces, if added, must not double-count.
- Visitors, identity merges, and conversations are explicitly out of
  scope for this limit.

This is the only definition compatible with the current product
surface. No alternative (active-only, imported-only, monthly
throughput) is justified by the repo.

## 4. Enforcement architecture decision

Because the creation boundary is **PostgREST, not Express**, route-
level middleware in `server/` cannot enforce `max_contacts` for the
real product path. Anything gated only in Express would be trivially
bypassed by the existing UI, which never calls Express for contact
writes.

Classification of the viable options:

### SAFE / PREFERRED (but require explicit approval, deferred)

- **DB-side enforcement on `public.contacts`**, one of:
  - A `BEFORE INSERT` trigger that reads the workspace's effective
    `max_contacts` and raises when the new row would exceed it.
  - A SECURITY DEFINER RPC (`create_contact`, `bulk_create_contacts`)
    that performs the check, with `INSERT` on `public.contacts`
    revoked from `authenticated` so the RPC becomes the single
    creation boundary.

  Either option puts enforcement at the true creation point and
  cannot be bypassed by the existing direct-PostgREST UI.

### POSSIBLE BUT RISKY

- Introducing a brand-new `server/routes/contacts.ts` create/import
  endpoint and migrating the UI to call it. This is a product-level
  refactor (changes how `useCreateContact` / `useBulkCreateContacts`
  work) and is explicitly **out of scope** for this phase per the
  non-negotiable rules.

### DO NOT USE

- Client-side "soft" checks in `useCreateContact` / the import
  wizard. These are advisory only and trivially bypassed; they would
  also create a second, divergent counting system in the UI.
- Adding `max_contacts` to the registry **without** a real
  enforcement consumer. That would mislead Super Admin into believing
  a configured limit is enforced when it is not.

## 5. Counter / resolver readiness

A live `SELECT count(*) FROM public.contacts WHERE workspace_id = $1`
is sufficient and low-risk for the expected scale; no separate
counter table or trigger-maintained counter is needed yet. If a
counter is later introduced, it must have **one** canonical producer
(the same trigger or RPC that enforces the limit), to avoid the
multi-counter divergence that the entitlement architecture forbids.

No resolver was added in this phase because there is no consumer for
it: `USAGE_BACKED_LIMIT_KEYS` does not yet include `max_contacts`,
and adding a resolver without a consumer would create dead code.

## 6. Decision

`max_contacts` is **not promoted** to the central capability registry
in this phase. The entitlement architecture's invariant — *every
limit key in the registry has a real enforcement consumer* — would
otherwise be violated.

What WAS done in this phase:

- Audited the contacts surface and confirmed PostgREST-only creation.
- Locked the semantics of `max_contacts` (current-occupancy count of
  `public.contacts` rows, workspace-scoped).
- Identified the only safe enforcement architectures (DB trigger or
  SECURITY DEFINER RPC on `public.contacts`).
- Documented why route-level enforcement is not viable today.

What was intentionally NOT done:

- No registry change (no `max_contacts` key added).
- No new resolver, counter, or trigger.
- No new server route.
- No UI gating, soft-check, or product redesign.
- No RLS / DB schema change (those require explicit approval per the
  project's strict architecture rule).

## 7. Next phase prerequisites

To safely promote `max_contacts`, a future phase must, with explicit
approval:

1. Choose between the BEFORE-INSERT trigger and the SECURITY DEFINER
   RPC enforcement model on `public.contacts`.
2. Implement that single canonical creation boundary, including bulk
   import semantics (per-row evaluation, partial success policy).
3. Add `max_contacts` to the capability registry as a numeric limit
   with the existing limit metadata shape.
4. Wire it into `USAGE_BACKED_LIMIT_KEYS` with a single live-count
   resolver as the canonical source.
5. Add focused tests covering: at-limit insert denied, delete frees
   capacity, bulk import partial behavior, plan upgrade lifts limit.

Until step 1 has explicit approval, this limit remains deferred.
