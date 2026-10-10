# انتشار نسخه‌ی جدید اپ ویندوز (Releasing the Windows app)

> **English summary.** One source, two apps: WebYar and RESPOK
> (`-p:Brand=Webyar|Respok`, `Directory.Build.props`, `src/Webyar.Core/Config/Brand.cs`).
> **Every merge to `main` that changes `windows-native/` or `macos/` builds,
> tests and publishes both**, as `<Major>.<Minor>.<count>` (Major.Minor from
> `<Version>` in `Directory.Build.props`, count = the commits on `main`'s
> first-parent line; the Mac apps of the same commit get the same version): WebYar to
> `pc30cc/webyar-desktop-releases` (secret `DESKTOP_RELEASES_TOKEN`), RESPOK to
> `pc30cc/respok-releases` (secret `RESPOK_RELEASES_TOKEN`). The workflow run
> on `main` with `publish_now` publishes the same way without a merge. There
> are no hand-picked numbers: a new Major.Minor is a `<Version>` bump in a merge. Within 5 minutes the downloads host
> mirrors each onto its own site (`https://app.webyar.ai/downloads/`,
> `https://app.respok.app/downloads/`: installer and update feed; section 5),
> and installed apps pick it up from there by themselves.

## ۰. دو برند از یک کد

- اپ ویندوز از یک کد دو برنامه‌ی جدا می‌سازد: **وب‌یار** (پیش‌فرض، دقیقاً مثل قبل) و **RESPOK** (`-p:Brand=Respok`).
- هر کدام نام، آیکون، فایل اجرایی (`Webyar.exe` / `Respok.exe`)، پوشه‌ی نصب و داده (`WebyarWindows` / `RespokWindows`)، سرور (`api.webyar.ai` / `api.respok.app`) و فید آپدیت خودش را دارد؛ هر دو روی یک کامپیوتر کنار هم نصب می‌شوند.
- متن‌ها مشترک‌اند؛ هر خطی که نام محصول را دارد، برای RESPOK در `src/Webyar.Core/Localization/strings.respok.json` آمده است (تست‌ها اجازه نمی‌دهند خطی با نام وب‌یار در RESPOK بماند). متن جدیدی که نام محصول را دارد، نسخه‌ی RESPOK اش را هم در همان فایل بگذارید.
- آیکون‌ها: `src/Webyar.App/Assets/Brand/<Brand>/` (`icon.png`، `app.ico`، `app-calls.ico`)؛ آیکون‌های RESPOK از کیت برند (Thread / Signal)، همان که سایت respok.app دارد.
- هر اپ فقط به فید برند خودش اعتماد می‌کند. سوپر ادمین هر سایت فید همان برند را نشان می‌دهد؛ اگر در دیتابیس RESPOK هنوز فید وب‌یار باشد، سرور آن را به فید RESPOK تبدیل می‌کند (`shared/nativeAppBrands.ts`).

این راهنما می‌گوید نسخه‌ی جدید اپ ویندوز چطور منتشر می‌شود و اپ‌های نصب‌شده چطور خودشان را آپدیت می‌کنند.

---

## ۱. آپدیت خودکار چطور کار می‌کند

- **فید آپدیت روی سایت است:** `https://app.webyar.ai/downloads/windows`. اپ‌های ۲.۶.۱ به بعد آپدیت را از همین‌جا می‌گیرند، حتی وقتی در سوپر ادمین آدرس گیت‌هاب نوشته شده باشد (محتوا یکی است). فقط کانال `beta` هنوز مستقیم از گیت‌هاب می‌خواند.
- **انبار ساخت:** CI هر نسخه را در مخزن عمومی
  [`pc30cc/webyar-desktop-releases`](https://github.com/pc30cc/webyar-desktop-releases)
  می‌گذارد و سرور سایت هر ۵ دقیقه نسخه‌های جدید را از آن‌جا روی سایت کپی می‌کند (بخش ۵). هر نسخه یک GitHub Release است با تگ `v<نسخه>` (نسخه‌ها تا ۲.۵.۰ با تگ `native-v<نسخه>`). CI این تگ را خودش می‌سازد.
  اپ‌های نصب‌شده شماره‌ی نسخه را از همین تگ می‌خوانند. اپ‌های تا ۲.۵.۰ فقط تگی را می‌فهمند که خودِ نسخه باشد (با یک `v` در ابتدا).
- **تنظیمات در سوپر ادمین:** بخش «Windows app» در سوپر ادمین (جدول `desktop_app_settings`) این‌ها را تعیین می‌کند:
  - آدرس فید (`update_feed_url`)
  - کانال `stable` یا `beta`
  - روشن یا خاموش بودن آپدیت خودکار (`auto_update_enabled`)
  - فاصله‌ی چک کردن (`update_check_interval_minutes`، الان ۲۴۰ دقیقه)
  - حداقل نسخه‌ی مجاز
- **فید باید مورد اعتماد باشد:** اپ فقط از فیدهایی که در خود build مجازند آپدیت می‌گیرد
  (`src/Webyar.Core/Config/UpdateFeeds.cs`). اگر در سوپر ادمین آدرس دیگری گذاشته شود، آپدیت خودکار خاموش می‌شود.
- **نصب برای هر کاربر، مثل Slack و Discord** (از ۲.۵.۲؛ `src/Webyar.App/Services/UpdateService.cs`):
  - `Webyar-Setup.exe` برنامه را بدون اجازه‌ی مدیر در `%LOCALAPPDATA%\Programs\Webyar` نصب می‌کند (مثل VS Code). کش برنامه جدا در `%LOCALAPPDATA%\WebyarWindows` می‌ماند. درونش setup خود Velopack است که بی‌صدا اجرا می‌شود. برنامه در منوی Start، دسکتاپ و «Apps & features» قرار می‌گیرد.
  - اپ خودش آپدیت را از روی `releases.win.json` دانلود می‌کند؛ اگر بشود فقط تغییرات را (delta).
  - با «راه‌اندازی مجدد و به‌روزرسانی»، برنامه یک لحظه بسته و با نسخه‌ی جدید باز می‌شود. پنجره‌ی اجازه‌ی ویندوز هم نمی‌آید.
  - تنظیمات و ورود کاربر در `%APPDATA%\WebyarWindows` است و با نصب، آپدیت یا حذف دست نمی‌خورد.
- **نصب‌های قدیمی در `C:\Program Files\Webyar`** (نسخه‌های ۲.۲ تا ۲.۵.۱):
  - اپ قدیمی `Webyar-Setup.exe` نسخه‌ی جدید را از ریلیزها می‌گیرد و اجرا می‌کند. ویندوز یک بار اجازه می‌خواهد.
  - نصب‌کننده برنامه را به نصب کاربر منتقل می‌کند و نسخه‌ی Program Files را پاک می‌کند.
  - از آن به بعد آپدیت‌ها بدون سؤال و درجا انجام می‌شوند.
- **زمان چک:** اولین چک ۱۵ ثانیه بعد از باز شدن اپ است و بعد از آن طبق فاصله‌ی تعیین‌شده در سوپر ادمین.
- **قاعده‌ی مهم:** آپدیت فقط وقتی انجام می‌شود که شماره‌ی نسخه‌ی منتشرشده **بزرگ‌تر** از نسخه‌ی نصب‌شده باشد.

## ۲. پیش‌نیازها (فقط یک بار)

1. **secret به نام `DESKTOP_RELEASES_TOKEN`** (برای وب‌یار؛ برای RESPOK همین کار با `RESPOK_RELEASES_TOKEN` روی مخزن `pc30cc/respok-releases`) در
   `kindred-core-build` → Settings → Secrets and variables → Actions.
   مقدارش یک *fine-grained personal access token* است:
   - Repository access: فقط `pc30cc/webyar-desktop-releases`
   - Permissions → **Contents: Read and write**
   - وقتی توکن منقضی شد، همین را تمدید یا دوباره بسازید. بدون آن، مرحله‌ی «Publish release» با خطای
     `DESKTOP_RELEASES_TOKEN is not set` متوقف می‌شود.
2. **مخزن `webyar-desktop-releases` حداقل یک commit داشته باشد** (مثلاً یک `README.md`).
   در مخزن خالی GitHub نمی‌تواند تگ بسازد، پس ریلیز به‌صورت **draft** می‌ماند. اپ‌های نصب‌شده draft را نمی‌بینند.
3. در سوپر ادمین آپدیت خودکار روشن باشد و آدرس فید یکی از این‌ها باشد:
   `https://app.webyar.ai/downloads/windows` (پیشنهادی، از ۲.۶.۱)،
   `https://github.com/pc30cc/webyar-desktop-releases` یا
   `https://github.com/pc30cc/webyar-desktop-releases/releases/latest/download`.
   اپ‌های قدیمی‌تر از ۲.۶.۱ آدرس سایت را نمی‌شناسند؛ تا وقتی همه آپدیت نشده‌اند آدرس گیت‌هاب را نگه دارید.

## ۳. مراحل انتشار هر نسخه

**راه اصلی: خودکار.** هر مرجی به `main` که چیزی در `windows-native/` را تغییر دهد، هر دو برند را تست، build و منتشر می‌کند. شماره‌ی نسخه `<Major>.<Minor>.<شماره‌ی اجرای workflow>` است (Major و Minor از `<Version>` در `Directory.Build.props`)، پس همیشه بزرگ‌تر از قبلی است. کار دیگری لازم نیست.

- برای امکانات بزرگ، رقم وسط `<Version>` را در همان PR بالا ببرید (مثلاً ۲.۷.۰ → ۲.۸.۰).
- اگر توکن یک برند تنظیم نشده باشد، آن برند build می‌شود ولی منتشر نمی‌شود و در خلاصه‌ی اجرا هشدار می‌آید؛ برند دیگر منتشر می‌شود.

**انتشار بدون مرج (اختیاری):** Actions → **Windows app (native)** → «Run workflow»، شاخه‌ی `main`، تیک
`publish_now`. همان کار مرج را می‌کند و شماره را هم خودش می‌گذارد (مثلاً بعد از رفع مشکل توکن).

- شماره‌ی دستی (تگ `native-v…` یا `release_version`) دیگر وجود ندارد: شماره‌ای که دستی انتخاب شود ممکن است از نسخه‌های خودکار کمتر باشد، یا آن‌قدر بیشتر که نسخه‌های بعدی هیچ‌وقت به اپ‌های نصب‌شده نرسند.

**هر اجرا:**

1. **CI همه‌چیز را انجام می‌دهد.** workflow به نام **Windows app (native)**
   (`.github/workflows/desktop-native.yml`) برای هر برند جدا: تست‌های Core، build، بسته‌ی Velopack و نصب‌کننده (`Webyar-Setup.exe` / `RESPOK-Setup.exe`)، و انتشار در مخزن ریلیز همان برند.
2. **بررسی کنید.** در
   <https://github.com/pc30cc/webyar-desktop-releases/releases> و
   <https://github.com/pc30cc/respok-releases/releases>
   ریلیز جدید باید نصب‌کننده، `releases.win.json` و فایل‌های `.nupkg` را داشته باشد.
3. **حداکثر ۵ دقیقه بعد نسخه روی هر دو سایت است** (بخش ۵).

## ۴. اگر مشکلی پیش آمد

| مشکل | کار لازم |
|---|---|
| مرحله‌ی «Test Core» شکست خورد | باگ را رفع و مرج کنید؛ مرج بعدی با شماره‌ی بعدی منتشر می‌شود. |
| هشدار «built but not published» (توکن یک برند تنظیم نیست) یا خطای دسترسی | توکن را بسازید یا تمدید کنید (بخش ۲). بعد Actions → **Windows app (native)** → «Run workflow» روی `main` با تیک `publish_now` (شماره‌ی تازه می‌گیرد و هر دو برند را منتشر می‌کند)، یا در صفحه‌ی همان اجرا فقط job همان برند را دوباره اجرا کنید («Re-run this job»). «Re-run all jobs» نزنید: شماره همان می‌ماند و برندی که منتشر شده شکست می‌خورد. |
| ریلیز در `webyar-desktop-releases` به‌صورت **Draft** مانده (آدرسش `untagged-…` است)، یا مرحله‌ی «Publish release» با `The release is still a draft` متوقف شد | مخزن ریلیزها commit ندارد. یک `README.md` به آن اضافه کنید (الان دارد). بعد یا draft را باز کنید و «Publish release» را بزنید، یا در Actions → **Windows app (native)** → «Run workflow» در فیلد `publish_tag` تگ را بنویسید (مثلاً `v2.5.1`) تا بدون build دوباره منتشرش کند. نسخه و تگ جدید لازم نیست. |
| jobها در چند ثانیه fail شدند و runner نگرفتند | مشکل GitHub است؛ یک بار «Re-run» بزنید. |
| اپ آپدیت نمی‌شود | ۱) نسخه‌ی منتشرشده از نسخه‌ی نصب‌شده بزرگ‌تر باشد؛ ۲) در سوپر ادمین آپدیت خودکار روشن و فید درست باشد؛ ۳) اپ با `Webyar-Setup.exe` نصب شده باشد، نه کپی دستی یا portable. |

## ۵. انتشار روی سایت (`app.webyar.ai/downloads` و `app.respok.app/downloads`)

همه‌چیز از سرور production (`vps-50cc1602`) سرو می‌شود و **خودکار** است:

| | وب‌یار | RESPOK |
|---|---|---|
| دانلود ویندوز (آخرین نسخه، zip حاوی نصب‌کننده) | `https://app.webyar.ai/downloads/Webyar-Windows.zip` | `https://app.respok.app/downloads/RESPOK-Windows.zip` |
| دانلود مک (آخرین نسخه، zip حاوی DMG) | `https://app.webyar.ai/downloads/Webyar-Mac.zip` | `https://app.respok.app/downloads/RESPOK-Mac.zip` |
| فید آپدیت اپ‌ها | `https://app.webyar.ai/downloads/windows` | `https://app.respok.app/downloads/windows` |

اسکریپت `/data/app-downloads/sync-downloads.sh` با تایمر systemd به نام `app-downloads-sync` هر ۵ دقیقه
ریلیزهای جدید هر برند را روی سایت همان برند کپی می‌کند (نسخه‌ی مک هم همین‌طور). سایت فایل‌ها را فقط به‌صورت zip می‌دهد؛
لینک‌های قدیمی `Webyar-Setup.exe` و `Webyar-Mac.dmg` (و `RESPOK-…`) به همان zip هدایت می‌شوند. برای اجرای فوری روی سرور:

```sh
systemctl start app-downloads-sync
journalctl -u app-downloads-sync -n 20
```

جزئیات راه‌اندازی در `deploy/app-downloads/README.md` است.

## ۶. نصب اولیه روی یک کامپیوتر

- `Webyar-Windows.zip` را از `app.webyar.ai/downloads` بگیرید، باز کنید و `Webyar-Setup.exe` درونش را اجرا کنید (یا همان فایل را از صفحه‌ی ریلیز). اجازه‌ی مدیر لازم نیست. برنامه برای همان کاربر نصب می‌شود و در منوی Start، دسکتاپ (اختیاری) و «Apps & features» قرار می‌گیرد.
- اگر نسخه‌ی قدیمی در Program Files باشد، نصب‌کننده یک بار اجازه می‌خواهد و آن را پاک می‌کند. تنظیمات و ورود کاربر حفظ می‌شود.
- اجرای بی‌صدا: `Webyar-Setup.exe /silent /launch`.
  حذف: از «Apps & features»، یا `Webyar-Setup.exe /uninstall /silent`.
- `WebyarWindows-win-Setup.exe` در همان ریلیز، setup خام Velopack است (بدون پنجره‌ی ما). آن را فقط برای آزمایش به کار ببرید، چون برنامه را در پوشه‌ی پیش‌فرض خودش (`%LOCALAPPDATA%\WebyarWindows`) نصب می‌کند.
- کپی portable (`WebyarWindows-win-Portable.zip`) فقط برای تست است و خودش آپدیت نمی‌شود.
