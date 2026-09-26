/**
 * Capability registry localisation for the Super Admin plan editor.
 *
 * The registry (`server/services/billing/capabilityRegistry.ts`) ships English
 * labels, descriptions, group ids and unit ids — "localisation handled in UI".
 * This module is that UI side: every registry key, group and unit has a
 * Persian entry here, and anything missing falls back to the registry's
 * English so a newly added key still renders (the capability i18n test fails
 * until it is translated).
 */

import type { CapabilityDefinition } from '@/lib/entitlements-api';

type CapabilityCopy = { label: string; description?: string };

/** `-1` pinned left-to-right so the minus sign stays in front inside RTL text. */
const NEG_ONE = '‎-1';
const UNLIMITED = `${NEG_ONE} = نامحدود.`;
const CONTACTS_BOUND = 'محدود به ماژول مخاطبین.';

const CAPABILITIES_FA: Record<string, CapabilityCopy> = {
  // ─── Modules ───
  chat: { label: 'گفتگوی زنده' },
  knowledge_base: { label: 'پایگاه دانش' },
  ai_assistant: { label: 'دستیار هوش مصنوعی' },
  visitor_tracking: { label: 'ردیابی بازدیدکنندگان' },
  email_campaigns: { label: 'کمپین‌های ایمیلی' },
  automation: { label: 'اتوماسیون' },
  analytics: { label: 'تحلیل و گزارش' },
  omnichannel: { label: 'چندکاناله' },
  custom_branding: { label: 'برندینگ سفارشی' },
  api_access: { label: 'دسترسی API' },
  voice_video: { label: 'صوت و تصویر' },
  help_center: { label: 'مرکز راهنما' },
  call_center: {
    label: 'مرکز تماس',
    description:
      'مجموعه صف تماس، مسیریابی، دعوت‌نامه‌ها و تماس برگشتی. محدود به ماژول «صوت و تصویر» و صفحه کنترل سراسری تماس.',
  },
  contacts: {
    label: 'مخاطبین',
    description:
      'فهرست مخاطبین: رکوردهای ذخیره‌شده مخاطب، جستجو، برچسب‌گذاری، یادداشت‌ها و نمای جزئیات. زیرقابلیت‌ها (ورود، خروجی، عملیات گروهی، برچسب و یادداشت) در گروه ویژگی‌های «مخاطبین» قرار دارند.',
  },
  seo: {
    label: 'سئو / ممیزی وب‌سایت',
    description: 'خزش و تحلیل سلامت فنی سئوی وب‌سایتی که در فضای کاری ثبت شده است (تنظیمات ← دامنه‌ها).',
  },
  commerce: {
    label: 'یکپارچه‌سازی فروشگاه',
    description:
      'اتصال فروشگاه (ووکامرس و ارائه‌دهندگان بعدی) تا دستیار هوش مصنوعی بتواند با داده‌های واقعی فروشگاه به پرسش‌های محصول، قیمت و سفارش پاسخ دهد.',
  },
  seo_backlinks: {
    label: 'سئو — تحلیل بک‌لینک',
    description:
      'دریافت و مرور پروفایل بک‌لینک وب‌سایت ثبت‌شده در فضای کاری، از طریق ارائه‌دهنده داده بک‌لینک که در پلتفرم پیکربندی شده است.',
  },
  seo_keywords: {
    label: 'سئو — تحقیق کلمات کلیدی',
    description:
      'بررسی حجم جستجو، CPC و میزان رقابت برای فهرستی از کلمات کلیدی پایه، از طریق ارائه‌دهنده داده کلمات کلیدی که در پلتفرم پیکربندی شده است.',
  },
  seo_rank_tracking: {
    label: 'سئو — رهگیری رتبه',
    description:
      'رهگیری فهرستی از کلمات کلیدی و ثبت دوره‌ای جایگاه آن‌ها در گوگل برای وب‌سایت ثبت‌شده در فضای کاری.',
  },
  seo_performance: {
    label: 'سئو — ممیزی عملکرد',
    description:
      'دریافت شاخص‌های Core Web Vitals و امتیاز دسته‌های Lighthouse برای صفحات وب‌سایت، از طریق ارائه‌دهنده داده عملکرد که در پلتفرم پیکربندی شده است.',
  },
  seo_gsc_insights: {
    label: 'سئو — بینش‌های سرچ کنسول (GSC)',
    description:
      'اتصال یک پراپرتی Google Search Console و مرور داده‌های عملکرد جستجوی آن (کلیک، نمایش، CTR و جایگاه) مستقیماً داخل فضای کاری.',
  },
  seo_site_explorer: {
    label: 'سئو — کاوشگر سایت',
    description:
      'بررسی پروفایل بک‌لینک و کلمات کلیدی ارگانیک هر دامنه — از جمله رقبا — بدون ثبت آن به‌عنوان وب‌سایت فضای کاری.',
  },
  web_analytics: {
    label: 'سئو — تحلیل وب',
    description:
      'گزارش ترافیک، مخاطبان و رفتار (منابع، صفحات، موقعیت جغرافیایی، دستگاه‌ها، رویدادهای سفارشی و قیف‌ها) بر پایه داده‌های ردیابی بازدیدکنندگان فضای کاری.',
  },
  email_inbox: {
    label: 'صندوق ایمیل',
    description:
      'یک کلاینت ایمیل واقعی و اختصاصی داخل پلتفرم (فعلاً جیمیل، یاهو میل در برنامه) — جدا از صندوق ورودی یکپارچه گفتگو.',
  },
  bot_analytics: {
    label: 'سئو — تحلیل ربات‌ها',
    description:
      'بارگذاری لاگ‌های دسترسی وب‌سرور/CDN برای دیدن اینکه کدام خزنده‌های موتور جستجو و هوش مصنوعی/LLM (Googlebot، GPTBot، ClaudeBot، PerplexityBot و …) از سایت بازدید کرده‌اند و به کدام صفحات سر زده‌اند.',
  },
  brand_radar: {
    label: 'سئو — رادار برند',
    description:
      'رهگیری دیده‌شدن برند در دستیارهای هوش مصنوعی (آیا ChatGPT از شما نام می‌برد؟)، رتبه‌های جستجوی ارگانیک و تقاضای واقعی Search Console برای نام برند شما در مقایسه با رقبای رهگیری‌شده.',
  },

  // ─── Commerce ───
  commerce_catalog: {
    label: 'فروشگاه — کاتالوگ محصولات',
    description: 'هوش مصنوعی می‌تواند محصولات، قیمت‌ها و موجودی را در فروشگاه متصل جستجو کند.',
  },
  commerce_orders: {
    label: 'فروشگاه — سفارش‌ها و رهگیری',
    description: 'هوش مصنوعی پس از احراز هویت می‌تواند به پرسش‌های وضعیت سفارش و رهگیری مرسوله پاسخ دهد.',
  },
  commerce_customer_history: {
    label: 'فروشگاه — سابقه سفارش‌های مشتری',
    description: 'هوش مصنوعی می‌تواند سفارش‌های اخیر مشتری احراز هویت‌شده را فهرست کند.',
  },
  commerce_max_connected_stores: { label: 'فروشگاه — فروشگاه‌های متصل' },

  // ─── Channels ───
  chat_widget: { label: 'ویجت گفتگو' },
  email: { label: 'ایمیل' },
  whatsapp: { label: 'واتس‌اپ' },
  sms: { label: 'پیامک' },
  instagram: { label: 'اینستاگرام' },
  telegram: { label: 'تلگرام' },
  bale: { label: 'بله' },
  gmail: { label: 'جیمیل' },
  yahoomail: { label: 'یاهو میل' },
  voice: { label: 'تماس صوتی' },
  video: { label: 'تماس تصویری' },

  // ─── AI / support / security / branding ───
  advanced_ai_agent: { label: 'عامل هوش مصنوعی پیشرفته' },
  ai_operator_assist: { label: 'دستیار هوشمند اپراتور' },
  ai_kb_builder: { label: 'سازنده پایگاه دانش با هوش مصنوعی' },
  priority_support: { label: 'پشتیبانی اولویت‌دار' },
  sso: { label: 'ورود یکپارچه (SSO / SAML)' },
  audit_logs: { label: 'گزارش‌های حسابرسی' },
  white_label: { label: 'برندینگ وایت‌لیبل' },
  remove_powered_by: {
    label: 'حذف «Powered by» (قدیمی)',
    description:
      'منسوخ — با `widget_powered_by` جایگزین شده است. فقط به‌عنوان مقدار جایگزین برای پلن‌هایی خوانده می‌شود که هرگز مهاجرت داده نشده‌اند.',
  },
  widget_powered_by: {
    label: 'نمایش پانویس «Powered by» در ویجت',
    description:
      'تعیین می‌کند ویجت گفتگو پانویس اعتبار پلتفرم را نشان دهد یا نه. متن، نام برند و لینک آن در اختیار مدیر پلتفرم است (مدیریت ← تنظیمات ویجت ← Powered by). با خاموش کردن آن برای یک پلن، پانویس کاملاً پنهان می‌شود و محتوای ویجت تا لبه پایین امتداد می‌یابد.',
  },
  widget_powered_by_toggle: {
    label: 'امکان پنهان کردن «Powered by» توسط فضای کاری',
    description:
      'به مالک فضای کاری اجازه می‌دهد پانویس Powered by را از مسیر ویجت ← ظاهر ← لوگو و برندینگ خاموش کند. کلید فضای کاری به‌طور پیش‌فرض روشن است، پس اعتبار تا وقتی مالک آن را خاموش نکند نمایش داده می‌شود. نیازمند مجاز بودن پانویس با «نمایش پانویس Powered by در ویجت» است.',
  },

  // ─── Widget ───
  widget_attachments: {
    label: 'پیوست فایل در ویجت',
    description: 'بازدیدکنندگان می‌توانند در کادر نوشتن پیام ویجت گفتگو فایل پیوست کنند.',
  },
  widget_voice_notes: {
    label: 'پیام صوتی در ویجت',
    description: 'بازدیدکنندگان می‌توانند از ویجت گفتگو پیام صوتی ضبط و ارسال کنند.',
  },
  widget_emoji: {
    label: 'انتخابگر ایموجی ویجت',
    description: 'انتخابگر ایموجی در کادر نوشتن پیام ویجت گفتگو.',
  },
  widget_smart_engagement: {
    label: 'تعامل هوشمند ویجت',
    description: 'تلنگرها، اطلاعیه‌ها و پیام‌های پیش‌دستانه مبتنی بر رفتار بازدیدکننده (ویجت ← تعامل هوشمند).',
  },
  ai_proactive_nudge: {
    label: 'تلنگر پیش‌دستانه هوش مصنوعی',
    description:
      'پیام‌های کوتاه کنار دکمه ویجت که هوش مصنوعی بر اساس مسیر بازدیدکننده می‌سازد (ویجت ← تعامل هوشمند ← دستیار پیش‌دستانه هوش مصنوعی). نیازمند «تعامل هوشمند ویجت» و «دستیار هوش مصنوعی».',
  },
  widget_business_hours: {
    label: 'ساعات کاری ویجت',
    description: 'ساعات پاسخ‌گویی و رفتار حالت آفلاین ویجت گفتگو برای هر فضای کاری.',
  },
  widget_domain_allowlist: {
    label: 'فهرست دامنه‌های مجاز ویجت',
    description: 'محدود کردن محل جاسازی ویجت با فهرست دامنه‌های مجاز. محدود به max_widget_domains.',
  },
  max_widget_domains: {
    label: 'حداکثر دامنه‌های ویجت',
    description: `حداکثر تعداد دامنه‌های مجاز برای جاسازی ویجت در هر فضای کاری. هنگام ذخیره فهرست مجاز اعمال می‌شود. ${UNLIMITED}`,
  },
  widget_assignment_routing: {
    label: 'واگذاری خودکار گفتگو',
    description:
      'مسیریابی خودکار / نوبتی (round-robin) گفتگوهای واگذارشده به اپراتورها. اگر خاموش باشد، فضای کاری فقط به واگذاری دستی محدود می‌شود.',
  },
  widget_raw_ip_storage: {
    label: 'ذخیره IP کامل بازدیدکننده',
    description:
      'اجازه به فضای کاری برای ذخیره نشانی IP کامل (بدون پوشاندن) بازدیدکننده. از نظر حریم خصوصی حساس است — به‌طور پیش‌فرض خاموش.',
  },
  widget_reply_time_text: {
    label: 'متن سفارشی زمان پاسخ',
    description: 'فضای کاری می‌تواند متن «معمولاً در … پاسخ می‌دهد» را زیر نام برند ویجت بنویسد.',
  },
  widget_welcome_message: {
    label: 'پیام خوش‌آمد سفارشی',
    description: 'فضای کاری می‌تواند پیام خوش‌آمد ویجت را بنویسد؛ در غیر این صورت پیش‌فرض زبان استفاده می‌شود.',
  },
  widget_launcher_label: {
    label: 'متن سفارشی حباب دکمه ویجت',
    description: 'فضای کاری می‌تواند متن حبابی را که کنار دکمه شناور ویجت نمایش داده می‌شود بنویسد.',
  },
  widget_launcher_size: {
    label: 'اندازه سفارشی دکمه ویجت',
    description:
      'فضای کاری می‌تواند اندازه دکمه شناور ویجت را تغییر دهد؛ در غیر این صورت اندازه پیش‌فرض 56 پیکسل استفاده می‌شود.',
  },
  widget_launcher_icon: {
    label: 'آیکن سفارشی دکمه ویجت',
    description: 'فضای کاری می‌تواند آیکن دکمه شناور ویجت را انتخاب کند؛ در غیر این صورت آیکن پیش‌فرض گفتگو استفاده می‌شود.',
  },
  widget_composer_placeholder: {
    label: 'متن راهنمای سفارشی کادر پیام',
    description: 'فضای کاری می‌تواند متن راهنمای «پیام خود را بنویسید» را در کادر نوشتن پیام ویجت تعیین کند.',
  },
  widget_team_avatars: {
    label: 'آواتار اپراتورهای آنلاین',
    description: 'نمایش آواتار اپراتورهای آنلاین داخل دکمه «شروع گفتگو» ویجت.',
  },
  widget_workspace_logo: {
    label: 'لوگوی فضای کاری در ویجت',
    description: 'نمایش لوگوی فضای کاری در سربرگ ویجت. در صورت عدم دسترسی، ویجت فقط نام برند را نشان می‌دهد.',
  },
  widget_appearance: {
    label: 'ویرایشگر ظاهر ویجت',
    description:
      'فضای کاری می‌تواند ظاهر ویجت را سفارشی کند (ویجت ← ظاهر). در صورت عدم دسترسی، پیش‌فرض‌های پلتفرم استفاده می‌شود.',
  },
  widget_behavior: {
    label: 'تنظیمات رفتار ویجت',
    description: 'فضای کاری می‌تواند رفتار ویجت را پیکربندی کند (ویجت ← رفتار).',
  },
  widget_prechat_form: {
    label: 'فرم پیش از گفتگوی ویجت',
    description: 'دریافت اطلاعات بازدیدکننده پیش از شروع گفتگو (ویجت ← فرم پیش از گفتگو).',
  },

  // ─── Inbox ───
  inbox_ai_queue: {
    label: 'تب صف هوش مصنوعی در صندوق ورودی',
    description: 'تب گفتگوهای خودکار / مدیریت‌شده با هوش مصنوعی در صندوق ورودی اپراتور.',
  },
  inbox_needs_human: {
    label: 'تب «نیازمند اپراتور» در صندوق ورودی',
    description: 'گفتگوهایی که هوش مصنوعی واگذار کرده و به اپراتور نیاز دارند.',
  },
  inbox_team_chat: {
    label: 'گفتگوی همکاران در صندوق ورودی',
    description: 'تب گفتگوی داخلی اپراتورها با یکدیگر در صندوق ورودی.',
  },

  // ─── Mobile ───
  mobile_promo_banner: {
    label: 'بنر تبلیغاتی موبایل',
    description: 'نمایش بنر تبلیغاتی خود پلتفرم در بالای صندوق ورودی iOS برای فضاهای کاری این پلن.',
  },
  mobile_promo_fullscreen: {
    label: 'تبلیغ تمام‌صفحه موبایل',
    description:
      'نمایش گاه‌به‌گاه تبلیغ تمام‌صفحه در اپلیکیشن iOS برای فضاهای کاری این پلن. تناوب آن با محدودیت‌های زیر تنظیم می‌شود و همیشه قابل بستن است.',
  },
  mobile_promo_interval_minutes: {
    label: 'دقیقه بین تبلیغ‌های تمام‌صفحه',
    description:
      'حداقل فاصله زمانی نمایش تبلیغ تمام‌صفحه در اپلیکیشن iOS. اگر تنظیم پلتفرم سخت‌گیرانه‌تر باشد، همان اعمال می‌شود.',
  },

  // ─── Calls ───
  call_recording: {
    label: 'ضبط تماس',
    description:
      'اجازه به اپراتورها برای ضبط تماس‌های صوتی/تصویری. محدود به کلید سراسری call_recording_enabled_global در زمان اجرا.',
  },
  call_queue: {
    label: 'صف تماس',
    description: 'دسترسی سطح پلن به صف و مسیریابی تماس. محدود به کلید سراسری call_queue_enabled_global در زمان اجرا.',
  },
  call_callbacks: {
    label: 'تماس برگشتی',
    description:
      'اجازه به بازدیدکنندگان برای درخواست تماس برگشتی هنگام نقض SLA. محدود به کلید سراسری callback_offer_after_timeout در زمان اجرا.',
  },
  max_concurrent_calls: {
    label: 'حداکثر تماس هم‌زمان',
    description: `سقف کل فضای کاری برای call_sessions فعال هم‌زمان (مجموعه فعال مرجع: pending، ringing، connecting و active با همه مقادیر entry_source). هنگام ایجاد در POST /api/calls/create (اپراتور) و POST /api/widget/calls/request (بازدیدکننده) با شمارش مشتق مرجع اعمال می‌شود. به‌صورت افزایشی با تنظیم مدیر پلتفرم در سطح ویجت platform_call_center_settings.max_concurrent_calls_per_workspace ترکیب می‌شود — هر دو سقف می‌توانند درخواست جدید را رد کنند و اولین رد ملاک است. ${UNLIMITED}`,
  },
  max_call_minutes_per_month: {
    label: 'دقیقه تماس در ماه',
    description: `سقف ماهانه دقایق قابل صورتحساب تماس برای هر فضای کاری (ماه UTC). قابل صورتحساب یعنی فقط تماس‌های برقرارشده: CEIL((ended_at - connected_at) / 60) برای هر تماس پایان‌یافته. زمان پیش از اتصال، صف، انتظار و زمانی که فقط ضبط است حساب نمی‌شود. مصرف توسط تریگر دیتابیس tg_call_sessions_bill_minutes در workspace_usage_counters.call_minutes_used تجمیع می‌شود (تنها نویسنده). هنگام ایجاد در POST /api/calls/create و POST /api/widget/calls/request با checkPlanMonthlyMinutesCeiling اعمال می‌شود. ${UNLIMITED}`,
  },
  recording_retention_days: {
    label: 'مدت نگهداری ضبط تماس',
    description: `حداکثر تعداد روزهایی که فایل ضبط تماس پیش از حذف قطعی توسط پاک‌کننده ضبط‌ها نگهداری می‌شود. دامنه: ردیف‌های public.call_recordings با legal_hold = false. زمان‌سنج: یک بار هنگام درج به‌صورت retention_expires_at = created_at + effective_days ثبت می‌شود؛ مقدار در زمان ایجاد قفل می‌شود، پس تغییر پلن فقط روی ضبط‌های بعدی اثر دارد. ${NEG_ONE} = نامحدود (retention_expires_at خالی می‌ماند و پاک‌کننده هرگز آن ردیف را انتخاب نمی‌کند). فقط توسط server/services/recordings/retentionJanitor.ts اعمال می‌شود — مسیر حذف دیگری وجود ندارد. docs/CALL_RECORDING_RETENTION.md را ببینید.`,
  },
  max_call_recordings: {
    label: 'حداکثر فایل ضبط تماس',
    description: `سقف کل تعداد فایل‌های ضبط تماس ذخیره‌شده برای فضای کاری. دامنه: ردیف‌های public.call_recordings متصل به call_sessions با workspace_id = $1. شمارش زنده count(*). هنگام شروع ضبط توسط server/services/callCenter/recordingControl.ts#startCallCenterRecording پیش از فراخوانی ارائه‌دهنده اعمال می‌شود. حذف فایل ضبط ظرفیت را آزاد می‌کند. ${UNLIMITED}`,
  },
  max_call_recording_storage_mb: {
    label: 'فضای ذخیره ضبط تماس',
    description: `سقف کل حجم ذخیره‌شده (MiB) فایل‌های ضبط تماس فضای کاری. منبع: SUM(call_recordings.size_bytes) متصل به call_sessions با workspace_id = $1، تبدیل‌شده به MiB. هنگام شروع ضبط توسط server/services/callCenter/recordingControl.ts#startCallCenterRecording پیش از فراخوانی ارائه‌دهنده اعمال می‌شود. حذف فایل ضبط ظرفیت را آزاد می‌کند. ${UNLIMITED}`,
  },

  // ─── Contacts ───
  contact_import: {
    label: 'ورود مخاطبین',
    description: `ویزارد ورود CSV برای ساخت گروهی رکوردهای مخاطب. ${CONTACTS_BOUND}`,
  },
  contact_create: {
    label: 'ایجاد مخاطب',
    description: `ایجاد دستی رکورد مخاطب جدید از فهرست مخاطبین. ${CONTACTS_BOUND}`,
  },
  contact_edit: {
    label: 'ویرایش مخاطب',
    description: `ویرایش رکوردهای موجود مخاطب (نام، ایمیل، تلفن، یادداشت‌ها و برچسب‌ها). ${CONTACTS_BOUND}`,
  },
  contact_export: {
    label: 'خروجی مخاطبین',
    description: `خروجی گرفتن از فهرست مخاطبین به CSV. ${CONTACTS_BOUND}`,
  },
  contact_tags: {
    label: 'برچسب‌های مخاطب',
    description: `برچسب‌گذاری، فیلتر بر اساس برچسب و گروه‌بندی مبتنی بر برچسب روی رکوردهای مخاطب. ${CONTACTS_BOUND}`,
  },
  contact_notes: {
    label: 'یادداشت‌های مخاطب',
    description: `یادداشت‌های آزاد متصل به رکورد مخاطب. ${CONTACTS_BOUND}`,
  },
  bulk_contact_actions: {
    label: 'عملیات گروهی مخاطبین',
    description: `عملیات گروهی با انتخاب چندتایی (مثلاً حذف گروهی) در فهرست مخاطبین. ${CONTACTS_BOUND}`,
  },
  contact_ip_visibility: {
    label: 'نمایش IP مخاطب',
    description: `نمایش نشانی IP بازدیدکننده در صفحه جزئیات مخاطب. اگر غیرفعال باشد، IP هرگز به کلاینت ارسال نمی‌شود (حذف در سمت سرور). ${CONTACTS_BOUND}`,
  },
  max_contacts: {
    label: 'حداکثر مخاطبین',
    description:
      'حداکثر تعداد رکوردهای مخاطب (ردیف‌های public.contacts) در هر فضای کاری در هر لحظه. مبنای اشغال ظرفیت: حذف، ظرفیت را آزاد می‌کند؛ ویرایش، برچسب و یادداشت ظرفیتی مصرف نمی‌کنند. توسط POST /api/contacts و POST /api/contacts/bulk با requireLimit و شمارش زنده count(*) اعمال می‌شود.',
  },

  // ─── Team / usage ───
  max_agents: { label: 'حداکثر اپراتور' },
  max_workspaces: { label: 'حداکثر فضای کاری' },
  max_conversations: { label: 'گفتگو در ماه' },
  max_visitors: { label: 'بازدیدکننده ردیابی‌شده در ماه' },
  storage_gb: { label: 'فضای ذخیره‌سازی' },
  data_retention_days: { label: 'مدت نگهداری داده' },
  max_kb_articles: {
    label: 'مقالات پایگاه دانش',
    description: `حداکثر تعداد مقالات پایگاه دانش (ردیف‌های public.knowledge_base_articles) در هر فضای کاری در هر لحظه. مبنای اشغال ظرفیت: حذف مقاله ظرفیت را آزاد می‌کند. هنگام ایجاد توسط POST /api/knowledge-base/articles با شمارش زنده count(*) اعمال می‌شود. کلیدهای جایگزین قدیمی (فقط وقتی این کلید وجود ندارد خوانده می‌شوند): ai_kb_max_articles و kb_articles. ${UNLIMITED}`,
  },

  // ─── AI limits ───
  ai_credits_per_month: { label: 'اعتبار هوش مصنوعی در ماه' },
  ai_kb_max_pages: {
    label: 'سازنده پایگاه دانش — حداکثر صفحات هر خزش',
    description:
      'سقف صفحات خزش وب‌سایت در سازنده پایگاه دانش هوش مصنوعی. کلید قدیمی: وقتی ai_agent_web_source_max_pages تنظیم نشده باشد، برای دریافت صفحات وب عامل هوش مصنوعی هم به‌عنوان مقدار جایگزین استفاده می‌شود.',
  },
  ai_kb_max_depth: {
    label: 'سازنده پایگاه دانش — عمق خزش',
    description:
      'سقف عمق خزش وب‌سایت در سازنده پایگاه دانش هوش مصنوعی. کلید قدیمی: وقتی ai_agent_web_source_max_depth تنظیم نشده باشد، برای دریافت صفحات وب عامل هوش مصنوعی هم به‌عنوان مقدار جایگزین استفاده می‌شود.',
  },
  ai_kb_jobs_per_month: {
    label: 'سازنده پایگاه دانش — کار در ماه',
    description:
      'تعداد کارهای خزش سازنده پایگاه دانش هوش مصنوعی در ماه. کلید قدیمی: وقتی ai_agent_web_source_jobs_per_month تنظیم نشده باشد، برای دریافت صفحات وب عامل هوش مصنوعی هم به‌عنوان مقدار جایگزین استفاده می‌شود.',
  },
  ai_agent_web_source_max_pages: {
    label: 'عامل هوش مصنوعی — صفحات وب: حداکثر صفحات هر منبع',
    description:
      'فقط برای دریافت منبع «صفحات وب» عامل هوش مصنوعی (Data Hub)، مقدار ai_kb_max_pages را بازنویسی می‌کند. برای ادامه استفاده از مقدار مشترک/قدیمی ai_kb_max_pages آن را تنظیم نکنید.',
  },
  ai_agent_web_source_max_depth: {
    label: 'عامل هوش مصنوعی — صفحات وب: عمق خزش',
    description:
      'فقط برای دریافت منبع «صفحات وب» عامل هوش مصنوعی (Data Hub)، مقدار ai_kb_max_depth را بازنویسی می‌کند. برای ادامه استفاده از مقدار مشترک/قدیمی ai_kb_max_depth آن را تنظیم نکنید.',
  },
  ai_agent_web_source_jobs_per_month: {
    label: 'عامل هوش مصنوعی — صفحات وب: کار همگام‌سازی در ماه',
    description:
      'فقط برای دریافت منبع «صفحات وب» عامل هوش مصنوعی (Data Hub)، مقدار ai_kb_jobs_per_month را بازنویسی می‌کند. برای ادامه استفاده از مقدار مشترک/قدیمی ai_kb_jobs_per_month آن را تنظیم نکنید.',
  },
  ai_kb_file_size_mb: { label: 'عامل هوش مصنوعی — حداکثر حجم فایل' },
  ai_kb_file_count: { label: 'عامل هوش مصنوعی — حداکثر تعداد فایل' },
  included_ai_allowance_irr: {
    label: 'سهمیه هوش مصنوعی در ماه',
    description:
      'سهمیه ریالی هوش مصنوعی (IRR) که بخش صورتحساب مصرف هوش مصنوعی در ابتدای هر دوره صورتحساب به فضای کاری می‌دهد. دقیقاً یک بار برای هر (فضای کاری، دوره) به‌صورت بسته موجودی PLAN_ALLOWANCE داده می‌شود که در پایان دوره منقضی می‌شود؛ سهمیه استفاده‌نشده هرگز به دوره بعد منتقل نمی‌شود و به اعتبار خریداری‌شده تبدیل نمی‌شود. مصرف برابر هزینه مشتری است که از مصرف واقعی ارائه‌دهنده محاسبه می‌شود (docs/AI_BILLING_ARCHITECTURE.md را ببینید). محدودیت فقط در حالت صورتحساب ENFORCED اعمال می‌شود؛ در حالت METER_ONLY مصرف اندازه‌گیری می‌شود اما هرگز رد نمی‌شود. 0 = بدون سهمیه.',
  },

  // ─── SEO limits ───
  seo_max_pages_per_crawl: {
    label: 'سئو — حداکثر صفحات هر ممیزی',
    description: 'حداکثر تعداد صفحاتی که خزنده سئو در یک اجرای ممیزی بازدید می‌کند.',
  },
  seo_max_depth: {
    label: 'سئو — حداکثر عمق خزش',
    description: 'حداکثر عمق لینک (تعداد کلیک از صفحه اصلی) که خزنده سئو در یک اجرای ممیزی دنبال می‌کند.',
  },
  seo_workspace_concurrent_jobs: {
    label: 'سئو — ممیزی‌های هم‌زمان',
    description:
      'حداکثر تعداد ممیزی‌های سئو که می‌توانند هم‌زمان برای کل فضای کاری و همه وب‌سایت‌های ثبت‌شده آن در صف یا در حال اجرا باشند.',
  },
  seo_crawl_frequency_hours: {
    label: 'سئو — فاصله ممیزی مجدد (ساعت)',
    description: 'حداقل تعداد ساعتی که باید از آخرین ممیزی یک وب‌سایت بگذرد تا ممیزی بعدی برای آن شروع شود.',
  },
  seo_backlinks_max_per_scan: {
    label: 'سئو — حداکثر بک‌لینک در هر اسکن',
    description: 'حداکثر تعداد ردیف‌های بک‌لینک که در یک اسکن بک‌لینک دریافت و ذخیره می‌شوند.',
  },
  seo_backlinks_workspace_concurrent_scans: {
    label: 'سئو — اسکن‌های هم‌زمان بک‌لینک',
    description: 'حداکثر تعداد اسکن‌های بک‌لینک که می‌توانند هم‌زمان برای کل فضای کاری در صف یا در حال اجرا باشند.',
  },
  seo_backlinks_scan_frequency_hours: {
    label: 'سئو — فاصله اسکن مجدد بک‌لینک (ساعت)',
    description: 'حداقل تعداد ساعتی که باید از آخرین اسکن بک‌لینک یک وب‌سایت بگذرد تا اسکن بعدی برای آن شروع شود.',
  },
  seo_keywords_max_per_lookup: {
    label: 'سئو — حداکثر کلمه کلیدی در هر جستجو',
    description: 'حداکثر تعداد کلمات کلیدی پایه که در یک جستجوی تحقیق کلمات کلیدی پذیرفته می‌شود.',
  },
  seo_keywords_workspace_concurrent_runs: {
    label: 'سئو — جستجوهای هم‌زمان کلمات کلیدی',
    description:
      'حداکثر تعداد جستجوهای تحقیق کلمات کلیدی که می‌توانند هم‌زمان برای کل فضای کاری در صف یا در حال اجرا باشند.',
  },
  seo_keywords_lookup_frequency_hours: {
    label: 'سئو — فاصله جستجوی مجدد کلمات کلیدی (ساعت)',
    description:
      'حداقل تعداد ساعتی که باید از آخرین جستجوی کلمات کلیدی یک وب‌سایت بگذرد تا جستجوی بعدی برای آن شروع شود.',
  },
  seo_rank_tracking_max_keywords: {
    label: 'سئو — حداکثر کلمات کلیدی رهگیری‌شده هر سایت',
    description: 'حداکثر تعداد کلمات کلیدی که یک وب‌سایت می‌تواند هم‌زمان در فهرست رهگیری رتبه داشته باشد.',
  },
  seo_rank_tracking_check_frequency_hours: {
    label: 'سئو — فاصله بررسی مجدد رتبه (ساعت)',
    description: 'هر چند ساعت یک بار جایگاه هر کلمه کلیدی رهگیری‌شده دوباره بررسی شود. 24 = روزانه، 168 = هفتگی.',
  },
  seo_performance_max_pages_per_audit: {
    label: 'سئو — حداکثر صفحات هر ممیزی عملکرد',
    description: 'حداکثر تعداد صفحاتی که در یک اجرای ممیزی عملکرد از نظر Core Web Vitals بررسی می‌شوند.',
  },
  seo_performance_audit_frequency_hours: {
    label: 'سئو — فاصله ممیزی مجدد عملکرد (ساعت)',
    description: 'حداقل تعداد ساعتی که باید از آخرین ممیزی عملکرد یک خزش بگذرد تا ممیزی بعدی برای آن شروع شود.',
  },
  seo_gsc_max_properties: {
    label: 'سئو — حداکثر پراپرتی‌های متصل GSC',
    description: 'حداکثر تعداد پراپرتی‌های Google Search Console که یک فضای کاری می‌تواند هم‌زمان متصل کند.',
  },
  seo_gsc_sync_frequency_hours: {
    label: 'سئو — فاصله به‌روزرسانی داده GSC (ساعت)',
    description: 'حداقل تعداد ساعت بین دو به‌روزرسانی داده‌های ذخیره‌شده Search Console برای یک پراپرتی متصل.',
  },
  seo_explorer_max_backlinks_per_scan: {
    label: 'سئو — حداکثر بک‌لینک در هر اسکن کاوشگر',
    description: 'حداکثر تعداد ردیف‌های بک‌لینک که در یک جستجوی بک‌لینک کاوشگر سایت دریافت و ذخیره می‌شوند.',
  },
  seo_explorer_max_keywords_per_scan: {
    label: 'سئو — حداکثر کلمه کلیدی در هر اسکن کاوشگر',
    description: 'حداکثر تعداد ردیف‌های کلمات کلیدی ارگانیک که در یک جستجوی کلمات کلیدی کاوشگر سایت دریافت و ذخیره می‌شوند.',
  },
  seo_explorer_workspace_concurrent_scans: {
    label: 'سئو — جستجوهای هم‌زمان کاوشگر',
    description:
      'حداکثر تعداد جستجوهای کاوشگر سایت (مجموع بک‌لینک و کلمات کلیدی) که می‌توانند هم‌زمان برای کل فضای کاری در صف یا در حال اجرا باشند.',
  },
  seo_explorer_scan_frequency_hours: {
    label: 'سئو — فاصله جستجوی مجدد کاوشگر (ساعت)',
    description:
      'حداقل تعداد ساعتی که باید از آخرین جستجوی کاوشگر سایت از یک نوع برای همان دامنه بگذرد تا جستجوی بعدی شروع شود.',
  },
  web_analytics_max_funnels: {
    label: 'سئو — حداکثر قیف‌های ذخیره‌شده',
    description: 'حداکثر تعداد قیف‌های ذخیره‌شده تحلیل وب که یک فضای کاری می‌تواند تعریف کند.',
  },
  bot_analytics_max_log_lines: {
    label: 'سئو — حداکثر خطوط لاگ در هر بارگذاری',
    description: 'حداکثر تعداد خطوط یک لاگ دسترسی بارگذاری‌شده که فضای کاری می‌تواند در هر بار ورود پردازش کند.',
  },
  brand_radar_max_topics: {
    label: 'سئو — حداکثر موضوعات هوش مصنوعی رادار برند',
    description: 'حداکثر تعداد موضوعات/پرامپت‌های رهگیری دیده‌شدن در هوش مصنوعی که فضای کاری می‌تواند تعریف کند.',
  },
  brand_radar_max_competitors: {
    label: 'سئو — حداکثر رقبای رادار برند',
    description: 'حداکثر تعداد نام برندهای رقیب که فضای کاری می‌تواند در رادار برند رهگیری کند.',
  },
  brand_radar_check_frequency_hours: {
    label: 'سئو — فاصله بررسی رادار برند (ساعت)',
    description:
      'حداقل ساعاتی که فضای کاری باید بین دو اجرای کامل بررسی رادار برند صبر کند (هزینه اعتبار هوش مصنوعی و ارائه‌دهنده رهگیری رتبه را محدود می‌کند).',
  },
};

const GROUPS_FA: Record<string, string> = {
  modules: 'ماژول‌ها',
  channels: 'کانال‌ها',
  commerce: 'فروشگاه',
  ai: 'هوش مصنوعی',
  support: 'پشتیبانی',
  security: 'امنیت',
  branding: 'برندینگ',
  widget: 'ویجت',
  inbox: 'صندوق ورودی',
  mobile: 'اپلیکیشن موبایل',
  calls: 'تماس‌ها',
  contacts: 'مخاطبین',
  team: 'تیم',
  usage: 'مصرف',
  seo: 'سئو',
};

const UNITS_FA: Record<string, string> = {
  count: 'تعداد',
  bytes: 'بایت',
  mb: 'مگابایت',
  gb: 'گیگابایت',
  seconds: 'ثانیه',
  minutes: 'دقیقه',
  hours: 'ساعت',
  per_month: 'در ماه',
  per_day: 'در روز',
  percent: 'درصد',
  boolean: 'روشن/خاموش',
  days: 'روز',
};

const BUCKETS_FA: Record<string, string> = {
  entitlements: 'دسترسی‌ها',
  limits: 'محدودیت‌ها',
};

/** Server-side plan validation messages (`validatePlanPayload` in the registry). */
const ISSUE_PATTERNS_FA: Array<[RegExp, (...m: string[]) => string]> = [
  [/^Unknown entitlement key '(.+)' \(not in registry\)$/, (k) => `کلید دسترسی ناشناخته «${k}» (در رجیستری نیست)`],
  [/^Unknown limit key '(.+)' \(not in registry\)$/, (k) => `کلید محدودیت ناشناخته «${k}» (در رجیستری نیست)`],
  [/^Entitlement '(.+)' must be boolean$/, (k) => `مقدار دسترسی «${k}» باید روشن/خاموش (boolean) باشد`],
  [
    /^Key '(.+)' is a limit; expected in 'limits' not 'entitlements'$/,
    (k) => `کلید «${k}» یک محدودیت است و باید در limits باشد، نه entitlements`,
  ],
  [
    /^Limit '(.+)' must be a finite number \(use -1 for unlimited\)$/,
    (k) => `محدودیت «${k}» باید یک عدد معتبر باشد (برای نامحدود از ${NEG_ONE} استفاده کنید)`,
  ],
  [
    /^Key '(.+)' is not a 'limit' in registry \(type=(.+)\)$/,
    (k, type) => `کلید «${k}» در رجیستری از نوع محدودیت نیست (نوع: ${type})`,
  ],
];

const isFa = (locale: string) => locale === 'fa';

export function capabilityLabel(cap: Pick<CapabilityDefinition, 'key' | 'label'>, locale: string): string {
  return (isFa(locale) && CAPABILITIES_FA[cap.key]?.label) || cap.label;
}

export function capabilityDescription(
  cap: Pick<CapabilityDefinition, 'key' | 'description'>,
  locale: string,
): string | undefined {
  if (!cap.description) return undefined;
  return (isFa(locale) && CAPABILITIES_FA[cap.key]?.description) || cap.description;
}

export function capabilityGroupLabel(group: string, locale: string): string {
  return (isFa(locale) && GROUPS_FA[group]) || group;
}

export function capabilityUnitLabel(unit: string, locale: string): string {
  return (isFa(locale) && UNITS_FA[unit]) || unit;
}

export function planBucketLabel(bucket: string, locale: string): string {
  return (isFa(locale) && BUCKETS_FA[bucket]) || bucket;
}

export function planIssueMessage(message: string, locale: string): string {
  if (!isFa(locale)) return message;
  for (const [pattern, render] of ISSUE_PATTERNS_FA) {
    const match = pattern.exec(message);
    if (match) return render(...match.slice(1));
  }
  return message;
}

/** Localised currency name with its ISO code, e.g. «دلار امریکا (USD)». */
export function currencyLabel(code: string, locale: string): string {
  try {
    const name = new Intl.DisplayNames([locale], { type: 'currency' }).of(code);
    return name && name !== code ? `${name} (${code})` : code;
  } catch {
    return code;
  }
}

/** Localised language name for a locale code, e.g. `en` → «انگلیسی». */
export function languageLabel(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(code) || code;
  } catch {
    return code;
  }
}

/** Exposed for the coverage test only. */
export const __capabilityI18nFa = {
  capabilities: CAPABILITIES_FA,
  groups: GROUPS_FA,
  units: UNITS_FA,
  issuePatterns: ISSUE_PATTERNS_FA,
};
