# Platform support

An operator of any workspace talks to the team that runs the platform — from
Settings in an app, and later from the web console. The team answers in its
own inbox, with the tools it already has.

## Model

- **The support workspace** is an ordinary workspace that Super Admin picks
  (Core settings → Support, stored in `platform_support_settings`). Its
  members are the support team.
- **A thread** is one conversation in that workspace's inbox, with
  `metadata.channel = 'platform_support'`. There are two kinds:
  - `chat`: live, and one per operator while it is open, pending or resolved.
    Once it is closed, the next message starts a new one.
  - `ticket`: filed while nobody on the team is available. It has a subject
    and a number, and it is tagged `ticket` in the inbox.
- **The operator is the thread's contact** in the support workspace:
  - Their name, email and photo come from their profile and follow it.
  - An existing contact with the same email (for example, someone who wrote
    through the website widget) is adopted.
  - `contacts.metadata` records `platform_user_id`, `platform_workspace_id`
    and `platform_workspace_name`.
  - The inbox labels these conversations **"Site user"** (fa «کاربر سایت», tr
    «Site kullanıcısı»).
- **Any operator may use it, the support team's own members included.**
  Super Admin can try it from their own account. Everything the operator reads
  or writes goes through `platform_support_threads`, keyed on their own user
  id, never through the support workspace's membership. A team member who
  writes to support gets no push about their own message.

## Delivery

| Event | Support team | Operator |
| --- | --- | --- |
| The operator writes | Inbox realtime; push to the team (channel `platform_support`) | Their other devices: `support_message` on their user channel |
| A new ticket | Mail `platform_support_ticket_created` to the workspace's owners and admins, and to the extra addresses in the settings | — |
| An agent replies (`POST /api/conversations/send-message`) | As any reply | `support_message` on `ws:<their workspace>:user:<id>`; push `support_reply`; for a ticket, mail `platform_support_ticket_reply` |

- **Online** follows the website widget's own rule
  (`resolveAvailability`): business hours, plus whether anybody on the team is
  available.
- **AI:** the AI is not run on support threads.
- **Mail:** templates are seeded in en, fa and tr and can be edited in Super
  Admin → Branding → Email templates.

## HTTP — `/api/platform-support`

Authentication is any signed-in session: the cookie on the web, `Bearer` in
the apps. Bodies and responses are camelCase JSON.

| Method and path | Body | Response |
| --- | --- | --- |
| `GET /status` | — | `{ enabled, available, online, ticketsEnabled, teamName }` |
| `GET /threads` | — | `{ threads: Thread[] }`, newest activity first |
| `GET /threads/:id` | — | `{ thread: Thread, messages: Message[] }`, oldest first, last 200 |
| `POST /chat` | `{ body, clientMessageId?, workspaceId? }` | `{ thread, message }` |
| `POST /tickets` | `{ subject, body, clientMessageId?, workspaceId? }` | `{ thread, message }` |
| `POST /threads/:id/messages` | `{ body, clientMessageId? }` | `{ thread, message }` |
| `POST /threads/:id/read` | — | `{ ok: true }` |

```ts
type Thread = {
  id: string;                 // the conversation id
  kind: 'chat' | 'ticket';
  number: number;             // shown as #1234
  subject: string | null;     // tickets
  status: 'open' | 'pending' | 'resolved' | 'closed';
  createdAt: string;
  updatedAt: string;
  unread: number;             // the team's messages not read yet
  lastMessage: { body: string; fromTeam: boolean; createdAt: string } | null;
};

type Message = {
  id: string;
  body: string;
  author: 'me' | 'team';
  senderName: string | null;   // the agent's name
  senderAvatar: string | null; // the agent's photo
  createdAt: string;
  clientMessageId: string | null;
  hasAttachment: boolean;      // an agent's file: shown as a placeholder
};
```

**Request rules**
- `workspaceId` is the workspace the operator is writing from, when the client
  knows it. The inbox shows its name next to the contact.
- `clientMessageId` makes a retry safe: `[A-Za-z0-9_-]{8,64}`, minted once per
  message. The same id on `POST /tickets` returns the same ticket.

**Errors** are `{ error: code }`:

| Code | Status |
| --- | --- |
| `support_disabled`, `support_not_configured`, `thread_not_found` | 404 |
| `thread_closed` | 409 |
| `tickets_disabled` | 403 |
| `invalid_body`, `invalid_subject` | 400 |
| `rate_limited` | 429 |

**Limits**
- 30 messages per 5 minutes per operator.
- 5 tickets per hour.
- A body is at most 4000 characters, a subject at most 200.

### Realtime

On the operator's user channel `ws:<workspace>:user:<userId>`, where the app
subscribes through `POST /api/realtime/operator-user-subscribe`, events have
this shape:

```json
{ "type": "event", "payload": { "kind": "support_message" | "support_read", "workspace_id": "…", "thread_id": "…", "message_id": "…" } }
```

Events carry ids only. The client re-reads the thread.

### Push

The data payload is `{ type: 'support_reply', workspaceId, threadId, messageId }`.
- The Android tag is `support:<threadId>`.
- `workspaceId` is a workspace the operator belongs to, which the app files
  the notification under.

## Super Admin — `/api/admin/platform-support`

| Method and path | Body | Response |
| --- | --- | --- |
| `GET /settings` | — | `{ settings: { enabled, workspaceId, ticketsEnabled, notifyEmails, updatedAt }, workspace, suggestions }` |
| `PUT /settings` | `{ enabled?, workspaceId?, ticketsEnabled?, notifyEmails? }` | `{ success, settings }` |
| `GET /workspaces?search=` | — | `{ workspaces: [{ id, name, slug }] }` |

`GET /settings` returns `suggestions`: the workspaces this Super Admin owns
or administers.

## Clients

- **Android:** Settings → Support.
  - The section appears when `enabled && available`.
  - When the team is online it opens the chat; otherwise it offers a ticket.
  - The operator's earlier threads are listed below.
  - Replies arrive live, and a `support_reply` push opens the thread.
- **iOS, macOS, Windows, web:** the same endpoints and events.
