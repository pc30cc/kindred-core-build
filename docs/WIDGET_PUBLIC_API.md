# WebYar Chat Widget — Public JavaScript API

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
| `isOpen` | — | *Not a queueable command* — see below. |
| `identify` | `{ name?, email?, phone? }` | Remembers visitor contact details and includes them on the visitor's next sent message, via the same `visitor_name`/`visitor_email`/`visitor_phone` fields the pre-chat form already sends. Does not create a conversation or send anything by itself. |

### Querying state: `isOpen`

`isOpen` cannot be meaningfully "pushed" (its return value would be
discarded by the queue). Instead, once the widget is ready, call it as an
event handler side-effect or via `onOpen`/`onClose`, e.g.:

```js
window.__gs.push(['onOpen', function () { /* panel is open */ }]);
window.__gs.push(['onClose', function () { /* panel is closed */ }]);
```

If you need a one-off synchronous read (rare — prefer the events above),
you can inspect it from inside an `onReady`/`onOpen`/`onClose` callback,
since those only fire once the internal API object exists.

## Events

Registering for an event is itself a command — `push(['onX', callback])` —
so it follows the exact same queue-before-ready semantics as every other
command: register anytime, even before the loader has run.

| Event | Payload | Fires when |
|---|---|---|
| `onReady` | — | The widget's command API has finished bootstrapping and is accepting commands. Registering `onReady` **after** the widget is already ready still fires immediately (it does not require having been queued in time). |
| `onOpen` | — | The chat panel transitions from closed to open. |
| `onClose` | — | The chat panel transitions from open to closed. |
| `onMessage` | `{ text: string, senderType: string }` | A new inbound message (from an operator or the AI agent — never the visitor's own message) arrives while the panel is closed, on another tab, or the message isn't otherwise already visible. The payload is intentionally minimal — no message id, no conversation id, no attachment data — to avoid leaking anything beyond what a host page legitimately needs (e.g. driving its own notification UI). |
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
