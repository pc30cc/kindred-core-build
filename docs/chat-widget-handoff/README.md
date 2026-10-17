# WebYar + Respok chat widget · design handoff for implementation

<div dir="rtl">

## راهنمای فارسی

این بسته طراحی‌های **ویجت چت** وب‌یار و ری‌اسپوک است، آماده برای اینکه Claude Code آن‌ها را روی سایت پیاده‌سازی کند.
**ویجت کال سنتر در این بسته نیست.**

### چه چیزی داخل بسته است

| پوشه | محتوا |
|---|---|
| `CLAUDE_CODE_BRIEF.md` | دستورالعمل اصلی پیاده‌سازی برای Claude Code: معماری، اندازه پنل، رنگ و فونت، ترتیب کار، چک‌لیست تحویل |
| `webyar/` | وب‌یار، فارسی و راست‌به‌چپ. `README.md` همین پوشه شناسنامه برند است |
| `webyar/template-1-classic/` | قالب ۱ «کلاسیک»: خانه با هدر رنگی و کارت‌ها، منوی پایین (خانه / پیام‌ها / راهنما). ۱۳ بورد |
| `webyar/template-2-simple-home/` | قالب ۲ «خانه ساده»: بدون منوی پایین، کادر پرسش روی صفحه خانه. ۶ بورد |
| `respok/` | ری‌اسپوک، انگلیسی و چپ‌به‌راست، با همان دو قالب (`template-1-classic/`، `template-2-simple-home/`) |
| `shared/` | نقشه ویجت فعلی سایت (`production-map.md`)، فونت‌ها و مجوزشان، لوگوها و آیکون‌های برند |

داخل پوشه هر طراحی:

| فایل یا پوشه | چیست |
|---|---|
| `README.md` | مشخصات کامل و دقیق پیاده‌سازی: فهرست صفحه‌ها، اندازه‌ها، رنگ‌ها، فونت‌ها، اجزا، حالت‌ها، حرکت‌ها، راست‌به‌چپ، دسترس‌پذیری، متن‌ها، و اینکه هر صفحه با کدام بخش کد فعلی ویجت جور می‌شود |
| `tokens.json` | همه توکن‌های طراحی با مقدار دقیق |
| `source/` | فایل‌های اصلی بوردها (کد طراحی) |
| `reference/` | نسخه HTML و CSS هر بورد که مستقیم در مرورگر باز می‌شود، با فونت‌ها |
| `screens/panels/` | عکس تک‌تک صفحه‌ها با کیفیت دوبرابر: معیار تحویل کار |
| `screens/boards/`، `screens/states/` | عکس کل بوردها، و حالت‌های دیگر بوردهای تعاملی (باز، خوش‌آمدگویی، پنل شکلک) |

### چطور به Claude Code بدهید

۱. کل این پوشه را داخل ریپوی پروژه ویجت کپی کنید، مثلاً در `docs/chat-widget-handoff/`.

۲. به Claude Code بگویید (انگلیسی یا فارسی):

```
Read docs/chat-widget-handoff/CLAUDE_CODE_BRIEF.md, then shared/production-map.md and
webyar/template-1-classic/README.md. Implement WebYar Template 1 (template id `default`) following the brief's
order of work (§8). Keep every data-* hook. After each step, compare the widget with the PNGs in
webyar/template-1-classic/screens/panels at 2x and fix differences before moving on.
```

۳. بعد از تمام شدن هر قالب، همین را برای بعدی تکرار کنید: `respok/template-1-classic` (قالب `intl`)، سپس قالب ۲
هر دو برند (`simple` و `simple-intl`).

### تصمیم‌هایی که در بسته گرفته شده (اگر نظر دیگری دارید به Claude Code بگویید)

- قالب ۱ جای ظاهر فعلی ویجت را می‌گیرد (همان شناسه‌های `default` و `intl`)؛ قالب ۲ با شناسه‌های تازه `simple` و
  `simple-intl` اضافه می‌شود و برای هر سایت قابل انتخاب است.
- اندازه پنل دسکتاپ مطابق طراحی ۴۰۰ × ۷۲۰ می‌شود (الان ۴۲۰ × ۶۸۰ است).
- دکمه شناور همان کیت فعلی وب‌یار و ری‌اسپوک می‌ماند؛ فقط چیزهای تازه بوردها (حباب خوش‌آمدگویی، مدل‌های دکمه،
  زمان‌بندی باز و بسته شدن) اضافه می‌شود.
- لوگوی ری‌اسپوک دو جهت دارد (Open و Thread). پیش‌فرض **Thread** گذاشته شده چون دکمه شناور فعلی سایت Thread است؛
  هر دو پیاده‌سازی می‌شوند و با یک تنظیم عوض می‌شوند.
- دو بورد «فرم پیش از گفتگو داخل چت» و «دکمه شناور + رنگ» با نسخه درستشان در بسته آمده‌اند (روی بوم، عنوان یکی
  به اشتباه به دیگری منتقل شده بود).

</div>

---

## English

This package hands the new **chat widget** designs for WebYar (Persian, RTL) and Respok (English, LTR) to Claude Code
for implementation. The call-center widget is not included.

**Start here:** [`CLAUDE_CODE_BRIEF.md`](CLAUDE_CODE_BRIEF.md).

| Folder | Contents |
|---|---|
| [`CLAUDE_CODE_BRIEF.md`](CLAUDE_CODE_BRIEF.md) | Master implementation brief: architecture, frame, accent and fonts, behaviour rules, order of work, acceptance, known issues |
| [`shared/`](shared/) | [`production-map.md`](shared/production-map.md) (how today's widget is built: markup, hooks, state classes), [`fonts/`](shared/fonts/) with licences, [`brand/`](shared/brand/) SVGs and the Respok kit tokens |
| [`webyar/`](webyar/README.md) | WebYar brand sheet + [Template 1 · Classic](webyar/template-1-classic/README.md) (13 boards) + [Template 2 · Simple home](webyar/template-2-simple-home/README.md) (6 boards) |
| [`respok/`](respok/README.md) | Respok brand sheet + [Template 1 · Classic](respok/template-1-classic/README.md) (13 boards, Open and Thread screenshots) + [Template 2 · Simple home](respok/template-2-simple-home/README.md) (6 boards) |

Each design folder holds `README.md` (the full spec), `tokens.json`, `source/` (design source files), `reference/`
(static HTML/CSS renders with fonts, open in Chrome), and `screens/` (`panels/` = every screen at 2x, the acceptance
target; `boards/` and `states/` for context and interactive states).

| Design | Template id (brief §3) | Screens (2x crops) | Spec |
|---|---|---|---|
| WebYar · Template 1 | `default` | 27 | [README](webyar/template-1-classic/README.md) |
| WebYar · Template 2 | `simple` (new) | 14 + the live prototype | [README](webyar/template-2-simple-home/README.md) |
| Respok · Template 1 | `intl` | 30 with the Open logo + 27 with the Thread logo (default), + the live overview | [README](respok/template-1-classic/README.md) |
| Respok · Template 2 | `simple-intl` (new) | 14 + the live prototype | [README](respok/template-2-simple-home/README.md) |

Suggested first prompt for Claude Code, after copying this folder into the widget repository (for example to
`docs/chat-widget-handoff/`):

```
Read docs/chat-widget-handoff/CLAUDE_CODE_BRIEF.md, then shared/production-map.md and
webyar/template-1-classic/README.md. Implement WebYar Template 1 (template id `default`) following the brief's
order of work (§8). Keep every data-* hook. After each step, compare the widget with the PNGs in
webyar/template-1-classic/screens/panels at 2x and fix differences before moving on.
```

Fonts (Vazirmatn, Figtree, DM Mono) are SIL OFL 1.1 and may be bundled with the widget; see
[`shared/fonts/LICENSES.md`](shared/fonts/LICENSES.md).
