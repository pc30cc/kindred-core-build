---
name: widget-template
description: Add, change or review a visual template (design/skin/theme) of the website chat widget (public/widget) or the call center widget (public/call-widget), for example when the owner hands over a new widget design from Claude Design. Follows docs/operations/WIDGET_TEMPLATE_RULES.md so a new template keeps the widget's load speed, caching and fonts rules.
---

# Adding or changing a widget template

A widget template is what a visitor sees: the renderer, the stylesheet and
the fonts of the chat widget or the call center widget. The rules that keep
it fast are in `docs/operations/WIDGET_TEMPLATE_RULES.md`. Read that file
fully before writing anything; this skill is the procedure.

## 1. Understand the design you were given

- A design from Claude Design usually comes as HTML/CSS mockups of the
  widget's states. Map each state to the existing markup first: the class
  names and `data-*` hooks come from `public/widget/presentation-default.js`
  (chat) and `public/call-widget/presentation-default.js` (call). The
  `data-*` attributes are behaviour hooks the core binds: keep every one.
- Decide the smallest form that delivers the design:
  1. a SKIN (one stylesheet over an existing renderer: tokens and selectors,
     ~1 KB) when the markup can stay;
  2. a new stylesheet with the existing renderer;
  3. a new renderer only when the structure really changes. It costs every
     future runtime feature twice, so say why in the commit.
- Fonts: use the shared faces (IRANSans for Persian, InterWY for Latin)
  unless the design truly needs another family. A new family means a new
  fonts stylesheet with unicode-range faces, woff2 files within budget, and
  a licence that allows web use (subset only OFL-type fonts).

## 2. Write the files

Chat widget, in `public/widget/`:
- `presentation-<id>.css` (stylesheet or skin), and `presentation-<id>.js`
  only for a new renderer (registers `window.__gs_presentation_<id>`, pure
  functions, `prepare(context)` per the rules).
- Fonts: reuse `presentation-default-fonts.css`, or add
  `presentation-<id>-fonts.css` plus files in `public/widget/fonts/`.

Call widget, in `public/call-widget/`:
- `presentation-<id>.css`, and either a `registry.register('<id>', …)` in the
  presentation script it reuses or its own `presentation-<id>.js`.
- No `@font-face` in it: faces come from the document-level fonts stylesheet.

Never: font bytes in CSS, `@font-face` in a template/skin/call stylesheet,
`@import`, any external host, network or storage calls in a renderer, `?v=`
on a hashed URL, a fixed file name in code, or `${` in nginx.conf.template.

## 3. Register it

1. `shared/widgetTemplates.ts`: the descriptor in `CHAT_WIDGET_TEMPLATES` /
   `CALL_WIDGET_TEMPLATES`, and the id in the edition's `offered` list
   (`EDITION_*_TEMPLATES`). Do not touch the Iranian edition's `default`
   unless the owner asked to change WebYar's look.
2. The same id and files in `public/widget/presentation-registry.js` (chat).
3. Call widget: add the id to the zod enum in
   `server/services/callCenter/presentation.ts` (`callWidgetTemplateIdSchema`).
4. The per-workspace choice of the CHAT template exists (migration 275:
   `widget_settings.widget_template_id` / `widget_template_options`, the
   Super Admin's catalog `widget_edition_settings.chat_templates`;
   `shared/chatTemplateCatalog.ts`). A new id in `offered` is disabled until
   the Super Admin enables it in Widget settings → Widget templates, so no
   migration is needed. If the template reads options, list them in
   `CHAT_TEMPLATE_OPTIONS` (they reach the renderer as
   `config.templateOptions`); give it a default name and description in
   `src/i18n/widgetCatalog.ts` (brand-neutral) and a shape in
   `src/components/app/widget/TemplateSketch.tsx`. See
   `docs/operations/EDITIONS.md`, "The chat widget template catalog". The
   call widget has its own column and picker.

## 4. Verify (all of it, before committing)

1. `npx vitest run src/test/widget/templateRules.test.ts` (the rules and the
   size budgets; never raise a budget to make it pass without the owner's
   decision), then `npx vitest run src/test/widget src/test/edition src/test/perf src/test/callWidgetPresentationContract.test.ts src/test/callWidgetRuntimePresentation.test.ts`.
2. `npm run typecheck`, `npx tsc -p tsconfig.server.json --noEmit`,
   `npx eslint <changed files>`.
3. Build both brands in a scratch copy (never inside the repo):
   `VITE_BRAND=iran node scripts/widget-hash.js && VITE_BRAND=iran node scripts/call-widget-hash.js`,
   the same with `VITE_BRAND=respok`, then
   `VITE_BRAND=respok node scripts/build/brandAudit.mjs dist`.
4. In a real browser (Chromium: `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`
   in cloud sessions), open the panel in fa and in en: it opens in its own
   typeface, only the expected woff2 files are requested, and the bytes match
   the budgets. Check RTL and LTR, every widget state (home, chat, forms,
   offline, help center; for the call widget: queue, in call, ended, callback).
5. If `nginx.conf.template` changed: render it with
   `envsubst '${BACKEND_URL}'` and run `nginx -t`; curl a hashed file (one
   immutable Cache-Control), a missing hashed name (no-store 404) and
   `loader.js` (no-cache).
6. The widget Playwright specs locally (`e2e/widget*.spec.ts`).

## 5. Report

Say which template form you chose and why, the measured sizes against the
budgets, the fonts each locale downloads, what you verified in a browser,
and anything the owner must decide (a migration, a raised budget, a new font
licence).
