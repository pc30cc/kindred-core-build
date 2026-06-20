# Contacts Plan Model

Status: **plan-modeled, not enforced**.

This phase adds Contacts as a first-class plan surface in the central
capability registry so Super Admin can toggle Contacts behavior per
plan through the existing registry-driven Plans UI. No route gating
was rolled out and no numeric limits were added.

## 1. What "Contacts" means in this repo

A **contact** is a saved record in the `public.contacts` table
(workspace-scoped, with `name`, `email`, `phone`, `tags text[]`,
free-form `notes`, and a `metadata` JSON for company/score/location).

It is **distinct** from:

- `visitor_sessions` / `visitor_presence` — anonymous tracked visitors,
  modeled separately under the `visitor_tracking` module.
- `identity_merges` — widget-side identity reconciliation, not a
  user-facing contacts feature.
- `auth.users` / `profiles` — operator/admin accounts.

The user-facing surface is:

- `src/pages/app/ContactsPage.tsx` — directory list with search, tag
  filter, sort, multi-select bulk delete, CSV import, CSV export.
- `src/pages/app/ContactDetailPage.tsx` — detail view with editable
  name/email/phone/tags/notes plus linked conversations.
- `src/features/contacts/ContactDrawer.tsx` and
  `ContactImportWizard.tsx` — drawer + CSV import wizard
  (`parseCSV` + `useBulkCreateContacts`).
- `src/hooks/useContacts.ts` — CRUD hooks against `public.contacts`.

## 2. Registry additions (this phase)

Added to `server/services/billing/capabilityRegistry.ts`:

| Key                    | Type    | Group    | Default | Notes                                                              |
|------------------------|---------|----------|---------|--------------------------------------------------------------------|
| `contacts`             | module  | modules  | `true`  | Top-level Contacts directory.                                      |
| `contact_import`       | feature | contacts | `false` | CSV import wizard (`ContactImportWizard`).                         |
| `contact_export`       | feature | contacts | `false` | CSV export (`exportContactsToCSV`).                                |
| `contact_tags`         | feature | contacts | `true`  | Tag editing, tag filter, tag display.                              |
| `contact_notes`        | feature | contacts | `true`  | Free-form `notes` field on contact records.                        |
| `bulk_contact_actions` | feature | contacts | `false` | Multi-select bulk operations (currently bulk delete).              |

All keys are `planConfigurable: true`, `workspaceOverridable: true`,
`userVisible: true`. They surface automatically in the registry-driven
Super Admin Plans UI; no UI rewrite was needed.

## 3. Intentionally NOT added

| Candidate                  | Why deferred                                                                 |
|----------------------------|------------------------------------------------------------------------------|
| `contact_segments`         | No segment entity, table, or UI exists in the repo.                          |
| `custom_contact_fields`    | `metadata` JSON exists, but there is no custom-field schema or editor UI.    |
| `contact_merge_dedupe`     | Identity merging exists at the widget level (`identity_merges`), not as a contacts feature. No merge UI on `ContactsPage`. |
| `contact_activity_timeline`| Detail page already shows linked conversations; no separate "activity" surface to gate. |

These can be added in a later phase if/when the corresponding product
surface lands. Adding them now would create plan keys with no
consumer, breaking the registry's "key implies real surface" rule.

## 4. Numeric limits — intentionally deferred

No numeric Contacts limit was added.

- The legacy `billing_plans.limits` seed JSON contains a `contacts`
  key (e.g. `100` / `5000` / `-1`). It is **not** promoted to the
  registry in this phase because:
  - There is no usage resolver for it in
    `server/services/billing/usageResolvers.ts`.
  - There is no `requireLimit('max_contacts', ...)` consumer.
  - Promoting it now would force resolver + counter + enforcement
    work, which is out of scope for an additive plan-modeling pass.
- `max_segments`, `max_tags_per_contact`, `max_custom_contact_fields`,
  `max_import_rows_per_job` — not added; no underlying entity or
  enforcement boundary exists.

If a future phase wants to enforce `max_contacts`, the natural counting
path is `select count(*) from public.contacts where workspace_id = $1`,
with the creation boundary being `useCreateContact` /
`useBulkCreateContacts` (and any server route added later).

## 5. Candidate enforcement boundaries (for a later phase)

These are documented for the future enforcement phase. **No gating is
applied today.**

| Capability             | Candidate boundary (creation/mutation)                                | Read-only / cleanup (must stay open) |
|------------------------|-----------------------------------------------------------------------|--------------------------------------|
| `contacts` (module)    | Whatever server route eventually backs `useCreateContact`.            | List / detail reads, deletion.       |
| `contact_import`       | The bulk-insert path used by `ContactImportWizard`.                   | n/a.                                 |
| `contact_export`       | A future server-side export endpoint, if introduced.                  | n/a (pure client export today).      |
| `contact_tags`         | Tag write paths (update with non-empty `tags` array).                 | Reading existing tags must stay open. |
| `contact_notes`        | Notes write paths.                                                    | Reading existing notes must stay open. |
| `bulk_contact_actions` | Bulk-mutation endpoints (e.g. bulk delete).                           | Single-record delete remains open.   |

Today the contacts UI talks to Supabase directly via PostgREST
(`supabase.from('contacts')...`) — there is no `server/routes/contacts.ts`.
Enforcement therefore requires either:

1. Introducing a thin server route for create/import/bulk paths and
   gating it via `requireModule('contacts')` / `requireFeature(...)`,
   or
2. Encoding the same checks in RLS / RPC.

Either choice is a real architectural decision and is **explicitly
deferred**.

## 6. Backward compatibility

- No existing capability key was renamed.
- No route, env var, schema, or middleware contract was changed.
- The new keys are additive; plans that do not list them fall back to
  registry defaults via the existing effective-entitlement resolution.
- `USAGE_BACKED_LIMIT_KEYS` is unchanged; resolver alignment tests
  continue to pass.