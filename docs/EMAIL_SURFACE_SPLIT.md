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

## Route truth audit (current callers)

| Caller                                                 | Path                          | Class              |
| ------------------------------------------------------ | ----------------------------- | ------------------ |
| `server/services/auth-email.ts` (verify, recovery)     | in-process `sendEmail()`      | PLATFORM / AUTH    |
| Invitation outbox worker                              | in-process `sendEmail()`      | PLATFORM (auth)    |
| `server/routes/widget.ts` offline-message notification | in-process `sendEmail()`      | PLATFORM (ops)     |
| `server/routes/widget.ts` admin-test offline email     | in-process `sendEmail()`      | PLATFORM (test)    |
| `src/providers/email/api.ts` → `EmailPage` test send   | `POST /api/email/send`        | PLATFORM (test)    |
| (future) workspace channel-email customer comms        | `POST /api/email/send-channel` or `sendChannelEmail()` | CHANNEL |

No current caller of the HTTP route is unambiguously a channel-email
customer-facing send. The split therefore introduces the dedicated
channel surface as the single safe gate point and leaves all existing
callers on the platform surface.

## Canonical split

- `POST /api/email/send` — **retired arbitrary relay**; always returns 410.
- `POST /api/email/test-send` — manager-gated provider test surface.
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