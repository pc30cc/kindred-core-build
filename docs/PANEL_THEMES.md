# Workspace panel themes ("قالب")

The Super Admin can switch the look of every workspace panel (`/:slug/...`),
for every user, with one click: **Super Admin → Panel theme**
(`/admin/panel-theme`). No theme is ever removed; switching back is one click
too.

| Theme | Id | What it is |
| --- | --- | --- |
| Classic | `classic` | The panel's own design (`src/index.css`), unchanged. Default. |
| Art | `art` | After the Lart design: warm ivory paper, deep ink, a clay accent; the page floats on a soft panel inside the sidebar's colour. Light and dark. |

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
  (sessionStorage), with a bar to end the preview; nothing is saved.
- **Personal settings.** Light/dark mode and text size stay per user. A theme
  other than Classic brings its own colours, so Settings → Interface hides the
  accent, chroma and skin choices while it is active (they apply to Classic).

A theme reaches all ~90 panel pages without editing them, in three layers:

1. **Tokens.** The panel's colour variables (`--background`, `--primary`,
   `--sidebar-*`, shadows, gradients, ...) redefined under
   `:root[data-panel-theme="<id>"]` (and `.dark`). The `:root[...]` selector
   outranks the per-user `html[data-ui-*]` attributes.
2. **Palette.** Tailwind's hues (`bg-sky-500`, `from-indigo-500`, ...) go
   through CSS variables (`--palette-<family>-<shade>`, `src/themes/palette.ts`,
   wired in `tailwind.config.ts`). By default they hold Tailwind's exact values,
   so Classic renders as before; a theme may give a palette transform that
   repaints them (Art: `src/themes/art/palette.ts`, lower chroma, warm grays).
3. **Hooks.** The shell carries `data-shell="app | frame | main | sidebar |
   topbar | search | bottom-nav ..."`, nav items `data-nav-item` /
   `data-nav-chip` / `data-active`, decorations `data-shell-decor`, and the
   shadcn primitives `data-slot` (`card`, `button` + `data-variant`, `input`,
   `select-trigger`, `dialog-content`, `menu-content`, `table-head`, ...).
   A theme stylesheet styles those.

## Adding a theme

1. Add its id to `PANEL_THEME_IDS` in `shared/panelThemes.ts` (a short
   lower-case slug; no migration needed).
2. Write `src/themes/<id>/theme.css` and import it in `src/main.tsx`.
   - Every selector starts with `:root[data-panel-theme="<id>"]`
     (`src/test/themes/panelThemes.test.ts` checks this for Art; extend it).
   - Define the full token set for light and dark (copy Art's blocks).
   - To change a primitive's size, radius or shadow, key the rule to its
     default class (`[data-slot="card"].rounded-lg`), so a page that chose its
     own still wins.
3. Optionally add a palette transform and register it in `THEME_PALETTES`
   (`src/themes/palette.ts`).
4. Add its card colours to `src/themes/registry.ts` and its texts
   (`admin.panelThemes.themes.<id>.name / description / trait1-3`) to the three
   locales. It then appears on the Super Admin page by itself.

The native mobile app (`src/mobile`) has its own shell and does not use these
themes.
