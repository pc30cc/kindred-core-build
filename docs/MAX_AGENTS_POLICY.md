# Max Agents — Seat Limit Policy & Rollout Audit

_Last updated: 2026-06-22 (Workspace Member Write Boundary phase).
Status: **canonical Express seat-creation boundary has now landed —
`max_agents` enforcement still deferred, but the remaining blocker is
narrower (RPC bypass) rather than "no boundary exists at all."**_

This is the deliverable of the _Max Agents Resolver + Consumer + Legacy
Alias Migration Readiness_ phase. The phase's strict objective is to
turn `max_agents` from an inert canonical limit into a real
enforced usage-backed limit, **only if** a real semantics + chokepoint
pair can be locked safely. After audit, that bar is not met yet, and
per the phase rules ("Prefer one honest defer over one fake
max_agents rollout") rollout is deferred with an explicit unblock
matrix.

No middleware, no resolver, no route, and no plan row was changed in
this phase.

---

## 1. Semantics audit — what counts as an "agent"?

### 1.1 Candidate entities found in the repo

| Entity | Storage | Created where | Classification |
|---|---|---|---|
| Row in `workspace_members` | `public.workspace_members(workspace_id, user_id, role, …)` | **Frontend-only** mutation (TeamPage, StaffAccessPage, TeamDepartmentsPage) and presumably a DB-side handler when an invite is redeemed. No Express route inserts into this table. | **CANONICAL AGENT ENTITY (candidate)** — the only durable per-workspace seat record. |
| Row in `workspace_invitations` | `public.workspace_invitations(workspace_id, role, invited_email, token, max_uses, expires_at, …)` | `src/pages/app/TeamPage.tsx` lines 187–211 (frontend `supabase.from('workspace_invitations').insert(...)`). | **RELATED BUT NOT COUNTED.** A token, not a seat. Pending invites do not consume capacity until they are redeemed and a `workspace_members` row appears. |
| Row in `workspace_department_members` | per-department assignment | callCenter / departments services | **NOT COUNTED.** Department membership is a sub-grouping inside the seat; one user across N departments is one seat. |
| Row in `account_members` | account-level (cross-workspace billing scope) | account routes | **NOT COUNTED for `max_agents`.** That is an account-billing concept, not a workspace seat. |
| Row in `call_center_department_agents` / `call_participants` / call routing helpers | call-routing read paths | `server/services/calls/*`, `server/services/callCenter/*` | **NOT COUNTED.** These are read-side helpers that select existing operators; they do not create seats. |
| `profiles` row | `public.profiles` | auth signup | **NOT COUNTED.** A profile may exist without any workspace membership; profiles are global, seats are per-workspace. |

### 1.2 Role taxonomy — currently ambiguous

Live data (2026-06-22): `SELECT role, COUNT(*) FROM workspace_members
GROUP BY role` returns **only `owner`**. No `agent`, `operator`,
`admin`, or other role is present in shipped data. The
`workspace_members.role` column is therefore not yet a reliable
filter for "operator/agent" vs "admin" — there is no shipped
evidence of a multi-role seat policy.

Consequence: **every shipped workspace member today is an owner**.
Filtering "agents" by role would either count zero seats (if
`role IN ('agent','operator')`) or every member (if no filter). Both
are wrong, and neither matches a clear product decision.

### 1.3 Seat-creation moment — not visible in Express

Exhaustive search:

- `rg "from\('workspace_members'\)" server/` returns **no INSERT** in
  any Express route. All matches are SELECT-only (read paths in
  `permissions.ts`, `routing.ts`, `departments.ts`, `aiKb`,
  `operatorPresence`, `privacy/exporter`, `usageResolvers`).
- `rg "from\('workspace_invitations'\)" server/` returns nothing —
  the table is not used by the Express layer at all.
- The only INSERT into `workspace_invitations` is in the frontend
  (`src/pages/app/TeamPage.tsx`), going directly through the
  Supabase JS client under RLS.
- The actual `workspace_members` INSERT (when an invite is redeemed)
  is not visible in either layer; it is presumably triggered by a DB
  function or a Supabase auth handler reached when the user follows
  the `/auth/invite?token=…` link. That path does not currently flow
  through `featureGating.ts` middleware.

**There is no Express boundary today where `requireLimit('max_agents',
…)` can be installed without first introducing a new server endpoint
that owns the seat-creation moment.**

> **Update — Workspace Member Write Boundary phase, 2026-06-22.**
> The Express boundary now exists:
> `POST /api/workspace-members/accept-invitation`
> (`server/routes/workspaceMembers.ts`). It forwards the user's JWT
> into a scoped Supabase client and calls the existing
> `accept_workspace_invitation` SECURITY DEFINER RPC verbatim, so
> `auth.uid()` semantics are preserved. The frontend
> `src/pages/auth/InvitePage.tsx` was migrated to call this route
> instead of `supabase.rpc('accept_workspace_invitation', ...)`
> directly. Read/update/delete team flows are intentionally
> untouched (StaffAccessPage, TeamDepartmentsPage, the TeamPage
> member-listing query, and frontend `workspace_invitations.insert`
> for token creation all remain as-is).
>
> The boundary exists, but **`requireLimit('max_agents', …)` is not
> mounted yet** — see §4.1 below for the residual bypass that keeps
> rollout deferred.

### 4.1 Residual bypass (still blocking max_agents enforcement)

The new Express route is **not yet the only path** to the underlying
RPC. By default, Supabase grants `EXECUTE` on `public` functions to
the `authenticated` role, so any logged-in user can still call
`supabase.rpc('accept_workspace_invitation', { _token: ... })`
directly from the browser. Mounting
`requireLimit('max_agents', usageFnForLimit('max_agents'))` on the
Express route alone would be circumventable — and the phase rule
"Do not bolt max_agents onto a fake or partial consumer" applies.

**Unblock criterion (now reduced to one narrow change):** revoke
`EXECUTE` on `public.accept_workspace_invitation(text)` from the
`authenticated` role, leaving it executable only via the service
role / SECURITY DEFINER call from the Express route. After that
migration ships:

1. Register `resolveMaxAgents` in `server/services/billing/usageResolvers.ts`.
2. Mount `requireLimit('max_agents', usageFnForLimit('max_agents'))`
   on `POST /api/workspace-members/accept-invitation`.
3. Run the `team_members / agents → max_agents` seed migration —
   now mechanical (see `docs/PLAN_DATA_RECONCILIATION.md` §6).

No further architectural work is required between today and that
three-step rollout.

---

## 2. Locked semantics (for the future rollout)

The semantics below are the policy `max_agents` will enforce **once**
the chokepoint exists. Locking them now keeps the future migration
mechanical.

1. **Counted entity:** one row in `public.workspace_members` per
   `workspace_id`. One unique `(workspace_id, user_id)` pair = one
   seat. (Departments do not multiply seats.)
2. **Occupancy, not throughput:** `max_agents` is a current-occupancy
   limit — not a per-month creation count. Removing a seat
   immediately frees capacity.
3. **Pending invitations do NOT consume capacity.** Capacity is
   consumed only at the moment a `workspace_members` row is created
   (i.e. the invite is redeemed).
4. **Role filter:** until a multi-role taxonomy is shipped and
   product-locked, **all** `workspace_members` rows count. If
   `(workspace_id, user_id)` exists, it counts as a seat regardless
   of `role`. This is the only role policy supported by current
   shipped data.
5. **`-1` means unlimited** — same semantic as every other registry
   limit.
6. **Workspace owner counts.** The owner is one of the seats; carving
   them out would require a separate "owner is free" product
   decision that has not been made.

---

## 3. Counting model (chosen, not yet wired)

**Live exact count.** Same shape as `max_contacts`:

```ts
const { count, error } = await sb
  .from('workspace_members')
  .select('*', { count: 'exact', head: true })
  .eq('workspace_id', workspaceId);
```

No counter table, no trigger, no shadow column. Member tables are
small (worst case dozens of rows per workspace), the query is
indexed on `workspace_id`, and a delete-frees-capacity invariant
falls out of the query naturally — exactly what `max_agents`
requires.

No second seat-counting system will be introduced.

---

## 4. Canonical enforcement chokepoint (deferred)

The smallest safe boundary is a **server-owned seat-creation
endpoint**. Today this does not exist. The closest candidates and
why none are usable today:

| Candidate | Reason it cannot be gated today |
|---|---|
| Frontend `workspace_invitations.insert(...)` in `TeamPage.tsx` | Bypasses Express entirely (Supabase JS client + RLS). `requireLimit` is Express-only middleware. Also: invitations are tokens, not seats — gating here would deny capacity at the wrong layer. |
| Frontend `workspace_members.delete(...)` in TeamPage / StaffAccessPage / TeamDepartmentsPage | Removal, not creation. Should not be gated; it frees capacity. |
| Invite-redemption (`/auth/invite?token=...`) | Not visible in Express. The `workspace_members` INSERT happens at the DB / Supabase-handler layer, outside `featureGating.ts`. |
| Department add (`workspace_department_members` insert) | Sub-grouping; not a seat boundary. Gating here would conflate two policies. |

**Unblock criterion:** introduce one new Express route — e.g.
`POST /api/workspace/:id/members` (used by invite-redemption AND any
admin-add path) — that performs the canonical
`workspace_members` INSERT. Mount `requireLimit('max_agents',
usageFnForLimit('max_agents'))` on that route. At that point §3's
resolver becomes live and §2's semantics become enforced.

Until then: any `requireLimit('max_agents', …)` middleware would
have nowhere to attach, or would attach to the wrong layer (token
creation, deletion, sub-grouping).

---

## 5. Rollout actually applied this phase

- **Documentation only.**
  - This doc (`docs/MAX_AGENTS_POLICY.md`) added.
  - Cross-references added in `docs/PLAN_DATA_RECONCILIATION.md`,
    `docs/PLANS_SYSTEM_HANDOFF.md`, and
    `docs/ENTITLEMENT_ARCHITECTURE.md`.
- **No resolver added.** `resolveMaxAgents` is intentionally not
  registered in `usageResolvers.ts`. Adding an unconsumed resolver
  would create the false impression that `max_agents` is enforced.
  The existing `KNOWN_UNSUPPORTED.max_agents` rationale is updated
  in tandem to point at this doc.
- **No middleware change.** No route was gated.
- **No plan-row mutation.** `team_members` and `agents` legacy
  aliases stay exactly as catalogued in
  `docs/PLAN_DATA_RECONCILIATION.md` §2.2.
- **No tests added.** Per the phase rules ("Add focused
  deterministic tests only if resolver/consumer/enforcement is
  added") no behavior changed, so no new test is owed.

### Update — Workspace Member Write Boundary phase, 2026-06-22

- **Express route added:**
  `server/routes/workspaceMembers.ts` →
  `POST /api/workspace-members/accept-invitation`. Mounted at
  `/api/workspace-members` in `server/index.ts`. Narrow: seat
  creation only, no other CRUD.
- **Frontend migrated:** `src/pages/auth/InvitePage.tsx` now calls
  the Express route via `fetch` with the user's access token. The
  prior `supabase.rpc('accept_workspace_invitation', ...)` call from
  this page is gone.
- **Resolver still NOT registered.** Per the residual-bypass
  argument in §4.1.
- **No middleware gating yet.** The route is a pure pass-through
  chokepoint waiting for the RPC EXECUTE revoke.
- **No plan-row mutation.** Seed migration still gated on §4.1
  unblock criterion.
- **Tests added:**
  `src/test/billing/workspaceMembersAcceptInvitation.test.ts` —
  8 cases covering auth, body validation, JWT-scoped client
  construction, RPC error mapping, and an explicit assertion that
  no `requireLimit`-style middleware is on the route yet (so the
  defer is fail-loud, not implicit).

---

## 6. Legacy alias migration readiness

`team_members` and `agents` (in `billing_plans.limits`) remain legacy
aliases of the same conceptual limit — but the migration is **not yet
mechanical**. Two blockers must clear in order:

1. **(this phase, done)** Lock `max_agents` semantics + counting
   model (§§2–3 above). ✅
2. **(future phase, blocked)** Land an Express seat-creation route
   that owns `workspace_members` INSERT, then gate it with
   `requireLimit('max_agents', usageFnForLimit('max_agents'))` and
   register `resolveMaxAgents` in `usageResolvers.ts`. ❌
3. **(after #2)** Run a one-shot SQL `UPDATE billing_plans` that
   copies `limits->'team_members'` (or `limits->'agents'` for free)
   into `limits->'max_agents'`. Leave the legacy keys in place for
   one release. Diagnostics will then show the canonical key
   present and the legacy key as a soft warning, identical to the
   `contacts` pattern documented in
   `docs/PLAN_DATA_RECONCILIATION.md`.

Step 3 is mechanical now (mapping is high-confidence: same
occupancy semantic, same `-1`-means-unlimited semantic, identical
per-plan values where present). It is gated on step 2 only because
running step 3 first would lift Pro/Enterprise from the registry
default of 1 seat to 10 / unlimited without an enforcement path —
i.e. customers would see a higher limit in the UI but the limit
would still be unenforced.

---

## 7. Backward-compatibility safeguards still in force

- `validatePlanPayload` continues to soft-warn on `team_members` and
  `agents` (pinned by `src/test/billing/legacyPlanKeys.test.ts`).
- `KNOWN_UNSUPPORTED.max_agents` still surfaces in
  `usageFnForLimit('max_agents')` callers — no caller silently
  receives 0 occupancy.
- No registry key, route, env var, schema column, or middleware
  contract was renamed.
- Customer-facing `/api/plans/workspace/:id/effective` payload is
  unchanged: `max_agents` still falls through to the registry
  default 1.

---

## 8. Hard acceptance checks (re-verified 2026-06-22)

- [x] No canonical capability key renamed.
- [x] `max_agents` is **not** "implemented" — rollout was honestly
      deferred with explicit unblock criteria.
- [x] Only one counting model is locked (live exact count); no
      second seat-count system was introduced.
- [x] No customer-facing behavior changed.
- [x] Legacy alias migration is **not** done. The defer is explicit.
- [x] No route / env / schema / key rename occurred.
- [x] The repo is more ready for `team_members / agents → max_agents`
      reconciliation than before: semantics, counting model, and
      unblock criteria are now locked in writing.