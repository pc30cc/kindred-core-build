# New hooks, settings, view-model fields and i18n keys

This is the canonical registry of every new name the four design specs introduce: `data-*` hooks (and the classes and
custom properties used as hooks), settings, view-model fields and i18n keys. There is **one name per concept**, shared by
both brands, and by both templates wherever the concept exists in both. Template 1 is one renderer for WebYar `default`
and Respok `intl`; Template 2 is one renderer for `simple` and `simple-intl` ([brief §3](../CLAUDE_CODE_BRIEF.md)).
Existing production names ([production map](production-map.md) §1.5, §6, §7) are listed only where a spec relies on them
in a new way: a new value, a new place, or changed copy. Every hook in production map §6 keeps its element and value
contract ([brief §2](../CLAUDE_CODE_BRIEF.md)). If a design README and this file ever disagree on a name, this file wins.

**Abbreviations.** T1 = Template 1, T2 = Template 2. WY1, RP1, WY2, RP2 = the design specs
([WebYar T1](../webyar/template-1-classic/README.md), [Respok T1](../respok/template-1-classic/README.md),
[WebYar T2](../webyar/template-2-simple-home/README.md), [Respok T2](../respok/template-2-simple-home/README.md)).
"Named here" = the specs describe the data but give it no name; this file names it.

**How each name was chosen.**

1. An existing production name when one fits.
2. Otherwise the name most specs already used.
3. On a tie, the name that follows production's conventions: feature prefixes as in production (`home…`, `kb…`, `msg…`,
   `prechat…`, `conv…`), one vocabulary across the files ("away" for the team-unavailable state, "operator" for the person
   answering, as in `setOperatorTyping` and `.msg-row.operator`), and pairs that read as pairs. If still tied, the
   WebYar spec (the base of each renderer; Respok is a skin over it).
4. Format: settings camelCase, hooks `data-…` kebab-case, i18n keys camelCase. Copy used only by Template 2 keeps the
   `simple…` prefix both Template 2 specs use; copy shared by both templates has no template prefix. An i18n
   placeholder has the same name in both languages (`{n}`, `{name}`, `{time}`, `{workspace}`, …).

---

## 1. Settings

| Key | Values | Default | Templates | What it controls | Notes |
|---|---|---|---|---|---|
| `templateId` (existing) | `default`, `intl`; new `simple`, `simple-intl` | `default` | all | Which renderer and skin a workspace wears | New registry entries and `shared/widgetTemplates.ts` ([brief §3](../CLAUDE_CODE_BRIEF.md), RP2 §9). The launcher kit follows `edition` only |
| `navStyle` | `va`, `vb`, `vc`, `vd` | `vb` | T1 | Bottom-bar style: classic bar with diamond marker, floating dock with active capsule, segmented, brand dock | Class on `nav.wy-tabs`. `va`, `vc`, `vd` are optional alternatives and ignore `navMode` ([brief §7a](../CLAUDE_CODE_BRIEF.md)). WY1 §4.10, RP1 §4.12 |
| `navMode` | `both`, `active`, `icon`, `text`, `none` | `active` | T1 | Label mode of the floating dock: icons and labels, icons with the active label, icons only, labels only, no menu | Super-admin setting. Class `nv-both`, `nv-icon`, `nv-text` or `nv-none` on each view root `.wy-view` (`active` has no class). `none` adds the home "All conversations" link and back buttons in Messages and Help. WY1 §4.10, RP1 §4.12 |
| `logoDirection` | `thread`, `open` | `thread` | Respok: T1, T2 and the launcher | Respok logo direction: hero watermark, Messages-tab icon (T1), footer lockup, launcher glyph and its arrival animation, greeting corners | Class `lg-thread` / `lg-open` on `.shell` (the loader's, in RESPOK's build only: `@intl-kit`), so the launcher and the panel agree; the skins draw the brand art from it (CSS masks of `data:` SVGs under `.lg-open`, Thread otherwise), with no class on the elements. The settings board's "Respok Open" and "Respok Thread" chat-button tiles set it. [Brief §5.6](../CLAUDE_CODE_BRIEF.md), RP1 §4.1, RP2 §4.33 |
| `prechatMode` | `card`, `steps` | `card` | T1 | Pre-chat inside the conversation: one form card, or one question at a time | `steps` needs the step flow in Core (validation, skip of optional steps, the workspace's country-code prefix). After submit both modes show the saved-details summary with `data-prechat-edit`. **Built as a template option** (`config.templateOptions.prechatMode`, Super Admin default → workspace, `shared/chatTemplateCatalog.ts`); a conversation keeps the mode its form first rendered in. RP1 §5.11, WY1 §9 |
| `csat` *(named here)* | `true`, `false` | `true` | T2 | The rating card under the «… closed the conversation» line | Template option (`config.templateOptions.csat`, Super Admin default → workspace). Off: the line only, and `POST …/csat` answers 403 `csat_disabled`. §6 |
| `transcriptEmail` *(named here)* | `true`, `false` | `true` | T1, T2 | "Email me the transcript": the rating card's link (T2) and the ⋯ menu item (T1, T2) | Template option. Off: neither is drawn, and `POST …/transcript` answers 403 `transcript_disabled`. §6 |
| `askExamples` | up to 2 strings | none | T2 | Lines 2 and 3 of the rotating ask placeholder, each shown after `simpleAskExamplePrefix` | Line 1 is `simpleAskPlaceholder`. With fewer than two examples, render the static field (`.field.static`, suggestion). WY2 §4.4, RP2 §4.5 |
| `topics` | list of `{label, icon}` | none | T2 home and thread chips; T1 new-conversation chips | Topic chips (`data-topic`) | Without topics: Q&A chips (`data-qna-question`); T2 home falls back to article chips (`data-home-article`) or no chips. RP2 §4.17, WY2 §4.4 |
| `fab.shape` (existing) | `circle`, `square`; new `pill` | `circle` | Launcher (both templates) | Launcher outline. `square` is the "WebYar square" tile (18px radius on WebYar's kit button, as the designs draw it; 16px on any other launcher). `pill` is "Pill with text" | With `pill` the launcher widens to the glyph plus the `fab.label` text inside it, and the separate `.gs-fab-label` card is not drawn. The pill's glyph follows `fab.icon` (the boards draw the kit glyph). A pill (and the glyphs `bubble`, `duo`, `avatar`) is drawn by `runtime-fab.css` (§6, "Launcher styles"). WY1 §4.24, RP1 §4.29 |
| `fab.icon` (existing) | `chat`, `message`, `help`, `headset`, `phone`, `sparkles`, `smile`; new `bubble`, `duo`, `avatar` | `chat` | Launcher | Launcher glyph. `chat` = the brand kit glyph (Respok: per `logoDirection`). `bubble` = classic bubble, `duo` = two bubbles, `headset` = support headset (the templates draw the design's glyph), `avatar` = agent face | `avatar` draws an initial tile with a presence dot; the letter is `fab.initial` (the first character that shows of the team's first operator's stack name, online first, else of the workspace's; the team is the first four members to join among those who receive chats, one without a name of their own named «اپراتور» / "Operatör" / "Operator" by the widget's language, in `teamMembers` too; the same rule in every dashboard preview and the picker, `shared/widgetTeam.ts`). An agent photo stays production's `fab.imageUrl` (unchanged). The idle loops of board 11 / board 10 are settings-preview only. WY1 §4.24, RP1 §4.29 |
| `fab.label` (existing) | string | none | Launcher | Today the label card next to the launcher; with `fab.shape: "pill"`, the text inside the pill | Design defaults for the pill: «سؤالی دارید؟ بپرسید» (WY1 §10) and "Questions? Ask us" (RP1 §10) |
| `primaryColor` (existing) | any hex; palette presets in [brief §5.5](../CLAUDE_CODE_BRIEF.md) | `#3B82F6` (= uncustomised) | all | Accent `--a` | Uncustomised (empty, `#3B82F6` or unparseable) maps to the brand accent (`#0B7D6C` WebYar, `#16142B` Respok): the renderer writes no inline colour and puts `.gs-accent-brand` on its view roots and the panel's close button ([brief §5.2](../CLAUDE_CODE_BRIEF.md)). A chosen colour gets Ink text only when it is light; any other gets white, on the colour darkened until white on it reaches 5:1 (T1, T2 `accentTokens()`: `#EF4444` → `#CB3939`, `#8B5CF6` → `#7D53DF`; owner, 2026-10-18). The launcher keeps the raw colour |

**Launcher options of the settings boards** (WebYar board 11, Respok board 10) mapped onto the settings above:

| Board option | Settings |
|---|---|
| «وب‌یار اصلی» (WebYar original); "Respok Open" and "Respok Thread" (brand kit) | `fab.shape: "circle"`, `fab.icon: "chat"`; the Respok tiles also set `logoDirection: "open"` or `"thread"` |
| «وب‌یار مربعی» (WebYar square) | `fab.shape: "square"`, `fab.icon: "chat"` |
| «حباب کلاسیک» / "Classic bubble" | `fab.icon: "bubble"` |
| «دو حباب» / "Two bubbles" | `fab.icon: "duo"` |
| «هدست پشتیبانی» / "Support headset" | `fab.icon: "headset"` |
| «چهره اپراتور» / "Agent face" | `fab.icon: "avatar"` |
| «کپسول با متن» / "Pill with text" | `fab.shape: "pill"`, text from `fab.label` |

---

## 2. Hooks

### 2.1 New `data-*` attributes

| Attribute | Element | Purpose | What Core must bind | Templates |
|---|---|---|---|---|
| `data-kb-search` | `input.kb-search[type=search]` from `kbSearchBarHtml` (PD:1345-1351, exported but not composed today): T1 home help card and Help view, T2 Help view | Help-center search | Input (debounced) sets the KB query and shows `kbHtml` in `searching` / `results`; on T1 home it opens the Help view with the query | T1, T2 ([brief §9](../CLAUDE_CODE_BRIEF.md), WY1 §4.6, RP1 §4.9, WY2 §4.17, RP2 §4.22) |
| `data-kb-search-clear` | T2 search clear button (`.sfield .x`) | Clear the query | Click empties the query and refocuses the field | T2 (RP2 §4.22) |
| `data-kb-category="<id>"` | Category row (T1 categories card) or tile (T2 `.cat`) | Open one category | Click shows that category's article list (new view state) | T1, T2 (RP1 §9, WY2 §4.17, RP2 §4.23) |
| `data-kb-progress` | T2 article reading-progress line `.prog` | Reading progress | On scroll of the article scroller, write the progress 0–1 (as `--p` or `transform: scaleX(p)`); hide when unavailable | T2 (WY2 §9) |
| `data-kb-suggest` | T2 instant-answers tray `div.tray[data-kb-suggest][hidden]`, first child of `[data-composer-zone]` | Help articles that match the draft | On draft input (debounced) search the KB, fill rows `button[data-kb-action="open"][data-kb-slug]` with escaped `mark` highlights, toggle `hidden` | T2 (RP2 §4.21; WY2 §4.15) |
| `data-topic="<label>"` | Topic chip button: T1 new-conversation chips (alternative to `data-qna-question`), T2 home chips and thread chips | Send a topic | Click: on home, start a conversation whose first message is the label; inside a conversation, send the label. A home chip may also carry `data-home-action="chat"` so a Core without `data-topic` still opens the chat (RP2 §4.6) | T1, T2 ([brief §9](../CLAUDE_CODE_BRIEF.md), WY1 §5.8, RP1 §4.23, WY2 §4.4, RP2 §4.6) |
| `data-home-ask` | T2 home ask field `textarea[rows=1]` inside `.ask .field` | The first message, typed on home | On `[data-home-action="chat"]` click or Enter, start a conversation with this draft as its first message; hide the `.ph` overlay while it has text | T2 (WY2 §4.4, RP2 §4.5) |
| `data-rec-send` | Recorder "send" round button | Stop and send in one step | Click stops recording and sends the note without the preview | T1 ([brief §7a](../CLAUDE_CODE_BRIEF.md), WY1 §4.18, RP1 §4.19); T2 only if the owner chooses direct send |
| `data-vn-rate` | Preview speed chip `.spd` inside `[data-vn-bar]` | Playback rate of the preview | Click cycles the rate of `[data-vn-audio]` and updates the chip label | T1 (WY1 §9, RP1 §4.19) |
| `data-prechat-edit` | "Edit" link in the saved-details summary card | Reopen the contact details | Click shows the form card (or step mode) with the saved values | T1 (WY1 §9, RP1 §4.21) |
| `data-prechat-skip` | "No thanks…" link under the T2 email card | Skip the email | Click hides the card and continues; render only when email is not required (`identity.isRequired`) | T2 (WY2 §4.20, RP2 §4.30) |
| `data-csat-rate="1…5"` | The five CSAT face buttons, with `aria-pressed` | Conversation rating | Click sets the rating and `aria-pressed` on the chosen face | T2 (WY2 §4.22, RP2 §4.32) |
| `data-csat-comment` | CSAT comment `textarea` | Optional comment | Read on submit | T2 |
| `data-csat-submit` | CSAT "Send feedback" button | Submit the rating | Click sends rating + comment: `POST /api/widget/conversations/:id/csat` (§6) | T2 |
| `data-csat-transcript` | CSAT "Email me the transcript" link (a `button`) | Transcript by email | Click calls `POST /api/widget/conversations/:id/transcript` (§6) | T2 |
| `data-csat` *(named here)* | The CSAT card root (`role="group"`) | Card container | Core (runtime-late.js) binds the four hooks above inside it | T2 |
| `data-chat-menu-toggle` *(named here)* | Chat bar ⋯ button (`aria-haspopup="menu"`, `aria-expanded`, `aria-label` = `moreOptions`) | Open the header menu | Click opens or closes `[data-chat-menu]`; drawn only when the menu has an item, never on a new conversation | T1, T2 |
| `data-chat-menu` *(named here)* | The menu (`role="menu"`, `hidden` while closed) | Header menu | Escape closes it and returns focus to the toggle; an outside click closes it | T1, T2 |
| `data-chat-menu-action="transcript\|sound"` *(named here)* | Menu items (`role="menuitem"`; the sound item `menuitemcheckbox` with `aria-checked`) | Email the transcript; notification sounds on/off | `transcript`: the same API as `data-csat-transcript`, only while the server says it is available; `sound`: Core's `uiPrefsStore.soundEnabled`, remembered for the visitor in `localStorage` `gs:sound:<workspaceId>` (`'0'` while off, removed when on; hidden when the workspace turned sound off). No "end conversation" item (owner) | T1, T2 |
| `data-msg-react="❤️"` + `data-msg-id="<message id>"` *(named here)* | `button.msg-act[aria-pressed]` in a team bubble's action row (operator, AI, bot; a server message id only) | The visitor's heart | Click sets or takes back the visitor's ❤️: `POST /api/widget/conversations/:id/reactions` (§6), optimistic, then the server's list; `aria-pressed` = the visitor's own; focus returns to the same heart after the repaint. The visitor has no other emoji (owner) | T2 |
| `data-prechat-step="<name\|email\|phone>"` *(named here)* | The step box root `div.cbox.steps`, inserted before `[data-input-bar]` in `[data-composer-zone]` | One pre-chat question at a time (`prechatMode: "steps"`) | Core (runtime-late.js) owns the box: progress, validation, the edition's phone prefix (+98 Iran, none International), one `POST /api/widget/identity/prechat` at the end | T1 |
| `data-prechat-step-input`, `data-prechat-step-submit`, `data-prechat-step-skip` *(named here)* | The step's input, its submit button, the skip link of an optional step | Answer, submit, skip | Enter (not while composing) or the button submits; skip answers nothing and moves on. Not `data-prechat-skip`, which skips the whole pre-chat | T1 |
| `data-ph-away` *(named here)* | The automated reply row (`.away-reply`, `awayReplyHtml`), its value the away placeholder (`simpleAddMore`) | Placeholder while away with a thread | Core (runtime-late.js) gives the composer that placeholder while the row is on screen and the team is away, and its own back after | T2 |
| `data-fb-skip` *(named here)* | «نه ممنون» in the T2 away email card, drawn only when the email is not required | Leave no email | Core marks the card skipped (no request) and puts the focus in the composer | T2 |

### 2.2 New values of existing hooks

| Attribute | Element | Purpose | What Core must bind | Templates |
|---|---|---|---|---|
| `data-view="home"` | Bottom-menu Home tab `button.wy-tab` | Navigate to home | Core navigation must accept `home` (`list` and `help` exist) | T1 (WY1 §4.10, RP1 §4.12, [brief §9](../CLAUDE_CODE_BRIEF.md)) |
| `data-home-action="track-order"` | T2 home "Track an order" row | Order tracking | Behaviour not specified (suggestion in RP2: start a conversation with "Track my order"); render only with a store context | T2 (WY2 §4.5, RP2 §4.7) |
| `data-kb-rate="neutral"` | Middle face of the T2 article rating (`down`, `neutral`, `up`) | "Partly" rating | Store `neutral`; until the KB API does, render only `down` and `up` ([brief §7a](../CLAUDE_CODE_BRIEF.md)) | T2 (WY2 §9, RP2 §4.25) |
| `data-smart-cta="<index>"` | Each quick reply of the WebYar T1 greeting | Run the rule's n-th CTA | Loader reads the index (first CTA `0`, suggestion) | T1 WebYar (WY1 §9) |

### 2.3 Classes and custom properties used as hooks

| Hook | Element | Purpose | Set by | Templates |
|---|---|---|---|---|
| `nav.wy-tabs` > `button.wy-tab[data-view][aria-current]` | Bottom menu | Tabs Home / Messages / Help; design classes (`.tabs`, `.tab`, `.tic`, `.tl`, `.on`) may be added next to them | Renderer, after the footer of home, list and help list/results | T1 (WY1 §4.10, RP1 §4.12) |
| `.va`, `.vb`, `.vc`, `.vd` on `nav.wy-tabs` | Bottom menu | Bar style from `navStyle` | Renderer | T1 |
| `.nv-both`, `.nv-icon`, `.nv-text`, `.nv-none` on each view root `.wy-view` | Home, list, help views | Label mode from `navMode` (`active` = no class) | Renderer | T1 |
| `.lg-thread` / `.lg-open` on `.shell` | Shell, launcher, panel | Respok logo direction from `logoDirection`: the skins draw the matching art (the home watermark, T1's greeting avatar and Messages tab icon, the launcher greeting's corners) as CSS masks under `.lg-open`, Thread otherwise. The drafts' `.g-t` / `.g-o` on the brand elements were not used | Loader, in RESPOK's build only (`@intl-kit`) | Respok T1, T2 |
| `.gs-accent-brand` on each view root `.wy-view` and on `.panel-close` | View roots, close button | Hand-tuned brand-default overrides (`tokens.json` → `brandOverrides`): the brand colour and its hero, in the stylesheet (a skin gives its own) | Renderer (`accentTokens()`), when the accent is uncustomised; the brand's own colour chosen explicitly is matched by `[style*='--a:#0b7d6c;' i]` instead ([brief §5.2](../CLAUDE_CODE_BRIEF.md)) | T1, T2 |
| `--on-a`, inline next to `--a` | View roots, close button | Text and icons on the accent | Renderer (`accentTokens()`): Ink on a light accent, else the stylesheet's white; the drafts' loader-set `--gs-on-primary` was not used ([brief §5.3](../CLAUDE_CODE_BRIEF.md)) | T1, T2 |
| `.typing-row` (production class, unused today) | `div.msg-row.operator.is-last.typing-row[aria-hidden="true"]` > avatar + `div.msg.operator.typing-bubble > span.typing-dots` | Visible "operator is typing" row, last row of the thread | Renderer, from `view.operatorTyping` (§3); the sr-only `[data-typing-row]` keeps announcing | T1, T2 (WY1 §4.14, RP1 §4.15, WY2 §4.10, RP2 §4.11) |
| `.msg-row.is-first` + `span.msg-sender-label` | First row of an operator-side run | Sender name above it, only where the team's side changes hands: another person than the last operator-side run, or a person after the AI. Never on the thread's first run (the bar names who answers); a day break, the visitor's messages or a system row do not bring it back (owner, 2026-10-18) | Renderer (from the group keys, PD:638-643; T2 `prevOp`, T1 `lastLabel`) | T1, T2 (RP1 §4.14, WY2 §4.9) |
| `.input-bar.is-locked` | Composer | Composer locked while the pre-chat card waits | Core (keeps the textarea disabled) | T1 (WY1 §4.16, RP1 §4.17) |
| `.panel.wy-after-fab` | Panel | Delay the open by .2s when the launcher was on screen and drops first | Core or the loader | T1 (RP1 §6) |
| `.wy-avatar-tile` | `span.wy-avatar` in the home hero | Logo tile look (48px, 15px radius) | Renderer | T1 (RP1 §4.3) |
| `.wy-head-chat.is-new` | Chat header | Header variant while the thread is empty | Renderer | T1 (RP1 §9) |
| `span.react[data-msg-id]` *(named here)* | The reaction badge under a bubble (`role="img"`, display only) | A badge already on screen | Core adds `.no-enter` to a badge it has shown, so a repaint does not replay its entrance | T2 |
| `.msg-actions` *(production class)* in `.msg-line` | Reply, copy and the heart beside a bubble | Shown only on the line hovered (a tap hovers the tapped line on a phone) or holding keyboard focus (`:focus-within`); hidden, they take no taps on a touch screen (`@media (hover: none)`). No `title` tooltips; their `aria-label`s stay (owner, 2026-10-18) | Stylesheet | T1, T2 |
| `.fx`, `.fx-<icon>`, `.fx-<shape>` and `.fx-off` on `button.launcher`; `data-fx`, `data-fi`, `dir` *(named here)* | Launcher | A launcher style (`fab.shape` / `fab.icon`, §1): `fx-off` while the team is away, the pill's text in `data-fx`, the agent's initial in `data-fi` | Loader, only with `config.fabStyleUrl`; the look is `runtime-fab.css` (§6, "Launcher styles") | every template |

### 2.4 Existing hooks in new places

| Hook | New place | What changes for Core | Templates |
|---|---|---|---|
| `data-home-action="chat"` | T2 home `.send` (reads `data-home-ask`); T2 list `.fab`; T1 Messages bottom button (the header `.wy-fab` moves there) | T2 home send passes the draft | T1, T2 |
| `data-kb-action="open"` + `data-kb-slug` | T2 tray rows, outside the help view | Bind them outside `kbHtml` | T2 |
| `data-kb-action="switch-chat"` | T1 "Still have a question?" card and T2 `.cta`, shown always | None | T1, T2 |
| `data-fb="email"`, `data-fb-submit`, `data-fb-status` | T1 in-thread away e-mail card `.ec`; T2 away thread's `.fcard` | The visitor's thread message becomes the fallback message (production map §4.6): `POST /api/widget/offline-messages` with `client_message_id`, then the address through `POST /api/widget/identity/offline-email` (§6) | T1 (WY1 §4.20, RP1 §4.21), T2 (WY2 §4.20) |
| `data-prechat="email"`, `data-prechat-submit` | T2 email card `.fcard` (handoff card with only email, on the operator side) | None | T2 (WY2 §4.20, RP2 §4.30) |
| `[data-emoji-picker]` | First child of `div.input-wrap` | Confirm Core finds it by attribute | T1 (WY1 §4.17, RP1 §4.18); T2 since 2026-10-18 (the grid opens inside the message box, which grows upward; Core's toggle, outside click and Escape unchanged) |
| `[data-presence]` | T2: sr-only in the bar, whose visible small line is the operator's name or the status words (§3 `assignedOperator`) | None: Core writes its label from the chat frame, as for every template (`default`'s sr-only label is written too since 2026-10-18) | T2 (RP2 §4.8) |

---

## 3. View-model fields

| View | Field | Type | Purpose | Fallback when absent |
|---|---|---|---|---|
| home (T1, T2) | `visitorName` | string | Name in the returning greeting (`homeGreetingBack`, `simpleHomeHiReturning`); from `identify()` or the contact | Generic greeting (`homeGreeting`, `simpleHomeHi`) |
| home, list (T1, T2) | `conversations[].operatorName` | string | Assigned operator on the T1 recent card, the T2 continue row and the list rows | `title`, else the workspace name (production) |
| home, list (T1, T2) | `conversations[].operatorOnline` | boolean | Presence dot `.pr` on that operator's avatar | No dot |
| home, list (T1, T2) | `conversations[].operatorAvatar` | URL | Photo in the operator avatar (named here; RP1 and RP2 ask for an avatar) | Initial tile `.c1`–`.c4` |
| home, list (T1, T2) | `conversations[].lastFromVisitor` | boolean | "You: " prefix on the preview (named here; all four specs need it) | No prefix |
| home, list (every template) | `conversations[].preview` of a system row | string | Core's sentence in the visitor's language (`systemRowText`, from the API's `systemKind` / `systemMeta`, §6 "System messages") | The stored English body (an older backend) |
| home (T2) | `kbSummary` | `{ count, categories }`: article count and top category names | Help-row subtitle `simpleHelpSub` | The static `simpleHelpSubAway` line, or the title only |
| chat frame (T1, T2) | `assignedOperator` | `{ name, avatar, online }` | Chat header identity, presence and typing look. While an operator answers, the title is the workspace's name (`config.workspaceName`) and the operator's name the small line under it: T2 keeps its online dot, typing dots and grey away line there, and a long name ends in "…" (`.st b`); T1 (`.hn` / `.hs`) shows the name only. No workspace name, or the same name twice: the operator's name is the title (owner, 2026-10-18) | Workspace avatar, name and `replyTimeText` (production) |
| messages: the `view` argument of `messagesHtml` (PD:630-796) (T1, T2) | `view.operatorTyping` | `{ name, avatar }`, absent when nobody types | Visible typing row (`.typing-row`, §2.3) and its "{name} is typing…" meta (T1). Core already knows from `setOperatorTyping` | No visible row; the sr-only `[data-typing-row]` still announces |
| messages: the `view` argument of `messagesHtml` (T2) | `view.csat` *(named here)* | `{ closedId, name, avatar, rating, comment, state, transcript }`; `state` `ask` / `sending` / `done` / `error` / `gone`; `transcript` null or `{ state, to }` with `state` `idle` / `sending` / `sent` / `failed` / `no` | The rating card under the `conversation_closed` row whose id is `closedId` (runtime-late.js, from `GET …/csat`, §6) | No card: the closed line only |
| chat frame (T1, T2) | `menu` in the `chatHeaderHtml` view model *(named here)* | `{ open, items }`, items `{ action: 'transcript', state, to }` and `{ action: 'sound', on }` | The ⋯ menu (`data-chat-menu*`, §2.1); null on a new conversation or with no item | No ⋯ button |
| chat frame (T1) | `prechat` in the `chatHeaderHtml` view model *(named here)*, only for a renderer declaring the feature `prechatHeader` | boolean (runtime-ext.js) | The thread asks for the visitor's details (the card, the steps), or is the conversation they were given in (the saved details, then the thread while no AI answers it, until another conversation is opened): with no operator assigned, T1 draws the workspace with its lead's face (the first online team member), never "new conversation", and runtime-late.js gives it no ⋯ menu; an assigned operator stays the header's, with the menu; away, or nobody listed online, the workspace tile (boards 08·a-c) | The header as before (false without the feature: T2 does not declare it, so its header is not repainted for it) |
| config `availability` (T1, T2) | `availability.nextOpenAt` | ISO 8601 date-time | `{time}` in `homeBackAt`, `awayBannerSub`, `simpleAwayBackAt`, `simpleAwaySub`; the day part of the T2 away note | `replyTimeText(false)` / `homeReplySlow`; drop the "back at" part |
| kb (T1, T2) | `categories[].icon`, `categories[].count` | icon id, number | Category rows and tiles; `{n}` of `kbArticleCount` | Default icon (book); hide the count |
| kb article (T1, T2) | `article.categoryTitle` | string | Article header title (the article title moves into the body `h1`) | Article title in the header (production) |
| kb article (T1) | `article.categoryCount` | number | Article header subtitle (`kbArticleCount`); named here | Hide |
| kb article (T1, T2) | `article.author` | string | Meta line | Hide |
| kb article (T1, T2) | `article.readingMinutes` | number | `kbReadTime` | Hide |
| kb article (T1) | `article.updatedAt` | ISO 8601 date-time | `kbUpdated`; named here | Hide |
| kb results and tray (T2) | `results[].snippet`, `results[].matches`, `results[].readingMinutes` | string, match ranges, number | Two-line excerpt with `mark` highlights; tray "n min read"; named here | Title only, no highlight |
| message `metadata` (T2) | `metadata.kind: "order_status"` + order number, item summary, status label, steps, current step, delivery day, tracking URL | object | Order card (needs the store context, `data-commerce-*`) | Not rendered |
| message `metadata` (T2) | `metadata.reactions` | `[{ emoji, count, mine }]` in display order (❤️ 👍 😂 😮 😢 🙏); `mine` = the visitor's own | Reaction badge (up to 3 kinds, then the total) and the heart's `aria-pressed`. Put on the message by runtime-late.js from `GET …/reactions` and the `message_reactions` event (§6), only inside its `messagesHtml` wrapper: /history and /poll never carry it | Not rendered |
| message `metadata` (T2) | `metadata.kind: "conversation_closed"` + `by`, `agent_name` (who closed it), `operator_name` (the operator rated), `status` (`resolved` / `closed`) | object | System line `convClosedBy` `{name}` = `agent_name` (else the workspace), then the CSAT card; written by the server only for a template with `closedNotice` (§6). The stored row also holds `agent_id` and `operator_id`; the visitor never receives them (§6, "What a visitor never receives") | Omit (runtime.js drops the row before a renderer without `closedNotice` sees it) |
| messages: the `view` argument of `messagesHtml` (T2) | `view.react` *(named here)* | boolean | Reactions can be drawn: the badge (`reactHtml`) under each bubble with `metadata.reactions` and the visitor's heart (`reactBtnHtml`, `data-msg-react`) among a team message's actions; set only by the late pack, so no heart is drawn without the Core that answers it | No badge, no heart |
| messages: the `view` argument of `messagesHtml` (T1) | `view.queue` *(named here)* | `{ at, position, waitMinutes }`: `at` the index of the queued row it belongs to, `waitMinutes` null without an estimate | Queue pill on the LAST `routing_in_queue` row while nothing after it (a join, a transfer, an operator's message) says the wait is over: `routingInQueue` `{n}` `{min}`, or `routingInQueuePosition` `{n}` without `waitMinutes`. From `GET /api/widget/queue` (§6), polled every 30 s while shown | Production queue text (`routingInQueue` without placeholders) |
| messages: the `view` argument of `messagesHtml` (T1, T2) | `view.awayReply` *(named here)* | `{ at, email, status, value, error, skip }`: `at` the index of the visitor message captured while away, `email` the contact's address once known, `status` `ask` / `saving` / `saved` / `skipped` (T2), `value` and `error` the card's draft and its message key, `skip` the T2 card may offer «نه ممنون» (email not required) | The local auto-reply row after that message and its email card (`awayReplyHtml`); never a stored message, operators do not see it | No row |
| messages: the `view` argument of `messagesHtml` (T1) | `view.away` *(named here)* | boolean | While the team is away, the visitor's sent message says `msgSent` in words instead of the tick (07·09); set by runtime-late.js (`awayOn()`, round 4) | Ticks |
| loader `setUnread` (T1 Respok) | `setUnread(count, preview)`, `preview { name, avatar, text }` | object | Reply card while the panel is closed (RP1 §4.28) | Badge only |

---

## 4. i18n keys

Strings are copied verbatim from the copy decks: Persian from the WebYar specs (WY1 §10, WY2 §10), English from the
Respok specs (RP1 §10, RP2 §10). Values in the decks are shown with their demo data (a name, a number); the key column
lists the placeholders. "—" = that brand has no such string. Keys marked *(loader)* live in `LOADER_STRINGS`, not in
Core's table.

### 4.1 Shared by both templates

| Key | Persian (WebYar) | English (Respok) | Where used |
|---|---|---|---|
| `statusOnline` | «آنلاین» | Online | T1 home team card and chat header subtitle (then « · » + `replyShort`), WebYar greeting subtitle after the workspace name; T2 bar status (WY2, RP2) |
| `moreOptions` | «گزینه‌های بیشتر» | More options | Chat header ⋯ button `aria-label`, both templates; render it only when a menu exists |
| `sendVoice` | «ارسال پیام صوتی» | Send voice message | T1 recorder send (`data-rec-send`) and preview send (`data-vn-send`); T2 recorder button when it sends directly, otherwise that button keeps production's `stopRecording` ([brief §7a](../CLAUDE_CODE_BRIEF.md)) |
| `deleteRecording` | «حذف ضبط» | Delete recording | T1 preview delete (`data-vn-delete`); T2 recorder delete (`data-rec-cancel`). T1's recorder cancel keeps `cancelRecording` |
| `unitKB`, `unitMB` | «کیلوبایت» / «مگابایت» | — | File sizes with Persian digits and units in both templates (WY2: «{n} کیلوبایت»). English keeps `KB` / `MB` (hard-coded in production) |
| `kbArticleCount` `{n}` | «۵ مقاله» | 5 articles | T1 category rows and article header subtitle; T2 category tiles (WY2, RP2) |
| `kbReadTime` `{n}` | «۲ دقیقه مطالعه» | 2 min read | Article meta in both templates; T2 tray rows (WY2, RP2) |
| `saveEmail` | «ثبت ایمیل» | Save email | T1 away e-mail card submit (`.go`, `aria-label`); T2 email card OK button (WY2, RP2) |

### 4.2 Template 1: navigation and home

| Key | Persian (WebYar) | English (Respok) | Where used |
|---|---|---|---|
| `navHome` | «خانه» | Home | Bottom-menu tab label and tab `aria-label` |
| `navMessages` | «پیام‌ها» | Messages | Messages tab label; the Messages screen title is `wyConversations` (§4.13) |
| `navLabel` | «بخش‌های ویجت» | Widget sections | Bottom menu `nav` `aria-label` |
| `navMessagesUnread` `{n}` | «پیام‌ها، ۲ خوانده‌نشده» | Messages, 2 unread | Messages tab `aria-label` with the unread count; use `navMessages` at 0 |
| `homeGreetingBack` `{name}` | «سلام دوباره، علی» | Welcome back, Ali | Hero greeting for an identified visitor (`visitorName`) |
| `homeTeamTitle` | «گفتگو با تیم پشتیبانی» | Chat with our team | Home team card title |
| `replyShort` | «پاسخ در چند دقیقه» | Replies in minutes | Home CTA card; after `statusOnline` in the team card and chat header (English lower-cases it there: "Online · replies in minutes") |
| `homeAwayTitle` | «الان آفلاین هستیم» | We're away right now | Home away card title |
| `homeBackAt` `{time}` | «از ساعت ۹ صبح پاسخ می‌دهیم» | Back at 9:00 AM | Home away card status line; `{time}` from `availability.nextOpenAt`, fallback `homeReplySlow` |
| `homeAwayNote` | «پیامتان را بگذارید؛ پاسخ را به ایمیلتان می‌فرستیم و همین‌جا هم می‌بینید.» | Leave a message and we'll email you the reply. You'll find it here too. | Home away note |
| `searchKbAway` | «جوابتان شاید در راهنما باشد» | Your answer may be in Help | Home search placeholder while away |

### 4.3 Template 1: conversation, composer, voice and emoji

| Key | Persian (WebYar) | English (Respok) | Where used |
|---|---|---|---|
| `typingNamed` `{name}` | «سارا در حال نوشتن…» | Sara is typing… | Meta under the visible typing bubble (`view.operatorTyping.name`); also usable as the sr-only `[data-typing-label]` text |
| `msgRead` | «خوانده شد» | Read | Read-receipt `aria-label` |
| `msgDelivered` | «تحویل شد» | Delivered | Single-tick `aria-label` |
| `msgSent` | «ارسال شد» | Sent | Meta after the time while the team is away |
| `msgAutomated` | «پیام خودکار» | Automated message | Meta under the automated reply |
| `timeJustNow` | «همین حالا» | Just now | Meta time |
| `wyTeamOf` `{workspace}` | «تیم پشتیبانی فروشگاه نیلوفر» | Nilufar Store support | New-conversation welcome block title |
| `messageLabel` | «پیام» | Message | Composer textarea `aria-label` |
| `emojiPickerClose` | «بستن شکلک‌ها» | Close emoji | Emoji button while the picker is open (`emojiPicker` while closed) |
| `emojiDialog` | «انتخاب شکلک» | Emoji picker | Picker `role="dialog"` label |
| `emojiSearch` | «جستجوی شکلک» | Search emoji | Picker search placeholder |
| `emojiCategories` | «دسته‌های شکلک» | Emoji categories | Category `tablist` label |
| `emojiCat*` (one key per category) | «پرکاربرد · چهره‌ها · آدم‌ها و دست‌ها · قلب‌ها و نمادها · طبیعت · غذا و نوشیدنی» | Frequently used · Smileys · People and hands · Hearts and symbols · Nature · Food and drink | Category tabs and section headers |
| `recHint` `{max}` | «Esc لغو · Enter ارسال · حداکثر ۲ دقیقه» | Esc · cancel · Enter · send · up to 2 minutes | Recorder hint row (only with Esc / Enter handling and a length cap) |
| `playAudioProgress` `{pos}` `{total}` | «پخش — ۵ از ۱۴ ثانیه» | Play — 5 of 14 seconds | Voice-preview play button `aria-label` |
| `playbackRate` | «سرعت پخش» | Playback speed | Voice-preview speed chip `aria-label` (`data-vn-rate`) |
| `composerLockedPrechat` | «اول فرم بالا را تکمیل کنید» | Fill in the form above first | Locked composer (`.input-bar.is-locked`) |
| `loading` | «در حال بارگذاری» | Loading | Skeleton label: put it in a polite live region, skeletons stay `aria-hidden` |

### 4.4 Template 1: pre-chat and contact details

| Key | Persian (WebYar) | English (Respok) | Where used |
|---|---|---|---|
| `prechatIntroTitle` | «قبل از شروع، خودتان را معرفی کنید» | Before we start, introduce yourself | Pre-chat intro card title |
| `optional` | «(اختیاری)» | (optional) | Suffix of asked but optional fields; step progress |
| `errEmailIncomplete` | «ایمیل کامل نیست؛ مثلاً name@example.com» | Enter a full email, like name@example.com | E-mail error in the pre-chat form (Core validation text) |
| `prechatStepEmailInvalid` + `prechatStepEmailExample` | «ایمیل کامل نیست · مثلاً name@example.com» | That email isn't complete / · e.g. name@example.com | Step-by-step e-mail error meta, two parts |
| `prechatPrivacy` | «اطلاعات شما فقط برای پاسخگویی استفاده می‌شود.» | We only use your details to reply to you. | Pre-chat privacy line |
| `prechatPrivacyShort` | «فقط برای پاسخگویی استفاده می‌شود» | Only used to reply to you | Form-card privacy line |
| `prechatCardLabel` | «مشخصات تماس» | Contact details | Form card `aria-label` (today `prechatTitle`, PD:809) |
| `prechatAskName` | «سلام! برای شروع، اسم‌تون چیه؟» | Hi! To start, what's your name? | Step 1 question (`prechatMode: "steps"`) |
| `prechatAskEmail` `{name}` | «ممنون علی جان. ایمیل‌تون رو هم بنویسید تا جواب‌ها رو براتون بفرستیم.» | Thanks, Ali. What's your email, so we can send you our replies? | Step 2 question |
| `prechatAskEmailNoName` *(named here)* | «ایمیل‌تون رو بنویسید تا جواب‌ها رو براتون بفرستیم.» | What's your email, so we can send you our replies? | Step 2 question when no name is known (the name step was skipped or not asked) |
| `prechatAskPhone` | «اگه بخواید شماره موبایل‌تون رو هم بدید تا پیامکی خبرتون کنیم.» | If you like, add your phone number and we'll text you updates. | Step 3 question |
| `prechatStep` `{n}` `{total}` | «مرحله ۳ از ۳ · اختیاری» | Step 3 of 3 · optional | Step progress (+ `optional` on an optional step) |
| `skip` | «رد کردن» | Skip | Skip an optional step |
| `prechatPhonePhLocal` | «۹۱۲ ۳۴۵ ۶۷۸۹» | 415 555 0132 | Step phone placeholder after the country-code prefix |
| `prechatPhoneHint` | «برای پیامک پیگیری» | For text updates | Step phone hint |
| `prechatStepSubmit` (the designs' `submit`) | «ثبت» | Submit | Step submit `aria-label` |
| `prechatStepSaved` (the designs' `saved`) | «ثبت شد» | Saved | Meta of the newest accepted step answer (08·b) |
| `prechatSaved` | «مشخصات شما ثبت شد» | Your details are saved | Saved-details summary header |
| `edit` | «ویرایش» | Edit | Summary edit link (`data-prechat-edit`) |
| `prechatSavedLabel` | «مشخصات ثبت‌شده» | Saved details | Summary `aria-label` |
| `prechatThanks` `{name}` | «ممنون علی! یکی از همکارهام تا چند دقیقه دیگه جواب می‌ده. سؤال‌تون رو بنویسید.» | Thanks, Ali! A teammate will reply in a few minutes. Go ahead and ask your question. | Automated message after submit (or workspace text) |

### 4.5 Template 1: away

| Key | Persian (WebYar) | English (Respok) | Where used |
|---|---|---|---|
| `statusAwayEmail` | «آفلاین · پاسخ از طریق ایمیل» | Away · replies by email | Chat header subtitle while away |
| `awayBannerTitle` | «تیم ما الان آفلاین است» | Our team is away right now | In-thread away banner title |
| `awayBannerSub` `{time}` `{replyTime}` | «از ساعت ۹ صبح پاسخ می‌دهیم · معمولاً تا ۲ ساعت» | Back at 9:00 AM · usually replies within 2 hours | Away banner sub-line; `{time}` from `availability.nextOpenAt`, `{replyTime}` the typical reply time |
| `awayAutoReply` | «پیامتون ثبت شد. ایمیلتون رو بگذارید تا پاسخ رو براتون بفرستیم.» | Got your message! Leave your email and we'll send you the reply. | Automated reply in the away thread |
| `fallbackEmailLabel` | «ایمیل برای دریافت پاسخ» | Email for the reply | E-mail card visible label |
| `fallbackEmailFormLabel` | «ایمیل برای پاسخ» | Email for the reply | E-mail card form `aria-label`; named here (WY1 gives the string without a key; English from RP1 §8) |
| `awayRecorded` *(named here)* | «پیامتون ثبت شد.» | Got your message! | The automated reply once the e-mail is known |
| `awayReplyTo` `{email}` *(named here)* | «پاسخ را به {email} می‌فرستیم.» | We'll send the reply to {email}. | The card under it once the e-mail is known |

### 4.6 Template 1: help center

| Key | Persian (WebYar) | English (Respok) | Where used |
|---|---|---|---|
| `searchKbHelp` | «سؤالتان را بنویسید…» | Type your question… | Help view search placeholder |
| `kbPopular` | «پربازدیدترین‌ها» | Most read | Help popular card heading |
| `kbUpdated` `{time}` | «به‌روز شده ۳ روز پیش» | Updated 3 days ago | Article meta (`article.updatedAt`) |
| `kbStillQuestion` | «هنوز سؤال دارید؟» | Still have a question? | Article ask card title |

### 4.7 Template 2: home

| Key | Persian (WebYar) | English (Respok) | Where used |
|---|---|---|---|
| `simpleHomeHi` | «سلام 👋» | Hi there 👋 | Hero greeting |
| `simpleHomeHiReturning` `{name}` | «سلام {name}، خوش برگشتی 👋» | Welcome back, Ali 👋 | Hero greeting for an identified visitor (`visitorName`); see the copy note in WY2 §10 |
| `simpleHeadline` | «چطور می‌توانیم» + line break + «کمکتان کنیم؟» | How can we help you today? | Hero headline; designed line break after «چطور می‌توانیم» / "How can we" |
| `simpleHeadlineAway` | «پیامتان را» + line break + «بگذارید» | Leave us a message | Hero headline while away; break after «پیامتان را» / "Leave us" |
| `simplePresenceOnline` | «آنلاین هستیم» | Online now | Hero presence line, followed by «، » / ", " and the reply time (`replyTimeText`) |
| `simpleAwayBackAt` `{time}` | «آفلاین هستیم، از ساعت ۹ صبح پاسخ می‌دهیم» | Away right now, back at 9 AM | Hero presence line while away; `{time}` from `availability.nextOpenAt` |
| `simpleAskLabel` | «سؤالتان را بنویسید» | Ask a question | Ask field `aria-label` (`data-home-ask`) |
| `simpleAskPlaceholder` | «سؤالتان را بنویسید…» | Ask us anything… | Rotating ask placeholder, line 1 |
| `simpleAskExamplePrefix` | «مثلاً: » | e.g. | Prefix of placeholder lines 2–3, which come from `askExamples` |
| `simpleAskPlaceholderAway` | «پیامتان را بنویسید…» | Write your message… | Static ask field while away |
| `simpleAwayNote` | «پاسخ را صبح به ایمیلتان می‌فرستیم» | We’ll email you the reply in the morning | Note under the field while away (replaces the chips) |
| `simpleHelpCenter` | «مرکز راهنما» | Help center | Help row title and help bar title |
| `simpleHelpSub` `{n}` `{categories}` | «{n} مقاله درباره {categories}» | 24 articles on orders, delivery and returns | Help row subtitle (`kbSummary`) |
| `simpleHelpSubAway` | «بیشتر پاسخ‌ها همین‌جاست، همیشه در دسترس» | Most answers are here, any time | Help row subtitle while away |
| `simpleTrackOrder` | «پیگیری سفارش» | Track an order | Track-order row title (`data-home-action="track-order"`) |
| `simpleTrackOrderSub` | «با شماره سفارش، وضعیت را همین‌جا ببینید» | See its status with your order number | Track-order row subtitle |
| `simpleContinueWith` `{name}` | «ادامه گفتگو با {name}» | Continue with Sara | Continue row title (`conversations[].operatorName`) |
| `simpleYourConversations` | «گفتگوهای شما» | Your conversations | Conversations row title and list bar title |
| `simpleConversationsSub` `{n}` `{open}` | «{n} گفتگو، یکی باز است» | 3 conversations, 1 open | Conversations row subtitle (the Persian string fixes the open count at one; other counts not specified) |

### 4.8 Template 2: conversation, email card and away

| Key | Persian (WebYar) | English (Respok) | Where used |
|---|---|---|---|
| `simpleTyping` | «در حال نوشتن» | typing | Bar status while the operator types and the typing-row label. WY1 lists the same string as the T1 typing bubble's `aria-label`, which T1 does not need (the bubble is `aria-hidden`) |
| `simpleWelcomeTeam` `{workspace}` | «تیم پشتیبانی {workspace}» | The Nilufar Store team | New-conversation welcome block title |
| `simpleWereOnline` | «آنلاین هستیم» | We’re online | Welcome block status line |
| `simpleOtherTopic` | «موضوع دیگر» | Something else | Last thread topic chip (behaviour not specified; RP2 lists "Something else" among the demo topics) |
| `simpleInstantAnswers` | «پاسخ‌های آماده از مرکز راهنما» | Answers from the help center | Instant-answers tray heading (`data-kb-suggest`) |
| `simpleLoadingOlder` | «در حال بارگذاری گفتگوهای قدیمی‌تر» | Loading older conversations | Skeleton label while older conversations load |
| `simpleHandoffAck` | «سؤالتان به تیم رسید؛ معمولاً در چند دقیقه پاسخ می‌دهیم.» | Got it, the team has your question and usually replies within minutes. | First bubble above the email card (the handoff card's `.hc-subtitle` text) |
| `simpleAskEmail` | «اگر از سایت رفتید، پاسخ را کجا بفرستیم؟» | If you leave the site, where should we send the reply? | Second bubble (the card's `.hc-title`) |
| `simpleSkipEmail` | «نه ممنون، همین‌جا منتظر می‌مانم» | No thanks, I’ll wait here | Email card skip link (`data-prechat-skip`) |
| `simpleAwayStatus` | «آفلاین؛ پاسخ با ایمیل» | Away, replies by email | Bar status while away |
| `simpleAwayTitle` | «الان آفلاین هستیم» | We’re away right now | Away notice title |
| `simpleAwaySub` `{time}` `{replyTime}` | «از ۹ صبح پاسخ می‌دهیم؛ معمولاً تا ۲ ساعت» | Back at 9 AM, usually reply within 2 hours | Away notice sub-line |
| `simpleMessageRecorded` | «پیامتان ثبت شد.» | Your message is saved. | Auto-reply bubble |
| `simpleReplyToEmail` `{email}` | «پاسخ را به {email} می‌فرستیم.» | We’ll send the reply to ali@example.com. | Saved email card |
| `simpleAutoReply` | «پاسخ خودکار» | Automatic reply | Meta under the auto reply |
| `simpleAddMore` | «اگر چیزی اضافه دارید بنویسید…» | Add anything else… | Composer placeholder while away |
| `convClosedBy` `{name}` | «{name} گفتگو را بست» | Sara closed the conversation | System line when the operator closes the conversation (`metadata.kind: "conversation_closed"`) |
| `simpleReact` *(named here)* | «پسندیدن» | Like | The visitor's heart (`data-msg-react`): its `aria-label` (no `title` tooltip, as reply and copy) |
| `simpleReactions` `{list}` *(named here)* | «واکنش‌ها: ❤️ ۱، 👍 ۲» | Reactions: ❤️ 1, 👍 2 | Reaction badge `aria-label`; `{list}` = "emoji count" pairs joined by the dictionary's separator («، » in Persian, ", " in English and Turkish) |

### 4.9 Template 2: help center

| Key | Persian (WebYar) | English (Respok) | Where used |
|---|---|---|---|
| `kbClearSearch` | «پاک کردن» | Clear | Search clear `aria-label` (`data-kb-search-clear`) |
| `kbResultsCount` `{n}` | «{n} مقاله پیدا شد» | 3 articles found | Result count |
| `kbTopicsTitle` | «یا از یک موضوع شروع کنید» | Or start from a topic | Categories heading |
| `kbDidThisHelp` | «این مقاله کمک کرد؟» | Did this help? | Article feedback question |
| `simpleHelpfulPartly` | «تا حدی» | Somewhat | Middle article face (`data-kb-rate="neutral"`); the outer faces are `wyHelpfulNo` / `wyHelpfulYes` (§4.13) |
| `kbStillNeedHelp` | «هنوز سؤال دارید؟» | Still need help? | Article CTA title |
| `kbChatWithTeam` | «با تیم گفتگو کنید؛ » + reply time | Chat with the team, usually replies in 2 minutes | Article CTA sub-line, followed by the reply time |

### 4.10 Template 2: order card

| Key | Persian (WebYar) | English (Respok) | Where used |
|---|---|---|---|
| `orderTitle` `{number}` | «سفارش {number}» | Order 48213 | Order card title (RP2 lists "Order 48213" as commerce data) |
| `orderStatusShipped` | «ارسال شد» | Shipped | Status pill (other statuses not specified) |
| `orderStepPlaced`, `orderStepPreparing`, `orderStepShipped`, `orderStepDelivered` | «ثبت · آماده‌سازی · ارسال · تحویل» | Placed · Packed · Shipped · Delivered | Progress step labels, in order |
| `orderArrives` `{day}` | «تحویل:» + day | Arrives Thursday | Order card footer |
| `orderTrackPackage` | «پیگیری مرسوله» | Track package | Tracking link |

### 4.11 Template 2: rating after a chat

| Key | Persian (WebYar) | English (Respok) | Where used |
|---|---|---|---|
| `csatTitle` `{name}` | «گفتگو با {name} چطور بود؟» | How was your chat with Sara? | CSAT title |
| `csatSub` | «نظرتان کمک می‌کند بهتر شویم.» | Your answer helps the team get better. | CSAT sub-line |
| `csat1` … `csat5` | «خیلی بد · بد · معمولی · خوب · عالی» | Very bad · Bad · Okay · Good · Great | Face labels, 1 to 5 (`data-csat-rate`) |
| `csatComment` | «چیز دیگری هم بگویید (اختیاری)» | Tell us more (optional) | Comment placeholder (`data-csat-comment`) |
| `csatSend` | «ارسال نظر» | Send feedback | Submit button (`data-csat-submit`) |
| `csatTranscript` | «ارسال متن گفتگو به ایمیل» | Email me the transcript | Transcript link (`data-csat-transcript`) and the ⋯ menu item |
| `csatTranscriptSent` `{email}` *(named here)* | «متن گفتگو به {email} فرستاده شد» | We sent the transcript to {email} | After a sent transcript; `{email}` is the server's masked address (`a•••@example.com`), an isolated LTR run |
| `menuSound` *(named here)* | «صدای اعلان‌ها» | Notification sounds | ⋯ menu sound item (`data-chat-menu-action="sound"`), T1 and T2 |

The rating card's other states reuse or add renderer copy (`csatThanks`, `csatRated`, `csatGone`, `csatFailed`,
`csatTranscriptFailed` in the extras files' own dictionaries); `menuEndConversation` and `convEndedByYou` are not used
(no "end conversation" item, owner 2026-10-17).

### 4.12 Launcher

| Key | Persian (WebYar) | English (Respok) | Where used |
|---|---|---|---|
| `launcherTyping` *(loader)* | «پشتیبان در حال نوشتن» | — | Launcher `aria-label` while an operator types (WebYar kit typing state) |
| `openChatAway` *(loader)* | «گفتگو — آفلاین» | Open chat, team away | Launcher `aria-label` while the team is away |

### 4.13 Existing keys whose value or use changes

| Key | Persian (WebYar) | English (Respok) | Where used |
|---|---|---|---|
| `homeGreeting` | «سلام، خوش آمدید» | Hi there, welcome | T1 hero greeting; value changes (today «سلام» and English "Hello", each with a waving-hand emoji). T2 uses `simpleHomeHi` |
| `homeWelcome` | «چطور می‌توانیم کمکتان کنیم؟» | How can we help you today? | T1 hero question when `welcomeMessage` is empty; the Persian value changes (today greeting and question in one string) |
| `homeReplyFast` | «معمولاً در چند دقیقه پاسخ می‌دهیم» | We usually reply in a few minutes | T1 welcome block, through `replyTimeText(true)`; English today "Typically replies in a few minutes" |
| `homeStartChat` | «شروع گفتگو» | Start a conversation | T1 home button, pre-chat submit and form-card submit (the two submits are new places) |
| `searchKb` | «جستجو در راهنما» | Search for help | T1 home search placeholder and `aria-label` (new place); T2 Help search input label |
| `wyViewConversations` | «همه گفتگوها» | All conversations | T1 home link in `nv-none` mode; today «مشاهده گفتگوها» / "View conversations" |
| `wyConversations` | «پیام‌ها» | Messages | T1 Messages screen title; today «گفتگوها» / "Conversations". T2 uses `simpleYourConversations` |
| `wyRecentConversations` | «پیام اخیر» | Recent message | T1 recent card caption; today «گفتگوهای اخیر» / "Recent conversations" |
| `wyStartNew` | «ارسال پیام جدید» | Send us a message | T1 home CTA card and the Messages bottom button; today «گفتگوی جدید» |
| `wyNewConversation` | «گفتگوی جدید» | New conversation | T1 new-conversation header; T2 header and list `.fab`. **Decided:** «گفتگوی جدید» for both templates (T2 boards say «گفتگوی تازه»: accepted copy difference) |
| `typeMsg` | «پیام خود را بنویسید…» | Write a message… | Composer placeholder; today "Type a message..." with three dots. **Decided:** «پیام خود را بنویسید…» for both templates (T2 boards say «پیامتان را بنویسید…»: accepted copy difference) |
| `emojiPicker` | «شکلک‌ها» | Emoji | Emoji button label (closed state). **Decided:** «شکلک‌ها» everywhere, matching the dedicated emoji board 06 and its close label «بستن شکلک‌ها» (other boards say «ایموجی», production «شکلک»: accepted, it is an `aria-label`, not visible text) |
| `attachFile` | «پیوست» | Attach a file | Attach button (`aria-label`); today «پیوست فایل» / "Attach file". **Decided:** "Attach a file" for both templates (T1 boards say "Attach") |
| `recordVoice` | «ضبط پیام صوتی» | Record a voice message | Mic button; English today "Record voice message" |
| `retry` | «تلاش دوباره» | Try again | Failed-send retry; today «تلاش مجدد» / "Retry" |
| `remove` | «حذف پیوست» | Remove attachment | Pending-file remove; today «حذف» |
| `cancelRecording` | «لغو ضبط» | Cancel recording | T1 recorder cancel; today «لغو». The T2 recorder's trash button is `deleteRecording` |
| `wyConnectOperator` | «اتصال به پشتیبان» | Connect to support | T1 pre-chat header title; today «اتصال به اپراتور» / "Connect to an operator" |
| `prechatSubtitle` / `wyPrecontactDesc` | «اگر از سایت رفتید، پاسخ را برایتان می‌فرستیم.» | If you leave the site, we'll send you the reply. | T1 pre-chat intro text (PD:835) |
| `prechatTitle` | «مشخصات شما» | Your details | T1 form card title only (its `aria-label` is `prechatCardLabel`, the intro title `prechatIntroTitle`) |
| `wyArticleHelpful` | «این مقاله مفید بود؟» | Was this article helpful? | T1 rating question; Persian today «آیا این مقاله مفید بود؟». T2 uses `kbDidThisHelp` |
| `wyHelpfulYes`, `wyHelpfulNo` | «بله» / «نه» | Yes / No | T1 rating buttons and the outer T2 faces; today «مفید بود», «مفید نبود» / "Helpful", "Not helpful" |
| `wyStatusOpen`, `wyStatusResolved` | «باز» · «حل شده» | Open / Resolved | Status tags. **Decided:** «حل شده» (a status adjective) for both templates (T2 boards say «حل شد»: accepted copy difference) |
| `routingInQueue` `{n}` `{min}` | «نفر ۲ در صف · حدود ۳ دقیقه» | 2nd in line · about 3 minutes | T1 queue pill (`view.queue`, §3); new placeholders, in the T1 dictionary: Core's own `routingInQueue` (no placeholders) stays as it is for `default` |
| `routingInQueuePosition` `{n}` *(named here)* | «نفر ۲ در صف» | 2nd in line | T1 queue pill while there is no wait estimate (fewer than 3 measured claims, or more than 180 minutes) |
| `you` + ": " | «شما:» | You: | Preview prefix when the visitor sent the last message (`lastFromVisitor`), both templates; a composition, no new key |
| `kbSwitchToChat` (or `wyTalkToSupport`) | «با تیم پشتیبانی گفتگو کنید» | Chat with our support team | T1 ask card line, now shown always; both T1 specs name the same two candidates (PD:1416 decides) |
| `dismiss` *(loader)* | «بستن پیام» | Dismiss message | Greeting close (`aria-label`); today «بستن» / "Dismiss". **Decided:** «بستن پیام», matching the English (T1 boards say «بستن اعلان») |

---

## 5. Superseded names

Do not use these; they appeared in earlier drafts of the specs.

| Superseded | Canonical | Was in |
|---|---|---|
| `[data-typing-bubble]`, `typingRowHtml()`, `extraRowHtml` as the typing mechanism | `view.operatorTyping` → `.typing-row` | WY1 §4.14, §9; WY2 §4.10, §9 |
| `data-home-draft` | `data-home-ask` | RP2 §4.5, §9 |
| `fab.style` (`bubble`, `duo`, `agent`, `pill`; `open`, `thread`, `bubble`, `duo`, `headset`, `avatar`, `pill`) | `fab.icon` (`bubble`, `duo`, `avatar`, `headset`) + `fab.shape` (`pill`, `square`) + `logoDirection` | WY1 §5.24, §9; RP1 §9 |
| `nextOpenLabel`, `availability.nextOpenLabel` | `availability.nextOpenAt` | WY1 §9, WY2 §9 |
| `conversations[].agentName`, `.agentOnline` | `conversations[].operatorName`, `.operatorOnline` | WY1 §9 |
| `span.msg-name` | `span.msg-sender-label` | RP1 §4.14, §9 |
| `button.tab` (bottom menu) | `button.wy-tab` | RP1 §4.12, §9 |
| `navMode` class "on the panel root" | on each view root `.wy-view` | RP1 §4.12 |
| `lg-*` "on the template root" | on `.shell` | RP2 §4.33 |
| T1 away e-mail card as a handoff card (`data-prechat=email`) | contact-fallback hooks `data-fb="email"`, `data-fb-submit`, `data-fb-status` | RP1 §4.21, §9 |
| `presenceOnline`, `simpleStatusOnline`, `simpleOnline` | `statusOnline` | WY1, WY2, RP2 §10 |
| `simpleMoreOptions` | `moreOptions` | WY2, RP2 §10 |
| `simpleSendVoice` | `sendVoice` | WY2 §10 |
| `remove` / `cancelRecording` for "Delete recording" | `deleteRecording` | WY1, RP1, WY2, RP2 §10 |
| `simpleSizeKB` | `unitKB` | WY2 §10 |
| `simpleCategoryCount`; placeholder `{count}` | `kbArticleCount` `{n}` | WY2, RP2 §10 |
| `simpleReadTime`, `kbReadMinutes` | `kbReadTime` | WY2, RP2 §10 |
| `simpleSubmitEmail`, `simpleSaveEmail`, `fallbackSubmit` (e-mail card) | `saveEmail` | WY2, RP2, WY1 §10 |
| `typing` | `simpleTyping` | WY1 §10 |
| `homeOfflineTitle`, `homeOfflineNote`, `searchKbOffline` | `homeAwayTitle`, `homeAwayNote`, `searchKbAway` | WY1 §10 |
| `replyFrom` | `homeBackAt` | WY1 §10 |
| `replyFrom` + `replyWithin` `{h}`; placeholder `{sla}` | `awayBannerSub` `{time}` `{replyTime}` | WY1, RP1 §10 |
| `homeReplyFast` for "Replies in minutes"; `newConvReply` | `replyShort`; `homeReplyFast` | RP1 §10 |
| `searchKbPlaceholder` | `searchKbHelp` | WY1 §10 |
| `wyRecentMessage`, `homeRecentMessage` | `wyRecentConversations` | WY1, RP1 §10 |
| `wySendNewMessage`; `wyNewConversation` for "Send us a message" | `wyStartNew` | WY1, RP1 §10 |
| `messageField`, `emojiClose`, `typingName` | `messageLabel`, `emojiPickerClose`, `typingNamed` | RP1 §10 |
| `emojiPicker` for the picker dialog | `emojiDialog` | RP1 §10 |
| `audioPosition` `{cur}`; `playbackSpeed` | `playAudioProgress` `{pos}`; `playbackRate` | WY1, RP1 §10 |
| `justNow` | `timeJustNow` | RP1 §10 |
| `newConvTitle`; `wyTeamOf` `{name}` | `wyTeamOf` `{workspace}` | RP1, WY1 §10 |
| `prechatTitle` for the intro title and the card `aria-label` | `prechatIntroTitle`, `prechatCardLabel` | RP1 §10 |
| `errEmailFormat` | `errEmailIncomplete` | RP1 §10 |
| `stepAskName`, `stepAskEmail`, `stepAskPhone`, `stepProgress`, `stepPhoneHint` | `prechatAskName`, `prechatAskEmail`, `prechatAskPhone`, `prechatStep`, `prechatPhoneHint` | RP1 §10 |
| `stepEmailInvalid`, `stepEmailExample`; "same key, two parts" | `prechatStepEmailInvalid`, `prechatStepEmailExample` | RP1, WY1 §10 |
| `detailsSaved`, `detailsSavedLabel` | `prechatSaved`, `prechatSavedLabel` | RP1 §10 |
| `presenceOfflineEmail`, `offlineBannerTitle` | `statusAwayEmail`, `awayBannerTitle` | WY1 §10 |
| `fallbackIntro` for the automated reply | `awayAutoReply` | WY1 §10 |
| `emailForReply`, `automatedMessage`, `composerLocked`, `kbMostRead` | `fallbackEmailLabel`, `msgAutomated`, `composerLockedPrechat`, `kbPopular` | RP1 §10 |
| `launcherOffline` | `openChatAway` | WY1 §10 |
| placeholders `{position}`, `{eta}` | `routingInQueue` `{n}` `{min}` | RP1 §10 |
| `simpleHello`, `simpleWelcomeBack` | `simpleHomeHi`, `simpleHomeHiReturning` | RP2 §10 |
| `simpleHomeQuestion`, `simpleHomeQuestionOffline` | `simpleHeadline`, `simpleHeadlineAway` | WY2 §10 |
| `simpleOnlineNow` | `simplePresenceOnline` | RP2 §10 |
| `simplePresenceOffline` + reply text | `simpleAwayBackAt` `{time}` | WY2 §10 |
| `simplePresenceOnline` for the welcome block | `simpleWereOnline` | WY2 §10 |
| `simpleOfflineEmailNote`, `simpleStatusOfflineEmail`, `simpleTypeMsgOffline` | `simpleAwayNote`, `simpleAwayStatus`, `simpleAddMore` | WY2 §10 |
| `simpleHelpRowSub`, `simpleHelpRowSubOffline`; placeholders `{count}`, `{topics}` | `simpleHelpSub` `{n}` `{categories}`, `simpleHelpSubAway` | WY2, RP2 §10 |
| `simpleMessageSaved`, `simpleReplyTo`, `simpleTeamTitle` | `simpleMessageRecorded`, `simpleReplyToEmail`, `simpleWelcomeTeam` | RP2 §10 |
| `simpleYouPrefix` | `you` + ": " | RP2 §10 |
| `simpleClearSearch`, `simpleResultsCount`, `simpleCategoriesLabel`, `simpleStillNeedHelp`, `simpleChatWithTeam` | `kbClearSearch`, `kbResultsCount`, `kbTopicsTitle`, `kbStillNeedHelp`, `kbChatWithTeam` | WY2 §10 |
| `wyArticleHelpful` for the Template 2 question | `kbDidThisHelp` | WY2 §10 |
| `simpleOrderTitle`, `simpleOrderShipped`, `simpleOrderStep…`, `orderStatus*`, `simpleOrderDelivery`, `simpleTrackShipment` | `orderTitle`, `orderStatusShipped`, `orderStep…`, `orderArrives`, `orderTrackPackage` | WY2, RP2 §10 |
| `simpleClosedBy`, `simpleCsatTitle` … `simpleCsatComment`, `simpleCsatSubmit`, `simpleEmailTranscript` | `convClosedBy`, `csatTitle` … `csatComment`, `csatSend`, `csatTranscript` | WY2 §10 |
| placeholder `{count}` in `kbResultsCount`, `simpleConversationsSub` | `{n}` | RP2 §10 |

---

## 6. Server names of the late features (issue #340, as built)

The widget calls these only from Core's lazy modules (`public/widget/runtime-ext.js`, `public/widget/runtime-late.js`),
for a template that declares the feature; `default` and `intl` never do.

**Template descriptor** (`shared/widgetTemplates.ts`): `closedNotice` — the renderer draws the `conversation_closed`
line and its rating card (t2 only; must equal the renderer's `features.closedNotice`). The server writes the line only
for a workspace whose **effective** template has it (`server/services/widget/configSnapshot.ts`
`workspaceChatTemplate`: the catalog, the plan, the choice — the same answer `GET /config` gives; a workspace whose
widget settings cannot be read counts as wearing the edition's own `default` / `intl`).

**Renderer features and Core capabilities**: a renderer's `features.closedNotice` keeps `conversation_closed` rows
(runtime.js drops them, before the stores and notify, for a renderer without it); `features.csat` (the rating card,
`view.csat`, §3) and `features.chatMenu` (the ⋯ menu, the header's `menu`, §3) are run by runtime-late.js.
`env.capabilities.csat` and `env.capabilities.chatMenu` are true since the API below exists.

**The closed line** (`server/services/conversationClosedNotice.ts`): when an operator closes a widget conversation
(inbox `PATCH` to `resolved` / `closed`, or "Send & resolve"), one `conversation_messages` row, `sender_type: 'system'`,
body `"<name> closed the conversation"` (frozen English), `metadata` as in §3, published like any message on
`ws:<ws>:conv:<cid>`. Never for another channel, never twice with nothing said in between, never failing the
operator's request. The inbox draws it with `inbox.system.closedBy` / `inbox.system.closed`.

| Endpoint | Body | Answers |
|---|---|---|
| `GET /api/widget/conversations/:id/csat` | — (`workspace_id` in the query) | `{ closed_id, rateable, rating: {score, comment, rated_at} \| null, operator: {name, avatar} \| null, transcript: {available, to} }`; 404 `not_found` for a conversation that is not the visitor's |
| `POST /api/widget/conversations/:id/csat` | `{ workspace_id?, closed_id, rating: 1–5, comment? (≤ 1000) }` | 200 `{ok, rating}`; 400 `invalid_rating`; 403 `csat_disabled` (`code: 'CSAT_DISABLED'`) / `CONVERSATION_ACCESS_DENIED`; 409 `not_ratable` / `already_rated` (+ `rating`); 503 `csat_unavailable` |
| `POST /api/widget/conversations/:id/transcript` | `{ workspace_id?, locale?, tz? }` (never an address) | 200 `{ok, to}` (masked); 403 `transcript_disabled` (`code: 'TRANSCRIPT_DISABLED'`) / `CONVERSATION_ACCESS_DENIED`; 409 `no_email` / `nothing_to_send`; 429 `rate_limited` (+ `retry_after`, `Retry-After`) / `limit_reached` / `workspace_limit`; 502 `send_failed`; 503 `email_unavailable` |

- Each 403 these routes answer carries a `code`: the widget's `fetchWith` (runtime.js) takes a code-less 401/403 for
  an expired token, refreshes it and sends the request again.
- Rating rules: only the closed line the thread ends with (other system rows after it do not count; anything said
  does), within 7 days, once (`conversation_ratings.closed_message_id` unique), only when a human operator answered.
  runtime-late.js picks the card's closed row by the same rule (`lastClosed`), so the card and the server agree on
  which closure is rated (`src/test/widget/afterChatServer.test.ts` runs the shipped widget against the real routes).
- Transcript rules: only to the email on the conversation's contact, only when a human operator answered, with a
  platform email provider; 3 sent per conversation, one per 10 minutes, 100 attempts per workspace a day
  (`conversation_transcript_emails`), plus the widget rate-limit category `transcript` (3 per visitor per 10 minutes,
  `server/services/widget/security.ts`). The mail is the Super Admin template `visitor_conversation_transcript`
  (variables `{brand} {year} {workspace} {workspace_name} {date} {transcript} {transcript_text}`), in the visitor's
  language as the edition allows.
- Timeline events (`conversation_events`): `rated` `{score, comment, closed_id, operator_id, source}` and
  `transcript_emailed` `{status, to (masked), messages, source}`; Operator Activity shows satisfaction per operator from
  `conversation_ratings`.
- Before migration 276 every read answers "nothing to rate" / unavailable and every write 503, never a 500.

**Realtime** (`server/services/realtime/publish.ts`): the visitor's channel `ws:<ws>:conv:<cid>` carries messages
(the closed line included), typing and seen as before, and of the operator `event` envelopes only the kinds listed in
`WIDGET_EVENT_FIELDS`, cut to the fields the widget reads (`call:ended`, `message_reactions`); every other operator event goes to
`ws:<ws>:inbox` only. A new widget-visible kind must be added there with exactly its fields, pinned by a test. The
operator typing envelope is `{actor, conversation_id, ts, name?, avatar?}`: the typing operator's public name and
avatar (as on their messages), never an id, e-mail or role.

**Reactions** (round 3, g2): `shared/messageReactions.ts` holds the rules (the six emojis ❤️ 👍 😂 😮 😢 🙏, who
reacts to what), `server/services/messageReactions.ts` the storage (`conversation_message_reactions`, migration 276:
one row per message, actor and emoji; the visitor side has no id) and the live event. Template descriptor
`reactions` (`shared/widgetTemplates.ts`, t2 only; must equal the renderer's `features.reactions`): the inbox offers
React only for a workspace whose **effective** template has it (`workspaceShowsReactions`), and only on widget
conversations, so an operator never reacts where the visitor cannot see it.

| Endpoint | Body | Answers |
|---|---|---|
| `GET /api/widget/conversations/:id/reactions` | — (`workspace_id`, optional `visitor_id` / `session_id` in the query, as `/history`) | `{ reactions: { <message_id>: [{emoji, count, mine}] }, at }` (only messages that have any; `at` = ms when read); 403 `CONVERSATION_ACCESS_DENIED`; before 276 `{ reactions: {}, at }` |
| `POST /api/widget/conversations/:id/reactions` | `{ workspace_id, message_id, emoji: '❤️', on }` | 200 `{ok, message_id, reactions: [{emoji, count, mine}], at}`; 400 `invalid_payload` / `invalid_emoji` (anything but ❤️; a bare U+2764 counts as ❤️); 403 `CONVERSATION_ACCESS_DENIED`; 404 `message_not_found` (another conversation's, or an inbox-only row); 422 `not_reactable` (not a team message: the visitor's own, a system row); 503 `migration_required` |
| `POST /api/conversations/:id/messages/:messageId/reactions` (inbox) | `{ workspace_id, emoji, on }` (`on: false` also takes back an emoji since dropped from the list) | 200 `{ok, message_id, reactions: [{emoji, count, mine, visitor}], at}`; 400; 401 / 403 (membership, seat or plan lock); 404 `conversation_not_found` / `message_not_found`; 409 `reactions_not_shown`; 422 `reactions_unsupported_channel` / `not_reactable` (only a visitor's message); 503 `migration_required` |
| `GET /api/conversations/:id/messages` (inbox, existing) | — | each row may gain `reactions: [{emoji, count, mine, visitor}]` (only when it has any) and `can_react: true` (a visitor's message this operator may react to); a change touches the message's `updated_at`, so `?since=` returns it |

- A write sets or takes back (`on`), never toggles: a retry changes nothing. A change publishes the operator event
  `message_reactions` `{conversation_id, message_id, reactions: [{emoji, count, visitor}], at}` (the inbox channel
  whole; the visitor's channel cut to these fields by `WIDGET_EVENT_FIELDS`); the widget keeps the newest `at`. No
  answer or event names who reacted; `mine` is the reader's own. GET `/poll`, `/history`, `/identity/history` and
  `POST /message` carry no reactions.

**Queue place** (round 3, g4 f2): `GET /api/widget/queue?workspace_id&conversation_id` (optional `visitor_id` /
`session_id`, ownership as `/history`) → `{ position, wait_minutes }`, two integers or nulls (not waiting: an
operator has it, it is closed, routing never queued it; and before 276); 403 `CONVERSATION_ACCESS_DENIED`. Routing
in assignment mode `manual` (`server/services/chatRouting.ts`) writes `metadata.queued_at` when the conversation
enters the queue (kept while it waits and when an operator hands it back; one older than 24 hours is a new entry)
and `metadata.queue_entry_position`; `chat_queue_status()` (276) counts the place on the partial index (only the rows
that wait: unassigned, open or pending, not spam), since 280b in the conversation's own department's queue (the same
`metadata.department_id`, the one the visitor picked; none counts among none, R-22), and gives the wait only from 3
measured claims and up to 180 minutes. `POST /message` keeps a picked `department_id` only when it is one of the
workspace's enabled chat departments. A **hand-back** (an operator unassigns a queued conversation, or a paused seat is released): 276's trigger
`trg_conversations_queue_return` keeps `queued_at` (the place) and writes `metadata.queue_reentered_at` (when it came
back) and `queue_entry_position` (at which place) in the same UPDATE; the claim sampler measures the next claim from
the later of `queued_at` and `queue_reentered_at`; the next routing run posts a new `routing_in_queue` row, once per
return (`metadata.queue_return_notice_at`), so the visitor's queue pill comes back. The inbox's unassign
(`PATCH /api/conversations/:id` with `assigned_to: null`) runs that routing at once (`rerouteConversation`, after its
internal «unassigned» notice), in every mode since 2026-10-21 (auto and round robin give it to the next operator,
never the one who let it go; manual puts it back in the queue), for a conversation nobody has that the AI will not
answer (one the AI manages again: its next message is the AI's, and a handoff routes it); the visitor's next message
then posts nothing more. The unassign itself applies only while the conversation is still with whoever the panel saw
(409 `assignment_changed` otherwise), so a double-clicked unassign posts one queue row.

**Away thread** (round 3, g4 f3): `POST /api/widget/offline-messages` takes `client_message_id` (8–64 characters;
then any non-empty message up to the 5,000 characters `POST /message` takes, and the contact's stored name, email
and phone without failing on them) and answers `message_id` too; the same id again within 24 hours answers the same
`conversation_id` and `message_id` without a second insert, push or mail. Without the field (the leave-a-message
form) the request is checked and answered exactly as before. `POST /api/widget/identity/offline-email`
`{ workspace_id?, conversation_id, email }` → 200 `{ok, contact_id}`; 400 `Invalid input`; 403
`CONVERSATION_ACCESS_DENIED` (the signed cookie alone); 409 `not_offline_capture` (only a conversation tagged
`offline`: never a way around required pre-chat fields); 500 `merge_failed`. The address is an unverified claim,
merged as pre-chat merges one (never linking to another contact), and the continuity cookie is issued as
`/identity/prechat` does. Step pre-chat uses `/identity/prechat` unchanged.

**Order card** (round 4, g3): the AI's reply about ONE order its commerce tools read live in that turn (WooCommerce:
the latest order with its tracking, or an order by number; OpenCart: one order's detail with the shipments read for
it, never a list) carries `metadata.kind: 'order_status'` and `metadata.order`
`{v: 1, number, summary, more, status, statusLabel, step, arrives, trackingUrl}`
(`server/services/ai-agent/commerce-tools/orderCard.ts`): `number` a plain order number (`[A-Za-z0-9#._-]{1,32}`,
else no card); `summary` the first product line (sanitized, ≤ 80 characters + …) or null, `more` the other product
lines; `status` one of `pending on_hold processing shipped completed cancelled refunded failed unknown` (`shipped`:
processing or unknown with a tracking number or link this turn); `statusLabel` the store's own status name (OpenCart,
≤ 40) or null (WooCommerce); `step` 0–3 (placed · preparing · shipped · delivered; `completed` → 3, all four done) or
null (no progress row: cancelled, refunded, failed, unknown); `arrives` `YYYY-MM-DD` or null; `trackingUrl` an
absolute https link (no credentials, ≤ 500, none of the characters the card never links, `\s " ' < > \\`, left in it
after normalisation) or null: a link the server sends is one the card draws. Only the auto reply's row carries it
(never a handoff, intro, limit or suggestion), built beside the tool results from the same objects: the prompt, the
tool results and the text are what they were, and every other reader (default/intl, the inbox, channels, the apps)
shows the text. Without a card the AI row's metadata is exactly as before. Optional plugin fields (none sent yet):
`item_summary` / `item_count` on the customer's order list and `estimatedDelivery` on tracking. Renderer feature /
capability: `orderCard`.

**Track an order** (round 4, g3): `config.commerce = { trackOrder: true }`, right after `templateOptions`, only for a
template with `coreFeatures` whose workspace has a store the AI can answer "track my order" for
(`configSnapshot.ts` `getStoreOrders` / `trackOrderEntitlementFor`: a store-family connection, not revoked, in a
health the gateway accepts, `orders.read` negotiated, the owner's `orders` permission and, for WooCommerce, order
history on a synced catalogue, for OpenCart the platform policy; the plan's `commerce` and
`commerce_customer_history` (WooCommerce) or `commerce_orders` (OpenCart)); absent otherwise and for `default` /
`intl`, which never read `commerce_connections`. Cached 60 s per workspace (a failed read: false, for 5 s), dropped
by `widget:<ws>`, which a disconnect, a permission change, a pairing and a handshake that changes a store's health
publish. The row (t2 home, `data-home-action="track-order"`) sends «پیگیری سفارشم» / "Track my order" /
"Siparişimi takip et" as the first message; each detects as `order_status`. Renderer feature: `trackOrder`.

**Instant answers** (round 4, g3): `GET /api/widget/kb-suggest?workspace_id&q&locale&limit`
(`server/routes/widgetKbSuggest.ts`, `server/services/knowledge-base/widgetSuggest.ts`), token-secured like every
widget route (the workspace is the token's; another → 403 `WORKSPACE_MISMATCH`), `Cache-Control: no-store` → 200
`{ results: [{ slug, title, snippet, matches: [words], readingMinutes }] }`, at most `limit` (clamped to 1–3,
default 2). Bad input (no `q`, `q` over 200), a draft with nothing to search, no match and a database error all answer
`{ results: [] }`. The draft's words: punctuation, symbols and control characters out, lower-cased as the database folds case («İ» is «i»), no stopwords
(`KB_SUGGEST_STOPWORDS`, fa/en/tr) or one-letter words, the four longest of its first 120 characters; only published
articles shown in the widget (`visible_in_widget`), never one the plan locked; title or summary (never the text); a
word in the title counts 2, in the summary 1, at least 2 to be shown, the conversation's language breaking ties.
`matches` are the searched words the row contains, case folded (the tray marks them, escaped, an «i» also marking
an «İ»); `snippet` up to 120 characters of the summary around the first match, cut at spaces with …; `readingMinutes`
exactly the article view's formula (`kbReadingMinutes` = runtime-ext.js `kbArticleMeta`: tags to spaces, words / 200,
rounded, at least 1; `src/test/widget/commerceKbServer.test.ts` pins both, and the route, on one fixture).
Memos: per (workspace, words) 60 s, only the articles an answer can show for any language and limit, without their
summaries (≤ 2,000 that found something, ≤ 2,000 that found nothing), the reading time per article version (≤ 20,000).
Limits of its own: the widget rate-limit category `kb_suggest` (30 a minute per visitor or per address, 300 per
address; 429 `{code: 'RATE_LIMITED', retry_after}` + `Retry-After`) first, then the process ceiling
`kbSuggestGlobalCeiling` (`WIDGET_KB_SUGGEST_GLOBAL_PER_MIN`, 1800; 429 `{code: 'PREAUTH_GLOBAL_LIMIT', scope:
'kb-suggest', retry_after}`): the help center's `/api/widget/kb/*` limits and this one never spend each other.
Renderer feature / capability: `instantAnswers` (hook `[data-kb-suggest]`, rows `[data-kb-action="open"][data-kb-slug]`).

**Help results** (round 4, g3): `GET /api/widget/kb/search?match=words` (runtime-ext.js `kbSearch`) also gives each
result `snippet` (≤ 160 characters of its summary around the first match) and `matches` (the words its title or
summary contains). Without `match=words` (every help center) the rows are exactly as before. In every help search
(the words, the one phrase without `match=words`, and the help center's page `/help/:locale/search`) a control
character is a space (a NUL failed the database read: no results), and a query of nothing else searches nothing; the
words are lower-cased as ILIKE folds case (`kbSuggestFold`: «İade» finds «İade» and «iade»), the phrase is not
lower-cased (ILIKE folds it). Any other query is searched exactly as before (`widgetSearch.ts`); only the word
search's order changes where an article's title or summary holds «İ»: it is folded too, so «İade politikası» now
counts as a title match for "iade" (it was found before, ranked as if it held no word).

**KB article author** (round 4, g5-2a): `knowledge_base_articles.author_user_id` (migration 276). The widget asks for
it with `meta=1` on `GET /api/widget/kb/article` (runtime-ext.js `kbMeta`, a renderer declaring `kbAuthor`): the
article gains `author_name` (the author's `profiles.full_name`, while they are a member of the workspace, ≤ 80
characters; else null), never `author_user_id`; before 276 the article without a byline, never a 404. Without
`meta=1` the query and the answer are exactly as before. View-model field `article.author`. The dashboard's write API
(`server/routes/knowledgeBase.ts`): `author_user_id` absent on create → the creator (when a member), absent on update
→ unchanged, null → none, any other id must be a member of the workspace (else 400 `invalid_author`); before 276 the
article is saved without it. The AI's article writers name no author. The editor's select
(`src/pages/app/knowledge/ArticleEditorPage.tsx`): keys `knowledgeBase.editor.authorLabel` / `authorNone` /
`authorHint` (fa/en/tr).

**Emoji keywords** (round 4, g5-2c): `config.modules.emoji` (the hashed `runtime-emoji.js`) only for a template with
`coreFeatures`, next to `modules.ext`; Core requests it only when a visitor first uses the picker's search.

**Launcher styles** (round 5, g5-1; every template, the launcher being the loader's): `fab.shape` / `fab.icon` (§1)
as `shared/launcherStyles.ts` resolves them (an unknown icon reads `chat`, an unknown shape or a pill without a text
`circle`; all under the plan capability `widget_launcher_icon`). A pill, or the glyph `bubble`, `duo` or `avatar`,
is a style: `/config` then names the hashed stylesheet as `config.fabStyleUrl` (absent otherwise, so every other
payload is as before), and for `avatar` the agent's letter as `config.fab.initial` (the first character that shows,
never an RLM, a ZWNJ or a lone mark, of the team's first operator's stack name, online first, else of the
workspace's name; `shared/widgetTeam.ts`, the same rule in the dashboard's picker and previews). The loader requests
`runtime-fab.css` into its shadow root (canonical-name retry), keeps the launcher and its card unseen until it is in
(3 s at most), and puts `fx fx-<icon> fx-<shape>` (`fx-off` while the team is away) on the launcher, the pill's text
in `data-fx`, the letter in `data-fi` and `dir` (§2.3). The file only restyles that launcher: inline `data:` SVG masks
of the launcher's colour, the bubble's dots in the kit's second colour on the kit's own ground
(`var(--rpk-kit-accent, var(--lk-kit-dot))`), no font, no host (WIDGET_TEMPLATE_RULES.md §2, §3). The team behind
the stack and the letter is the first four members to join (`workspace_members.created_at`) among those who
receive chats (no staff, no suspended member), online first; one
without a name of their own is «اپراتور» / "Operatör" / "Operator" by the widget's language, never an e-mail.

**System messages in the reader's language** (2026-10-18, every template): a `sender_type: 'system'` row keeps its
stored English body and `metadata.kind`; every reader writes the sentence in its own reader's language, and nothing
stored is rewritten. The kinds and the visitor's part of their metadata are `shared/systemMessages.ts`
(`SYSTEM_MESSAGE_KINDS`, `VISITOR_PREVIEW_SYSTEM_KINDS`, `VISITOR_SYSTEM_META_KEYS`, `visitorSystemPreview`); a new
kind is added there first, and Core, the operator localizer and the native apps are tested against that list.

- `GET /api/widget/conversations`: a row whose preview is a system row also carries `systemKind` and `systemMeta`
  (only `agent_name`, `to_name`, `channel`, `operator_name`, `ended_by`, `end_reason`, `duration_seconds`; names that
  are a stand-in such as 'a colleague', or an e-mail address, are left out). `preview` stays the stored body for a
  runtime loaded before the deploy. A system row the widget cannot write never becomes the preview: the previous row
  the visitor can see does. Every other row has exactly its old keys. A quoted system row (`reply_to`) carries `kind`
  and `meta` the same way (`server/routes/widgetAttachments.ts`).
- Core's `systemRowText(t, locale, kind, meta)` (`public/widget/runtime.js`) writes that sentence wherever a renderer
  does not draw the row itself: the home card and the conversation list of every template, the toast, the
  screen-reader line, the public `message` event and the quote box. A transfer reads as a join naming whoever holds the
  conversation now, a call's duration in the widget's digits. A kind it cannot write gives '': no toast text, no quote
  (a toast for an attachment-only message stays). The thread renderers are unchanged.
- What the visitor receives (`publish.ts` `visitorMessageMetadata`, `/poll`, `/history`, realtime) has no stand-in or
  e-mail as a name. The AI's built-in name 'AI Assistant' (`DEFAULT_AI_AGENT_NAME`) still goes out as stored, there,
  in the intro response and in `/config` `aiAgent.agentName`: a runtime.js loaded before this release labels the AI's
  replies with it, and without a name `default` puts such a reply in one run with the system line under it (no badge,
  no time). Core treats it as no name (`aiOwnName`): in `default` / `intl` it labels a nameless AI reply with its own
  word (`wyAiAssistant`), so the reply keeps its badge and time beside a system line; t1 and t2 show the badge alone
  and t1 the workspace's tile; the toast and the screen-reader line name the workspace. On `/poll` and `/history` a
  name the owner gave the agent since wins over the default a row was stamped with. A later release may stop sending
  the default once no runtime from before this one is served.
- Producers: a join by an operator without a full name stores `agent_name: null` ("A colleague joined the
  conversation."); a call invitation's `operator_name` is the full name only. The owner's per-language texts (the
  hand-over acknowledgement and pre-chat subtitle, the availability labels and offline message, the intro) are used
  only in the visitor's language, else the built-in text. Every error the call widget and the chat's call screen show
  is the widget's own sentence, never the server's or the call engine's English.
- Operators: the dashboard's localizer is `shared/systemMessageText.ts` (`src/lib/systemMessageText.ts` re-exports it)
  and covers every kind; the inbox draws every system row as a notice (`SystemNoticeRow`), never as a bubble. The
  operator APIs (`GET /api/conversations` `last_message.body`, `GET /api/conversations/:id/messages`, `?since`
  included, `GET /api/contacts/:id/conversations` `last_message_body`) return a system row's `body` written in the
  operator's language (`server/services/operatorSystemText.ts`, the server's copy of the dashboard's strings, tested
  equal; the requester card keeps its stored details in a thread), `system_kind`, `system_meta` and `metadata` as
  stored apart from stand-in names, set to null. The operator's language (`server/services/operatorLocale.ts`) is
  `profiles.preferred_locale` when the platform offers it, else the platform's default language, else its first,
  else English; push, the e-mail dispatcher, the transcript and the offline-capture e-mail (each recipient in their
  own) use the same rule, and the top bar's language switch saves `preferred_locale` as Settings → Interface does.
- Not yet everywhere: the native apps' sources have every kind, from their next release; until then an installed app
  shows the English body of a live `conversation_closed`, `support_rating` or requester row until it reads the thread
  again (the server-written body then). A widget loaded before the deploy keeps the English preview until a reload.

**What a visitor never receives**: an operator's account id. Every message a visitor gets — the visitor's channel
(`publishConversationEvent`), `GET /poll`, `/history`, `/identity/history` — goes through
`server/services/realtime/publish.ts` `visitorMessagePayload` / `visitorMessageMetadata`: no `sender_id`, and no
`actor_id`, `agent_id`, `operator_id`, `from_id`, `to_id`, `assigned_to`, `created_by_user_id` or
`ended_by_user_id` in `metadata` (a join, a transfer, the closed line, call rows). The widget shows the names next to
them (`agent_name`, `to_name`, `operator_name`; never a stand-in such as 'a colleague' or an e-mail address; the AI's
built-in name, which Core shows as none: above) and groups bubbles by name and avatar. The inbox channel and every operator API keep the ids.
(An operator's avatar URL is derived from a storage key that names their user id: a storage-layout matter, not
covered here.)

**Per-visitor setting**: the ⋯ menu's sound switch is remembered in the visitor's `localStorage` under
`gs:sound:<workspaceId>` (`'0'` while off, removed when on); nothing about it reaches the server.
