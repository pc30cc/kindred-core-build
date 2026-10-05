# Notes for Claude Code sessions

## Running the Android app for someone to see (Mac)

The owner's MacBook Pro is reachable through Desktop Commander as
`rass-MacBook-Pro-7.local`. To put the app on its screen, use the launcher
that is known to show a picture there:

```sh
~/dev/webyar-emulator.command
```

It starts `Webyar_API36` with `-gpu swiftshader_indirect` (flag, not
`config.ini`), waits for boot and opens `com.webyar.ai`. Do not use
`Webyar_API37` (SurfaceFlinger crash-loop) or `-gpu host` (black window), and
keep `hw.display1.*` at 0 in the AVD (a second display halves the phone).
Build from a separate worktree (`~/dev/kcb-ui-preview`), never from the
owner's checkout in `~/dev/kindred-core-build`, which is on their own branch.

Why each of those holds, with measurements: `docs/ANDROID_LOCAL_DEV.md`.

## The iOS app in Xcode on the Mac

`~/dev/kcb-ios-preview` is the copy of the iOS app (`ios/Webyar`)
open in the owner's Xcode. A LaunchAgent (`ai.webyar.xcode-sync`, script
`~/dev/webyar-xcode-sync.sh`, log `~/dev/webyar-xcode-sync.log`) moves it to
the latest `origin/main` every 3 minutes and regenerates the Xcode project, so
whatever is merged shows up there on its own. It skips the update while a
tracked file there has local edits. Do not check other branches out in that
folder: build and test a PR in a separate worktree (e.g. `~/dev/kcbi-pr`).
Turn the sync off with `launchctl bootout gui/$(id -u)/ai.webyar.xcode-sync`.
