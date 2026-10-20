# WebYar (وب‌یار) · brand sheet for the call-center widget

WebYar is the Iranian edition (webyar.ai). The call-center widget lets a visitor start a **voice or video call** with the
support team, or leave a **callback request**. It speaks **Persian, right to left**, and must read as a native Persian
product. It belongs to the same family as the WebYar chat widget (same accent logic, type, footer and motion language).

| Design | Folder | Production template id (see [brief §3](../CLAUDE_CODE_BRIEF.md)) |
|---|---|---|
| Template 1 · Call center: light panel for choosing and forms, dark "call stage" for the queue and the call | [`template-1-call-center/`](template-1-call-center/README.md) | `default` (restyled in place) |

## Colour

| Role | Value | Notes |
|---|---|---|
| Default accent (`--a`) | `#0B7D6C` | Used when the workspace has not chosen a colour. Any other colour from `widget_theme` replaces it and re-tints the whole widget, including the dark call stage |
| Accent presets on the boards | `#0B7D6C` · `#2563EB` · `#7C3AED` · `#DB2777` · `#D9480F` · `#111827` | Any colour also works (the design-system board shows several brands) |
| Call stage | `--s1` / `--s2` / `--s3` derived from the accent (`#0A4E44` / `#072D27` / `#041411` with the default) plus a glow `--glow` | The dark background of the queue, the live call and the in-call states |
| Live / available | `#12A150` (`--live`), highlight `#3BDC8A` | "Operators available" dot, connected states |
| End call | `#E5484D` (`--end`) | The red hang-up button |
| Error | `#D33A43` (`--bad`) | Field errors |
| Warning | `#E8A317` on `#FFF6E1`, text `#8A5300` | Reconnecting, consent notes |
| Rating stars | `#F5A524` (`--star`) | |
| Text ink scale | `#0F1217` · `#3F4551` · `#626A77` · `#A1A7B2` | `--ink`, `--ink-2`, `--ink-3`, `--ink-4` |

All values: [`template-1-call-center/tokens.json`](template-1-call-center/tokens.json).

## Logo in the widget

| Asset | Where |
|---|---|
| The workspace's own logo or initial | Header tile `.lg` (44 × 44, radius 14) and the "business logo" launcher variant, which flips to the phone icon on hover |
| [`../shared/brand/webyar/webyar-mark-dots.svg`](../shared/brand/webyar/webyar-mark-dots.svg) | "Powered by" footer: 11 × 15px mark before `قدرت گرفته از وب‌یار` (وب‌یار bold). White at 78% on the dark call stage |
| [`../shared/icons/`](../shared/icons/README.md) | The stroke icon set of the widget (phone, hang-up, mic, camera, …). The launcher glyph is the phone icon, not the chat kit's bubble |

## Type and language

- **Vazirmatn** 400 / 500 / 600 / 700 for everything ([`../shared/fonts/`](../shared/fonts/)).
- Persian digits (۰–۹) for **every** number the widget prints: timers (`۰:۴۷`, `۲:۱۴`), queue position (`نفر ۳ صف`),
  durations, dates and times of callbacks. Reference codes stay Latin (`A1B2C3D4`).
- Latin fragments (emails, reference codes, URLs) sit in an LTR isolate inside Persian text.
- Keep zero-width non-joiners (`می‌گیریم`, `کال‌سنتر`, `وب‌یار`).
- Tone: polite plural (`شما`), calm and reassuring around waiting: `جای شما محفوظ است`.
