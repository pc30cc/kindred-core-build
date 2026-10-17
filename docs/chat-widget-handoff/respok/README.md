# Respok · brand sheet for the chat widget

Respok is the International edition of the support widget (respok.app). The widget speaks **English, left to right**.
If a Respok widget runs in Persian, the same layout mirrors and text switches to Vazirmatn.

| Design | Folder | Production template id (see [brief §3](../CLAUDE_CODE_BRIEF.md)) |
|---|---|---|
| Template 1 · Classic: home with hero and cards, bottom menu (Home / Messages / Help) | [`template-1-classic/`](template-1-classic/README.md) | `intl` (skin over `default`) |
| Template 2 · Simple home: ask field on home, no bottom menu | [`template-2-simple-home/`](template-2-simple-home/README.md) | `simple-intl` (new, skin over `simple`) |

## Colour (Respok brand kit v1.0)

| Name | HEX | Use in the widget |
|---|---|---|
| Ink | `#16142B` | Default accent (`--a`): header hero, visitor bubbles, primary buttons, launcher. Main text colour |
| Signal | `#FF5A3C` | "Live" status dot, the recording dot, the launcher's answer pill / dot; in Template 2 also keyboard focus rings, the composer and search focus ring, the typing caret and highlights |
| Signal Deep | `#D3361A` | Unread badges (white text), error text, the stop-recording icon |
| Slate | `#5E5C75` | Secondary text (`--ink-3`) |
| Mist | `#E4E3EC` | Borders and dividers (`--line`) |
| Paper | `#F5F5F8` | Panel and page backgrounds (`--bg` / `--paper`) |
| Away | `#A9A7BC` | Away state: an empty ring instead of the Signal dot; away answer pill on the launcher |
| White | `#FFFFFF` | Surfaces |

- Colour palette in settings (from the "launcher and colour" board): Respok Ink `#16142B` (default) · Blue `#2F5BFF` ·
  Indigo `#4F46E5` · Violet `#7C3AED` · Pink `#DB2777` · Orange `#C2410C` · Green `#15803D` · Teal `#0F766E`. Any hex
  must work.
- With the default Ink accent the hero uses hand-tuned stops (Template 1:
  `linear-gradient(155deg,#302C59 0%,#1E1B3B 50%,#16142B 100%)`; Template 2: `--h1 #3B3576`, `--h2 #1E1B3B`,
  `--h3 #100E20`, glow `#FF5A3C`).
- Contrast (from the kit): Ink on Signal 5.8:1 and white on Signal Deep 4.87:1 are fine for body text; white on Signal
  (3.1:1) and Signal Deep on Paper (4.48:1) only for large text and icons.
- The kit's own token file is copied to [`../shared/brand/respok/respok-kit-tokens.css`](../shared/brand/respok/respok-kit-tokens.css)
  (and `.json`). Its panel sizes (372 × 560, radius 24) describe the kit's demo widget; **the designs in this package
  override them** (400 × 720, radius 28, see each design README).

## Logo directions: Open and Thread

The brand kit has two finished directions and says to pick one:

- **Open**: a speech bubble with one square corner, pointing at a Signal dot.
- **Thread**: two message pills, the visitor's question (Ink/white) and Respok's answer (Signal).

Every Respok board supports both through one class on the widget root: `lg-open` or `lg-thread` (elements marked `g-o`
are shown only for Open, `g-t` only for Thread). The direction changes the hero watermark, the "Powered by" lockup, the
Messages-tab icon and the launcher glyph.

| | Template 1 boards default | Template 2 boards default | Production launcher kit today |
|---|---|---|---|
| Direction | Open | Thread | Thread (`RESPOK_LAUNCHER_CHAT_GLYPH`, the q/a pills) |

**Implementation:** support both behind one setting, `logoDirection: "thread" | "open"`, default **`thread`** so the panel
matches the launcher that ships today. Template 1 comes with screenshots in both directions (`*--thread.png` for the
default, the plain names for Open); Template 2's screenshots are Thread. If the owner standardises on Open, the launcher kit needs the Open glyph (bubble +
dot), drawn in the Template 1 launcher board. Files: [`../shared/brand/respok/`](../shared/brand/respok/)
(`respok-thread-symbol.svg`, `respok-open-symbol.svg`, `respok-open-bubble.svg`, `respok-lockup-thread.svg`,
`respok-lockup-open.svg`, `respok-launcher-close.svg`, plus the kit sprite `respok-sprite.svg`). The wordmark is drawn,
never typed.

## Type

| Use | Family | Weights |
|---|---|---|
| Interface (Latin) | Figtree | 400, 500, 600, 700, 800 |
| Codes, tracking numbers | DM Mono | 400, 500 |
| Persian / RTL | Vazirmatn | 400, 500, 600, 700 |

Figtree needs tighter leading than Vazirmatn: the Respok skins reduce line-heights (Template 1 `respok.css`, Template 2
`.b-rp` rules). Files and licences: [`../shared/fonts/`](../shared/fonts/).

## Language rules

- English UI copy in sentence case: "How can we help you today?", "Start a conversation", "Powered by Respok".
- Times in the user's locale (`7:42 PM` in the boards). Latin digits.
- Message sides stay physical: the visitor on the right, the team on the left.
