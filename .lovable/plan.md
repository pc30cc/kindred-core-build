# Realtime: از تک‌نود به معماری چندنودی قابل مقیاس

## نتیجه ممیزی وضعیت فعلی (Phase A)

بررسی‌شده روی کد فعلی:

- `server/services/realtime/store.ts` — پیکربندی سراسری در `app_runtime_config` با کلید `default_realtime_provider`، کش ۳۰ ثانیه‌ای، `normalize()` برای دو شکل قدیمی/جدید. نقطهٔ درست برای افزودن topology با پیش‌فرض امن.
- `server/services/realtime/centrifugo.ts` — درایور با HS256 + issuer/audience، TTL پیش‌فرض ۱۸۰۰ ثانیه (به‌عمد، به‌خاطر رفتار تب مخفی)، `health()` با `info`، `presenceUsers()`. قرارداد «Backend فقط توکن و ws_url می‌دهد، مرورگر مستقیم وصل می‌شود» حفظ می‌شود.
- `server/routes/realtime.ts` (۹۸۴ خط) — `/connect`، `/reconnect-signal`، `/subscribe`، `/operator-connect`، `/operator-subscribe` و مسیرهای ادمین. اینجا فقط منبع `ws_url` عوض می‌شود، نه شکل پاسخ.
- کنترل‌پلین موجود: `controlPlane.ts`، `failoverEngine.ts`، `failoverHealth.ts`، `failoverState.ts`، `failoverTicker.ts`، `effectivePolicy.ts` — لایهٔ provider failover است و دست‌نخورده می‌ماند؛ لایهٔ جدید «انتخاب نود» زیر آن قرار می‌گیرد.
- حضور: `server/services/widget/operatorPresenceSource.ts` (realtime-first با fallback دیتابیس) و کانال‌های `ws:{id}:operators` / `:visitors` / `:inbox` در `types.ts` — بدون بازنویسی حفظ می‌شوند.
- `server/services/widget/visitorLiveness.ts` — باگ تأییدشده: خط ۱۰۸ کد `'404'` را «تابع موجود نیست» می‌شمارد و باعث fallback خاموش می‌شود.
- استقرار: فقط `docker-compose.centrifugo.yml` (env-driven، `centrifugo/centrifugo:v5.4.5`، بدون healthcheck) و `DEPLOY_CENTRIFUGO_COOLIFY.md`. هر دو دست‌نخورده می‌مانند و Mode 1 هستند.
- کلاینت: `src/realtime/resolveClientRealtimeProvider.ts` + `src/realtime/providers/centrifugo.ts` — مذاکره یک‌بار در هر تب انجام می‌شود و کش می‌شود؛ برای گرفتن نود تازه بعد از خرابی باید کش باطل شود.
- ادمین: `ProvidersPage` → کارت Realtime؛ بخش جدید داخل همان کارت اضافه می‌شود، صفحهٔ تازه ساخته نمی‌شود.

نتیجه: هستهٔ فعلی قابل استفادهٔ مجدد است؛ چیزی بازنویسی نمی‌شود. اضافه‌شونده‌ها: مدل topology، رجیستری نود، روتر نود، سلامت هر نود، UI و مستندات.

## آنچه ساخته می‌شود

### B — مدل داده و سازگاری به عقب
- سه حالت رسمی: `single_memory`، `app_routed_redis`، `load_balanced_redis`.
- افزودن `deployment_mode`، `nodes[]`، `load_balancer.ws_url` به همان رکورد runtime config. `normalize()` پیکربندی بدون mode را `single_memory` می‌گیرد؛ هیچ نصب فعلی نیاز به تغییر دستی ندارد.
- هر نود: شناسه پایدار، نام، ws_url، api_url، enabled، accepting_new_connections، draining، weight، region اختیاری، زمان‌های ساخت/به‌روزرسانی. secretها cluster-level و مشترک می‌مانند و در رکورد نود تکرار نمی‌شوند. Redis URL/password هرگز در دیتابیس ذخیره نمی‌شود.

### C — روتر نود و سلامت
- `nodeRegistry.ts` + `nodeRouter.ts` + `nodeHealth.ts`.
- انتخاب: حذف نودهای disabled/draining/unhealthy، سپس انتخاب weighted با روش power-of-two-choices روی کش سلامت — قابل تست، بدون هیچ نوشتن در PostgreSQL به‌ازای هر اتصال، بدون شمارندهٔ سراسری.
- سلامت هر نود از `info` با کش TTL کوتاه (۱۰ ثانیه) و بازهٔ pull پس‌زمینه؛ خرابی همیشه به سمت «انتخاب نکن» می‌رود. حالت‌ها: healthy / degraded / down / draining / maintenance.
- `/connect` و `/operator-connect` ws_url نود انتخاب‌شده را برمی‌گردانند (Mode 2)، یا ws_url لودبالانسر (Mode 3)، یا همان ws_url فعلی (Mode 1). شکل پاسخ تغییر نمی‌کند.
- کلاینت: بعد از خرابی واقعی transport، کش resolver باطل و assignment تازه گرفته می‌شود، با backoff نمایی + jitter + سقف تلاش + پراکندگی برای جلوگیری از هجوم هم‌زمان.

### D — استقرار Redis
فایل‌های جدید در همین مخزن:
- `docker-compose.centrifugo-redis.yml` — یک نود Centrifugo با `CENTRIFUGO_ENGINE=redis`، قابل استقرار چندباره در Coolify فقط با تغییر دامنه/env.
- `docker-compose.realtime-redis.yml` — Redis/Valkey اختصاصی، نسخهٔ pin‌شده، رمز از env (`REALTIME_REDIS_PASSWORD`)، بدون پورت عمومی، شبکهٔ داخلی، healthcheck واقعی، سیاست حافظه و persistence مستند.
- `docker-compose.realtime-cluster.yml` — Redis + دو نود Centrifugo برای تست محلی/staging.
- نام env و پشتیبانی prefix با همان نسخهٔ pin‌شدهٔ v5.4.5 در زمان اجرا تأیید می‌شود، نه از روی حدس.

### E — رابط سوپر ادمین
داخل کارت Centrifugo، بخش «معماری استقرار»: انتخاب حالت؛ در Mode 1 فقط فیلدهای فعلی، در Mode 2 جدول نودها (سلامت، اتصال‌ها اگر معتبر، وزن، فعال، پذیرش اتصال جدید، Drain/Resume، تست نود، آخرین بررسی) به‌همراه Add Node و Test All، در Mode 3 فیلد آدرس لودبالانسر. هیچ credential ای از Redis در مرورگر نمایش داده نمی‌شود. ترجمهٔ کامل فارسی/انگلیسی/ترکی. ثبت همهٔ اقدامات ادمین در سیستم حسابرسی موجود بدون مقدار secret.
- Preflight قبل از فعال‌سازی: حداقل یک نود سالم، اعتبار مشترک درست، publish و presence بین‌نودی وقتی ≥۲ نود؛ در صورت شکست، پیکربندی قبلی فعال می‌ماند. بازگشت به `single_memory` بدون قطع اجباری کاربران.
- باطل‌سازی کش پیکربندی هنگام تغییر mode/نود/وزن/drain، با در نظر گرفتن چند instance اپ.

### F/G — حضور
- اپراتور: همان کانال و همان قرارداد (Centrifugo منبع حقیقت، دیتابیس fallback) در هر سه حالت؛ اثبات cross-node با دو نود.
- بازدیدکننده فاز ۲: وقتی Centrifugo سالم است، liveness از اتصال realtime خوانده می‌شود و heartbeat دوره‌ای دیتابیس خاموش می‌شود (هدف: صفر نوشتن دوره‌ای). فاز ۱ فعلی حذف نمی‌شود و به‌صورت خودکار فقط در حالت degraded/down روشن می‌شود.
- اصلاح باگ: `isMissingRpcError` دیگر `404` عمومی را نمی‌پذیرد؛ فقط `42883`، `PGRST202` و پیام صریح همان تابع. تست اضافه می‌شود.

### H/I/J — خرابی، مستندات، تست
- قطعی Redis: بدون آفلاین کاذب، کنترل هجوم reconnect، فعال شدن fallback و بازگشت خودکار.
- متریک‌ها و هشدارها روی زیرساخت observability موجود، بدون ایجاد حلقهٔ write-heavy جدید در `alert_events`.
- مستندات: به‌روزرسانی `DEPLOY_CENTRIFUGO_COOLIFY.md` (Mode 1) و افزودن `DEPLOY_REALTIME_MULTI_NODE_COOLIFY.md` شامل ساخت Redis، نود ۱، نود ۲، ثبت نودها، فعال‌سازی، تست‌ها، مسیر مهاجرت Mode 1 → Mode 2 بدون قطعی، rollback، هم‌سرور در برابر چندسرور، و رفع اشکال قطعی Redis.
- تست‌ها: انتخاب نود، عدم انتخاب نود ناسالم/غیرفعال/draining، صفر نود سالم، رعایت وزن، صفر نوشتن دیتابیس در هر assignment، publish و presence بین‌نودی، drain بدون قطع اتصال‌ها، جداسازی workspace، عدم صدور توکن کانال اپراتور برای ویجت، عدم نشت secret، تست همزمانی واقعی `visitor_touch_liveness`، و بنچمارک مسیر assignment (p50/p95/p99).

## خارج از دامنه
Billing، Auth، دعوت‌ها، AI runtime، migrationهای نامرتبط و بازطراحی observability دست‌نخورده می‌مانند.
