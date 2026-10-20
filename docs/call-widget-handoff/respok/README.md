# Respok · brand sheet for the call-center widget

Respok is the International edition (respok.app). The call-center widget lets a visitor start a **voice or video call**
with the support team, or book a **callback**. It speaks **English, left to right** (Persian/RTL falls back to Vazirmatn).
It belongs to the same family as the Respok chat widget.

| Design | Folder | Production template id (see [brief §3](../CLAUDE_CODE_BRIEF.md)) |
|---|---|---|
| Template 1 · Call center: light panel for choosing and forms, Ink "call stage" for the queue and the call | [`template-1-call-center/`](template-1-call-center/README.md) | `intl` (skin over `default`, restyled in place) |

## Colour (Respok brand kit)

| Name | HEX | Use in the call widget |
|---|---|---|
| Ink | `#16142B` | Default accent (`--a`): primary buttons, launcher, header tile; main text |
| Signal | `#FF5A3C` | Live / available dot, focus rings, the consent switch, the active segmented-control icon, rating stars, the stage glow |
| Signal Deep | `#D3361A` | Errors (`--bad`) |
| End call | `#E5432A` | The hang-up button (`--end`) |
| Stage | `#2E2A5E` / `#1A1838` / `#0D0C1C` (`--s1`..`--s3`) with a Signal glow and an indigo `#3B3576` light | The dark background of the queue and the call (fixed Ink stage, not derived from a custom accent) |
| Slate · Mist · Paper | `#5E5C75` · `#E4E3EC` · `#F5F5F8` | Secondary text, lines, quiet fills |
| Away | `#A9A7BC` | Offline states |

- Accent presets on the boards: `#16142B` · `#2F5BFF` · `#0F766E` · `#C2410C`; any colour works.
- All values: [`template-1-call-center/tokens.json`](template-1-call-center/tokens.json).

## Logo directions

Respok has two official logo directions, **Open** and **Thread** (see the brand kit). The call-center boards support
both through one root class (`lg-thread` / `lg-open`; elements `g-t` / `g-o`), which changes the "Powered by" lockup.
The boards default to **Thread**, matching the chat widget package and the chat launcher that ships today; implement the
same setting (`logoDirection`, default `thread`). Files: [`../shared/brand/respok/`](../shared/brand/respok/).

## Type and language

| Use | Family | Weights |
|---|---|---|
| Interface | Figtree | 400–800 |
| Reference codes | DM Mono | 400, 500 |
| Persian / RTL | Vazirmatn | 400–700 |

Figtree is set with tighter leading and slight negative tracking on large titles (the `.b-rp` rules in `cc.css`).
English UI copy in sentence case ("Talk to our team", "Request a callback"); times like "0:47" and "2:14".
