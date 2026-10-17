# WebYar (وب‌یار) · brand sheet for the chat widget

WebYar is the Iranian edition of the support widget (webyar.ai). The widget speaks **Persian, right to left**, and must
read as a native Persian product, not a mirrored English one.

| Design | Folder | Production template id (see [brief §3](../CLAUDE_CODE_BRIEF.md)) |
|---|---|---|
| Template 1 · Classic: home with hero and cards, bottom menu (Home / Messages / Help) | [`template-1-classic/`](template-1-classic/README.md) | `default` |
| Template 2 · Simple home: ask field on home, no bottom menu | [`template-2-simple-home/`](template-2-simple-home/README.md) | `simple` (new) |

## Colour

| Role | Value | Notes |
|---|---|---|
| Default accent (`--a`) | `#0B7D6C` | Used when the workspace has not chosen a colour (empty or production default `#3B82F6`). Any other hex replaces it and re-tints the whole widget |
| Colour palette in settings | فیروزه‌ای وب‌یار `#0B7D6C` · آبی `#2563EB` · نیلی `#4F46E5` · بنفش `#7C3AED` · صورتی `#DB2777` · نارنجی `#D9480F` · سبز `#15803D` · مشکی `#111827` | From the "launcher and colour" board; any hex also works |
| Hero, Template 1, brand default | `linear-gradient(155deg,#1DB99D 0%,#0F927D 46%,#0B7D6C 100%)` | Only with the default accent; other accents use the formula in `template-1-classic/tokens.json` |
| Hero, Template 2, brand default | stops `--h1 #22C4A6`, `--h2 #0F927D`, `--h3 #08594E`, glow `#7CF5DF` | Only with the default accent |
| Launcher kit (production, brand mode) | `linear-gradient(140deg,#22D3B4,#0B7D6C)`, dots `#18AD94`, ring `#16C7A8`, shadow `0 12px 28px rgba(11,125,108,.36),0 3px 8px rgba(18,20,31,.16)` | Unchanged; see production map §3.2 |
| Unread badge | `#FFB423` background, `#12141F` text, Persian digits | Same yellow on the launcher and on the Messages tab |
| Text ink scale | `#0F1217` · `#434955` · `#666D7A` · `#A3A9B4` | `--ink`, `--ink-2`, `--ink-3`, `--ink-4` |
| Status | online `#12A150` · error `#D33A43` · recording `#E5484D` | `--ok` / `--live`, `--bad`, `--rec` |
| Offline launcher | ground `#12141F`, bubble `#16C7A8`, dots `#12141F` | Production kit offline state |

## Logo in the widget

Files in [`../shared/brand/webyar/`](../shared/brand/webyar/) (all `fill="currentColor"`, colour them with CSS):

| File | Where the widget uses it |
|---|---|
| `webyar-mark.svg` (viewBox `17 13.5 26 33.5`) | Large watermark in the home hero, white at low opacity (Template 1 `.hx-mk`: 156px wide, opacity .11, rotated -10deg; Template 2 `.hero .mk`: 172px wide, opacity .08) |
| `webyar-mark-dots.svg` | "Powered by" footer mark, 11 × 15px, before the text `قدرت گرفته از وب‌یار` (the word وب‌یار in bold) |
| `webyar-launcher-glyph.svg` | The chat-button glyph (bubble + three diamond dots). Identical to production `WEBYAR_LAUNCHER_CHAT_GLYPH` |
| `webyar-launcher-close.svg` | The chevron the launcher shows while open. Identical to production `WEBYAR_LAUNCHER_CLOSE_GLYPH` |

People never get photos in the designs: team members appear as an initial on a soft colour tile (`.c1`–`.c4`), and the
store itself as its logo, or its initial in the accent colour, on the white `.logo` tile in the hero. WebYar's mark never
replaces the store's logo; it only appears as the hero watermark, in the footer and on the launcher.

## Type

**Vazirmatn** 400 / 500 / 600 / 700 for everything, including Latin. Files and licence:
[`../shared/fonts/`](../shared/fonts/). Production currently ships IRANSans; the new templates replace it (brief §6).

## Language rules

- Persian digits (۰–۹) for every number the UI prints: times (`۱۹:۴۱`), counts, badges, dates, step numbers, sizes.
- Latin fragments stay Latin and left-to-right inside Persian text: order and tracking codes (`TR-2290-5531`), emails,
  URLs, phone numbers in input fields. Wrap them in an element with `direction: ltr; unicode-bidi: isolate`.
- Keep zero-width non-joiners in words such as `می‌توانیم`, `وب‌یار`, `پیام‌ها`.
- Tone: polite plural (`شما`), short and warm: `سلام، خوش آمدید` / `چطور می‌توانیم کمکتان کنیم؟`.
- Message sides stay physical: the visitor on the right, the team on the left.
- Dates follow production (Jalali in `Asia/Tehran` unless the workspace chose Gregorian).
