# Platform support

An operator of any workspace talks to the team that runs the platform — from
Settings in an app, and later from the web console. The team answers in its
own inbox, with the tools it already has.

## Model

- **The support workspace** is an ordinary workspace that Super Admin picks
  (Core settings → Support, stored in `platform_support_settings`). Its
  members are the support team.
- **A conversation** is one row of `conversations` in that workspace, with
  `metadata.channel = 'platform_support'`. `platform_support_threads` links it
  to the operator who opened it; every read or write for the operator goes
  through that link, never through the support workspace's membership.
- **The open conversation, and the closed ones.** Opening support shows the
  operator's open conversation. With none open, it shows a page as fresh as
  the very first. Conversations that ended are listed on their own, and each
  can be read back and rated there.
  - The **active** conversation is the newest one that is `open` or
    `pending` and belongs to today's support workspace
    (`activeConversationId`). There is at most one.
  - The app names the conversation it writes to (`conversationId`). A
    message goes there while it is active, and is refused with
    `conversation_ended` once it is not. It is never moved to another
    conversation the operator is not looking at.
  - When nothing is active (never started, or the last one is `resolved` or
    `closed`), the first message names no conversation and starts a new one.
  - A `resolved` or `closed` conversation is never reopened by the operator.
    The team can still reopen it from the inbox, and it is active again.
  - Conversations opened as tickets before tickets were removed are closed
    (migration `244_platform_support_close_legacy_tickets`).
- **Offline** is the website widget's own rule (`resolveAvailability`):
  business hours, plus whether anybody on the team is available. Offline, the
  app says "leave a message" and shows the business hours. The message is
  delivered the same way; the team answers when it is back.
- **Joins.** When a conversation is assigned or transferred, the inbox writes
  a system message (`metadata.kind` `routing_agent_joined` or
  `conversation_transferred`). The app shows it as "‹name› joined the
  conversation". Internal notices (`metadata.internal = true`) never reach the
  operator.
- **Rating.** Once a conversation is `resolved` or `closed` and the team had
  answered in it, the operator may rate it once: 1–5 stars and an optional
  comment. It is stored on `platform_support_threads`, and an internal system
  message (`metadata.kind = 'support_rating'`) shows it in the inbox.
- **Files.** The operator may attach a file up to **2 MB**: PNG, JPEG, WebP,
  GIF, PDF or plain text. It is stored like any chat attachment of the support
  workspace (`conversation_attachments`). The team's files come back to the app
  the same way.
- **Who is asking.** Every new conversation opens with an internal notice
  (`metadata.kind = 'platform_support_requester'`, `internal: true`), written
  before the operator's first message (`server/services/platformSupport/requester.ts`).
  The inbox draws it as a card on the web and in the Android app; the operator
  never sees it. It is a snapshot as of that first message:
  - The person: name, email, phone, company, website, member since, the app
    they wrote from, and the workspace they wrote from.
  - Each workspace they belong to, owned ones first (at most 10; the total is
    given): their role, the plan with its state and renewal or trial end,
    operators, contacts, and this month's conversations, visitors, messages,
    AI credits and storage, each against the plan's limit where it sets one
    (`-1` is unlimited).
  - The stored body is the same in plain English, for a client that does not
    know the kind.
- **The operator is the conversation's contact** in the support workspace:
  - Their name, email and photo come from their profile and follow it.
  - An existing contact with the same email is adopted rather than duplicated.
  - `contacts.metadata` records `platform_user_id`, `platform_workspace_id`,
    `platform_workspace_name` and `client_platform`.
  - The inbox labels these conversations **"Site user · ‹app›"** — fa
    «کاربر سایت», tr «Site kullanıcısı» — where ‹app› is the client the
    operator wrote from: `Android`, `iOS`, `macOS`, `Windows` or `Web`.
- **Client.** Each write reads the `X-Client-Platform` header (`android`,
  `ios`, `macos`, `windows`; anything else or nothing is `web`) and stores it
  as `client_platform` on the message, the conversation and the contact.
- **Anyone may use it,** the support team's own members included. A team
  member who writes gets no push about their own message.
- **AI:** the AI is not run on support conversations.

## HTTP — `/api/platform-support`

Authentication is any signed-in session: the cookie on the web, `Bearer` in
the apps. Bodies and responses are camelCase JSON.

| Method and path | Body | Response |
| --- | --- | --- |
| `GET /status` | — | `Status` |
| `GET /history` | — | `History` |
| `POST /messages` | `{ body, clientMessageId, conversationId?, workspaceId? }` | `{ conversation: Conversation, item: Item }` |
| `POST /attachments` | `{ fileName, mimeType, data, clientMessageId, conversationId?, workspaceId? }` | `{ conversation: Conversation, item: Item }` |
| `GET /attachments/:id` | — | the file's bytes (`Content-Type` is its type) |
| `POST /conversations/:id/rating` | `{ score, comment? }` | `{ conversation: Conversation }` |
| `POST /read` | — | `{ ok: true }` |

```ts
type Status = {
  enabled: boolean;            // Super Admin has it on and a workspace chosen
  available: boolean;          // this operator may use it (today: = enabled)
  online: boolean;             // somebody on the team is reachable now
  teamName: string | null;     // the support workspace's name
  teamAvatar: string | null;   // its logo (workspace_branding), for the chat's bar
  unread: number;              // the team's messages the operator has not read
  hours: BusinessHours | null; // null when the workspace keeps no hours
  nextOpenAt: string | null;   // ISO; set while closed by the hours
};

type BusinessHours = {
  timezone: string;            // IANA, e.g. "Asia/Tehran"
  // Keys sat..fri; an absent or empty day is closed. Times are "HH:mm".
  weekly: Partial<Record<'sat'|'sun'|'mon'|'tue'|'wed'|'thu'|'fri', { from: string; to: string }[]>>;
};

type History = {
  conversations: Conversation[]; // oldest first; the last 20
  items: Item[];                 // oldest first, across them; at most 500
  activeConversationId: string | null;
};

type Conversation = {
  id: string;
  status: 'open' | 'pending' | 'resolved' | 'closed';
  createdAt: string;
  endedAt: string | null;       // when it was resolved or closed
  rating: { score: number; comment: string | null; ratedAt: string } | null;
  canRate: boolean;             // ended, answered by the team, not rated yet
};

type Item = {
  id: string;
  conversationId: string;
  kind: 'message' | 'joined';
  author: 'me' | 'team';        // 'team' for a join
  body: string;                 // for a join: empty
  senderName: string | null;    // the agent's name; for a join: who joined
  senderAvatar: string | null;
  createdAt: string;
  clientMessageId: string | null;
  attachments: Attachment[];
};

type Attachment = {
  id: string;                   // fetch with GET /attachments/:id
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  kind: 'image' | 'audio' | 'video' | 'file';
};
```

**Request rules**
- `conversationId` is the conversation the app shows, when it is active.
  Leave it out to start a new one; when the operator's other device already
  started one, the message joins that. An ended conversation is refused with
  `conversation_ended` — unless this `clientMessageId` landed there before it
  ended, which returns that item.
- `workspaceId` is the workspace the operator is writing from, when the client
  knows it. The inbox shows its name next to the contact.
- `clientMessageId` makes a retry safe: `[A-Za-z0-9_-]{8,64}`, minted once per
  message. The same id returns the same item, and — for the message that
  starts a conversation — the same conversation.
- `data` is the file's bytes in base64. At most 2 MB once decoded.

**Errors** are `{ error: code }`:

| Code | Status |
| --- | --- |
| `support_disabled`, `support_not_configured`, `conversation_not_found`, `attachment_not_found` | 404 |
| `conversation_ended`, `already_rated`, `not_ratable` | 409 |
| `invalid_body`, `invalid_rating`, `invalid_file`, `file_type_not_allowed` | 400 |
| `file_too_large` | 413 |
| `rate_limited` | 429 |

**Limits**
- 30 messages or files per 5 minutes per operator.
- A body is at most 4000 characters; a rating comment at most 1000.

### Realtime

On the operator's user channel `ws:<workspace>:user:<userId>`, where the app
subscribes through `POST /api/realtime/operator-user-subscribe`, events have
this shape:

```json
{ "type": "event", "payload": { "kind": "support_message" | "support_update" | "support_read", "workspace_id": "…", "thread_id": "…", "message_id": "…" } }
```

- `support_message`: the team wrote, or the operator did on another device.
- `support_update`: the conversation was resolved, closed, reopened,
  assigned or transferred.
- `support_read`: the operator read the chat on another device.

Events carry ids only; `thread_id` is the conversation id. The client reads
`/history` again.

### Push

The data payload is `{ type: 'support_reply', workspaceId, threadId, messageId }`.
- The Android tag is `support:<threadId>`.
- `workspaceId` is a workspace the operator belongs to, which the app files
  the notification under. A tap opens the support chat.

## Super Admin

`/api/admin/platform-support`:

| Method and path | Body | Response |
| --- | --- | --- |
| `GET /settings` | — | `{ settings: { enabled, workspaceId, updatedAt }, workspace, suggestions }` |
| `PUT /settings` | `{ enabled?, workspaceId? }` | `{ success, settings }` |
| `GET /workspaces?search=` | — | `{ workspaces: [{ id, name, slug }] }` |

`GET /settings` returns `suggestions`: the workspaces this Super Admin owns
or administers.

Mobile App → Android → In-app → **Show "Online support"**
(`mobile_app_settings.android_app_show_support`, served as `showSupport`)
hides the section in the Android app without a new build.

## Clients

- **Android:** Settings → Online support, one row. It opens the chat.
  - The section appears when `enabled && available` and `showSupport`.
  - Offline, a banner says "leave a message" and lists the hours.
  - Settings ends with the version in small type, the platform's website
    (`canonicalBaseUrl` from `/api/platform/origins`) and «WEBYAR AI»; there
    is no About section.
  - The bar shows the support workspace's logo (`teamAvatar`; a headset
    while it has none) and its presence.
  - On arrival, the chat shows the open conversation, or, with none open, a
    fresh page like the very first.
  - When there are closed conversations, a **Closed** button in the bar lists
    them, newest first. Each row shows its first words, how and when it
    ended, and its stars, or "Rate". A conversation opens read-only, with its
    end and its rating card.
  - If the conversation on screen ends, the composer gives way to "This
    conversation was resolved" and a **Start a new conversation** button.
    Nothing more can be written to it.
  - A message refused with `conversation_ended` (the team closed the
    conversation while the operator typed) goes back into the composer, and
    the chat shows the end.
  - The composer takes text and a file (2 MB); no emoji.
  - Replies arrive live, and a `support_reply` push opens the chat.
- **iOS, macOS, Windows, web:** the same endpoints and events.
