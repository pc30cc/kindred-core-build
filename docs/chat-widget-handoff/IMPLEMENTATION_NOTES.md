# Implementation notes (read before the handoff's own brief)

The handoff in this folder was written for a plan the owner changed. Where it disagrees with these notes, these notes
win. WebYar (Iranian edition) was implemented first, on 2026-10-17; RESPOK (International edition) followed in issue
#340 round 5 (2026-10-18, section "RESPOK" below).

## Owner decisions

1. **The look live today stays the default.** Template `default` (and `intl`) is byte-identical: it was NOT restyled
   in place, contrary to brief §3. Both designs were ADDED as new templates.
2. **Neutral ids, names in the database.** Template 1 "Classic" is `t1`, Template 2 "Simple home" is `t2` (files
   `public/widget/presentation-t1.*` / `presentation-t2.*`, globals `__gs_presentation_t1` / `_t2`). The names people
   see live in the Super Admin's catalog, per dashboard language, renamable at any time; they never appear in an id, a
   file name, a class or the widget config. Default names: «آشنا» / «فیروزه» / «نسیم» (Familiar / Turquoise / Breeze)
   for `default` / `t1` / `t2`. The handoff's `simple` / `simple-intl` ids were not used. RESPOK's are `t1-intl` /
   `t2-intl` (skins over `t1` / `t2`), default names Classic / Simple, «کلاسیک» / «ساده», Klasik / Sade.
3. **Persian text is IRANSans only.** Vazirmatn is not shipped, loaded or referenced anywhere in the widget (the
   handoff's font files were left out of the repository). Both new templates use the shared
   `presentation-default-fonts.css` (IRANSans for Persian, InterWY for Latin): no new font bytes, and no clash with the
   call widget's single `gs-presentation-fonts` link. Weight 600 renders with the IRANSans 700 file, 800 with 700.
   Screenshots therefore differ from the PNGs in glyph shapes and text widths only.
4. **The Super Admin enables templates; a workspace owner chooses among the enabled ones.** New templates are disabled
   after a deploy until the Super Admin enables them, so a deploy changes nothing for any visitor.

## Where things are

| Concern | Code |
| --- | --- |
| Template descriptors, editions | `shared/widgetTemplates.ts` (`EDITION_CHAT_WIDGET_TEMPLATES.iran.offered = ['default','t1','t2']`), `public/widget/presentation-registry.js` |
| Catalog rules (enabled, default, names, options) | `shared/chatTemplateCatalog.ts` (pure, server + dashboard) |
| Storage | migration `database/migrations/275_widget_template_catalog.sql`: `widget_edition_settings.chat_templates` (one row per edition), `widget_settings.widget_template_id` / `widget_template_options`, KB rating `neutral` |
| Server | `server/services/widget/templateCatalog.ts`, `server/routes/adminWidgetCatalog.ts` (`GET/PUT /api/admin/widget-catalog`), `server/routes/widgetSettings.ts` (`GET /:ws/templates`, PATCH fields), `configSnapshot.ts` (`templateId`, `templateOptions` in the cached config) |
| Dashboard | Super Admin → widget settings → «قالب‌های ویجت»; Widget → Appearance → «قالب ویجت» (`TemplateChoiceCard.tsx`); the live preview renders the effective template. For every template, `default` included, the preview now also has a Messages view (پیام‌ها) and follows the renderer's own `[data-view]`, `[data-view-back]` and `[data-conversation-open]` links as the live widget does (on `origin/main` those clicks did nothing in the preview); the look of `default` there is pixel-identical |
| Server data a feature needs | sent only on request, so the API serves `default` as before: `operator=1` on `/api/widget/conversations` and `/api/widget/history` (the assigned operator; runtime.js `operatorQ()`, only for `conversationOperator` / `chatHeader` / `operatorTyping`), `match=words` on `/api/widget/kb/search` (the word search, with each result's `snippet` and `matches`; runtime-ext.js `kbSearch`), `meta=1` on `/api/widget/kb/article` (the author's name, `author_name`; runtime-ext.js `kbMeta`). Every help center (its search page and its SPA, which also calls `/api/widget/kb/search`) keeps its one-phrase search and its article answer. The endpoints only the lazy modules call (`/api/widget/kb-suggest`, `/queue`, `/conversations/:id/csat`, `/transcript`, `/reactions`, `/identity/offline-email`) and the config keys only Core-features templates get (`config.commerce`, `config.modules.ext` / `emoji` / `late` / `extras`) leave `default` / `intl` as they were. One thing is written for every template: an AI reply about one order carries `metadata.kind: 'order_status'` + `metadata.order` (`server/services/ai-agent/commerce-tools/orderCard.ts`), which only t2's extras draw. Names: `shared/new-hooks-and-settings.md` §6 |
| Core features | renderer-declared `features` + Core's `env.capabilities`: the feature code is Core's lazy module `public/widget/runtime-ext.js` (search `feat(`), named in the bootstrap (`config.modules.ext`) only for a template whose descriptor has `coreFeatures: true` (`shared/widgetTemplates.ts`); `env.capabilities` and the `ext()` hooks are in `public/widget/runtime.js`. What a first paint does not need is the **late pack**: the renderer's extras `presentation-<renderer>-x.js` (descriptor `extras`) and Core's `public/widget/runtime-late.js`, named in the bootstrap as `config.modules.extras` and `config.modules.late` only for a template with `coreFeatures` and `extras`, requested by runtime-ext.js after the first paint and applied together or not at all (`docs/operations/WIDGET_TEMPLATE_RULES.md` §2). `default` declares none and never downloads either, so its runtime path is unchanged |
| Round 3-4 features (server) | reactions `server/services/messageReactions.ts`; the queue's place `server/services/chatRouting.ts` (search `queueReturnToAnnounce`) and 276's triggers; the away thread `server/routes/widget.ts` (search `client_message_id`); the order card `server/services/ai-agent/commerce-tools/orderCard.ts` (written by `server/services/ai-agent/responder.ts`, search `order_status`); the track-order flag `server/services/widget/configSnapshot.ts` (search `getStoreOrders`); instant answers `server/services/knowledge-base/widgetSuggest.ts` (route `server/routes/widgetKbSuggest.ts`, limits `server/services/widget/security.ts`, search `kb_suggest`); the KB author `server/routes/kb.ts` (search `articleAuthorName`) and `server/routes/knowledgeBase.ts` (search `resolveArticleAuthor`), the editor's select `src/pages/app/knowledge/ArticleEditorPage.tsx` (search `data-kb-author`) |
| After-chat features (server) | the closed line `server/services/conversationClosedNotice.ts` (written only for a template whose descriptor has `closedNotice`, search `closedNotice`), the rating `server/services/conversationRatings.ts`, the transcript by email `server/services/visitorTranscript.ts`, their widget routes in `server/routes/widget.ts` (search `/conversations/:id/csat`), migration `database/migrations/276_widget_chat_features.sql`; the inbox line in `shared/systemMessageText.ts` (re-exported as `src/lib/systemMessageText.ts`; search `conversation_closed`), the timeline in `src/components/inbox/timelineMeta.tsx` (search `transcript_emailed`), satisfaction in Operator Activity (`server/routes/operatorActivity.ts`, search `ratingsByOperator`). Names: `shared/new-hooks-and-settings.md` §6 |
| System messages in the reader's language (every template) | the kinds and the visitor's metadata `shared/systemMessages.ts` (search `visitorSystemPreview`), the list's fields `server/routes/widget.ts` (search `systemKind`), Core's sentence `public/widget/runtime.js` (search `systemRowText`); the operator's sentence `shared/systemMessageText.ts`, written by the server for the operator APIs, the apps and the e-mails in `server/services/operatorSystemText.ts` (search `withOperatorSystemBody`) in the operator's language (`server/services/operatorLocale.ts`, search `operatorLocaleFrom`). Names: `shared/new-hooks-and-settings.md` §6 |
| The team and the agent face's letter | `shared/widgetTeam.ts` (search `agentFaceInitial`): the first four members to join among those who receive chats (`isWidgetTeamMember`: owner or team role, not suspended, receiving chats, seat not paused; staff never), online first, a member without a name of their own named in the widget's language; read by `/config` (`server/services/widget/configSnapshot.ts`, search `agentFaceInitial`) and every dashboard preview (`src/components/app/widget/previewTeam.ts`) |
| Screens for visual QA | `e2e/harness/templateScreens.ts` (`--template t1 --out <dir>`, `--list` for the states, design demo data) |

Template options (merged: code defaults → Super Admin defaults → workspace): t1 `navStyle` (`vb` default, `va`, `vc`,
`vd`), `navMode` (`active` default, `both`, `icon`, `text`, `none`), `topics` (≤ 4), `prechatMode` (`card` default,
`steps`), `transcriptEmail` (default on); t2 `topics`, `askExamples` (≤ 2), `csat` (the rating after a chat, default
on), `transcriptEmail` (default on); `t1-intl` / `t2-intl` their base template's keys plus `logoDirection` (`thread`
default, `open`).

## What the designs draw that is not built (renders nothing)

Left out by the owner for now, so the renderers draw nothing for them, never a dead control: an operator's own "send
order status" action in the inbox (the board draws a person sending the card; cards come from AI replies only), a guest
order lookup in the widget (the track-order row asks the AI, which answers a visitor signed in to the store and
otherwise asks them to sign in), and the plugin release that would send the card's item line and delivery day
(`item_summary`, `item_count`, `estimatedDelivery`: read when present, so the card shows them once a store sends them).
Not built either, so the handoff's fallback shows: the reply card beside the closed launcher (RESPOK T1, RP1 §4.28;
the loader's `setUnread` takes the count only, so the launcher shows its badge).

Built since (issue #340), each only for a template that declares it, in the late pack unless it is on the first
paint:

- round 2: the «… closed the conversation» line and the rating card after a chat (t2, option `csat`), the
  transcript by email (option `transcriptEmail`) and the chat header's ⋯ menu (t1, t2: the transcript and the
  notification sounds; no "end conversation", owner);
- round 3: message reactions (t2: the visitor's ❤️; operators react in the inbox), the step-by-step pre-chat (t1
  option `prechatMode: steps`), the queue's place and wait, the in-thread offline auto-reply with its e-mail card,
  and the typing operator's name;
- round 4: the order card in the thread (t2), the "track an order" home row (t2, first paint, only with
  `config.commerce.trackOrder`), instant answers while a first message is written (t2), help results with a snippet
  around the searched words (t2), the KB article's author (t1, t2), download progress on files and voice notes (t1,
  t2) and the emoji search in the picker (t1);
- round 5: for every template (the launcher is the loader's, not a template's), the launcher's styles of the
  "launcher and colour" board (the pill with the launcher text, the classic bubble, two bubbles, the agent's face,
  the square kit button; `fab.shape` / `fab.icon`, the look in a small `runtime-fab.css` requested only by a
  workspace that wears one: /config names it as `config.fabStyleUrl`, the agent's letter as `config.fab.initial`
  (the team's first operator, online first, by the team stack's name, else the workspace's; the team is the first
  four members to join among those who receive chats, a member without a name of their own named by the widget's word for an operator in its
  language, «اپراتور» / "Operatör" / "Operator"; one rule for /config and the dashboard, `shared/widgetTeam.ts`,
  never an email; the letter is a character that shows, never an RLM or a ZWNJ);
  the loader puts `fx fx-<icon> fx-<shape>` (`fx-off` while the team is away) on the launcher, the pill's text in
  `data-fx` and the letter in `data-fi`; the bubble's dots take the kit's second colour on its own ground; the
  dashboard's picker and live preview draw the same), and RESPOK's `t1-intl` / `t2-intl` (below), with the logo
  direction's loader and server parts (`lg-thread` / `lg-open`, the Open button and lockup);
- after round 5 (2026-10-18): the inbox's unassign posts the visitor's queue row at once (`routeQueueReturn`), help
  searches with a control character or a Turkish «İ» find what they should, Core's late composer focus no longer takes
  the focus from a control the visitor is on (the hook `autofocus`), `default`'s sr-only presence label is written
  (approved), t1's header draws the workspace with its lead's face while no operator holds a conversation that went
  through the pre-chat (feature `prechatHeader`), every system message reads in the reader's language (Where things
  are), and the owner's seven points on the chat screen (below).

## RESPOK (International edition): `t1-intl`, `t2-intl`

Built in issue #340 round 5 from the handoff's RESPOK boards (`respok/`, Thread and Open).

- **Skins, not new renderers.** `t1-intl` wears `presentation-t1.js` + `.css` + `-x.js` unchanged and then
  `presentation-t1-intl.css`; `t2-intl` likewise over t2 with `presentation-t2-intl.css` (descriptors in
  `shared/widgetTemplates.ts`, registry entries with the base renderer's global, so the handshake id is `t1` / `t2`).
  Everything RESPOK is in the skins: tokens (Ink `#16142B` text and accent, Signal `#FF5A3C` for live, rings and the
  caret, Signal Deep `#D3361A` for unread, fixed neutrals), flat Ink fills, Figtree, tighter LTR line heights, and the
  brand art as CSS masks of `data:` SVGs. WebYar's `t1` / `t2` stay pixel-identical (528 harness shots of every
  state in fa, en and tr with the brand colour, the brand's teal chosen, no colour, an unreadable one, `#2F5BFF` and
  `#FFC83D`, against the round's start), and so do `default` and `intl`.
- **The brand colour is the stylesheet's.** An uncustomised accent (empty, `#3B82F6`, unparseable) writes no inline
  colour: the renderers put `gs-accent-brand` on the view roots and the panel's close button, and the stylesheet gives
  the brand colour and its hand-tuned hero (t1 / t2: teal `#0B7D6C`; the skins: Ink). A chosen colour is inline, `--a`
  first, as before; the brand's own colour chosen explicitly still gets its hero (`[style*='--a:#16142b;' i]`).
- **Logo direction** (option `logoDirection`, `thread` default, `open`): the loader puts `lg-thread` / `lg-open` on the
  shell and draws that direction's chat button, the server names that direction's footer lockup, and the skins draw
  the matching art: the home header's watermark (only while the platform is credited), t1's greeting avatar and its
  Messages tab icon, and the launcher greeting's corners and place (Thread above the button, Open beside it).
- **Type.** Figtree (SIL OFL, `public/widget/fonts/OFL-Figtree.txt`) for Latin and Turkish text, variable, in two
  files in the shared `presentation-default-fonts.css` (`figtree-latin.woff2` 18,540 B, `figtree-tr.woff2` 2,312 B,
  each fetched only when its letters are on screen; cut by `scripts/fonts/subset-widget-fonts.py --figtree`).
  Persian stays IRANSans with t1's / t2's line heights. The boards' DM Mono is not shipped: code is the system
  monospace. `prepare()` warms Figtree instead of Inter for an `-intl` id (in Turkish both files: that first paint
  draws ğ, ş, İ).
- **Screens.** `e2e/harness/templateScreens.ts --edition international` (with `--options '{"logoDirection":"open"}'`)
  draws the skins with the kit's classes, Gregorian dates and, in English or Turkish, the handoff's English demo
  store. The dashboard's live preview draws the same (`WidgetLivePreview.tsx`).
- **Accepted differences from the boards:** the renderers' own English copy (t1's greeting and question, menu
  labels), times as `07:42 PM`, the board's phone frame, t1's emoji picker height, no inline code chip in articles,
  the operators' avatar stack order, t2's composer under a closed thread, and the system monospace for code.
- **Not seeded.** No catalog row is written: both are disabled until RESPOK's Super Admin enables them.

## Owner decisions after the RESPOK screenshots (2026-10-18)

The owner's iPhone screenshots of `t2-intl` on respok.app (accent `#EF4444`), to hold in both brands, and in `t1` /
`t1-intl` wherever the same defect was. Where a board disagrees, these win. `default` and `intl` are unchanged, and no
Core file changed. Tests: `src/test/widget/presentation-t2.test.ts`, `src/test/widget/presentation-t1.test.ts`,
`src/test/widget/prechatSteps.test.ts`, `e2e/widgetChatThread.spec.ts` (t2 and t1, `--workers=1`; harness states
`chat-operator`, `chat-handover`, `chat-ai-thinking`, `help-open-empty`, their `mobile-` variants and
`mobile-chat-long-names`).

- **The colour rule** (t1, t2). The renderer (`accentTokens()`) puts Ink on the workspace colour only when it is
  light (relative luminance above 0.30, Ink then about 6:1). On any other colour the ink is white and `--a` is that
  colour darkened (each channel ×0.97 until L ≤ 0.16) until white on it, and it as text or a ring on white, both reach
  5:1: `#EF4444` (respok.app) → `#CB3939`, `#8B5CF6` (webyar.ai) → `#7D53DF` (t1 writes `--a` and `--a-rgb` in lower
  case, `#7d53df`). A colour already that dark, a light one and the brand look (no colour, or the seeded `#3B82F6`)
  are written as before, so the brand-colour selectors (`[style*='--a:#0b7d6c;' i]`, `…#16142b;`) still match.
  Before, WCAG 2 picked Ink on `#EF4444` (4.77:1, APCA Lc 39) and on `#8B5CF6` (4.24:1): the visitor's text "could
  not be seen".
- **Every text on the accent sits on `--a` at full ink.** A sheen (`--a-hi`) ends at 30 % of the height: the
  visitor's bubble (the skins' is flat), t2's file and voice cards, text buttons (pre-chat submit, article feedback,
  rating submit), "New conversation" and the jump pill, t1's `.btn-p`; a bubble holding a quote is flat (the quote is
  its first line). The visitor's own secondary lines are at full ink: the quote (t1's on a deeper panel), a link chip
  (t2: no white tint), a sent file's size (t1 had grey on the accent, 1.04:1) and a voice note's time. Core's
  proactive in-chat button (`.smart-msg .smart-cta`) is `--a` with `--on-a` in t2 as in t1 (was 2.11:1). Measured in
  Chromium: the quote 5.02 / 5.03 / 5.98 / 6.02:1 in t2-intl / t2 / t1 / t1-intl (was 3.20 to 3.55); the t2 text
  buttons at least 4.5:1 (were 4.23 to 4.28); light accents keep Ink at 5.1:1 or more.
- **The launcher keeps the raw colour.** The loader draws the chat button from `config.primaryColor`, unchanged; inside
  the panel a mid-tone colour is the darkened tone, a shade deeper than the button. White on `#EF4444` itself is
  3.76:1, below AA, which is why the panel does not use it as is.
- **The help bar is flat** (t2). `.cta` is `var(--a)` with `--on-a` (both lines at full ink), not the hero's
  gradient, whose light end cannot carry white and whose dark end cannot carry Ink. The skin's
  `.cta { background: var(--ink) }` is gone: under the base's Ink ink on `#EF4444` it was Ink on Ink, 1:1. With no
  colour the bar is still Ink with white text (the board). The call card's answer button uses `--on-a` too. t1 has no
  such bar; its help center's "start a chat" button follows the colour rule.
- **The chat bar names the workspace.** While an operator answers, the title is the workspace's name
  (`workspaceName`) and the operator's name is the small line under it. t2 keeps that line's states (the online dot,
  the typing dots, away in grey), its words in a box of their own (`.st b`), so a long name ends in "…" and the typing
  dots after it stay in view; t1 (`.hn` / `.hs`) shows the name only, in the pre-chat too once an operator is assigned.
  No operator, no workspace name, or the same name twice: the bar as before. So t2's "Offline; we'll reply by email" /
  "Typing" words and t1's reply-time line are not on the bar while an operator holds the thread; away still shows in
  the thread's banner, the avatar's ring and t2's grey line.
- **A name over a run only where the team's side changes hands** (t1, t2): another person than the last
  operator-side run, or a person after the AI. The first run never has one (the bar names who answers); a day break,
  the visitor's messages or a system row between runs do not bring it back. The AI keeps its badge and name under its
  bubble. A direct transfer with no AI before it (Sara, then Mehdi) therefore labels Mehdi's run only.
- **The typing and thinking rows** sit their avatar on their bubble's bottom (they have no time line under them; t2
  both rows, t1 the thinking row, its typing row already did).
- **A message's actions** (reply, copy, the heart) show only on the line hovered (a tap hovers the tapped line on a
  phone; another tap elsewhere moves it) or holding keyboard focus; hidden, they take no taps on a touch screen
  (`pointer-events: none` under `@media (hover: none)` only, so a mouse can still go straight onto them). They keep
  their `aria-label`s; reply, copy and the heart have no `title` tooltip. t1 already behaved so.
- **The emoji grid opens inside the message box** (t2 `chatFrameHtml`: the picker is the first child of
  `[data-input-wrap]`): the box grows upward over the thread, a hairline between the grid and the text; the field stays
  where it was. Core's toggle, outside click, Escape (focus back to the field) and recording are unchanged. A keyboard
  ring on an edge emoji is drawn inside its button, so the scrolling grid does not cut it. t1 already drew the grid
  there.
- **Bytes** (shipped gzip, iran / respok; no budget was raised): `presentation-t2.js` 19,990 / 19,822 of 20,000
  (19,922 / 19,770 before), `presentation-t2.css` 15,449 (15,362), `presentation-t2-intl.css` 1,958 (1,963),
  `presentation-t2-x.js` 5,869 (5,875); `presentation-t1.js` 19,512 / 19,434 (19,392 / 19,314 before the round-6
  leftovers and these points; its initials skip an RLM, a ZWNJ or a lone mark as the launcher's letter does),
  `presentation-t1.css` 14,423 (14,375). First open of 40,000: t2 36,600, t2-intl 38,390, t1 35,096, t1-intl 37,135.
  t2's renderer has 10 B left: if it needs room, `kbArticleFeedbackHtml` can move to `presentation-t2-x.js` (−207 B).
- **Left open, for the owner:** on an iPhone (Chromium cannot show it), a tap on a bubble should reveal its actions and a
  link in an operator's bubble should open on the first tap; if the link needs two, the fix is a resting
  `opacity: .01` under `@media (hover: none)` in t1 and t2 (t1 on webyar.ai is the quickest place to try). The home
  greeting (t2 `.hi`, t1 `.hx-hi`) is white on the hero's lightest stop, 3.27 to 3.90:1 there (Ink was 3.41 to 4.46):
  outside the seven points; a darker `--h1` partner or no glow under the greeting would lift it.

## Rollout

- Migration 275 is applied by hand on WebYar's database before the merge (CLAUDE.md); RESPOK's migrator applies it on
  push. The file sets `lock_timeout` 5 s itself (RESPOK's migrator passes no `PGOPTIONS`), and a run stopped by it is
  simply run again. Every read tolerates it being absent (the catalog then reads as "only the edition default").
- After the deploy, the Super Admin enables `t1` / `t2` in «قالب‌های ویجت»; workspace owners then see «قالب ویجت».
  On RESPOK, its Super Admin enables `t1-intl` / `t2-intl` (Widget templates) the same way.
