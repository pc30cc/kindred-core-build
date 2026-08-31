# Conversation Limit Policy

_Status: **rolled out** — `max_conversations` is enforced on all
conversation-creation branches, widget and operator alike. Replies
into existing conversations remain ungated by design._

## Conversation creation surfaces (route truth)

| Route | Traffic | Creates conv row? | Enforcement |
|---|---|---|---|
| `POST /api/widget/message` (`server/routes/widget.ts`, line ~1251) | Visitor / public widget | Yes — only when `!convId` after all reuse fallbacks | **GATED** on the creation branch |
| `POST /api/widget/offline-messages` (`server/routes/widget.ts`, line ~2297) | Visitor / public widget | Yes — always inserts a new conversation | **GATED** |
| `POST /api/conversations/start-from-visitor` (`server/routes/conversations.ts`, line ~378) | Operator, authenticated workspace member | Sometimes — only when no open/pending conversation is reused | **GATED** on the creation branch (after the reuse short-circuit) |
| `POST /api/conversations/send-message` | Operator | No — replies into an existing conversation | NEVER gated by `max_conversations` |
| Existing-conversation branch of `POST /api/widget/message` | Visitor / public widget | No — reuses an open thread | NEVER gated by `max_conversations` |
| `services/ai-agent/intro.ts` (internal) | Server-side AI intro | Yes | **GATED** via the transport-free `checkMaxConversationsAllowance()` |

## How enforcement is wired

All gated branches call:

```ts
import { enforceMaxConversationsLimit } from '@/server/services/billing/conversationLimit';

const ok = await enforceMaxConversationsLimit(req, res);
if (!ok) return; // middleware already wrote a 403 (cap reached / not in plan)
```

The helper invokes the shared
`requireLimit('max_conversations', usageFnForLimit('max_conversations'))`
inline. There is **no** ad-hoc counting, no per-route usage math, and
no second entitlement system. Workspace ID is read from the request
body via the standard `extractWorkspaceId` path, which is the
already-verified workspace in every gated branch:

- Widget routes: `resolveWorkspaceId(...)` runs before the call and
  the body's `workspace_id` is cross-checked against the signed widget
  token (`req._widgetWorkspaceId`).
- Operator route: `authorizeWorkspaceMember(...)` has already verified
  the caller is a member of `body.workspace_id`.

## Cap-reached behavior

- The middleware returns HTTP `403` with the standard shape:
  `{ error: 'Limit reached: max_conversations', feature, plan, limit, used, upgrade_required: true }`.
- The widget runtime treats this like any other widget 403 (no special
  UX added in this phase). Replies in existing conversations remain
  fully functional because they never enter the gated branch.
- Offline capture at-cap returns the same 403; the widget already has
  a generic offline-failure path.

## Bypass policy

- No global admin bypass was added to `requireLimit` (matches the AI
  KB precedent).
- The operator route has no `isAdmin` short-circuit because
  `authorizeWorkspaceMember` does not model Super Admin and gating
  operators is correct: a workspace at cap should not be able to
  spawn new conversations from any surface.

## Non-HTTP callers

`services/ai-agent/intro.ts` has no req/res, so it calls the pure
checker that backs the same decision:

```ts
const allowance = await checkMaxConversationsAllowance(config, workspaceId);
if (!allowance.allowed) return { sent: false, reason: `conversation_limit_${allowance.reason}` };
```

Same entitlement RPC, same `usage_counters` resolver, fail-closed on an
unreadable entitlement or unreadable usage. The intro is simply not sent
when the workspace is at cap; nothing is inserted.

## Edge cases / future work
- The shared `usage_counters.conversations_count` increment is owned
  by existing DB triggers / handlers; this phase does not change
  counting, only enforcement.
