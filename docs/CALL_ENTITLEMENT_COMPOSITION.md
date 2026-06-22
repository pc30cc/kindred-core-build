# Call Entitlement Composition

Authoritative reference for how plan-level call capabilities compose
with the runtime/global/workspace call control plane.

## Two layers, one logical AND

- **Plan layer** (`server/services/billing/capabilityRegistry.ts`)
  - module: `voice_video`
  - channels: `voice`, `video`
  - module: `call_center`
  - features: `call_recording`, `call_queue`, `call_callbacks`
- **Runtime layer** (`server/services/calls/controlPlane.ts`)
  - global gates on `app_runtime_config.call_control_plane`
  - workspace overrides on `workspace_provider_settings(provider_type='call')`
  - resolved as `EffectiveCallChannels` via `loadEffectiveCallChannels`

`Effective = Plan AND Runtime`. Either layer can deny; neither can
override the other. Plan denies are commercial; runtime denies are
operational (kill switches, provider availability, SLA timing).

## Canonical composer

`server/services/calls/entitlementComposer.ts` is the single place
that performs this AND. Two entry points:

- `composeCallEntitlements(plan, runtime)` — pure function, unit-tested.
- `loadEffectiveCallEntitlements(config, workspaceId)` — async wrapper
  that reads plan flags via the existing RPC layer
  (`check_module_access`, `check_channel_access`,
  `check_workspace_entitlement`) and the runtime layer via
  `loadEffectiveCallChannels`. Fail-closed on RPC errors.

Output (`EffectiveCallEntitlements`):

| Field | Plan inputs | Runtime inputs |
| --- | --- | --- |
| `voice_enabled` | `voice_video` ∧ `voice` | `voice_enabled` |
| `video_enabled` | `voice_video` ∧ `video` | `video_enabled` |
| `visitor_voice_enabled` | `voice_video` ∧ `voice` | `visitor_initiated_audio` |
| `visitor_video_enabled` | `voice_video` ∧ `video` | `visitor_initiated_video` |
| `recording_enabled` | `voice_video` ∧ `call_recording` | `recording_enabled` |
| `queue_enabled` | `call_center` ∧ `call_queue` | `queue_enabled` |
| `callbacks_enabled` | `call_center` ∧ `call_callbacks` | `queue_enabled` |

The composer never replaces `loadEffectiveCallChannels` — it consumes
it. Existing handlers that already call `loadEffectiveCallChannels`
(notably `workspaceCalls.ts`) continue to work unchanged.

## Rollout status

**Phase: Call Route Enforcement Expansion — Strict Drain-Policy Pass.**
Three operator-side create boundaries are now gated on the canonical
composer. All three deny with
`403 { error: 'plan_forbidden', capability, upgrade_required: true }`
before mutating any state. No cleanup, cancel, status, or read path
was gated.

| Route | Composed entitlement | Capability label |
| --- | --- | --- |
| `POST /api/call-invitations` | channel-scoped: `eff.voice_enabled` (audio) or `eff.video_enabled` (video) | `voice` / `video` |
| `POST /api/calls/:id/recording/start` | `eff.recording_enabled` | `call_recording` |
| `POST /api/call-center/calls/:id/recording/start` | `eff.recording_enabled` | `call_recording` |

### Drain policy (locked)

- CREATE / START / ADMIT / REQUEST may be denied by the composer.
- READ / STATUS / CANCEL / CLEAR / CLEANUP / FINALIZE must remain
  reachable for already-existing objects after a plan downgrade.

Concretely, the matching `recording/stop`, invitation `cancel`/`get`/
`list`, queue cancel, callback list/patch, and call `end`/`hangup`
routes are intentionally NOT gated. The composer is consulted only at
the moment a brand-new action is requested.

### Route audit

| Route | Class | Reason |
| --- | --- | --- |
| `POST /api/call-invitations` | **GATED** | Pure operator create boundary; channel-scoped composer. |
| `POST /:id/cancel`, `GET /:id`, `GET /` (invitations) | DO NOT GATE | Cleanup / read paths must survive downgrade. |
| `POST /api/calls/:id/recording/start` | **GATED** | Pure create; composer's `recording_enabled`. |
| `POST /api/calls/:id/recording/stop` | DO NOT GATE | Cleanup / finalize for in-flight recordings. |
| `POST /api/call-center/calls/:id/recording/start` | **GATED** | Pure create; same `recording_enabled` mapping. |
| `POST /api/call-center/calls/:id/recording/stop` (+ status) | DO NOT GATE | Cleanup / finalize. |
| `POST /api/call-queue/:workspaceId/:entryId/offer` / `accept` | DEFERRED | Acts on already-existing queue entries — denial would strand in-flight queue work. Needs a drain plan before gating. |
| `POST /api/call-queue/:workspaceId/:entryId/cancel` | DO NOT GATE | Cleanup — must always succeed. |
| `POST /api/widget/call-queue/enqueue` | **GATED** (Phase: Visitor Queue Denial Policy + Selective Gating) | Visitor-public new-action boundary. Canonical-composer gate runs **before** `enqueueCall`, so no `call_queue_entries` row is created on plan denial. Mapping: `queue_enabled=false` → `capability: 'call_queue'` (precedence); else `audio` → `eff.visitor_voice_enabled` (`capability: 'voice'`), `video` → `eff.visitor_video_enabled` (`capability: 'video'`). Stable denial: `{ error: "plan_forbidden", capability, upgrade_required: true }` (403). Strictly distinct from runtime queue/business-state denials emitted by `enqueueCall` itself (`queue_disabled` / `voice_disabled` / `video_disabled` — workspace runtime toggles, surfaced as 409) and from `invalid_body` (400). Status / cancel surfaces (`POST /api/widget/call-queue/:entryId/cancel`) remain ungated. |
| `POST /api/widget/call-queue/:entryId/cancel` | DO NOT GATE | Visitor cleanup. |
| `POST /api/call-widget/calls/request` | **GATED** | Visitor-initiated new call request. Mapped to `eff.visitor_voice_enabled` / `eff.visitor_video_enabled`. Stable denial: `{ error: "plan_forbidden", capability: "voice" \| "video", upgrade_required: true }`. Runs before any DB insert / provider resolution so no half-created call objects are stranded. |
| `POST /api/call-widget/callbacks/request` | **GATED** | Visitor-initiated new callback request. Mapped to `eff.callbacks_enabled`. Stable denial: `{ error: "plan_forbidden", capability: "call_callbacks", upgrade_required: true }`. |
| `POST /api/widget-callbacks/request` | **GATED** | Same surface mounted under the unified widget router. Mapped to `eff.callbacks_enabled` with the same denial shape. |
| `GET /api/widget-callbacks/status` | DO NOT GATE | Visitor read of own existing callback — required for cleanup / cooldown UI after a downgrade. |
| `GET / PATCH /api/callbacks/:workspaceId(/...)` | DO NOT GATE | List + status patch (includes 'cancelled' / 'completed') — cleanup. |
| `POST /api/call-center/callbacks/:id/{assign,complete,cancel}` | DO NOT GATE | All three operate on existing callback rows — cleanup / finalize. |
| `POST /api/calls/create` | **GATED** (Phase: Operator Call Route Split + Selective Gating) | Pure new-action boundary. Mixed by `call_type`; split branch-by-branch via the canonical composer — `audio` → `eff.voice_enabled` (`capability: voice_video.voice`), `video` → `eff.video_enabled` (`capability: voice_video.video`). Composer runs before `resolveEffectiveCallProvider` and the `call_sessions` insert, so no half-created sessions are stranded. Stable denial: `{ error: "plan_forbidden", capability, upgrade_required: true }` (403). |
| `POST /api/calls/:id/{accept,reject,hangup,end,token}` and `GET /api/calls/:id/state` | DO NOT GATE | Cleanup / lifecycle / read — must always remain reachable so in-flight calls can be drained after a plan downgrade. |
| `POST /api/calls/:id/invite` | DEFERRED — audited (Participant / Continuity Pass) | Single undifferentiated handler: inserts a `call_participants` row, flips `call_sessions.state` to `ringing`, and (for visitor participants on a conversation context) emits the `call:incoming` envelope. The same code path serves both **brand-new optional participant adds** and **re-ring / recovery / rejoin** of an in-flight participant — there is no schema, body field, or branch in the route that distinguishes the two. Per the deny-on-create / allow-on-continuity policy, gating the whole route would strand active-call continuity (re-ring after a transport hiccup, mid-call additional invitee). No safe sub-branch can be isolated without a route-level participant-class signal (e.g. an explicit `reason: 'new' \| 'reissue'` or an idempotency contract on `call_participants`). Honest defer; no rollout. Mapping that *would* apply if a safe new-participant branch is later separated: audio session → `eff.voice_enabled`, video session → `eff.video_enabled`. |
| `POST /api/call-center/calls/:id/{accept,reject,end}` | DO NOT GATE | Cleanup / control surfaces. |
| `POST /api/call-center/calls/:id/{assign,transfer}` | DEFERRED | Operates on already-active calls; routing-level decision, not a new entitlement boundary. |
| `widgetCallInvitations.ts` `POST /:id/{join,decline,end}` | ALREADY GUARDED | Already consults `loadCallControlPlane` + `loadWorkspaceCallOverrides` per channel. |
| `callAvailability.ts`, `callCenter` settings/presence/departments | DO NOT GATE | Visibility/configuration surfaces — denial would block the very screens needed to manage a downgrade. |
| `adminCalls.ts`, `callCenter` `/admin/*` | DO NOT GATE | Platform-admin only; already role-protected. |

### Why the deferred routes stay deferred

Every deferred row above either (a) operates on an already-created
queue entry / call / callback (denial would strand in-flight work),
(b) is a public/widget surface where denial UX is still undefined, or
(c) is a mixed handler whose cleanup branches cannot be cleanly
separated from create branches. The composer is intentionally not
invoked there until each surface gets its own drain decision.

### Visitor / drain policy (locked)

- **Deny-on-create**: visitor `POST /api/call-widget/calls/request`,
  `POST /api/call-widget/callbacks/request`, and
  `POST /api/widget-callbacks/request` may be denied via the
  composer. Denial happens **before** provider resolution, queue
  inserts, and any DB mutation — so no half-created call objects or
  reserved queue rows are stranded.
- **Allow-on-cleanup / status / cancel / read**:
  `GET /api/widget-callbacks/status`, queue cancel paths, operator
  callback list / counts / PATCH, and all `accept` / `reject` /
  `hangup` / `end` / `cancel` surfaces remain reachable regardless of
  plan state so visitors and operators can finish or abort in-flight
  work.
- **Stable denial shape**: every newly gated visitor surface returns
  `{ error: "plan_forbidden", capability: <key>, upgrade_required: true }`
  with HTTP 403 — never a generic 500. The widget UI can branch on
  `error === "plan_forbidden"` without parsing prose.

## Numeric limits — still deferred

No `max_concurrent_calls` / `max_call_minutes_per_month` /
`recording_retention_days` plan limits are added in this phase. None
have a workspace-scoped counter or usage resolver yet
(`server/services/billing/usageResolvers.ts`), and adding limits
without a counter would be speculative.

## Backward compatibility

- No registry key was renamed.
- No route behavior changed.
- `loadEffectiveCallChannels` is unchanged and remains the runtime
  authority.
- The composer is additive; nothing imports it from a route handler.

## Phase: Call-Side Policy Backlog Resolution — Strict Single-Decision Pass

**Outcome: NO RUNTIME ROLLOUT (honest defer).** The remaining
call-side backlog was audited end-to-end against repository truth.
Every item that is still open requires either a product-policy
decision, a drain/continuity contract, or counter/resolver
architecture that does not yet exist. Forcing a rollout in this pass
would have violated the deny-on-create / allow-on-cleanup invariant
or faked numeric-limit activation. No code, schema, registry key,
route, env var, or middleware contract was changed.

### Remaining backlog — strict classification

| Item | Class | Why it stays deferred |
| --- | --- | --- |
| `POST /api/calls/:id/invite` | NEEDS PRODUCT POLICY DECISION | Confirmed in `server/routes/calls.ts` (lines 402–448): a single undifferentiated handler that serves both **new participant adds** and **re-ring / reissue / recovery** of an in-flight participant. The `inviteSchema` has only `participant_type` + `participant_id`; no `reason: 'new' \| 'reissue'`, no idempotency contract on `call_participants`. Gating the whole route would strand active-call continuity (re-ring after transport hiccup, mid-call invitee). No safe sub-branch is currently expressible. Unblock requires a route-level participant-class signal or a `(call_session_id, participant_id)` idempotency contract. |
| `POST /api/call-queue/:workspaceId/:entryId/offer` | NEEDS DRAIN / CONTINUITY POLICY | Acts on an already-existing `call_queue_entries` row created at `enqueue` time (which is itself already gated). Denying `offer` after a downgrade would strand visitors mid-queue with no operator routing. Unblock requires an explicit drain decision: either auto-cancel orphaned entries on plan loss (cleanup path) or grandfather already-enqueued rows. |
| `POST /api/call-queue/:workspaceId/:entryId/accept` | NEEDS DRAIN / CONTINUITY POLICY | Same shape as `offer`: operates on existing rows; denial strands work. Drain semantics must be decided at the queue level, not per-route. |
| `POST /api/call-center/calls/:id/{assign,transfer}` | NEEDS DRAIN / CONTINUITY POLICY | Operates on already-active calls. This is a routing decision over an in-flight session, not a new entitlement boundary. |
| `max_concurrent_calls` | NEEDS COUNTER / RESOLVER ARCHITECTURE | `rg` against `server/services/billing/usageResolvers.ts` and `capabilityRegistry.ts` confirms no resolver, no key, no counter. Activation without a counter would be speculative. |
| `max_call_minutes_per_month` | NEEDS COUNTER / RESOLVER ARCHITECTURE | No monthly minutes aggregator exists. `call_sessions` has `started_at`/`ended_at` but no monthly rollup table or resolver. |
| `recording_retention_days` | NEEDS COUNTER / RESOLVER ARCHITECTURE | Retention is a janitor/job concern, not a request-time limit; no retention worker exists yet. Modeling it as a `requireLimit` would be a category error. |

### Single decision target

Outcome **B — NO SAFE ROLLOUT**. None of the items above can be
resolved within the strict deny-on-create / allow-on-cleanup contract
without product-policy or counter-architecture work.

Of all candidates, the **best ratio of value to risk** for the next
call-side phase (after a policy decision lands) is splitting
`POST /api/calls/:id/invite` into a `reason: 'new' | 'reissue'`
contract and gating only the `'new'` branch on
`eff.voice_enabled` / `eff.video_enabled`. That is the smallest
bounded change that would actually move the backlog. It is **not**
done in this pass because the route schema does not yet carry that
signal and inventing it inline would be guessing.

### Backward compatibility

- No capability key was renamed.
- No route, env var, schema, or middleware contract was touched.
- `loadEffectiveCallChannels` and the canonical composer are
  unchanged.
- All previously gated surfaces (`/api/call-invitations`,
  `recording/start` ×2, `/api/calls/create`,
  `/api/widget/call-queue/enqueue`, `/api/call-widget/calls/request`,
  `/api/call-widget/callbacks/request`,
  `/api/widget-callbacks/request`) remain gated exactly as before.
- All cleanup / status / finalize / cancel surfaces remain reachable.

### Validation

- Re-read `server/routes/calls.ts` (`/invite` handler) to confirm
  there is still no participant-class signal in the route body.
- Re-read `server/routes/callQueue.ts` to confirm `offer` / `accept`
  still operate on already-existing rows.
- `rg` against `usageResolvers.ts` / `capabilityRegistry.ts` to
  confirm no `max_concurrent_calls` / `max_call_minutes_per_month` /
  `recording_retention_days` resolver exists.
- No tests added — runtime behavior is unchanged in this pass.
---

## June 2026 — `POST /api/calls/:id/invite` Route-Shape Split + Selective Gating

Status: **LIVE**. The previously-deferred split landed in this pass.

### Route-shape change

`inviteSchema` now accepts an optional discriminator:

```
reason: 'new' | 'reissue'  // optional
```

Semantics:

- `reason: 'new'`  → genuinely new optional-participant add. Gated by
  the canonical composer.
- `reason: 'reissue'` → reissue / recovery / re-ring against an
  already-allowed in-flight session. **Never** gated by the composer;
  stays reachable so in-flight sessions are not stranded by a plan
  downgrade.
- `reason` omitted → treated as `'reissue'` for backward compatibility
  (see below).

### Selective gating

Only the `'new'` branch consults `loadEffectiveCallEntitlements`:

| `ctx.session.call_type` | Gate                |
| ----------------------- | ------------------- |
| `'audio'`               | `eff.voice_enabled` |
| `'video'`               | `eff.video_enabled` |

Failure response: `403 { error: 'plan_forbidden', capability, upgrade_required: true }`.
No new capability keys were introduced. The composer is reused; there
is no second composer and no inline entitlement logic.

### Backward-compatibility rationale

Legacy callers (no `reason`) default to `'reissue'` — i.e. allowed.
This is the continuity-safe choice because:

1. `POST /api/calls/create` is the canonical deny-on-create boundary.
   An existing `call_session` already passed plan gating at creation
   time, so re-inviting on it is continuity behavior.
2. The deny-on-create / allow-on-continuity policy explicitly
   prioritizes not stranding in-flight calls over closing a marginal
   bypass on a non-creation surface.
3. The only known internal caller (`src/lib/calls-api.ts → callsApi.invite`)
   is migrated to send `reason: 'new'` explicitly, so the legacy
   default does not weaken gating for the known new-participant path.

### Files changed

- `server/routes/calls.ts` — `inviteSchema` + handler split.
- `src/lib/calls-api.ts` — caller migrated to send `reason: 'new'`.
- `src/test/billing/callsInviteRouteSplit.test.ts` — 5 deterministic
  tests covering: new-audio deny, new-video deny, new-allow,
  reissue-reachable-when-disabled, legacy-default-reachable.

### Intentionally deferred (still)

- Call-queue `offer` / `accept` selective gating — operates on existing
  rows; drain policy still undecided.
- Call-center `assign` / `transfer` selective gating — same reason.
- Numeric call limits (`max_concurrent_calls`,
  `max_call_minutes_per_month`, `recording_retention_days`) — no
  counters/resolvers exist; activation would be speculative.

## June 2026 — Queue Offer / Accept Drain Policy (No-Rollout)

Scope of this pass: exactly two routes —
`POST /api/call-queue/:workspaceId/:entryId/offer` and
`POST /api/call-queue/:workspaceId/:entryId/accept`
(`server/routes/callQueue.ts`).

### Route-truth audit

- `offer` calls `offerEntry(config, entryId, auth.userId)` on a row
  fetched via `getEntry(workspaceId, entryId)`. It only transitions an
  already-existing queue row from `waiting` → `offered` and assigns the
  current operator. It cannot create a queue row; the row was created
  earlier at the visitor enqueue boundary, which is already gated
  (`POST /api/widget/call-queue/enqueue` — `queue_enabled` /
  channel composer).
- `accept` calls `acceptEntry(entryId, call_session_id?)` and
  transitions `offered` → `accepted`, optionally binding to an existing
  `call_sessions` row (also created at an already-gated boundary,
  `/api/calls/create`).
- Neither handler contains a branch that admits new chargeable work.
  Both are pure in-flight continuation of a queue row that the plan
  composer already authorised at creation time.
- Operator authorisation is enforced via
  `resolveUserCallPermissions(...).can_join_queue_calls` (offer) and
  workspace membership (accept). Those are RBAC, not entitlement, and
  remain unchanged.

### Drain policy locked

For queue rows the governing rule is now explicit:

| Lifecycle step                | Boundary type                | Entitlement gate |
|-------------------------------|------------------------------|------------------|
| Visitor enqueue (new row)     | admit-new-work               | GATED (existing) |
| Operator `offer` (waiting→offered) | in-flight continuation  | NOT gated        |
| Operator `accept` (offered→accepted) | in-flight continuation | NOT gated        |
| `cancel` / timeout / cleanup  | cleanup                      | NOT gated        |

This is a direct application of the already-locked
deny-on-create / allow-on-continuity policy: once a queue row exists,
downgrades must not strand it, and operators must remain able to drain
the queue to completion or cancellation.

### Outcome

**No runtime rollout.** Adding an entitlement check at `offer` or
`accept` would either (a) be a no-op because the only governing
capabilities (`queue_enabled`, channel flags) were already evaluated at
enqueue, or (b) strand already-queued visitors on plan downgrade —
which the locked policy forbids. No safe new-action branch exists in
either handler.

No files under `server/`, `src/`, or `supabase/` were modified by this
pass. The canonical composer (`loadEffectiveCallEntitlements`) is
untouched and no new capability key, helper, or wrapper was introduced.

### Next remaining call-side backlog item

After this pass, the most promising remaining item is **call-center
`assign` / `transfer`**, which has the same structural shape (operates
on existing call_sessions) and therefore likely resolves to the same
no-rollout result, but has not yet been route-audited under this
policy. Numeric call limits remain blocked on missing usage resolvers.
