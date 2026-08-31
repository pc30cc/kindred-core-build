# Widget behaviours: preview fidelity + plan-level control

## Problem

1. Turning off **Live chat** or **Knowledge base** in the Behavior tab changes nothing in the preview. The preview computes KB availability with an OR (`kb_enabled !== false || knowledge_base_enabled !== false`), which is always true, and it never reads `chat_enabled` at all.
2. Super Admin cannot decide, per plan, which widget behaviours a customer may use: the behaviour switches, Smart Engagement, Business hours, and the Domains allowlist are always available to every workspace, and there is no cap on how many domains a workspace may add.

## What will be built

### 1. Preview honours every behaviour toggle

- Fix the KB flag to a real AND check, and feed `chat_enabled` into the preview view-model.
- With live chat off: no "Start chat" action, no composer, no chat view — exactly what the production runtime already does for a chat-disabled widget.
- With KB off: no article chips, no Articles surface, no KB tab.
- Same for file sharing, voice notes, emoji and visitor tracking, so preview and live widget agree on every behaviour switch.

### 2. New plan capabilities (Super Admin)

Added to the capability registry in a new **Widget** group, all plan-configurable and workspace-overridable:

| Capability | Type | Default |
|---|---|---|
| Widget file attachments | feature | off |
| Widget voice notes | feature | off |
| Widget emoji picker | feature | on |
| Widget smart engagement | feature | off |
| Widget business hours | feature | on |
| Widget domain allowlist | feature | on |
| Max widget domains | limit | 1 |

Live chat, Knowledge base and Visitor tracking reuse the existing `chat`, `knowledge_base` and `visitor_tracking` module capabilities rather than adding duplicates.

Because these keys are registry-driven, they appear automatically in the Super Admin plan editor and in the per-workspace override screen.

### 3. Enforcement (server is authoritative)

- Widget settings save: a request that enables a behaviour the plan does not grant is rejected; a behaviour whose capability is off is always persisted/returned as off.
- Widget bootstrap config: every behaviour flag sent to the visitor's browser is intersected with the plan, so a downgraded plan disables the feature in already-installed widgets without any settings edit.
- Domains: adding a domain beyond `max_widget_domains` is refused, and the allowlist editor is refused entirely when the domain-allowlist capability is off.

### 4. Settings UI reflects the plan

- Behaviour rows whose capability is off are disabled with an "upgrade required" hint instead of silently failing.
- Smart engagement, Business hours (availability) and Domains tabs use the existing plan-locked overlay when the plan does not include them.
- The Domains tab shows `used / allowed` and disables the Add button at the cap.

## Technical notes

- Capability keys: `widget_attachments`, `widget_voice_notes`, `widget_emoji`, `widget_smart_engagement`, `widget_business_hours`, `widget_domain_allowlist`, `max_widget_domains`.
- Registry: `server/services/billing/capabilityRegistry.ts`; enforcement through the existing `checkEntitlementFromDB` / `requireLimit` helpers in `server/middleware/featureGating.ts`.
- Widget route (`server/routes/widget.ts`) composes the effective flags once and reuses that result for both the settings API and the public bootstrap.
- Preview fixes stay in `src/components/app/widget/WidgetLivePreview.tsx`; renderer markup keeps coming from the production presentation template.
- Existing plans keep working: absent keys fall back to the registry defaults, so no plan data migration is required.
- No Edge Functions; all backend logic stays in the Express server.
