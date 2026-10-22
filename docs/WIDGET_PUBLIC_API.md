# Chat Widget — Public JavaScript API

The visitor-facing widget exposes a small, stable command/event surface on
`window.__gs`. This is the *only* supported way for a host page to control
the widget — never reach into the widget's Shadow DOM, `window.__gs_runtime`,
`window.__gs_token`, or any other internal global; those are implementation
detail and may change without notice.

## Embedding

```html
<script>
  window.__gs = window.__gs || [];
  window.__gs.push(['onReady', function () { console.log('widget ready'); }]);
</script>
<script async src="https://YOUR_DOMAIN/widget/loader.js" data-workspace-id="WS_ID"></script>
```

`window.__gs` is a **command queue**: every call is `__gs.push(['commandName', ...args])`.
Calls made before the loader script has even executed are captured by the
`window.__gs = window.__gs || []` bootstrap array and replayed in order once
the widget is ready — so it's always safe to queue commands immediately,
with no need to wait for anything. This is unchanged, backward-compatible
behavior; nothing about the existing `open`/`close`/`toggle`/`setUnread`
contract changes.

## Commands

| Command | Args | Description |
|---|---|---|
| `open` | — | Opens the chat panel. |
| `close` | — | Closes the chat panel. |
| `toggle` | — | Toggles the chat panel open/closed. |
| `setUnread` | `count: number` | Sets the launcher's unread badge count directly. Normally server-driven — only call this if you're deliberately overriding it. |
| `show` | — | Shows the launcher bubble (if previously hidden with `hide`). |
| `hide` | — | Closes the panel (if open) and hides the launcher bubble entirely. |
| `getState` | `callback: (state) => void` | Reads current widget state — see below. |
| `isOpen` | `callback: (state) => void` | Same callback/payload as `getState` — a shorter name for when you only care about `open`. |
| `identify` | `{ name?, email?, phone? }` | Remembers visitor contact details and includes them on the visitor's next sent message, via the same `visitor_name`/`visitor_email`/`visitor_phone` fields the pre-chat form already sends, and fills the pre-chat form's empty fields with them. A value that is not usable (an email that is not one, a phone over 30 characters) is left out, never a reason to refuse the visitor's message. Does not create a conversation or send anything by itself. |
| `consent` | `granted: boolean` | The visitor's answer to your consent banner for the widget's tracking (see [Privacy and consent](#privacy-and-consent)). `true` (or `'granted'`) starts it; anything else holds it, or stops it when it is running. Not stored by the widget: push it on every page load (it may be queued before the loader runs). Chat works either way. |

### Querying state: `getState` / `isOpen`

`window.__gs.push([...])` is a **fire-and-forget queue** — the dispatcher
that drains it calls each command and discards whatever it returns, so a
command that tried to `return` a value (e.g. a naive `isOpen()` design)
would have nowhere for that value to go and could never actually reach the
host page. Every state query is therefore **callback-shaped** instead,
exactly like `onReady`/`onOpen`/etc. — pass a function as the argument and
the widget calls it with a state object:

```js
window.__gs.push(['getState', function (state) {
  console.log(state); // { ready: true, open: false, visible: true, unread: 2 }
}]);

// Shorthand for the same thing, if you only care about `open`:
window.__gs.push(['isOpen', function (state) {
  if (state.open) { /* panel is currently open */ }
}]);
```

`state` is always exactly:

```ts
{
  ready: boolean;   // command API has finished bootstrapping
  open: boolean;    // chat panel is open
  visible: boolean; // launcher bubble is shown (false after hide())
  unread: number;   // current server-authoritative unread count
}
```

No tokens, visitor IDs, conversation IDs, or other internal state — ever.

This follows the same queue-before-ready semantics as every other command:
you can call `getState`/`isOpen` immediately after the embed snippet, even
before the loader script has run, and the callback fires once the widget
is actually ready to answer.

For state *transitions* (as opposed to a point-in-time read), prefer the
events below (`onOpen`/`onClose`/`onUnreadChange`) — they push to you
instead of requiring you to poll.

## Privacy and consent

What the widget tracks, unless held: the page path a visitor views (page
history and the operators' live visitors list), the visitor's browser,
device and referrer, the campaign (UTM) tags of the first page, Smart
Engagement counters in the browser's storage, and the recent pages the AI
proactive nudges read. The chat itself (and what a visitor types into it)
is not tracking: it works whatever the visitor answered.

- **Waiting for consent.** A workspace can turn on *Wait for visitor consent
  before tracking* (Settings → Privacy Requests → Visitor privacy). Nothing
  above is then recorded, sent or stored until your page pushes
  `['consent', true]`, typically from your cookie banner's "accept":

  ```js
  window.__gs = window.__gs || [];
  // On every page load, with the visitor's current answer:
  window.__gs.push(['consent', myBanner.hasConsent('functional')]);
  // And when they change it:
  myBanner.onChange(function (ok) { window.__gs.push(['consent', ok]); });
  ```

  Smart Engagement's proactive messages and the AI nudges start with it
  (they run on those counters and pages). `['consent', false]` holds
  tracking even where the workspace does not ask for consent, and stops it
  on the page where it is running (the visitor leaves the live visitors
  list).
- **Global Privacy Control.** A browser that sends GPC
  (`navigator.globalPrivacyControl`, the `Sec-GPC: 1` header) is treated as
  "waiting for consent" whatever the workspace's setting: only an explicit
  `['consent', true]` from your page starts tracking for that visitor. The
  server applies the same rule to the page views and custom events
  (`gsAnalytics.track`) it is sent, and stores nothing it was not allowed to.
- **Query strings.** A tracked page is recorded as its path only:
  `/checkout?email=…&token=…` is stored as `/checkout`. A workspace that
  needs them can turn on *Keep query strings in page history*. A referrer is
  always stored without its query string. Campaign (UTM) tags are read
  before and kept in their own fields.
- **Retention.** Once the platform turns visitor data retention on (it
  starts off), visitor sessions, page history, web analytics events and
  Smart Engagement and AI nudge records are deleted after 13 months, or
  after the period the workspace chooses (30 days to 3 years).
  Conversations and contacts are not affected (they stay in the inbox; an
  anonymous visitor back after the period starts a new visit).
- **The visitor's forms.** The pre-chat and leave-a-message forms can show
  a privacy line with a link to your policy, and a consent box the visitor
  ticks before sending (Widget → Pre-chat → Privacy notice in the form).

## Events

Registering for an event is itself a command — `push(['onX', callback])` —
so it follows the exact same queue-before-ready semantics as every other
command: register anytime, even before the loader has run.

| Event | Payload | Fires when |
|---|---|---|
| `onReady` | — | The widget's command API has finished bootstrapping and is accepting commands. Registering `onReady` **after** the widget is already ready still fires immediately (it does not require having been queued in time). |
| `onOpen` | — | The chat panel transitions from closed to open. |
| `onClose` | — | The chat panel transitions from open to closed. |
| `onMessage` | `{ text: string, senderType: string }` | A new inbound message (from an operator, the AI agent or the system — a join, the queue notice — never the visitor's own message) arrives while the panel is closed, on another tab, or the message isn't otherwise already visible. `text` is what the visitor reads: a system row's sentence in the widget's language, empty for a kind the widget cannot write. The payload is intentionally minimal — no message id, no conversation id, no attachment data — to avoid leaking anything beyond what a host page legitimately needs (e.g. driving its own notification UI). |
| `onUnreadChange` | `count: number` | The server-authoritative unread count changes (including going back to 0). |

Multiple listeners may be registered for the same event; each is called
independently and a throwing listener never prevents the others from
running.

## Safety guarantees

- **Calls before runtime load**: commands and event registrations made
  before the (lazily-loaded) chat runtime has finished mounting are queued
  and replayed in order once it's ready.
- **Calls before bootstrap completes**: same queueing applies to the very
  first moments after the loader script executes, before
  `POST /widget/bootstrap` resolves.
- **SPA navigation**: the widget is a singleton per page load; it is not
  torn down on client-side route changes, so registered listeners keep
  working across navigation within the same page.
- **Duplicate loader injection**: a second `<script src=".../loader.js">`
  tag (or an SPA re-mounting it) is a no-op — the existing instance and its
  registered listeners are left untouched.
- **No internal exposure**: no event payload or command ever exposes an
  access/session token, a raw visitor or conversation id, or any other
  internal identifier. The widget's internal DOM, stores, and realtime
  transport remain private implementation detail.

## Backward compatibility

`open`, `close`, `toggle`, and `setUnread` behave exactly as before this
API was extended. Nothing here is a breaking change.
