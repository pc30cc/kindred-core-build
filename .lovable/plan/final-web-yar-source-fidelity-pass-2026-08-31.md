# Final Web Yar source-fidelity pass

## Goal

Rebuild the remaining Web Yar surfaces from the uploaded `Web Yar Chat Widget.dc.html` as the sole visual source, while preserving every Core capability and making Preview and customer embeds consume the same assets, normalized data, renderer markup, and geometry.

## Implementation

### 1. Lock the production canvas and font pipeline

- Change the desktop panel to exactly `420×680`, `max-width: calc(100vw - 24px)`, and `max-height: calc(100dvh - 118px)`; retain the existing 56px launcher, 24px edge, 14px gap, and current mobile breakpoint behavior.
- Expand the settings preview column/frame to at least a 500×820 usable desktop viewport so production max constraints do not shrink the panel.
- Restore the source font mapping exactly: IRANSans 400, 500, Bold file at both 600 and 700; Inter Medium at 500. Ensure all Persian text and form controls inherit IRANSans.
- Add a shared presentation font-ready gate used by both loader and preview: load IRANSans 400/500/600 via `document.fonts.load`, race against a 500ms timeout, and reveal/open safely even if loading fails or the API is unavailable.
- Add explicit `woff2`/`woff` MIME mappings under `/widget/*` while retaining cross-origin CORS/CORP headers.

### 2. Reconstruct Web Yar presentation surfaces from the source

- **Chat/composer:** remove the headset/escalate button and unused presentation icon only; keep Core escalation optional and preserve offer-card/routing/handoff flows. Render only conditional emoji picker, reply preview, and the single input pill containing conditional mic, textarea, attachment, emoji, and conditional unfilled send icon. Apply the exact dimensions, ring, spacing, colors, and states from the source.
- **Articles:** rebuild the header and list using the exact source paddings, 44px identity avatar, 15/12 typography, 6px list gap/logical inset, and plain title/chevron rows. Do not render search, category, snippet, or decorative icons on this screen; continue using real KB data.
- **Article detail:** rebuild the 36px identity header, 20px body, 14px/1.9 article typography, and border-top-only centered feedback area. Preserve persisted `kb_article_feedback`; implement exact up/down selected states, confirmation copy, and down-vote-only support CTA.
- **Pre-chat:** replace the generic form chrome with the exact full-screen source layout. Remove field icons, extra inline padding, privacy/helper UI, and unrelated decoration; retain authoritative asked/required field logic, LTR email/phone direction, validation, and submission behavior.
- Audit Home and Conversation List against the uploaded source during the same pass so the final six-surface acceptance table has no unreviewed surface.

### 3. Make Preview and Live share identity and view-model normalization

- Replace ambiguous preview `brandName` usage with explicit `workspaceName` and `platformName`; workspace identity controls headers/avatar fallback, platform identity controls powered-by only.
- Pass the complete workspace member collection and online state into preview instead of synthesizing one operator. Normalize names, avatars, and presence through one shared browser-safe view-model helper used by both runtime and preview.
- Include `replyTimeText` in preview config with the same locale fallback as production.
- Route preview article opening through `R.kbHtml(articleVm)`, matching production’s full article surface.
- Consolidate equal-input normalization for workspace identity/logo, platform identity, reply time, locale/RTL, team/presence, KB, pre-chat requirements, and attachment/emoji/voice flags. Keep transport and event binding environment-specific.

### 4. Regression and parity contracts

- Update the design-contract tests for 420×680 geometry, the exact 600 font face, all-control inheritance, source composer DOM, zero `data-escalate-btn`, Articles, Article feedback, and Pre-chat geometry/content.
- Add same-input parity fixtures asserting Preview renderer DOM equals Runtime renderer DOM for Home, Chat, Pre-chat, Articles, and Article detail; include Conversation List in visual/computed verification.
- Keep explicit assertions that AI, handoff, routing, departments, realtime, multi-conversation, unread, reply, attachments, voice, emoji, calls, pre-chat rules, contact fallback, KB data/feedback, and smart engagement hooks remain wired.

### 5. Browser acceptance and evidence

- Render production loader and `WidgetLivePreview` at the same 500×820 viewport and capture each surface: Home, Chat, Pre-chat, Articles, Article, Conversation List.
- Compare screenshots and collect computed panel/header/avatar/body/composer/article/form dimensions and typography from both environments.
- For both Preview and a real customer-style host page, record all three IRANSans request URLs, HTTP 200, `Content-Type: font/woff2`, `document.fonts.check()` for 400/500/600, and matching loaded `FontFace` entries; verify actual Persian sample glyph readiness rather than only the computed family string.
- Run focused widget tests plus the project build signal, then report a table: `Surface | Source spec | Live computed | Preview computed | Match?`. Explicitly list any remaining mismatch instead of claiming completion.

## Technical boundaries

- Presentation changes stay in the Web Yar renderer/CSS; Core business capabilities are not removed.
- Runtime queries for the removed composer escalation element remain nullable/optional.
- No Supabase Edge Functions or hidden Edge Function dependency will be introduced.
- No database/backend behavior changes are planned beyond preserving existing KB feedback and widget configuration contracts. 
- پلن را تأیید می‌کنم، فقط قبل از اجرا یک اصلاح معماری مهم بده:
  بخش font-ready gate نباید loader.js یا Widget Core را به IRANSans/Web Yar وابسته کند.
  Loader نباید اسم IRANSans، weightهای آن یا font URLهای Web Yar را بشناسد.
  Font readiness باید Presentation-owned باشد. یکی از این روش‌های generic را استفاده کن:
  ترجیحاً Presentation contract یک optional hook مثل ready() / prepare() داشته باشد؛
  presentation-web-yar.js داخل همان hook، IRANSans 400/500/600 را با document.fonts.load() و timeout 500ms آماده کند؛
  Loader فقط اگر Presentation دارای hook عمومی readiness بود آن را await کند، بدون هیچ knowledge از font/template؛
  WidgetLivePreview هم دقیقاً همان Presentation readiness hook را اجرا کند.
  در آینده template دیگری ممکن است فونت دیگری داشته باشد یا اصلاً font preload نخواهد، بنابراین هیچ if web-yar و هیچ IRANSans در Core/Loader نباید اضافه شود.
  همچنین در acceptance صریحاً ثبت کن که افزایش panel از 380×600 فایل اصلی به 420×680 یک intentional product override به درخواست من است؛ بقیه typography/components باید از source بدون proportional scaling باقی بمانند.
  یک نکته دیگر در Preview parity:  
  DOM equality را بعد از حذف/normalize کردن attributeهای volatile/runtime-only بسنج؛ هیچ behavior یا runtime attribute لازم را فقط برای پاس شدن test حذف نکن.
  با این سه اصلاح، بقیه پلن را دقیقاً اجرا کن.