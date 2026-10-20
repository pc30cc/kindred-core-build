# Call-center icon set

One stroke family for every icon in the call-center designs (the production widget uses emoji today; the designs replace
them). All files: 24 × 24 viewBox, `fill="none"`, `stroke="currentColor"`, round caps and joins. The boards draw them at
sizes 14–36px with stroke width 1.6–2.6 (each design README gives the size and stroke per component); the files use 1.8.
Inline them as SVG in the widget markup (no icon font, no external requests). Icons marked "mirrors" get
`transform: scaleX(-1)` in right-to-left layouts (`[dir=rtl] .dirf`).

| File | Meaning | Used for |
|---|---|---|
| `phone.svg` | Phone handset | Voice call, launcher glyph, call stage avatar ring |
| `hangup.svg` | Handset rotated 135° | End call / cancel call (red button) |
| `phone-in.svg` | Handset with an incoming arrow | Callback request (launcher offline, callback buttons) |
| `video.svg` / `video-off.svg` | Camera / camera off | Video call, camera toggle |
| `mic.svg` / `mic-off.svg` | Microphone / muted | Mute toggle, microphone permission state |
| `vol.svg` / `vol-x.svg` | Speaker / speaker off | Ringback sound toggle in the queue |
| `headset.svg` | Headset | Operator / support, transfer state |
| `mini.svg` / `expand.svg` | Minimise / restore | Minimise the call into the launcher; reopen |
| `chev-d.svg` | Chevron down | Collapse the panel (header) |
| `chevron-forward.svg` | Chevron to the reading end (mirrors) | List rows, links |
| `back.svg` | Back arrow (mirrors) | Back in forms |
| `arrow-f.svg` | Forward arrow (mirrors) | Primary "continue" buttons |
| `check.svg` | Check | Success, saved contact, confirmed callback |
| `x.svg` | Close | Dismiss |
| `retry.svg` | Retry | Try again after an error |
| `warn.svg` / `info.svg` | Warning / info in a circle | Errors, notes |
| `wifi-off.svg` / `signal.svg` | Connection lost / signal strength | Reconnecting; live-call signal indicator |
| `lock.svg` / `shield.svg` | Lock / shield | Privacy, secure call notes, permission help |
| `bolt.svg` | Bolt | "Fast connection" feature row, urgent priority |
| `users.svg` | People | Queue management feature row |
| `cal.svg` / `clock.svg` / `moon.svg` | Calendar / clock / moon | Scheduled callback; "we will call you" timing note; team-offline note |
| `star.svg` | Star | Rating |
| `globe.svg` | Globe | Language switcher |
| `copy.svg` | Copy | Copy the callback reference code |
