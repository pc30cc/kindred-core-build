# Shared files

| Path | What it is |
|---|---|
| [`production-map.md`](production-map.md) | How the chat widget in production is built today: Shadow DOM mounting, template registry, panel frame, launcher kits, the markup of every view, all 119 `data-*` hooks, i18n keys, and what a re-skin must preserve. Line references point into `public/widget/*` |
| [`new-hooks-and-settings.md`](new-hooks-and-settings.md) | Canonical registry of the new behaviour hooks, settings, view-model fields and i18n keys the four design specs introduce: one name per concept, shared by both brands and both templates |
| [`fonts/`](fonts/) | Vazirmatn (WebYar), Figtree and DM Mono (Respok) font files, a ready `fonts.css`, and the licences ([`LICENSES.md`](fonts/LICENSES.md), SIL OFL 1.1) |
| [`brand/webyar/`](brand/webyar/) | WebYar mark, mark with the three diamond dots (footer), launcher glyph and close chevron. All `fill="currentColor"` |
| [`brand/respok/`](brand/respok/) | Respok symbols and lockups for both logo directions (Open, Thread), the launcher close chevron, the brand-kit sprite and the kit's token files (`respok-kit-tokens.css` / `.json`) |

Where each brand asset is used in the widget: [`../webyar/README.md`](../webyar/README.md),
[`../respok/README.md`](../respok/README.md).
