# WebYar + Respok call-center widget · design handoff for implementation

<div dir="rtl">

## راهنمای فارسی

این بسته طراحی **ویجت کال‌سنتر** (تماس صوتی، تماس تصویری و درخواست تماس) وب‌یار و ری‌اسپوک است، آماده برای اینکه
Claude Code آن را روی سایت پیاده‌سازی کند. ویجت چت بسته جداگانه‌ی خودش را دارد و در این بسته نیست.

### چه چیزی داخل بسته است

| پوشه | محتوا |
|---|---|
| `CLAUDE_CODE_BRIEF.md` | دستورالعمل اصلی پیاده‌سازی برای Claude Code: معماری، قاب و جایگاه ویجت، رنگ و فونت، حالت‌های تماس، ترتیب کار، چک‌لیست تحویل |
| `webyar/` | وب‌یار، فارسی و راست‌به‌چپ. `README.md` همین پوشه شناسنامه برند است |
| `webyar/template-1-call-center/` | طراحی کال‌سنتر وب‌یار: ۱۲ بورد و ۲۳ صفحه‌ی شماره‌دار |
| `respok/` | ری‌اسپوک، انگلیسی و چپ‌به‌راست، با همان طراحی در `template-1-call-center/` |
| `shared/` | نقشه‌ی کد فعلی ویجت کال‌سنتر روی سایت (`production-map.md`)، فهرست یکسان نام‌های تازه، فونت‌ها و مجوزشان، لوگوها، آیکون‌های تماس |

داخل پوشه هر طراحی:

| فایل یا پوشه | چیست |
|---|---|
| `README.md` | مشخصات کامل و دقیق پیاده‌سازی: فهرست صفحه‌ها، اندازه‌ها، رنگ‌ها، فونت‌ها، اجزا، همه‌ی حالت‌های تماس، حرکت‌ها، راست‌به‌چپ، دسترس‌پذیری، متن‌ها، و اینکه هر صفحه با کدام حالت و کدام بخش کد فعلی ویجت جور می‌شود |
| `tokens.json` | همه‌ی توکن‌های طراحی با مقدار دقیق، به‌همراه سه اندازه‌ی گوشه (کوچک، متوسط، بزرگ) |
| `source/` | فایل‌های اصلی بوردها (کد طراحی) |
| `reference/` | نسخه HTML و CSS هر بورد که مستقیم در مرورگر باز می‌شود، با فونت‌ها؛ نمونه‌ی زنده در چند حالت (باز، صف، تماس، کوچک‌شده، امتیاز) |
| `screens/panels/` | عکس تک‌تک صفحه‌ها، دکمه‌ها، جایگاه‌ها و حالت‌ها با کیفیت دوبرابر: معیار تحویل کار |
| `screens/boards/`، `screens/states/` | عکس کل بوردها و حالت‌های نمونه‌ی زنده |

### چطور به Claude Code بدهید

۱. کل این پوشه را داخل ریپوی پروژه کپی کنید، مثلاً در `docs/call-widget-handoff/`.

۲. به Claude Code بگویید:

```
Read docs/call-widget-handoff/CLAUDE_CODE_BRIEF.md, then shared/production-map.md and
webyar/template-1-call-center/README.md. Implement the WebYar call-center design (call widget template `default`)
following the brief's order of work. Keep the engine's states, intents and media hooks. After each step, compare the
widget with the PNGs in webyar/template-1-call-center/screens/panels at 2x and fix differences before moving on.
```

۳. بعد همین کار را برای `respok/template-1-call-center` (قالب `intl`) تکرار کنید.

</div>

---

## English

This package hands the new **call-center widget** designs (voice call, video call, callback request) for WebYar
(Persian, RTL) and Respok (English, LTR) to Claude Code for implementation. The chat widget has its own package.

**Start here:** [`CLAUDE_CODE_BRIEF.md`](CLAUDE_CODE_BRIEF.md).

| Folder | Contents |
|---|---|
| [`CLAUDE_CODE_BRIEF.md`](CLAUDE_CODE_BRIEF.md) | Master implementation brief: architecture, frame and placement, accent and fonts, call states, behaviour rules, order of work, acceptance, known issues |
| [`shared/`](shared/README.md) | [`production-map.md`](shared/production-map.md) (how today's call widget is built), [`new-hooks-and-settings.md`](shared/new-hooks-and-settings.md) (one name per new concept), [`fonts/`](shared/fonts/), [`brand/`](shared/brand/), [`icons/`](shared/icons/README.md) |
| [`webyar/`](webyar/README.md) | WebYar brand sheet + [the call-center design](webyar/template-1-call-center/README.md) (12 boards, screens 01–23) |
| [`respok/`](respok/README.md) | Respok brand sheet + [the call-center design](respok/template-1-call-center/README.md) (12 boards, screens 01–23) |

Each design folder holds `README.md` (the full spec), `tokens.json`, `source/` (design source files), `reference/`
(static HTML/CSS renders with fonts, open in Chrome; the live prototype also in six states and four launcher styles),
and `screens/` (`panels/` = every screen, launcher, placement and state card at 2x, the acceptance target; `boards/` and
`states/` at 1x).

Suggested first prompt for Claude Code, after copying this folder into the repository (for example to
`docs/call-widget-handoff/`):

```
Read docs/call-widget-handoff/CLAUDE_CODE_BRIEF.md, then shared/production-map.md and
webyar/template-1-call-center/README.md. Implement the WebYar call-center design (call widget template `default`)
following the brief's order of work. Keep the engine's states, intents and media hooks. After each step, compare the
widget with the PNGs in webyar/template-1-call-center/screens/panels at 2x and fix differences before moving on.
```

Fonts (Vazirmatn, Figtree, DM Mono) are SIL OFL 1.1 and may be bundled; see
[`shared/fonts/LICENSES.md`](shared/fonts/LICENSES.md).
