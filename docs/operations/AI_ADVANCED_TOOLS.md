# The AI Advanced tools as a plan feature

Owner, 2026-11-03: the AI section's «ابزارهای پیشرفته» (Advanced tools) is
turned on and off per plan by the Super Admin, and is off on every plan for
now. Both brands (WebYar, RESPOK). The section's pages: test cases, test runs,
suggested tests, regression runs, source health, the knowledge-search
(retrieval) debugger, the answer (run) inspector and the AI billing stub
(`src/App.tsx`, the routes wrapped in `AdvancedAiAgentGuard`).

Change this file with the code.

## Plan

- Registry key `ai_advanced_tools` (`server/services/billing/capabilityRegistry.ts`):
  type `feature`, group `ai`, label "AI Advanced Tools", default **`false`**,
  `planConfigurable: true`, `workspaceOverridable: false`, user visible.
  No plan carries the key, so every plan resolves it to the default, off
  (`effectiveEntitlements.ts`, `checkEntitlementFromDB`'s registry default).
  No migration.
- Labels: `src/lib/capability-i18n.ts` (en/fa/tr): "AI Advanced Tools" /
  «ابزارهای پیشرفتهٔ هوش مصنوعی» / "Yapay Zekâ Gelişmiş Araçları"; the
  customer plan card (`PlanFeatures.tsx`, `billing.plans.feat.ai_advanced_tools`).
- The App Review plan: `app_review_seed_plan()` (migrations 272/293) switches
  on every key **any other plan carries**, plus its fixed list, which does not
  name `ai_advanced_tools`. Today no plan carries it, so the App Review plan
  does not have it (off) and a reseed keeps it off. But the Super Admin's
  plan editor writes every registry key when it saves a plan (this one as
  `false` unless turned on), so once any plan is saved the key is "carried",
  and the next App Review reseed (Super Admin → App Review) turns it **on**
  for the App Review plan, as it does for every other key. The iPhone and
  Android apps have no Advanced tools, so Apple's reviewer sees nothing of
  it; only the web panel of that workspace would show the section.

## The rule

One rule, `shared/aiAdvancedTools.ts` (`aiAdvancedToolsAllowed`), on both sides:

- a platform admin (Super Admin): always;
- the non-production override: `VITE_ENABLE_AI_ADVANCED_TOOLS=true` (web
  build), `ENABLE_AI_ADVANCED_TOOLS=true` on a server whose `NODE_ENV` is not
  `production`, as before;
- otherwise: the workspace's effective plan has `ai_advanced_tools` exactly
  `true` **and** the member is the workspace's owner or an admin (the role
  every AI settings write asks for; agents and staff roles never). A plan
  not read yet or unreadable is off.

Web panel: `useAiAdvancedToolsAccess` (`src/features/ai-agent/`) reads the
admin check, the plan snapshot (`usePlanAccess`) and the role
(`useWorkspaceRole`). `AdvancedAiAgentGuard` shows a spinner while any of them
loads and redirects to `/ai-agent/overview` when the answer is no;
`AiAgentLayout` lists the Advanced section (`aiAgentMenu.ts`, `advanced: true`)
only once the answer is yes, so it never flashes. Its menu line reads
"Testing and troubleshooting the assistant" / «آزمون و عیب‌یابی دستیار» /
"Asistanı test etme ve sorun giderme".

Server: `canAccessAiAgentAdvancedToolsServer(config, userId, workspaceId)`
(`server/services/ai-agent/customerSafe.ts`) reads the member's row
(`workspace_members`, unsuspended) and the plan through
`checkEntitlementFromDB` (fails closed on an unreadable answer). The guard in
`server/routes/ai-agent/index.ts` (`ADVANCED_PATH_PATTERNS`):

- `/platform/*` (`/platform/settings`, `/platform/ai-proactive-stats`, the
  Super Admin's AI Control Center): Super Admin only, never a plan's
  (`canAccessAiAgentPlatformPagesServer`; the handlers check it again).
- every other advanced path: the rule above, for the workspace the handler
  acts on (`resolveAiAgentRequestWorkspace`, `platformGuards.ts`): the
  resource the path names by id (test case, test run, suggested test,
  regression batch or schedule, AI run, the feedback or test run a
  suggestion is made from) decides; a workspace id in the query or body must
  be that one, and all the ids a request names must agree. So an owner whose
  plan has the key never reaches another workspace's QA data, even one they
  are an agent in. Denied: 403 `advanced_ai_tools_not_available`.
- The id is read as its handler reads it (`resourceIdOfSegment`):
  percent-decoded, as Express decodes `req.params`, and in any uuid
  spelling Postgres takes (any case, without hyphens, in braces). Matching
  only the canonical 36-character form let `/test-runs/%62…?workspaceId=<own>`
  or a hyphenless id skip the lookup, so the guard judged the named
  workspace while the handler read another workspace's row.
- The handlers still check membership (and owner/admin for writes) of that
  same workspace, as before. `POST /regression/run-now` also refuses a
  `scheduleId` of another workspace (404 `schedule_not_found`).

## Scheduled regression runs

The regression worker (`worker/regression-runner`, WebYar app 22 and
RESPOK's counterpart, auto-deploy off: queue them by hand after the merge)
asks `regressionScheduleMayRunServer` (`customerSafe.ts`) before it runs a
due schedule: the workspace's plan must still have `ai_advanced_tools`, or
the Super Admin set the schedule up or last changed it (`created_by`,
`updated_by`). So turning the key off on a plan, or a downgrade, stops a
customer's scheduled runs (and their AI calls) too; an unreadable plan skips
that run. Batches already queued from the panel run once, as queued.

## The old platform switches

`platform_ai_agent_settings.advanced_tools_enabled`, `regression_runner_enabled`,
`source_health_visible_to_customers` and `test_harness_visible_to_customers`
(all default false) used to decide customer visibility of these tools. They
no longer open or close anything: the per-feature platform guard
(`assertFeatureEnabled`, `platformGuards.ts`) passes the regression, test
harness and source health features, since the plan rule above already ran.
The columns are kept (no migration) and the API still accepts them; the
Super Admin's AI Control Center no longer offers them: its "Advanced tools"
card says the tools are turned on per plan and links to Super Admin → Plans.
The capability snapshot's `advanced.*` flags
(`getWorkspaceAiAgentCapabilities`) follow the plan rule too.

## Turning it on for a plan

Super Admin → Plans → the plan → "AI Advanced Tools" on → save. The
entitlement cache (60 s) and the panel's plan snapshot pick it up; the
workspace's owner and admins then see «ابزارهای پیشرفته» in the AI section.
Off again: the section disappears and its endpoints answer 403.

Guards: `src/test/ai-agent/advancedToolsAccess.test.tsx` (the rule, the
hook, the page guard), `src/test/ai-agent/advancedToolsPlanGuard.test.ts`
(the server's guard through the real router),
`src/test/ai-agent/advancedRouteAccessPolicy.test.ts`,
`src/test/ai-agent/aiSectionMenu.test.ts`,
`src/test/ai-agent/aiAgentLayout.test.tsx`,
`src/test/plans/aiAdvancedToolsPlanKey.test.tsx` (the key, its labels, the
plan card, the menu line, the Control Center card),
`src/test/security/aiAgentPlatformAdminGuard.test.ts`.
