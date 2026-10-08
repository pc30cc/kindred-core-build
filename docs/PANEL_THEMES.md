# Workspace panel themes ("قالب")

The Super Admin can switch the look of every workspace panel (`/:slug/...`),
for every user, with one click: **Super Admin → Panel theme**
(`/admin/panel-theme`). No theme is ever removed; switching back is one click
too.

| Theme | Id | What it is |
| --- | --- | --- |
| Classic | `classic` | The panel's own design (`src/index.css`, `AppSidebar`, `AppTopBar`), unchanged. Default. |
| Art | `art` | A different UI after the Lart design: a top bar with navigation pills instead of the sidebar, a centred page on warm ivory paper, deep ink and a clay accent, its own shapes and sizes for buttons, fields, tabs, tables, menus, dialogs and charts. Light and dark. |

## How it works

- **Stored once.** `platform_branding.workspace_panel_theme`
  (`database/migrations/253_workspace_panel_theme.sql`), written only by
  `PUT /api/admin/management/panel-theme` (platform admins, audited as
  `admin.panel_theme.changed`). Every member reads it from the public config
  (`GET /api/platform/public/config`, `branding.workspace_panel_theme`).
  The server accepts only the ids in `shared/panelThemes.ts`.
- **Applied to the panel only.** `AppLayout` puts
  `<html data-panel-theme="<id>">` while the panel is mounted and removes it on
  leaving, so the Super Admin panel, sign-in and help center keep their look.
  Dialogs, menus and toasts render under `<html>`, so they follow the theme.
  The last value is kept in localStorage (`wy-panel-theme`) so the first paint
  already wears it (`src/themes/usePanelTheme.ts`).
- **Preview.** "Preview in my panel" wears a theme in that browser tab only
  (sessionStorage), for platform admins only, with a bar to end it; nothing is
  saved, and activating a theme ends the preview.
- **Personal settings.** Light/dark mode and text size stay per user. A theme
  other than Classic brings its own colours, so Settings → Interface hides the
  accent, chroma and skin choices while it is active (they apply to Classic).

## What a theme can change

1. **The frame.** `AppLayout` renders a theme's own frame when it has one:
   Art's is `src/themes/art/shell/` (`ArtShell`: header with the workspace
   switcher, navigation pills and "More", search, language, light/dark,
   alerts, settings and account; a slim plan strip; the inbox's view pills and
   the page toolbar slot `#topbar-page-slot`; a phone drawer). Its menu comes
   from `useArtNav`, which follows `AppSidebar`'s rules exactly (plan sections,
   roles, Super Admin, inbox queues, channel inboxes), so switching theme never
   changes what a member can reach. Classic keeps `AppSidebar` + `AppTopBar`.
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
   tooltips) and `pages.css` (charts, heroes, figures, side lists, empty
   states).

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
