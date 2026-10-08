# Workspace panel themes ("قالب")

The Super Admin can switch the look of every workspace panel (`/:slug/...`),
for every user, with one click: **Super Admin → Panel theme**
(`/admin/panel-theme`). No theme is ever removed; switching back is one click
too.

| Theme | Id | What it is |
| --- | --- | --- |
| Classic | `classic` | The panel's own design (`src/index.css`, `AppSidebar`, `AppTopBar`), unchanged. Default. |
| Art | `art` | A different UI after the Lart design: a calm page on warm paper with deep ink, framed by a top menu (navigation pills) or an inset side menu, in one of seven colour schemes; its own shapes and sizes for buttons, fields, tabs, tables, menus, dialogs and charts. Light and dark. |

Art has **options**, chosen on its card by the Super Admin for everyone too:
its **layout** (top menu or side menu) and its **colour scheme** (clay, sage,
indigo, plum, ocean, saffron, graphite). See [Art's options](#arts-options).

## How it works

- **Stored once.** `platform_branding.workspace_panel_theme`
  (`database/migrations/253_workspace_panel_theme.sql`) and the theme's
  options, `platform_branding.workspace_panel_theme_options`
  (`254_workspace_panel_theme_options.sql`, jsonb, per theme:
  `{"art": {"layout": "sidebar", "palette": "sage"}}`). Both are written only
  by `PUT /api/admin/management/panel-theme` (platform admins, audited as
  `admin.panel_theme.changed`), body `{ theme, options? }`:
  - the server accepts only the ids, options and values in
    `shared/panelThemes.ts` (`PANEL_THEME_IDS`, `PANEL_THEME_OPTIONS`,
    `isValidPanelThemeOptions`);
  - `options` may be partial: it is merged into the theme's own entry, and
    every other theme's entry is kept;
  - without `options` the options column is not touched, so a database
    without migration 254 still switches themes; options sent to such a
    database are refused with `409 migration_required`;
  - saving the active theme's options without changing the theme is allowed.

  Every member reads both from the public config
  (`GET /api/platform/public/config`, `branding.workspace_panel_theme` and
  `branding.workspace_panel_theme_options`). Whatever is stored is read
  through `resolvePanelThemeOptions`: a missing or unknown value is its
  option's default (the first value listed), so `{}` — and a database from
  before 254 — is every theme exactly as before.
- **Applied to the panel only.** `AppLayout` puts
  `<html data-panel-theme="<id>">` while the panel is mounted, and one
  `data-panel-<option>` per option of that theme (Art:
  `data-panel-layout="topnav|sidebar"`, `data-panel-palette="<scheme>"`), and
  removes them on leaving, so the Super Admin panel, sign-in and help center
  keep their look. Dialogs, menus and toasts render under `<html>`, so they
  follow the theme. The last values are kept in localStorage
  (`wy-panel-theme`, `wy-panel-theme-options`) so the first paint, and the
  loading skeleton, already wear them (`src/themes/usePanelTheme.ts`).
- **Preview.** "Preview in my panel" wears a theme, with the options picked on
  its card, in that browser tab only (sessionStorage), for platform admins
  only, with a bar naming it ("Art · Side menu · Sage") and a button to end
  it; nothing is saved, and activating or saving ends the preview.
- **Personal settings.** Light/dark mode and text size stay per user. A theme
  other than Classic brings its own colours, so Settings → Interface hides the
  accent, chroma and skin choices while it is active (they apply to Classic).
  In Art's side menu each member folds the menu into a rail for themselves
  (kept per browser, `wy-art-sidebar-collapsed`).

## What a theme can change

1. **The frame.** `AppLayout` renders a theme's own frame when it has one:
   Art's is `src/themes/art/shell/` (`ArtShell`, in the layout the Super Admin
   chose: the top menu — `ArtHeader` with the workspace switcher, navigation
   pills and "More", search, language, light/dark, alerts, settings and
   account; a slim plan strip; the inbox's view pills and the page toolbar
   slot `#topbar-page-slot` — or the side menu, `ArtSidebar`; a phone drawer
   either way). Its menu comes from `useArtNav`, which follows `AppSidebar`'s
   rules exactly (plan sections, roles, Super Admin, inbox queues, channel
   inboxes), so switching theme or layout never changes what a member can
   reach. Classic keeps `AppSidebar` + `AppTopBar`.
2. **Tokens.** The panel's colour variables (`--background`, `--primary`,
   `--sidebar-*`, shadows, gradients, ...) redefined under
   `:root[data-panel-theme="<id>"]` (and `.dark`). The `:root[...]` selector
   outranks the per-user `html[data-ui-*]` attributes.
3. **Palette.** Tailwind's hues (`bg-sky-500`, `from-indigo-500`, ...) go
   through CSS variables (`--palette-<family>-<shade>`, `src/themes/palette.ts`,
   wired in `tailwind.config.ts`). By default they hold Tailwind's exact values,
   so Classic renders as before; a theme may give a palette transform that
   repaints them (Art: `src/themes/art/palette.ts`). Chart series colours in
   pages use the same variables (`rgb(var(--palette-violet-500))`).
4. **Components and pages.** Stable hooks a stylesheet can target:
   - shadcn primitives: `data-slot` (`button` + `data-variant`/`data-size`,
     `card`, `input`, `select-trigger`, `tabs-list`, `table`, `table-row`,
     `dialog-content`, `menu-content`, `menu-item`, `tooltip-content`, `chart`,
     ... — see `src/components/ui`);
   - the frames: `data-shell` (`app`, `frame`, `main`, and in Art `header`,
     `primary-nav`, `workspace-switcher`, `context-bar`, `plan-strip`,
     `account`, `header-alerts`, `drawer`, ...) and the classic sidebar's
     `data-nav-item` / `data-nav-chip` / `data-active`;
   - page patterns: `data-page-hero` / `data-hero-icon` and the figure hooks
     used by the dashboard, SEO and analytics pages.

   Art's stylesheets: `src/themes/art/theme.css` (tokens, frame and bars),
   `components.css` (the primitives' shapes and sizes: pill buttons, filled
   fields, underline tabs, card-row tables, roomy menus and dialogs, inverted
   tooltips), `pages.css` (heroes, figures, side lists, empty states),
   `inbox.css` (the inboxes), `sidebar.css` (the side-menu frame),
   `palettes.css` (the colour schemes) and `charts.css` (every chart).

## Art's options

Chosen on Art's card on Super Admin → Panel theme: two sketches for the
layout, seven named swatches (each ringed by its chart colours) for the
colour scheme, a live preview of both in light or dark, "Preview in my
panel", and "Use for everyone" (or "Save for everyone" while Art is
active). Options are sent only when they differ from what is stored.

### Layout (`data-panel-layout`)

| Id | Name (fa / en / tr) | Frame |
| --- | --- | --- |
| `topnav` (default) | منوی بالا / Top menu / Üst menü | A top bar with the navigation as pills and "More", the plan as a slim strip, the inbox's views in a bar under it, pages centred in a 1280px column. |
| `sidebar` | منوی کناری / Side menu / Yan menü | An inset menu panel on the reading-start side (right in Persian, left in English and Turkish): the workspace and search on top, the destinations grouped by meaning, the inbox opening onto every one of its views, Team / Settings / Super Admin pinned under the list, the plan, account, language, light/dark and alerts at its foot. It folds into a rail of icons with tooltips. App pages (inbox, settings, ...) sit in a card of their own beside it. |

- The side menu is for desktops (`src/themes/art/shell/sideMenu.ts`): under
  1024px the frame is the top menu whatever the option says (phones also get
  the bottom tab bar and the drawer).
- Folded or not: the member's own choice once made (per browser); until then
  open from 1280px and a rail below. On Settings, which has a side list of its
  own, it is a rail (the member can unfold it for that visit).
- `ArtShellSkeleton` draws the same frame while the panel loads (`AppLayout`
  passes the layout), so nothing jumps.
- A change of layout never remounts the page: `ArtShell` renders one tree for
  both (under the top menu its two wrappers are `display: contents`), so
  `<main>` keeps its place. A Super Admin's switch reaches open panels on the
  next public-config read, and a window crossing 1024px switches the frame
  too; either way the open conversation and a half-typed reply stay.
- `sidebar.css` takes every colour from the panel's tokens (`--secondary`
  for the panel, `--border`, `--input`, `--art-shadow`, `--primary`), so the
  menu follows every colour scheme; a scheme may also set `--art-side`,
  `--art-side-edge` and `--art-side-card-edge` itself.

### Colour scheme (`data-panel-palette`)

| Id | fa | en | tr |
| --- | --- | --- | --- |
| `clay` (default) | خاک رس | Clay | Kil |
| `sage` | مریم‌گلی | Sage | Adaçayı |
| `indigo` | نیلی | Indigo | Çivit |
| `plum` | آلویی | Plum | Erik |
| `ocean` | اقیانوسی | Ocean | Okyanus |
| `saffron` | زعفرانی | Saffron | Safran |
| `graphite` | زغالی | Graphite | Grafit |

`src/themes/art/palettes.css` gives each scheme a light block
(`:root[data-panel-theme="art"][data-panel-palette="<id>"]:not(.dark)`) and a
dark one (`...[data-panel-palette="<id>"].dark`) with the panel tokens it
changes and its six chart series, `--art-chart-1` ... `--art-chart-6` (HSL
triplets, 1 = the scheme's main colour). Clay is theme.css's own tokens plus
its series, and the fallback for a missing or unknown attribute.
`src/themes/art/palettes.ts` mirrors each scheme as CSS colours
(`ART_PALETTE_SWATCHES`) for the Super Admin page's swatches and previews.

### Charts

`src/themes/art/charts.css` gives the panel's charts Art's look, and their
series colours are read from the active scheme as `hsl(var(--art-chart-N))`
(never a fixed colour), so every chart repaints with the colour scheme, in
light and dark.

### Adding a colour scheme

1. Add its id to `ART_PALETTES` in `shared/panelThemes.ts` (no migration:
   the server accepts it at once, and a stored value it does not know reads
   as clay).
2. Write its light and dark blocks in `palettes.css` as the others are (the
   tokens it changes, `--art-chart-1` ... `--art-chart-6`, optionally
   `--art-side*`); `src/test/themes/artPalettes.test.ts` checks the
   contrasts.
3. Add its swatches to `ART_PALETTE_SWATCHES` (`palettes.ts`).
4. Name it under `admin.panelThemes.palettes.<id>` in the three locales. It
   then appears on the Super Admin page by itself.

A new option for a theme works the same way: list it with its values in
`PANEL_THEME_OPTIONS` (first value = default); `AppLayout` puts it on
`<html>` as `data-panel-<option>` by itself; add its texts and its picker.

### On production

Migration 254 is applied by hand on the WebYar database before the code that
needs it is merged (CLAUDE.md, "Migrations"). Until then everything reads as
before (top menu, clay), switching themes works, and the Super Admin page
says that saving the layout and colour scheme needs the migration (preview
already works; "Use for everyone" then switches the theme alone).

The frontend (app 24) and the backend (app 25) deploy separately. While the
new page talks to an older backend, that backend ignores `options` and
answers with the theme alone: the page checks that the answer carries what
it sent and otherwise reports the save as failed ("may still be updating"),
never as done.

After applying 254 by hand, add it to the migration ledger line in
CLAUDE.md ("Database" → "Migrations").

## Adding a theme

1. Add its id to `PANEL_THEME_IDS` in `shared/panelThemes.ts` (a short
   lower-case slug; no migration needed).
2. Write `src/themes/<id>/*.css` and import them in `src/main.tsx`.
   - Every selector starts with `:root[data-panel-theme="<id>"]`
     (`src/test/themes/panelThemes.test.ts` checks Art's files; extend it).
   - Define the full token set for light and dark (copy Art's blocks).
   - To change a primitive's size, radius or shadow, key the rule to its
     default class (`[data-slot="card"].rounded-lg`), so a page that chose its
     own still wins.
3. Optionally a frame of its own (as Art's `shell/`, rendered from
   `AppLayout`) and a palette transform registered in `THEME_PALETTES`
   (`src/themes/palette.ts`).
4. Add its card to `src/themes/registry.ts` (colours, `layout`) and its texts
   (`admin.panelThemes.themes.<id>.name / description / trait1-3`) to the
   three locales. It then appears on the Super Admin page by itself.

Classic must stay untouched: shared components only ever gain `data-*` hooks
or a theme-only branch. The native mobile app (`src/mobile`) has its own shell
and does not use these themes.
