# Call Widget Professional Upgrade Plan

این کار چند بخش جدا داره. می‌خوام قبل از شروع تأیید بگیرم چون حجمش زیاده.

## ۱. باگ تایمر صف (00:00 شدن مکرر)
- بررسی `ccw-wait-timer` در `public/call-widget/runtime.js` (خط ۸۰۴ و ۱۴۲۸): دو `setInterval` همزمان روی یک المان کار می‌کنند و هر بار که bootstrap دوباره اجرا می‌شود `queueStartedAt` ریست می‌شود.
- رفع: ذخیره `queueStartedAt` در `sessionStorage` کنار session فعال، حذف interval تکراری، استفاده از `Date.now() - storedStart`.

## ۲. آیکون بلندگو + متن راهنما
- زیر آیکون 🔇 وقتی `needsGesture=true` متن «برای شنیدن صدا کلیک کنید» (با ترجمه fa/en/tr) نشان داده شود.
- بعد از اولین تپ متن حذف، آیکون به 🔊 تغییر کند.
- CSS pulse + glow روی آیکون تا توجه جلب شود.

## ۳. نمایش نام اپراتور و تایمر مکالمه به ویزیتور
- وقتی `phase='connected'`، نام اپراتور (از payload `call_accepted` / `call_started`) و یک تایمر mm:ss از لحظه `started_at` نشان داده شود.
- نیاز به اضافه کردن `operator_name` در payload رویدادهای realtime در `server/services/callCenter/realtime.ts` و route مربوطه.

## ۴. انتقال تماس بین اپراتورها (Transfer)
- بک‌اند: endpoint قبلاً وجود دارد (`useTransferCall`/`callCenterApi.transferCall`). بررسی اینکه رویداد `call_transferred` به ویجت ویزیتور هم publish شود.
- ویجت ویزیتور: با دریافت `call_transferred` → بازگشت به فاز `hold`، پخش مجدد صدای انتظار، نمایش «در حال اتصال به اپراتور جدید…»، سپس با `call_accepted` جدید، نام و تایمر اپراتور جدید.
- UI اپراتور: دکمه Transfer در `FloatingOperatorCallWindow` (در صورت نبود) برای انتخاب اپراتور آنلاین و ارسال.

## ۵. امتیازدهی بعد از تماس
- بعد از `call_ended` در ویجت، صفحه ۵ ستاره + کامنت اختیاری.
- جدول جدید `call_ratings` (workspace_id, call_id, visitor_id, rating, comment, created_at) با RLS و GRANTs.
- Route: `POST /api/call-widget/rate` (در `server/routes/callWidget.ts`).

## ۶. انیمیشن‌های زیبا برای فاز connected
- موج‌های صوتی (audio waveform) متحرک با CSS، پالس دور آواتار اپراتور، گرادیان متحرک پس‌زمینه.
- فقط CSS در `runtime.css`، بدون افزودن کتابخانه.

---

## ترتیب پیشنهادی پیاده‌سازی
1. باگ تایمر (ضروری، سریع)
2. متن راهنمای آیکون بلندگو
3. نمایش نام اپراتور + تایمر مکالمه
4. انیمیشن connected
5. جریان transfer (شامل بک‌اند)
6. امتیازدهی (شامل migration)

## سؤال قبل از شروع
- آیا با ساخت جدول جدید `call_ratings` در Supabase موافقید؟ (نیاز به migration)
- آیا UI اپراتور برای Transfer وجود دارد یا باید از صفر در `FloatingOperatorCallWindow` اضافه کنم؟
- زبان متن راهنما: فقط فارسی یا هر سه (fa/en/tr)؟

با تأیید این پلن، همه را به ترتیب پیاده می‌کنم.