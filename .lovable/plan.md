## Phase 0 — Source audit (done)

The project already has a very substantial call infrastructure. Re-creating it would break things. Here is what exists and what we will reuse vs. add.

### Existing tables (reuse, not recreate)

- `call_sessions`, `call_participants`, `call_queue_entries`, `call_events`, `callback_requests`, `call_invitations`, `call_recordings`, `operator_call_availability`

Column names differ from the spec (e.g. `call_session_id` vs `call_id`, `state` vs `status`, `payload` vs `metadata`, `offered_to_user_id` vs `assigned_agent_id`, enum types via `USER-DEFINED`). We will adapt code to the existing schema and only add missing columns/tables.

### Existing server services (reuse)

- `server/services/calls/`: `providerResolver.ts`, `rtcResolver.ts`, `queue.ts`, `queueTicker.ts`, `routing.ts`, `invitations.ts`, `endSession.ts`, `availability.ts`, `callbacks.ts`, `permissions.ts`, `errorCodes.ts`, `metrics.ts`, `livekitConfig.ts`, `livekitTwirp.ts`, `agoraConfig.ts`, `turnAuth.ts`, `controlPlane.ts`, `globalAdvancedRouting.ts`, `departments.ts`
- Providers: `providers/{livekitProvider,agoraProvider,jitsiProvider,janusProvider,types}.ts` — provider abstraction already exists.

### Existing routes (reuse)

- `server/routes/calls.ts`, `callQueue.ts`, `callInvitations.ts`, `callbacks.ts`, `callAvailability.ts`, `adminCalls.ts`, `widgetCallInvitations.ts`, `widgetCallbacks.ts`, `livekitWebhook.ts`

### Existing widget runtime (do NOT touch)

- `public/widget/runtime-call.js` — embedded inside chat widget. Per spec we must NOT reuse it directly; we build a new standalone `/call-widget/`.

### Risky areas

- The schema is mature but uses different column names than the spec. Forcing the spec's exact column names would break existing call code. **Decision: keep existing schema, add only missing fields, map names in API layer.**
- Existing `call_invitations`/`callQueue` is tied to chat conversations (operator-initiated calls inside an open chat). The new Call Center is **visitor-initiated calls from a standalone Call widget** — a different flow. We will add new "call center" entry routes that use the same underlying tables, with a discriminator.

## Implementation scope for this pass

To keep this PR reviewable and safe, we deliver an MVP slice. Anything not listed is deferred to the next pass.

### 1. DB migration (`007_call_center.sql`)

- New table: `call_center_settings` (workspace-scoped, all fields per spec).
- New table: `platform_call_center_settings` (singleton).
- Add columns to existing `call_sessions` if missing: `call_type` (voice|video), `subject`, `page_url`, `page_title`, `origin`, `wait_seconds`, `direction default 'inbound'`, `visitor_name`, `visitor_email`, `visitor_phone`. Use `ADD COLUMN IF NOT EXISTS`.
- Add `entry_source text default 'chat'` to `call_sessions` and `call_queue_entries` to discriminate `'call_widget'` vs existing `'chat'` flows.
- RLS: workspace members read; service role writes; visitors never query directly.
- Indexes per spec.

### 2. Provider abstraction

- Reuse `server/services/calls/providers/*` and `providerResolver.ts` as-is. No new abstraction layer — the existing one matches the spec's interface.

### 3. Backend routes

- New: `server/routes/callCenter.ts` mounted at `/api/call-center/*` — settings, overview, calls list, queue, accept/reject/end (delegate to existing services), agent-status, callbacks list/assign/complete/cancel.
- New: `server/routes/callWidget.ts` mounted at `/api/call-widget/*` — bootstrap, config, calls/request, calls/:id/cancel, calls/:id/join-token, callbacks/request.
- Public routes: origin allow-list against `call_center_settings.allowed_domains`, exact-origin echo CORS, short-lived widget session token (HMAC).
- Operator routes: existing auth middleware + role check (owner/admin/agent/team_lead).
- Fail-closed entitlement check using existing platform/plan helpers.

### 4. Independent call widget

- `public/call-widget/l.js` — tiny async loader, reads `workspace-id` / `public-key`, fetches `/api/call-widget/bootstrap`, injects runtime via Shadow DOM.
- `public/call-widget/runtime.js` + `runtime.css` — states: loading / online_available / offline / pre_call_form / queue_waiting / ringing / in_call / ended / callback_form / error. No chat dependency. Uses LiveKit/Agora client only when join-token returns a provider room.
- Polling fallback every 5s for queue/ringing status.

### 5. Workspace UI

- Sidebar: add "Call Center" item under capability gate `call_center_visible` (platform enabled AND workspace `call_center_settings.enabled`).
- Pages under `src/pages/app/call-center/`: `OverviewPage`, `LiveQueuePage`, `CallsPage`, `CallbacksPage`, `InstallPage`, `SettingsPage` (minimum UI per spec).
- Routes added to `src/App.tsx` under `/app/w/:slug/call-center/*`.
- Avatar upload via existing storage provider helper, path `workspace/{wid}/call-center/avatar/{uuid}-{name}`, 2MB cap, png/jpeg/webp.

### 6. Realtime

- Reuse existing realtime publisher. Channels: `ws:{wid}:call-center:queue`, `ws:{wid}:call:{id}`. Events as listed in spec. Polling fallback for widget.

### 7. Inbox integration

- Off by default in this pass. `call_sessions.conversation_id` left null unless an explicit setting toggles it later. No AI side effects. No `ai_state='ai_managed'`.

### 8. Billing/limits

- Add feature keys (`call_center_enabled`, `call_center_voice`, `call_center_video`, `call_center_callbacks`, `call_center_recording`) and limit keys (`call_center_monthly_minutes`, `call_center_concurrent_calls`, `call_center_queue_size`) to the existing entitlement registry. Hooked into `/api/call-widget/calls/request`. Fail-closed errors per spec.

### 9. Recording

- Schema/UI placeholders only. Warning banner if enabled but provider has no recording.

### 10. Verification

- `rg` safety greps as specified.
- `bunx tsc -p tsconfig.app.json --noEmit` and `tsconfig.server.json --noEmit`.

### Explicit non-goals (deferred)

- Super Admin `/admin/call-center` page (only kill switch via DB / env in this pass; full admin UI next pass).
- Departments / advanced routing rules table — uses existing `routing_mode` + `default_department_id` only.
- Recording download, transfer, screen share, SIP/PSTN, CRM sync, AI summaries.
- Migration of existing operator-initiated `runtime-call.js` flow to the new module.

### Risks / open question

This is a very large change (≈25-30 new files + 1 migration + sidebar/routes). I will deliver it as one cohesive PR. If you'd prefer to split into sub-passes (e.g. CC-1a = DB+routes, CC-1b = widget, CC-1c = UI), say so and I'll resequence. Otherwise I will proceed end-to-end with the scope above on your approval.

Proceed end-to-end, but keep the existing chat-widget/runtime-call flow fully untouched. If any required change touches public/widget/runtime-call.js, server/routes/calls.ts existing operator-initiated flow, or current chat call invitations, stop and report before patching. For this pass, standalone call-widget must be additive only.

Also, do not leave Super Admin control for next pass. Add a professional /admin/call-center control center in this pass with platform kill switch, feature toggles, limits, provider readiness, workspace overview, and audit-on-save.

Additional requirement — Super Admin Call Center Control Center

While building this pass, also add a professional Super Admin control page for Call Center.

Create:

- /admin/call-center

Purpose:

Super Admin must be able to control Call Center globally and professionally from the admin panel, not only by DB/env.

Mandatory:

- Use existing admin layout/sidebar pattern.

- Add "Call Center" item to Super Admin sidebar/navigation.

- Only super_admin/platform_admin can access.

- Workspace users must not access this page.

- All settings must be stored in platform_call_center_settings or the existing platform settings table if already created.

- Do not hardcode defaults in frontend only.

- Backend must be source of truth.

Super Admin page sections:

1. Global Status

- call_center_enabled global kill switch

- disabled_message editor, multilingual if existing i18n/jsonb pattern exists

- provider status summary

- total enabled workspaces

- active calls now

- waiting calls now

- failed provider status if provider missing

Behavior:

If call_center_enabled=false:

- Workspace Call Center sidebar hidden

- /api/call-widget/bootstrap returns disabled

- /api/call-widget/calls/request returns call_center_disabled

- no call_sessions / queue entries are created

- existing chat widget and chat calls remain untouched

2. Feature Toggles

Global defaults/toggles:

- voice_calls_enabled

- video_calls_enabled

- callback_requests_enabled

- call_recording_enabled

- screen_share_enabled placeholder disabled

- call_transfer_enabled placeholder disabled

- departments_enabled placeholder disabled

- advanced_routing_enabled placeholder disabled

Rules:

- If globally disabled, workspace cannot enable that feature.

- Workspace settings can only enable features allowed by platform.

- UI should clearly show "disabled by platform" where relevant.

3. Provider Defaults

Read active call provider from existing Provider Registry.

Show:

- active provider

- provider mode

- provider health/config readiness

- missing config warnings

- fallback provider if supported

Do not store provider secrets here unless existing provider settings UI already supports it.

Do not duplicate provider config.

4. Platform Limits

Global hard caps:

- max_concurrent_calls_per_workspace

- max_queue_size_per_workspace

- max_monthly_call_minutes_per_workspace

- max_callback_requests_per_month

- max_recording_storage_mb placeholder

These are platform safety caps.

Workspace plan limits must still be enforced separately through billing/entitlements.

Effective limit = min(platform cap, plan limit, workspace override if allowed).

5. Workspace Overrides / Visibility

Add a table/list:

- workspace name

- call_center_enabled

- voice/video/callback enabled

- current active calls

- queue count

- last call time

- quick toggle workspace visibility if existing admin workspace override pattern exists

If this is too much for this pass:

- implement read-only workspace overview now

- leave per-workspace override edit for next pass

6. Audit Log

On every Super Admin save:

- write audit log if audit_logs table/service already exists

- include changed keys only

- actor user id

- old/new values

- do not log secrets

If audit service does not exist, create internal call_center admin event only if there is an existing debug/audit pattern.

Do not create a heavy new audit system in this pass.

7. Safety

Super Admin controls must be fail-closed:

- if platform settings row missing, backend creates singleton with call_center_enabled=false

- never assume enabled by default

- widget bootstrap must check platform settings every time or through short safe cache

- cache max 30 seconds if caching is used

- provide manual refresh/reload after save

Verification:

- When Super Admin disables Call Center, workspace sidebar disappears and call widget stops creating calls.

- When Super Admin enables Call Center but provider is missing, workspace can see module but call request fails with provider_not_configured.

- When Super Admin disables video globally, workspace settings cannot enable video and widget only shows voice/callback.

- Existing chat widget and public/widget/runtime-call.js remain untouched.

- Existing operator-initiated chat calls remain untouched.

Return in final report:

- Super Admin files changed

- platform settings storage

- admin route added

- capability flags returned to workspace

- fail-closed behavior

- audit behavior