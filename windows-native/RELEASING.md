# انتشار نسخه‌ی جدید اپ ویندوز (Releasing the Windows app)

> **English summary.** Bump `<Version>` in `windows-native/Directory.Build.props`
> through a PR, merge it, then create the tag `native-v<version>` on `main`
> (GitHub → Releases → *Draft a new release*). The **Windows app (native)**
> workflow tests, builds and publishes the Velopack feed plus
> `Webyar-Setup.exe` to `pc30cc/webyar-desktop-releases`, using the
> `DESKTOP_RELEASES_TOKEN` secret. Installed apps pick it up by themselves.
> Finally copy `Webyar-Setup.exe` to the downloads host (section 5).

این راهنما می‌گوید نسخه‌ی جدید اپ ویندوز چطور منتشر می‌شود و اپ‌های نصب‌شده چطور خودشان را آپدیت می‌کنند.

---

## ۱. آپدیت خودکار چطور کار می‌کند

- **فید آپدیت:** مخزن عمومی
  [`pc30cc/webyar-desktop-releases`](https://github.com/pc30cc/webyar-desktop-releases)
  است. هر نسخه یک GitHub Release است با تگ `v<نسخه>` (نسخه‌ها تا ۲.۵.۰ با تگ `native-v<نسخه>`). CI این تگ را خودش می‌سازد.
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
  - `Webyar-Setup.exe` برنامه را بدون اجازه‌ی مدیر در `%LOCALAPPDATA%\WebyarWindows` نصب می‌کند. درونش setup خود Velopack است که بی‌صدا اجرا می‌شود. برنامه در منوی Start، دسکتاپ و «Apps & features» قرار می‌گیرد.
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

1. **secret به نام `DESKTOP_RELEASES_TOKEN`** در
   `kindred-core-build` → Settings → Secrets and variables → Actions.
   مقدارش یک *fine-grained personal access token* است:
   - Repository access: فقط `pc30cc/webyar-desktop-releases`
   - Permissions → **Contents: Read and write**
   - وقتی توکن منقضی شد، همین را تمدید یا دوباره بسازید. بدون آن، مرحله‌ی «Publish release» با خطای
     `DESKTOP_RELEASES_TOKEN is not set` متوقف می‌شود.
2. **مخزن `webyar-desktop-releases` حداقل یک commit داشته باشد** (مثلاً یک `README.md`).
   در مخزن خالی GitHub نمی‌تواند تگ بسازد، پس ریلیز به‌صورت **draft** می‌ماند. اپ‌های نصب‌شده draft را نمی‌بینند.
3. در سوپر ادمین آپدیت خودکار روشن باشد و آدرس فید یکی از این دو باشد:
   `https://github.com/pc30cc/webyar-desktop-releases` یا
   `https://github.com/pc30cc/webyar-desktop-releases/releases/latest/download`.

## ۳. مراحل انتشار هر نسخه

1. **شماره‌ی نسخه را بالا ببرید.** در `windows-native/Directory.Build.props`:
   ```xml
   <Version>2.4.2</Version>
   ```
   این تغییر را در یک PR بگذارید. بعد از سبز شدن CI، آن را در `main` مرج کنید.
   - شماره باید از همه‌ی نسخه‌هایی که جایی نصب شده‌اند بزرگ‌تر باشد.
   - برای رفع باگ رقم آخر را بالا ببرید، برای امکانات جدید رقم وسط را.
2. **تگ بزنید.** در
   <https://github.com/pc30cc/kindred-core-build/releases/new>:
   - Choose a tag: `native-v2.4.2` → «Create new tag»
   - Target: **`main`**
   - «Publish release»

   تگ باید دقیقاً با `<Version>` یکی باشد، وگرنه CI در مرحله‌ی «Version» متوقف می‌شود.
3. **CI خودش بقیه را انجام می‌دهد.** workflow به نام **Windows app (native)**
   (`.github/workflows/desktop-native.yml`) روی تگ اجرا می‌شود. تست‌های Core، build، ساخت بسته‌ی Velopack و ساخت `Webyar-Setup.exe` را انجام می‌دهد و همه را در `webyar-desktop-releases` منتشر می‌کند. حدود ۴ دقیقه طول می‌کشد.
4. **بررسی کنید.** در
   <https://github.com/pc30cc/webyar-desktop-releases/releases>
   ریلیز «Webyar 2.4.2» باید `Webyar-Setup.exe`، `releases.win.json` و فایل‌های `.nupkg` را داشته باشد.
5. **صفحه‌ی دانلود سایت را به‌روز کنید** (بخش ۵).

## ۴. اگر مشکلی پیش آمد

| مشکل | کار لازم |
|---|---|
| مرحله‌ی «Version»: `Tag X does not match <Version> Y` | تگ و `<Version>` یکی نیستند. تگ را روی کامیتی بزنید که همان نسخه را دارد. |
| مرحله‌ی «Test Core» شکست خورد | باگ را رفع کنید و نسخه را یک پله بالا ببرید (مثلاً ۲.۴.۲ → ۲.۴.۳). تگ قبلی را دوباره استفاده نکنید. |
| `DESKTOP_RELEASES_TOKEN is not set` یا خطای دسترسی | توکن را بسازید یا تمدید کنید (بخش ۲). بعد در صفحه‌ی همان اجرا «Re-run failed jobs» را بزنید؛ تگ جدید لازم نیست. |
| ریلیز در `webyar-desktop-releases` به‌صورت **Draft** مانده (آدرسش `untagged-…` است)، یا مرحله‌ی «Publish release» با `The release is still a draft` متوقف شد | مخزن ریلیزها commit ندارد. یک `README.md` به آن اضافه کنید (الان دارد). بعد یا draft را باز کنید و «Publish release» را بزنید، یا در Actions → **Windows app (native)** → «Run workflow» در فیلد `publish_tag` تگ را بنویسید (مثلاً `v2.5.1`) تا بدون build دوباره منتشرش کند. نسخه و تگ جدید لازم نیست. |
| jobها در چند ثانیه fail شدند و runner نگرفتند | مشکل GitHub است؛ یک بار «Re-run» بزنید. |
| اپ آپدیت نمی‌شود | ۱) نسخه‌ی منتشرشده از نسخه‌ی نصب‌شده بزرگ‌تر باشد؛ ۲) در سوپر ادمین آپدیت خودکار روشن و فید درست باشد؛ ۳) اپ با `Webyar-Setup.exe` نصب شده باشد، نه کپی دستی یا portable. |

## ۵. صفحه‌ی دانلود سایت (`app.webyar.ai/downloads`)

لینک‌های `https://app.webyar.ai/downloads/Webyar-Setup.exe` (آخرین نسخه) و
`…/Webyar-Setup-<نسخه>.exe` از سرور production (`analyticsme.site`) سرو می‌شوند. جزئیات راه‌اندازی در
`deploy/windows-downloads/README.md` است. بعد از هر انتشار، روی سرور:

```sh
v=2.4.2
cd /data/webyar-downloads/files
curl -fL -o "Webyar-Setup-$v.exe" \
  "https://github.com/pc30cc/webyar-desktop-releases/releases/download/v$v/Webyar-Setup.exe"
ln -sf "Webyar-Setup-$v.exe" Webyar-Setup.exe
```

## ۶. نصب اولیه روی یک کامپیوتر

- `Webyar-Setup.exe` را از `app.webyar.ai/downloads` یا صفحه‌ی ریلیز اجرا کنید. اجازه‌ی مدیر لازم نیست. برنامه برای همان کاربر نصب می‌شود و در منوی Start، دسکتاپ (اختیاری) و «Apps & features» قرار می‌گیرد.
- اگر نسخه‌ی قدیمی در Program Files باشد، نصب‌کننده یک بار اجازه می‌خواهد و آن را پاک می‌کند. تنظیمات و ورود کاربر حفظ می‌شود.
- اجرای بی‌صدا: `Webyar-Setup.exe /silent /launch`.
  حذف: از «Apps & features»، یا `Webyar-Setup.exe /uninstall /silent`.
- `WebyarWindows-win-Setup.exe` در همان ریلیز، setup خام Velopack است (بدون پنجره‌ی ما) و همان نصب را انجام می‌دهد.
- کپی portable (`WebyarWindows-win-Portable.zip`) فقط برای تست است و خودش آپدیت نمی‌شود.
