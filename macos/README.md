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

Super Admin → macOS app steers every installed copy without a release
(`GET /api/platform/macos-app`, read on launch and hourly, every minute
during maintenance; see `Core/Config/MacAppConfig.swift`): the appcast,
channel and cadence of updates and which builds must update, realtime and
polling, which sections and tools are on (ANDed with the workspace plan),
the menu bar item, open at login, the Dock badge and notifications, the
defaults of a first launch, a maintenance notice over the window, and the
help and legal links in the Help menu and Settings.

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
scripts/install-local.sh   # Release build, installed in ~/Applications and opened
```

(A plain `xcodebuild … -configuration Release` build keeps the hardened
runtime, which refuses LiveKit's WebRTC framework under an ad hoc signature;
the script builds without it.)

`WEBYAR_SAMPLE=1` (Debug builds only) answers every API call from memory, so
every screen can be laid out without a server or an account;
`WEBYAR_DEBUG_DIR=<folder>` also writes a PNG of each window there and takes
one-line commands from `<folder>/command.txt` (`route contacts`, `open c-1`,
`lang en`, `appearance dark`, `settings`, `ring`, `route email`, `mail e-2`,
`compose`, `websnap`) — see `App/DebugTools.swift`.
`xcodebuild test` runs the Windows app's Core tests, ported with the same
expected values.

## Updates

Installed apps update through Sparkle from `pc30cc/mac-os`, a public
repository: `appcast.xml` at its root and `releases/<version>/` with the zip
Sparkle downloads and the DMG people download. The app itself carries no
feed address and never reuses a remembered one: Super Admin → macOS app
tells it where the appcast is (this repository's, by default) on every
launch, as it tells it the channel and the DMG link, so the feed can move
without a new build. Until the platform has answered in a launch, the app
does not look for updates. Every update is signed
with an EdDSA key; its public half is `SPARKLE_PUBLIC_KEY` in `project.yml`,
so the apps refuse anything signed with another key.

Two ways to publish, both through `scripts/publish-feed.sh`:

- **From a Mac** — `scripts/release-local.sh <version> <build> [stable|beta] ["notes"]`
  builds, packages, signs with the private key `generate_keys` keeps in that
  Mac's Keychain, and pushes. Signed ad hoc: the first manual install needs
  right-click → Open once; updates after that need nothing. The build number
  must grow with every release. Back up the private key once with
  `generate_keys -x <file>` and keep it somewhere safe: without it, no
  update can ever reach the installed apps again.
- **From CI** — tag `mac-v<version>` (matching `MARKETING_VERSION` in
  `project.yml`); `.github/workflows/macos.yml` signs with Developer ID,
  notarizes and publishes. It needs the secrets listed at its top,
  including that same private key as `SPARKLE_PRIVATE_KEY`.
