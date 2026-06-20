# Contacts Limit Policy (`max_contacts`) — Readiness Audit

Status: **deferred — not added to the capability registry, not enforced.**

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
