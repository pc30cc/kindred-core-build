# استقرار روی Coolify

## تنظیمات سریع

| تنظیم | مقدار |
|--------|--------|
| **نوع دیپلوی** | Docker Compose |
| **مسیر فایل Compose** | `/docker-compose.yml` |
| **Base Directory** | `/` (ریشه ریپو) |
| **سرویس‌ها** | `frontend` (پورت 80) + `backend` (پورت 3001) |

## مراحل

### ۱. ریپو را به Coolify متصل کنید
1. در Coolify یک پروژه جدید بسازید
2. **Add Resource → Docker Compose** را انتخاب کنید
3. ریپوی GitHub را متصل کنید
4. مسیر Compose: `/docker-compose.yml`
5. Base Directory: `/` (پیش‌فرض)

### ۲. متغیرهای محیطی را تنظیم کنید

| متغیر | مقدار | توضیح |
|--------|--------|--------|
| `SUPABASE_URL` | `https://xxx.supabase.co` | آدرس پروژه Supabase |
| `SUPABASE_ANON_KEY` | `eyJ...` | کلید عمومی Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | `eyJ...` | کلید سرور Supabase (محرمانه) |
| `VITE_SUPABASE_URL` | `https://xxx.supabase.co` | همان SUPABASE_URL |
| `VITE_SUPABASE_ANON_KEY` | `eyJ...` | همان SUPABASE_ANON_KEY |
| `VITE_API_BASE_URL` | **خالی بگذارید** | nginx داخلی پروکسی میکنه |
| `CORS_ORIGINS` | `https://yourdomain.com` | دامنه‌های مجاز |

> **مهم:** `VITE_API_BASE_URL` را **خالی** بگذارید یا اصلاً تنظیم نکنید.
> Nginx داخل کانتینر frontend درخواست‌های `/api/*` را به سرویس `backend` پروکسی می‌کند.
> اگر آدرس دامنه خود را بگذارید (مثلاً `https://destekly.tr`)، درخواست دوباره به خود nginx برمی‌گردد و مشکلی نیست — ولی خالی گذاشتن ساده‌تر و قابل اطمینان‌تر است.

### ۳. دامنه را تنظیم کنید
- فقط **یک دامنه** به سرویس `frontend` وصل کنید (مثلاً `destekly.tr`)
- **نیازی به دامنه جدا برای backend نیست** — nginx پروکسی می‌کند

### ۴. دیپلوی کنید
دکمه **Deploy** را بزنید!

## معماری

```
اینترنت → https://yourdomain.com
              ↓
         ┌─────────┐
         │ frontend │  (nginx, پورت 80)
         │          │
         │  /api/*  │──→ backend:3001 (پروکسی داخلی)
         │  /*      │──→ React SPA
         └─────────┘
              ↓
         ┌─────────┐
         │ backend  │  (Express, پورت 3001)
         │          │──→ Supabase Cloud (دیتابیس)
         └─────────┘
```

## پس از دیپلوی

1. مایگریشن‌های دیتابیس را اجرا کنید (اگر هنوز نکرده‌اید):
```bash
psql $DATABASE_URL -f database/migrations/001_core_tables.sql
psql $DATABASE_URL -f database/migrations/002_workspace_features.sql
psql $DATABASE_URL -f database/migrations/003_visitors_kb_config.sql
psql $DATABASE_URL -f database/migrations/004_seed_defaults.sql
```

2. ثبت‌نام کنید و اولین workspace را بسازید
3. برندینگ و ویجت را پیکربندی کنید

## عیب‌یابی

| مشکل | راه‌حل |
|-------|--------|
| Frontend سفید/خالی | `VITE_SUPABASE_URL` و `VITE_SUPABASE_ANON_KEY` را چک کنید |
| خطای `Failed to fetch` در signup | مطمئن شوید سرویس `backend` بالا اومده: لاگ backend را چک کنید |
| خطای CORS | مقدار `CORS_ORIGINS` را بررسی کنید |
| nginx ریستارت میشه | لاگ frontend را چک کنید — اگر `host not found` بود، backend هنوز بالا نیومده |
| خطای ۵۰۲ | Health check بکند: `curl https://yourdomain.com/api/health` |
