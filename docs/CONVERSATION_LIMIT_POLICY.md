# Conversation Limit Policy (Readiness)

_Status: **DEFERRED — no rollout this phase.**_

This document records the route truth and policy gaps that prevent
attaching `requireLimit('max_conversations', usageFnForLimit('max_conversations'))`
to a conversation-creation route today.

## Conversation creation surfaces (route truth)

| Route | Traffic | Creates conv row? | Gateable now? |
|---|---|---|---|
| `POST /api/conversations/start-from-visitor` (`server/routes/conversations.ts`) | Operator, authenticated workspace member | Sometimes — reuses the most-recent open/pending conversation for the visitor session, only inserts when none exists | **No** — see §1 |
| `POST /api/conversations/send-message` (`server/routes/conversations.ts`) | Operator | No — sends into an existing conversation | N/A — not a creation route |
| `POST /api/widget/message` (`server/routes/widget.ts`) | **Visitor / public widget** | Yes — first message from a visitor session creates the conversation | **No** — visitor/public traffic, see §2 |
| `POST /api/widget/offline-messages` (`server/routes/widget.ts`) | **Visitor / public widget** | Yes — creates an offline conversation record | **No** — visitor/public traffic, see §2 |
| `services/ai-agent/intro.ts` (internal) | Server-side AI intro | Yes (rare) | **No** — not an HTTP route |

`workspace_id` is reliably available at middleware time only on the
operator route. The widget routes resolve workspace via signed widget
token after `enforceWidgetToken` runs and are not workspace-member
authenticated.

## Why no route was gated this phase

### 1. Operator `start-from-visitor` is not the dominant creator

The operator-initiated outreach is intentionally idempotent: repeat
clicks reuse an existing open conversation. In practice the vast
majority of `conversations` rows are inserted by the **public widget**,
not by operator outreach. Attaching `requireLimit('max_conversations')`
only here would:

- Block operators from reaching out while visitors continue to create
  conversations freely through the widget — asymmetric enforcement
  with the wrong product behavior.
- Be effectively unobservable for any workspace whose conversation
  volume comes from the widget.

This fails the "would gating here produce the intended product
behavior?" test. **Deferred.**

### 2. Widget creation routes need a widget-aware policy, not the
plain workspace middleware

`POST /api/widget/message` and `POST /api/widget/offline-messages` are
the real dominant creators. They run after `enforceWidgetToken` /
`enforceOrigin`, not after workspace-member auth. Applying the current
`requireLimit` middleware here would require:

- A widget-context adapter that pulls `workspace_id` from the verified
  widget token rather than from a member session.
- A defined policy for what happens at cap: silently reject the
  visitor message? show an "unavailable" state? fall back to offline?
  Each has product implications that are out of scope for a Phase-3
  enforcement pass.
- Confirmation that "new conversation" vs "new message in existing
  conversation" is correctly distinguished — `usageFnForLimit('max_conversations')`
  counts conversation rows, not messages, and the widget message
  handler does both depending on session state.

Until those decisions exist in writing, gating is unsafe.

## Recommended next step

Before any conversation-limit rollout, decide explicitly:

1. **Do visitor-created conversations count against `max_conversations`?**
   (Expected: yes — they are the product's primary unit of value.)
2. **What is the cap-reached behavior in the widget?**
   - Reject new conversation starts but keep message replies in
     existing conversations working (recommended — `requireLimit` only
     applies on the creation branch).
   - Surface a workspace-defined "service unavailable" message vs a
     generic 403.
3. **Does operator `start-from-visitor` share the same cap?** If yes,
   gate both surfaces in the same phase to avoid asymmetric
   enforcement.
4. **Admin/operator bypass:** keep route-local (`!auth.isAdmin` short
   circuit), matching the AI KB jobs precedent — no global bypass
   inside `requireLimit`.

Once (1)–(4) are decided, the rollout shape is:

- Add a thin widget-context wrapper that calls `requireLimit` with the
  widget-token-resolved `workspace_id`, applied **only** on the
  conversation-creation branch of `POST /api/widget/message` (and
  `/offline-messages`).
- Apply the same `requireLimit('max_conversations', usageFnForLimit('max_conversations'))`
  to `POST /api/conversations/start-from-visitor`, behind the existing
  workspace-member auth, with the operator/admin bypass pattern from
  AI KB jobs.

No code in `server/` was changed in this phase.
