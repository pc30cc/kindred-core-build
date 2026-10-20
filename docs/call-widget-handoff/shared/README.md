# Shared files

| Path | What it is |
|---|---|
| [`production-map.md`](production-map.md) | How the call-center widget in production is built today: loader, Shadow DOM host, presentation lifecycle, the 9 states and every sub-state with its markup, the controller calls, media hooks (LiveKit), timers, ringback, forms, `--ccw-*` tokens, i18n strings (fa / en), what a re-render must preserve, and the known bugs. Line references point into `public/call-widget/*` |
| [`new-hooks-and-settings.md`](new-hooks-and-settings.md) | Canonical registry of the new controller calls, hooks, settings, view-model fields and i18n keys the two design specs introduce: one name per concept, shared by both brands |
| [`icons/`](icons/README.md) | The call-center stroke icon set (34 SVGs) with what each icon is for |
| [`fonts/`](fonts/) | Vazirmatn (WebYar), Figtree and DM Mono (Respok) font files, a ready `fonts.css`, and the licences ([`LICENSES.md`](fonts/LICENSES.md), SIL OFL 1.1). The same files as the chat widget package |
| [`brand/webyar/`](brand/webyar/) | WebYar mark and the mark with diamond dots (footer). The launcher glyph files belong to the chat widget; the call launcher uses `icons/phone.svg` |
| [`brand/respok/`](brand/respok/) | Respok symbols and lockups for both logo directions (Open, Thread), the brand-kit sprite and the kit's token files |

Where each brand asset is used: [`../webyar/README.md`](../webyar/README.md), [`../respok/README.md`](../respok/README.md).
