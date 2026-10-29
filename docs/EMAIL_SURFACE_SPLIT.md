# Email Surface Split — Platform vs Channel

Status: implemented (Phase: Email Surface Split + Channel Gating).

## Why this exists

`server/routes/email.ts` historically exposed a single `POST /api/email/send`
endpoint that mixed two very different kinds of traffic:

1. **Platform / auth / transactional email** — must always be reachable
   regardless of plan: email verification, password reset, team
   invitations, internal operational notifications, admin test sends.
2. **Channel email** — workspace customer-facing communication on the
   email channel, which legitimately depends on whether the workspace
   plan includes the email channel.

Slapping `requireChannel('email')` on the existing route would have
broken auth, reset, and invitations for any workspace whose plan does
not include the email channel. That risk was explicitly recorded in
`ENFORCEMENT_COVERAGE_AUDIT.md` as the reason this surface stayed
deferred during earlier rollouts.

Which provider carries these mails (the platform's one, chosen by the Super
Admin: our own relay since 2026-10-29), retries, suppressions and bounces:
[`docs/operations/EMAIL.md`](operations/EMAIL.md).

## Route truth audit (current callers)

| Caller                                                 | Path                          | Class              |
| ------------------------------------------------------ | ----------------------------- | ------------------ |
| `server/services/auth-email.ts` (verify, recovery)     | in-process `sendEmail()`      | PLATFORM / AUTH    |
| Invitation outbox worker                              | in-process `sendEmail()`      | PLATFORM (auth)    |
| `server/routes/widget.ts` offline-message notification | in-process `sendEmail()`      | PLATFORM (ops)     |
| `server/routes/widget.ts` admin-test offline email     | in-process `sendEmail()`      | PLATFORM (test)    |
| `server/services/visitorTranscript.ts` transcript by email (the visitor asks, from the widget) | in-process `sendEmail()` | PLATFORM (visitor's request) |
| `src/providers/email/api.ts` (registered as `__default__`; nothing uses it) | `POST /api/email/send-channel` | CHANNEL (unused) |
| (future) workspace channel-email customer comms        | `POST /api/email/send-channel` or `sendChannelEmail()` | CHANNEL |

No current caller of the HTTP route is unambiguously a channel-email
customer-facing send. The split therefore introduces the dedicated
channel surface as the single safe gate point and leaves all existing
callers on the platform surface.

## Canonical split

- `POST /api/email/send` — **retired arbitrary relay**; always returns 410.
- `POST /api/email/test-send` — manager-gated test send through the
  platform's provider (workspaces have no provider of their own; no screen
  calls it today).
- `POST /api/email/send-channel` — **channel email**. Gated with
  `requireChannel('email')` from the canonical
  `server/middleware/featureGating.ts`. The dedicated boundary that
  future channel-email integrations must use.
- `server/services/email/sendChannelEmail.ts` — in-process equivalent
  of the channel route. Performs `checkChannelAccess(workspaceId,
  'email')` before delegating to `sendEmail()`. Use this from server
  code when sending true channel email without going through HTTP.

## Always-allowed (never plan-gated)

- Auth email verification (`server/services/auth-email.ts`)
- Password reset / recovery
- Team invitations
- Workspace operational notifications
- The transcript a visitor asks for from the widget
  (`services/visitorTranscript.ts`: every plan, the platform's default
  provider; only to the address already on the conversation's contact, with
  its own limits — not channel email, which an operator sends)
- Admin email test sends
- All `email_logs` reads

## Plan-gated

- `POST /api/email/send-channel`
- Any future code path that calls `sendChannelEmail()`

## Backward compatibility

- The unsafe arbitrary-recipient relay is intentionally retired with 410.
- No capability key renamed.
- No env var or schema change.
- No middleware contract change.
- All existing callers keep working unchanged.

## Intentionally deferred

- Migrating future workspace email-channel sends onto
  `sendChannelEmail()` / `/api/email/send-channel`. There is no
  current code path that does customer-facing channel-email sends in
  the product, so there is nothing to migrate today; the boundary
  exists so the next phase that adds such a path lands on the gated
  surface by default.