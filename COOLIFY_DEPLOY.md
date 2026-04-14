# استقرار روی Coolify

## روش ۱: Docker Compose (توصیه شده)

### ۱. ریپو را به Coolify متصل کنید
1. در Coolify یک پروژه جدید بسازید
2. **Add Resource → Docker Compose** را انتخاب کنید
3. ریپوی GitHub را متصل کنید
4. فایل `docker-compose.yml` به‌صورت خودکار شناسایی می‌شود

### ۲. متغیرهای محیطی را تنظیم کنید
در بخش **Environment Variables** کولیفای، مقادیر زیر را وارد کنید:

| متغیر | توضیح |
|--------|--------|
| `SUPABASE_URL` | آدرس پروژه Supabase |
| `SUPABASE_ANON_KEY` | کلید عمومی Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | کلید سرور Supabase (محرمانه) |
| `VITE_SUPABASE_URL` | همان `SUPABASE_URL` |
| `VITE_SUPABASE_ANON_KEY` | همان `SUPABASE_ANON_KEY` |
| `VITE_API_BASE_URL` | آدرس بکند (مثلاً `https://api.yourdomain.com`) |
| `CORS_ORIGINS` | دامنه‌های مجاز (مثلاً `https://yourdomain.com`) |

### ۳. دامنه‌ها را تنظیم کنید
- **Frontend**: دامنه اصلی (مثلاً `app.yourdomain.com`) → پورت `80`
- **Backend**: دامنه API (مثلاً `api.yourdomain.com`) → پورت `3001`

### ۴. دیپلوی کنید
دکمه **Deploy** را بزنید!

---

## روش ۲: دو سرویس مجزا

### Frontend
1. **Add Resource → Dockerfile**
2. Dockerfile Path: `Dockerfile.frontend`
3. Build Args:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   - `VITE_API_BASE_URL`
4. Port: `80`

### Backend
1. **Add Resource → Dockerfile**
2. Dockerfile Path: `Dockerfile.server`
3. Environment Variables: (مطابق جدول بالا)
4. Port: `3001`
5. Health Check: `http://localhost:3001/api/health`

---

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

- **Frontend سفید/خالی**: مطمئن شوید `VITE_API_BASE_URL` درست تنظیم شده
- **خطای CORS**: مقدار `CORS_ORIGINS` را بررسی کنید
- **خطای ۵۰۲**: Health check بکند را بررسی کنید: `curl https://api.yourdomain.com/api/health`
