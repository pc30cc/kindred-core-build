# Webyar for Windows

The operator app for Windows: the same inbox, chat, calls, email and team
messaging as the native iOS app (`ios/WebyarNative`), built for the desktop.
Electron + React + TypeScript, talking to the same REST API.

## What it does

Everything the iOS app does — sign-in and password reset, inbox queues and
channel inboxes, chat with attachments, voice notes, saved replies and emoji,
AI take-over and "say now", status / priority / transfer / tags / internal
notes, voice and video calls over LiveKit, email inbox, colleagues, contacts
with visitor device and location, availability, notification preferences,
profile, sessions, password, account deletion and promotions — in Persian,
English and Turkish, with right-to-left layout and the Persian calendar.

On top of that, the things a desktop is for: a three-pane layout with an inline
details panel, `Ctrl+K` search across everything, keyboard navigation, drag
and drop / paste to attach, `/` for saved replies, Windows notifications and a
taskbar badge, running in the tray, and starting with Windows.

## How it talks to the server

Every HTTP request is made by the main process (`src/main/api.ts`), never the
page. The API issues a Bearer session only to a client that sends no `Origin`
header (`server/routes/auth.ts`), and doing it there keeps the token out of the
renderer: it is stored encrypted with Windows DPAPI via `safeStorage`.

There is no push channel on Windows, so the app polls — the open chat every
4 s, the inbox every 10 s, and a background watcher that raises notifications
following the operator's own notification preferences.

## Build

```bash
npm install
npm run typecheck
npm run dist        # → dist/Webyar-Setup-<version>.exe (run on Windows)
```

`npm run dev` runs it with hot reload. `WEBYAR_SAMPLE=1` starts it against an
in-memory sample backend, for laying out screens without an account.

The copy shared with iOS is generated from `Strings.swift`:
`npm run strings` rewrites `src/renderer/src/i18n/strings.json`. Desktop-only
copy lives in `src/renderer/src/i18n/extra.ts`.
