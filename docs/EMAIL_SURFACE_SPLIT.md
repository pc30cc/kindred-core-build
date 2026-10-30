# Email Surface Split — Platform vs Channel

Status: implemented (Phase: Email Surface Split + Channel Gating); the
caller-composed send routes retired on 2026-10-29.

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
deferred during earlier rollouts. The split first added a gated
`POST /api/email/send-channel` beside it; on 2026-10-29 both routes were
retired, because each sent mail its caller composed From the platform's own
address (below).

Which provider carries these mails (the platform's one, chosen by the Super
Admin: our own relay since 2026-10-29), retries, suppressions and bounces:
[`docs/operations/EMAIL.md`](operations/EMAIL.md).

## Route truth audit (current callers)

| Caller | Path | Class |
| --- | --- | --- |
| `server/services/auth-email.ts` (verify, recovery) | in-process `sendEmailWithRetry()` | PLATFORM / AUTH |
| Invitation outbox worker | in-process `sendEmail()` | PLATFORM (auth) |
| `server/services/widget/offlineNotice.ts` (a visitor's offline message, to the owners and admins) | in-process `enqueueEmail()` | PLATFORM (ops) |
| The panel's test buttons | `POST /api/email/test-send`, `POST /api/email/test-offline-notice` | PLATFORM (test) |
| `server/services/visitorTranscript.ts` transcript by email (the visitor asks, from the widget) | in-process `sendEmail()` | PLATFORM (visitor's request) |
| Operator notification emails (`server/services/notificationEmail/`) | in-process `sendEmail()` | PLATFORM (notification) |
| A workspace writing to its customers | the workspace's own connected mailbox, `/api/email-inbox` | CHANNEL |

No route takes a recipient, a subject and a body from its caller any more.
Mail to a workspace's customers goes through the workspace's own mailbox
(Gmail, Yahoo or IMAP/SMTP, the Email Inbox), never through the platform's
sender.

## Canonical split

- `POST /api/email/send` and `POST /api/email/send-channel` — **retired**;
  both answer 410 `ARBITRARY_EMAIL_RELAY_RETIRED`. They took a recipient, a
  subject, a body or any platform template with the caller's own values,
  and sent it From the platform's address: a member could send the
  platform's real password-reset mail with a link of their choosing, signed
  with our domain's DKIM key. `server/services/email/sendChannelEmail.ts`,
  their in-process twin, and the browser's `src/providers/email/api.ts`
  are gone with them.
- `POST /api/email/test-send` and `POST /api/email/test-offline-notice` —
  the test buttons: an owner or admin of the workspace (or the platform's
  admin), to their own verified address only, within per-member and
  per-workspace limits.
- `/api/email-inbox` — **channel email**, from the workspace's own mailbox,
  gated by the plan's `email_inbox` module (`enforceModule` on each route).

## Always-allowed (never plan-gated)

- Auth email verification (`server/services/auth-email.ts`)
- Password reset / recovery
- Team invitations
- Workspace operational notifications (the offline-message notice; each
  owner or admin may turn it off for themselves, Settings → Notifications)
- The transcript a visitor asks for from the widget
  (`services/visitorTranscript.ts`: every plan, the platform's default
  provider; only to the address already on the conversation's contact, with
  its own limits — not channel email, which an operator sends)
- Admin email test sends
- All `email_logs` reads

## Plan-gated

- The Email Inbox (`/api/email-inbox`, module `email_inbox`): the
  workspace's own mailbox.

## Backward compatibility

- The unsafe arbitrary-recipient relays are intentionally retired with 410.
- No capability key renamed.
- No env var change.
- No middleware contract change.
- Every in-process caller keeps working unchanged.
