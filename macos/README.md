# Webyar for Mac

The operator app for macOS: the same inbox, chat, calls, visitors, contacts,
call center and team messaging as the native Windows app (`windows-native/`),
built natively for the Mac in SwiftUI — Liquid Glass on macOS 26, and a
material fallback back to macOS 14.

## What it does

Everything the Windows app does, section for section:

- **Inbox** — the queues and channel inboxes in the sidebar (open, AI,
  needs a human, pending, resolved, spam, colleagues, other inboxes), the
  conversation list with the visitor's OS, flag, city and unread count, and
  the thread with attachments, voice notes, saved replies (`/`), emoji,
  drag and drop / paste to attach, AI take-over and "say now", status,
  priority, transfer, tags and internal notes in the details inspector.
- **Calls** — voice and video with the visitor over LiveKit, from a
  conversation or from the call center, in their own window.
- **Call center** — the waiting line, the log, the numbers and your
  availability; an incoming call rings in a card over any page.
- **Visitors** — who is on the site right now, on a MapKit map, with their
  pages; start a chat with one click.
- **Contacts** and **Colleagues** (operator-to-operator messages).
- **Email** — the workspace mailbox the web console connects (Gmail), for
  owners and admins when the plan has it: All / Unread / Starred, search,
  older mail page by page; the thread as one page with earlier messages
  folded, HTML mail shown as sent (scripts off, links open in the browser,
  inline images); reply, reply all and forward with To / Cc / Bcc filled
  the way mail apps do, attachments (drop, pick, download), star and
  unread, and a compose window (⌘N; ⌘↩ sends).
- **Settings** — language (Persian, English, Turkish, right to left and the
  Persian calendar), appearance, notifications, open at login, the menu bar
  item, updates and the file cache.

And what a Mac is for: native notifications with a Dock badge, a menu bar
item with the unread count and your status, keeping running in the menu bar
when the window is closed, keyboard shortcuts (⌘1…⌘8 for the sections,
⌘R refresh, ⇧⌘E resolve, ⌥⌘I details), and self-update through Sparkle.

## How it is built

- `Webyar/Core` — the Windows app's `Webyar.Core`, ported to Swift line for
  line: the API client (Bearer transport, never an Origin header), the
  models, the plan rules, Centrifugo realtime, notification rules, the
  display rules (visitor names, previews, Persian dates and digits).
- `Webyar/Services` — the session and the watchers: presence and the
  heartbeat, the call queue, background notifications, Super Admin's ads,
  announcements and broadcasts, updates, the Keychain and the file cache.
- `Webyar/DesignSystem` — the product's colour tokens (the same as Windows,
  iOS and the web), the Liquid Glass helpers, and the shared components.
- `Webyar/Features` — one folder per section.

The copy is the Windows app's own `strings.json`, bundled as is, so the two
desktop apps can never word something differently; the few Mac-specific
lines are in `Webyar/Resources/*-strings.json`. Persian uses IRANSans, the
same font file the Windows app ships.

The session token and "remember me" live in the Keychain. The app is
sandboxed and uses the hardened runtime.

## Build

```bash
brew install xcodegen
cd macos
xcodegen            # writes Webyar.xcodeproj
open Webyar.xcodeproj
```

Or from the command line:

```bash
xcodebuild -project Webyar.xcodeproj -scheme Webyar -configuration Release build
```

`WEBYAR_SAMPLE=1` (Debug builds only) answers every API call from memory, so
every screen can be laid out without a server or an account;
`WEBYAR_DEBUG_DIR=<folder>` also writes a PNG of each window there and takes
one-line commands from `<folder>/command.txt` (`route contacts`, `open conv-1`,
`lang en`, `appearance dark`, `settings`, `ring`) — see `App/DebugTools.swift`.
`xcodebuild test` runs the Windows app's Core tests, ported with the same
expected values.

Local builds are signed ad hoc and run on the Mac that built them. Releases
are built by `.github/workflows/macos.yml`: tag `mac-v<version>` (matching
`MARKETING_VERSION` in `project.yml`) and it signs with Developer ID,
notarizes, and publishes the DMG and the Sparkle appcast to
`pc30cc/webyar-desktop-releases` — see the workflow for the secrets it needs.
A build without `SPARKLE_PUBLIC_KEY` has self-update turned off.
