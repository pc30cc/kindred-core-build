/**
 * Localized names and descriptions for every plan capability
 * (server/services/billing/capabilityRegistry.ts), its groups and its units.
 *
 * The registry speaks English only. Everything that shows a capability to a
 * person — the Super Admin plan editor and workspace console, the customer
 * Plan & usage panel, the "not in your plan" gates — reads it through here,
 * so a capability has one name per language everywhere.
 *
 * English labels mirror the registry exactly (a test keeps them equal), so
 * surfaces without the catalog still show the same English name; English
 * descriptions come from the registry itself.
 */

export type CapabilityLocale = 'en' | 'fa' | 'tr';

interface CapabilityText {
  label: string;
  description?: string;
}

export function capabilityLocale(locale: string | null | undefined): CapabilityLocale {
  return locale === 'fa' || locale === 'tr' ? locale : 'en';
}

const U = '‎-1'; // "-1" kept left-to-right inside Persian text

const EN_LABELS: Record<string, string> = {
  chat: 'Live Chat',
  knowledge_base: 'Knowledge Base',
  ai_assistant: 'AI Assistant',
  visitor_tracking: 'Visitor Tracking',
  email_campaigns: 'Email Campaigns',
  automation: 'Automation',
  analytics: 'Analytics',
  omnichannel: 'Omnichannel',
  custom_branding: 'Custom Branding',
  api_access: 'API Access',
  voice_video: 'Voice & Video',
  help_center: 'Help Center',
  call_center: 'Call Center',
  contacts: 'Contacts',
  seo: 'SEO / Website Audit',
  commerce: 'Commerce Integrations',
  commerce_catalog: 'Commerce — Product Catalog',
  commerce_orders: 'Commerce — Orders & Tracking',
  commerce_customer_history: 'Commerce — Customer Order History',
  commerce_max_connected_stores: 'Commerce — Connected Stores',
  chat_widget: 'Chat Widget',
  email: 'Email',
  whatsapp: 'WhatsApp',
  sms: 'SMS',
  instagram: 'Instagram',
  telegram: 'Telegram',
  bale: 'Bale',
  gmail: 'Gmail',
  yahoomail: 'Yahoo Mail',
  voice: 'Voice Calls',
  video: 'Video Calls',
  advanced_ai_agent: 'Advanced AI Agent',
  ai_operator_assist: 'AI Operator Assist',
  ai_kb_builder: 'AI KB Builder',
  priority_support: 'Priority Support',
  sso: 'SSO / SAML',
  audit_logs: 'Audit Logs',
  white_label: 'White-label Branding',
  remove_powered_by: 'Remove "Powered by" (legacy)',
  widget_powered_by: 'Show Widget "Powered by" Footer',
  widget_powered_by_toggle: 'Workspace May Hide "Powered by"',
  widget_attachments: 'Widget File Attachments',
  widget_voice_notes: 'Widget Voice Notes',
  widget_emoji: 'Widget Emoji Picker',
  widget_smart_engagement: 'Widget Smart Engagement',
  ai_proactive_nudge: 'AI Proactive Nudge',
  widget_business_hours: 'Widget Business Hours',
  widget_domain_allowlist: 'Widget Domain Allowlist',
  max_widget_domains: 'Max Widget Domains',
  widget_assignment_routing: 'Automatic Chat Assignment',
  widget_raw_ip_storage: 'Store Raw Visitor IP',
  widget_reply_time_text: 'Custom Reply-Time Note',
  widget_welcome_message: 'Custom Welcome Message',
  widget_launcher_label: 'Custom Launcher Bubble Text',
  widget_launcher_size: 'Custom Launcher Size',
  widget_launcher_icon: 'Custom Launcher Icon',
  widget_composer_placeholder: 'Custom Composer Placeholder',
  widget_team_avatars: 'Online Operator Avatars',
  widget_workspace_logo: 'Workspace Logo in Widget',
  widget_appearance: 'Widget Appearance Editor',
  widget_behavior: 'Widget Behaviour Settings',
  widget_prechat_form: 'Widget Pre-chat Form',
  inbox_ai_queue: 'Inbox AI Queue Tab',
  inbox_needs_human: 'Inbox "Needs Human" Tab',
  inbox_team_chat: 'Inbox Colleagues Chat',
  mobile_promo_banner: 'Mobile Promo Banner',
  mobile_promo_fullscreen: 'Mobile Full-screen Promo',
  mobile_promo_interval_minutes: 'Minutes Between Full-screen Promos',
  call_recording: 'Call Recording',
  call_queue: 'Call Queue',
  call_callbacks: 'Call Callbacks',
  contact_import: 'Contact Import',
  contact_create: 'Contact Create',
  contact_edit: 'Contact Edit',
  contact_export: 'Contact Export',
  contact_tags: 'Contact Tags',
  contact_notes: 'Contact Notes',
  bulk_contact_actions: 'Bulk Contact Actions',
  contact_ip_visibility: 'Contact IP Visibility',
  max_agents: 'Max Agents',
  max_kb_articles: 'Knowledge Base Articles',
  max_workspaces: 'Max Workspaces',
  max_conversations: 'Conversations / month',
  max_visitors: 'Tracked Visitors / month',
  ai_credits_per_month: 'AI Credits / month',
  ai_kb_max_pages: 'AI KB Builder — Max pages per crawl',
  ai_kb_max_depth: 'AI KB Builder — Crawl depth',
  ai_kb_jobs_per_month: 'AI KB Builder — Jobs / month',
  ai_agent_web_source_max_pages: 'AI Agent — Web Pages: Max pages per source',
  ai_agent_web_source_max_depth: 'AI Agent — Web Pages: Crawl depth',
  ai_agent_web_source_jobs_per_month: 'AI Agent — Web Pages: Sync jobs / month',
  ai_kb_file_size_mb: 'AI Agent — Max file size',
  ai_kb_file_count: 'AI Agent — Max files',
  storage_gb: 'Storage',
  data_retention_days: 'Data Retention',
  max_contacts: 'Max Contacts',
  max_concurrent_calls: 'Max Concurrent Calls',
  max_call_minutes_per_month: 'Call Minutes / Month',
  recording_retention_days: 'Call Recording Retention',
  max_call_recordings: 'Max Call Recordings',
  max_call_recording_storage_mb: 'Recording Storage',
  included_ai_allowance_irr: 'AI Allowance / Month',
  seo_max_pages_per_crawl: 'SEO — Max pages per audit',
  seo_max_depth: 'SEO — Max crawl depth',
  seo_workspace_concurrent_jobs: 'SEO — Concurrent audits',
  seo_crawl_frequency_hours: 'SEO — Re-audit cooldown (hours)',
  seo_backlinks: 'SEO — Backlink Analysis',
  seo_backlinks_max_per_scan: 'SEO — Max backlinks per scan',
  seo_backlinks_workspace_concurrent_scans: 'SEO — Concurrent backlink scans',
  seo_backlinks_scan_frequency_hours: 'SEO — Backlink re-scan cooldown (hours)',
  seo_keywords: 'SEO — Keyword Research',
  seo_keywords_max_per_lookup: 'SEO — Max keywords per lookup',
  seo_keywords_workspace_concurrent_runs: 'SEO — Concurrent keyword lookups',
  seo_keywords_lookup_frequency_hours: 'SEO — Keyword lookup cooldown (hours)',
  seo_rank_tracking: 'SEO — Rank Tracking',
  seo_rank_tracking_max_keywords: 'SEO — Max tracked keywords per site',
  seo_rank_tracking_check_frequency_hours: 'SEO — Rank re-check interval (hours)',
  seo_performance: 'SEO — Performance Auditing',
  seo_performance_max_pages_per_audit: 'SEO — Max pages per performance audit',
  seo_performance_audit_frequency_hours: 'SEO — Performance re-audit cooldown (hours)',
  seo_gsc_insights: 'SEO — GSC Insights',
  seo_gsc_max_properties: 'SEO — Max connected GSC properties',
  seo_gsc_sync_frequency_hours: 'SEO — GSC data refresh cooldown (hours)',
  seo_site_explorer: 'SEO — Site Explorer',
  seo_explorer_max_backlinks_per_scan: 'SEO — Max backlinks per Explorer scan',
  seo_explorer_max_keywords_per_scan: 'SEO — Max keywords per Explorer scan',
  seo_explorer_workspace_concurrent_scans: 'SEO — Concurrent Explorer lookups',
  seo_explorer_scan_frequency_hours: 'SEO — Explorer re-lookup cooldown (hours)',
  web_analytics: 'SEO — Web Analytics',
  web_analytics_max_funnels: 'SEO — Max saved funnels',
  email_inbox: 'Email Inbox',
  bot_analytics: 'SEO — Bot Analytics',
  bot_analytics_max_log_lines: 'SEO — Max log lines per import',
  brand_radar: 'SEO — Brand Radar',
  brand_radar_max_topics: 'SEO — Max Brand Radar AI topics',
  brand_radar_max_competitors: 'SEO — Max Brand Radar competitors',
  brand_radar_check_frequency_hours: 'SEO — Brand Radar check frequency (hours)',
};

const FA: Record<string, CapabilityText> = {
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
    description: 'مجموعه‌ی صف تماس، مسیریابی، دعوت به تماس و تماس مجدد. در چارچوب ماژول «صوت و تصویر» و کنترل سراسری تماس‌های پلتفرم کار می‌کند.',
  },
  contacts: {
    label: 'مخاطبین',
    description: 'دفترچه‌ی مخاطبین: ذخیره‌ی مخاطب، جستجو، برچسب، یادداشت و صفحه‌ی جزئیات. امکانات جزئی‌تر (ورود، خروجی، عملیات گروهی، برچسب و یادداشت) در گروه ویژگی‌های «مخاطبین» تنظیم می‌شوند.',
  },
  seo: {
    label: 'سئو / ممیزی وب‌سایت',
    description: 'پیمایش و تحلیل سلامت فنی سئوی وب‌سایتی که در فضای کاری ثبت شده است (تنظیمات ← دامنه‌ها).',
  },
  commerce: {
    label: 'اتصال فروشگاه',
    description: 'اتصال یک فروشگاه (ووکامرس و درگاه‌های بعدی) تا دستیار هوش مصنوعی بتواند از روی داده‌ی واقعی فروشگاه به پرسش‌های محصول، قیمت و سفارش پاسخ دهد.',
  },
  commerce_catalog: {
    label: 'فروشگاه — کاتالوگ محصولات',
    description: 'هوش مصنوعی می‌تواند محصولات، قیمت‌ها و موجودی فروشگاه متصل را جستجو کند.',
  },
  commerce_orders: {
    label: 'فروشگاه — سفارش‌ها و پیگیری',
    description: 'هوش مصنوعی پس از تأیید هویت مشتری به پرسش‌های وضعیت و پیگیری سفارش پاسخ می‌دهد.',
  },
  commerce_customer_history: {
    label: 'فروشگاه — سابقه‌ی سفارش مشتری',
    description: 'هوش مصنوعی می‌تواند سفارش‌های اخیر مشتریِ تأییدشده را فهرست کند.',
  },
  commerce_max_connected_stores: { label: 'فروشگاه — تعداد فروشگاه متصل' },
  chat_widget: { label: 'ویجت چت' },
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
  advanced_ai_agent: {
    label: 'دستیار هوش مصنوعی پیشرفته',
    description: 'رزرو شده: هنوز هیچ قابلیتی این گزینه را نمی‌خواند، پس فعال کردن آن فعلاً چیزی اضافه نمی‌کند. به این دلیل نگه داشته شده که ممکن است در پلن‌های موجود تنظیم شده باشد.',
  },
  ai_operator_assist: { label: 'کمک‌کار هوشمند اپراتور' },
  ai_kb_builder: { label: 'سازنده‌ی پایگاه دانش با هوش مصنوعی' },
  priority_support: { label: 'پشتیبانی با اولویت' },
  sso: { label: 'ورود یکپارچه (SSO / SAML)' },
  audit_logs: { label: 'گزارش‌های ممیزی' },
  white_label: { label: 'برندینگ کاملاً اختصاصی (White-label)' },
  remove_powered_by: {
    label: 'حذف «Powered by» (قدیمی)',
    description: 'منسوخ — جای خود را به «نمایش پانویس Powered by ویجت» داده است. فقط برای پلن‌هایی که هنوز منتقل نشده‌اند به‌عنوان جایگزین خوانده می‌شود.',
  },
  widget_powered_by: {
    label: 'نمایش پانویس «Powered by» در ویجت',
    description: 'آیا ویجت چت پانویس معرفی پلتفرم را نشان دهد. متن، نام برند و لینک آن در اختیار مدیر پلتفرم است (مدیریت ← تنظیمات ویجت ← Powered by). اگر برای پلنی خاموش شود پانویس کاملاً حذف می‌شود و محتوای ویجت تا پایین کادر ادامه پیدا می‌کند.',
  },
  widget_powered_by_toggle: {
    label: 'اجازه‌ی مخفی‌کردن «Powered by» به فضای کاری',
    description: 'صاحب فضای کاری می‌تواند پانویس Powered by را در ویجت ← ظاهر ← لوگو و برند خاموش کند. این کلید در فضای کاری به‌طور پیش‌فرض روشن است، پس تا صاحب فضای کاری آن را خاموش نکند نمایش داده می‌شود. به روشن بودن «نمایش پانویس Powered by در ویجت» نیاز دارد.',
  },
  widget_attachments: {
    label: 'پیوست فایل در ویجت',
    description: 'بازدیدکنندگان می‌توانند در کادر نوشتن پیام ویجت چت، فایل پیوست کنند.',
  },
  widget_voice_notes: {
    label: 'پیام صوتی در ویجت',
    description: 'بازدیدکنندگان می‌توانند از ویجت چت پیام صوتی ضبط و ارسال کنند.',
  },
  widget_emoji: {
    label: 'انتخابگر ایموجی ویجت',
    description: 'انتخابگر ایموجی در کادر نوشتن پیام ویجت چت.',
  },
  widget_smart_engagement: {
    label: 'تعامل هوشمند ویجت',
    description: 'پیام‌های تشویقی، اطلاعیه‌ها و پیام‌های پیش‌دستانه بر اساس رفتار بازدیدکننده (ویجت ← تعامل هوشمند).',
  },
  ai_proactive_nudge: {
    label: 'پیشنهاد پیش‌دستانه‌ی هوش مصنوعی',
    description: 'پیام‌های کوتاه کنار دکمه‌ی ویجت که هوش مصنوعی بر اساس مسیر بازدیدکننده می‌سازد (ویجت ← تعامل هوشمند ← دستیار پیش‌دستانه‌ی هوش مصنوعی). به «تعامل هوشمند ویجت» و «دستیار هوش مصنوعی» نیاز دارد.',
  },
  widget_business_hours: {
    label: 'ساعات کاری ویجت',
    description: 'ساعات پاسخ‌گویی و رفتار ویجت در زمان آفلاین، مخصوص هر فضای کاری.',
  },
  widget_domain_allowlist: {
    label: 'فهرست دامنه‌های مجاز ویجت',
    description: 'محدود کردن جاهایی که ویجت می‌تواند در آن‌ها نصب شود با فهرست دامنه‌های مجاز. سقف آن را «حداکثر دامنه‌ی ویجت» تعیین می‌کند.',
  },
  max_widget_domains: {
    label: 'حداکثر دامنه‌ی ویجت',
    description: `بیشترین تعداد دامنه‌ی مجاز برای نصب ویجت در هر فضای کاری. هنگام ذخیره‌ی فهرست دامنه‌ها بررسی می‌شود. مقدار ${U} یعنی نامحدود.`,
  },
  widget_assignment_routing: {
    label: 'واگذاری خودکار گفتگو',
    description: 'واگذاری خودکار یا نوبتی گفتگوهای ارجاع‌شده به اپراتورها. اگر خاموش باشد، فضای کاری فقط می‌تواند گفتگوها را دستی واگذار کند.',
  },
  widget_raw_ip_storage: {
    label: 'ذخیره‌ی IP کامل بازدیدکننده',
    description: 'اجازه به فضای کاری برای ذخیره‌ی نشانی IP کامل (بدون پوشاندن) بازدیدکننده. از نظر حریم خصوصی حساس است و به‌طور پیش‌فرض خاموش است.',
  },
  widget_reply_time_text: {
    label: 'متن دلخواه زمان پاسخ‌گویی',
    description: 'فضای کاری می‌تواند متن «معمولاً در … پاسخ می‌دهیم» زیر نام برند در ویجت را خودش بنویسد.',
  },
  widget_welcome_message: {
    label: 'پیام خوش‌آمد دلخواه',
    description: 'فضای کاری می‌تواند پیام خوش‌آمد ویجت را خودش بنویسد؛ در غیر این صورت متن پیش‌فرض همان زبان نمایش داده می‌شود.',
  },
  widget_launcher_label: {
    label: 'متن دلخواه حباب دکمه‌ی ویجت',
    description: 'فضای کاری می‌تواند متن حبابی را که کنار دکمه‌ی شناور ویجت نمایش داده می‌شود خودش بنویسد.',
  },
  widget_launcher_size: {
    label: 'اندازه‌ی دلخواه دکمه‌ی ویجت',
    description: 'فضای کاری می‌تواند اندازه‌ی دکمه‌ی شناور ویجت را تغییر دهد؛ در غیر این صورت اندازه‌ی پیش‌فرض ۵۶ پیکسل استفاده می‌شود.',
  },
  widget_launcher_icon: {
    label: 'آیکون دلخواه دکمه‌ی ویجت',
    description: 'فضای کاری می‌تواند آیکون دکمه‌ی شناور ویجت را انتخاب کند؛ در غیر این صورت آیکون پیش‌فرض چت استفاده می‌شود.',
  },
  widget_composer_placeholder: {
    label: 'متن راهنمای دلخواه کادر پیام',
    description: 'فضای کاری می‌تواند متن راهنمای «پیام خود را بنویسید» در کادر نوشتن پیام ویجت را خودش بنویسد.',
  },
  widget_team_avatars: {
    label: 'تصویر اپراتورهای آنلاین',
    description: 'نمایش تصویر اپراتورهای آنلاین داخل دکمه‌ی «شروع گفتگو»ی ویجت.',
  },
  widget_workspace_logo: {
    label: 'لوگوی فضای کاری در ویجت',
    description: 'نمایش لوگوی فضای کاری در سربرگ ویجت. اگر مجاز نباشد، ویجت فقط نام برند را نشان می‌دهد.',
  },
  widget_appearance: {
    label: 'ویرایشگر ظاهر ویجت',
    description: 'فضای کاری می‌تواند ظاهر ویجت را سفارشی کند (ویجت ← ظاهر). اگر مجاز نباشد، پیش‌فرض‌های پلتفرم استفاده می‌شوند.',
  },
  widget_behavior: {
    label: 'تنظیمات رفتار ویجت',
    description: 'فضای کاری می‌تواند رفتار ویجت را تنظیم کند (ویجت ← رفتار).',
  },
  widget_prechat_form: {
    label: 'فرم پیش از گفتگو',
    description: 'گرفتن اطلاعات بازدیدکننده پیش از شروع گفتگو (ویجت ← فرم پیش از گفتگو).',
  },
  inbox_ai_queue: {
    label: 'تب صف هوش مصنوعی در صندوق ورودی',
    description: 'تب گفتگوهای خودکار که هوش مصنوعی مدیریت می‌کند، در صندوق ورودی اپراتور.',
  },
  inbox_needs_human: {
    label: 'تب «نیاز به انسان» در صندوق ورودی',
    description: 'گفتگوهایی که هوش مصنوعی به اپراتور ارجاع داده و منتظر اپراتورند.',
  },
  inbox_team_chat: {
    label: 'گفتگوی همکاران در صندوق ورودی',
    description: 'تب گفتگوی داخلی اپراتورها با یکدیگر، داخل صندوق ورودی.',
  },
  mobile_promo_banner: {
    label: 'بنر تبلیغاتی موبایل',
    description: 'نمایش بنر تبلیغاتی خود پلتفرم در بالای صندوق ورودی اپ iOS برای فضاهای کاری این پلن.',
  },
  mobile_promo_fullscreen: {
    label: 'تبلیغ تمام‌صفحه‌ی موبایل',
    description: 'نمایش گاه‌به‌گاه یک تبلیغ تمام‌صفحه در اپ iOS برای فضاهای کاری این پلن. فاصله‌ی نمایش را محدودیت‌های زیر تعیین می‌کنند و همیشه قابل بستن است.',
  },
  mobile_promo_interval_minutes: {
    label: 'فاصله‌ی تبلیغ‌های تمام‌صفحه (دقیقه)',
    description: 'کمترین فاصله‌ی بین دو تبلیغ تمام‌صفحه در اپ iOS. اگر تنظیم پلتفرم سخت‌گیرانه‌تر باشد، همان اعمال می‌شود.',
  },
  call_recording: {
    label: 'ضبط تماس',
    description: 'اپراتورها می‌توانند تماس‌های صوتی و تصویری را ضبط کنند. در چارچوب کلید سراسری ضبط تماس در پلتفرم.',
  },
  call_queue: {
    label: 'صف تماس',
    description: 'دسترسی پلن به صف و مسیریابی تماس‌ها. در چارچوب کلید سراسری صف تماس در پلتفرم.',
  },
  call_callbacks: {
    label: 'درخواست تماس مجدد',
    description: 'اگر زمان پاسخ‌گویی از حد مجاز بگذرد، بازدیدکننده می‌تواند درخواست تماس مجدد بدهد. در چارچوب تنظیم سراسری پیشنهاد تماس مجدد در پلتفرم.',
  },
  contact_import: {
    label: 'ورود مخاطبین',
    description: 'ساخت گروهی مخاطبین با ویزارد ورود فایل CSV. در چارچوب ماژول «مخاطبین».',
  },
  contact_create: {
    label: 'ساخت مخاطب',
    description: 'ساخت دستی مخاطب جدید از دفترچه‌ی مخاطبین. در چارچوب ماژول «مخاطبین».',
  },
  contact_edit: {
    label: 'ویرایش مخاطب',
    description: 'ویرایش مخاطبین موجود (نام، ایمیل، تلفن، یادداشت و برچسب). در چارچوب ماژول «مخاطبین».',
  },
  contact_export: {
    label: 'خروجی مخاطبین',
    description: 'گرفتن خروجی CSV از دفترچه‌ی مخاطبین. در چارچوب ماژول «مخاطبین».',
  },
  contact_tags: {
    label: 'برچسب مخاطبین',
    description: 'برچسب‌گذاری، فیلتر و دسته‌بندی مخاطبین بر اساس برچسب. در چارچوب ماژول «مخاطبین».',
  },
  contact_notes: {
    label: 'یادداشت مخاطبین',
    description: 'یادداشت آزاد روی پرونده‌ی هر مخاطب. در چارچوب ماژول «مخاطبین».',
  },
  bulk_contact_actions: {
    label: 'عملیات گروهی مخاطبین',
    description: 'انتخاب چند مخاطب و انجام عملیات گروهی (مثلاً حذف گروهی) در دفترچه‌ی مخاطبین. در چارچوب ماژول «مخاطبین».',
  },
  contact_ip_visibility: {
    label: 'نمایش IP مخاطب',
    description: 'نمایش نشانی IP بازدیدکننده در صفحه‌ی جزئیات مخاطب. اگر خاموش باشد، IP اصلاً برای مرورگر فرستاده نمی‌شود (در سرور حذف می‌شود). در چارچوب ماژول «مخاطبین».',
  },
  max_agents: { label: 'حداکثر اپراتور' },
  max_kb_articles: {
    label: 'مقاله‌های پایگاه دانش',
    description: `بیشترین تعداد مقاله‌ی پایگاه دانش که هر فضای کاری در هر لحظه می‌تواند داشته باشد؛ حذف مقاله ظرفیت را آزاد می‌کند. هنگام ساخت مقاله با شمارش زنده بررسی می‌شود. اگر این کلید تنظیم نشده باشد، کلیدهای قدیمی ai_kb_max_articles و kb_articles خوانده می‌شوند. مقدار ${U} یعنی نامحدود.`,
  },
  max_workspaces: { label: 'حداکثر فضای کاری' },
  max_conversations: { label: 'گفتگو در ماه' },
  max_visitors: { label: 'بازدیدکننده‌ی ردیابی‌شده در ماه' },
  ai_credits_per_month: { label: 'اعتبار هوش مصنوعی در ماه' },
  ai_kb_max_pages: {
    label: 'سازنده‌ی پایگاه دانش — حداکثر صفحه در هر پیمایش',
    description: 'سقف صفحه‌ها در پیمایش وب‌سایت برای سازنده‌ی پایگاه دانش. کلید قدیمی: اگر «دستیار — صفحات وب: حداکثر صفحه در هر منبع» تنظیم نشده باشد، برای آن هم به کار می‌رود.',
  },
  ai_kb_max_depth: {
    label: 'سازنده‌ی پایگاه دانش — عمق پیمایش',
    description: 'سقف عمق پیمایش وب‌سایت برای سازنده‌ی پایگاه دانش. کلید قدیمی: اگر «دستیار — صفحات وب: عمق پیمایش» تنظیم نشده باشد، برای آن هم به کار می‌رود.',
  },
  ai_kb_jobs_per_month: {
    label: 'سازنده‌ی پایگاه دانش — کار در ماه',
    description: 'تعداد کارهای پیمایش سازنده‌ی پایگاه دانش در هر ماه. کلید قدیمی: اگر «دستیار — صفحات وب: همگام‌سازی در ماه» تنظیم نشده باشد، برای آن هم به کار می‌رود.',
  },
  ai_agent_web_source_max_pages: {
    label: 'دستیار — صفحات وب: حداکثر صفحه در هر منبع',
    description: 'فقط برای دریافت منبع «صفحات وب» دستیار هوش مصنوعی (مرکز داده)، جایگزین «حداکثر صفحه در هر پیمایش» می‌شود. خالی بگذارید تا همان مقدار مشترک قدیمی استفاده شود.',
  },
  ai_agent_web_source_max_depth: {
    label: 'دستیار — صفحات وب: عمق پیمایش',
    description: 'فقط برای دریافت منبع «صفحات وب» دستیار هوش مصنوعی (مرکز داده)، جایگزین «عمق پیمایش» سازنده‌ی پایگاه دانش می‌شود. خالی بگذارید تا همان مقدار مشترک قدیمی استفاده شود.',
  },
  ai_agent_web_source_jobs_per_month: {
    label: 'دستیار — صفحات وب: همگام‌سازی در ماه',
    description: 'فقط برای دریافت منبع «صفحات وب» دستیار هوش مصنوعی (مرکز داده)، جایگزین «کار در ماه» سازنده‌ی پایگاه دانش می‌شود. خالی بگذارید تا همان مقدار مشترک قدیمی استفاده شود.',
  },
  ai_kb_file_size_mb: { label: 'دستیار — حداکثر حجم فایل' },
  ai_kb_file_count: { label: 'دستیار — حداکثر تعداد فایل' },
  storage_gb: { label: 'فضای ذخیره‌سازی' },
  data_retention_days: { label: 'مدت نگهداری داده' },
  max_contacts: {
    label: 'حداکثر مخاطبین',
    description: 'بیشترین تعداد مخاطبی که هر فضای کاری در هر لحظه می‌تواند داشته باشد؛ حذف مخاطب ظرفیت را آزاد می‌کند و ویرایش، برچسب و یادداشت ظرفیتی مصرف نمی‌کنند. هنگام ساخت تکی و گروهی مخاطب با شمارش زنده بررسی می‌شود.',
  },
  max_concurrent_calls: {
    label: 'حداکثر تماس هم‌زمان',
    description: `سقف تماس‌های هم‌زمانِ فعال در کل فضای کاری (در انتظار، در حال زنگ، در حال اتصال و فعال، از هر مبدأ). هنگام شروع تماس توسط اپراتور و درخواست تماس بازدیدکننده از ویجت بررسی می‌شود. در کنار سقف جداگانه‌ای که مدیر پلتفرم برای تماس‌های ویجت تعیین می‌کند اعمال می‌شود؛ هر کدام زودتر برسد مانع می‌شود. مقدار ${U} یعنی نامحدود.`,
  },
  max_call_minutes_per_month: {
    label: 'دقیقه‌ی تماس در ماه',
    description: `سقف دقیقه‌های قابل‌محاسبه‌ی تماس در هر ماه (ماه به وقت UTC). فقط تماس‌های برقرارشده حساب می‌شوند: مدت هر تماس از لحظه‌ی اتصال تا پایان، به دقیقه و رو به بالا گرد می‌شود. زمان پیش از اتصال، صف، انتظار و زمانی که فقط ضبط در جریان است حساب نمی‌شود. هنگام شروع تماس (توسط اپراتور یا درخواست بازدیدکننده از ویجت) بررسی می‌شود. مقدار ${U} یعنی نامحدود.`,
  },
  recording_retention_days: {
    label: 'مدت نگهداری ضبط تماس',
    description: `بیشترین تعداد روزی که فایل ضبط تماس نگه داشته می‌شود و پس از آن برای همیشه حذف می‌شود؛ فایل‌هایی که در «نگهداری قانونی» هستند مستثنا هستند. این مدت هنگام ساخت هر فایل ثبت می‌شود، پس تغییر پلن فقط روی ضبط‌های بعدی اثر دارد. مقدار ${U} یعنی نامحدود.`,
  },
  max_call_recordings: {
    label: 'حداکثر فایل ضبط تماس',
    description: `سقف تعداد فایل‌های ضبط تماسِ نگه‌داشته‌شده برای فضای کاری. پیش از شروع هر ضبط با شمارش زنده بررسی می‌شود و حذف یک ضبط ظرفیت را آزاد می‌کند. مقدار ${U} یعنی نامحدود.`,
  },
  max_call_recording_storage_mb: {
    label: 'فضای ذخیره‌ی ضبط تماس',
    description: `سقف مجموع حجم فایل‌های ضبط تماس فضای کاری (مگابایت). پیش از شروع هر ضبط بررسی می‌شود و حذف یک ضبط ظرفیت را آزاد می‌کند. مقدار ${U} یعنی نامحدود.`,
  },
  included_ai_allowance_irr: {
    label: 'سهمیه‌ی ماهانه‌ی هوش مصنوعی',
    description: 'سهمیه‌ی ریالی هوش مصنوعی که در ابتدای هر دوره‌ی صورتحساب یک بار به فضای کاری داده می‌شود و در پایان همان دوره منقضی می‌شود؛ باقی‌مانده به دوره‌ی بعد منتقل نمی‌شود و به اعتبار خریداری‌شده تبدیل نمی‌شود. مصرف آن هزینه‌ای است که از استفاده‌ی واقعی از سرویس‌دهنده‌ها محاسبه می‌شود. محدودیت فقط در حالت «اعمال» صورتحساب هوش مصنوعی اجرا می‌شود؛ در حالت «فقط اندازه‌گیری» مصرف ثبت می‌شود اما مانع نمی‌شود. مقدار ۰ یعنی بدون سهمیه.',
  },
  seo_max_pages_per_crawl: {
    label: 'سئو — حداکثر صفحه در هر ممیزی',
    description: 'بیشترین تعداد صفحه‌ای که خزنده‌ی سئو در یک اجرای ممیزی بازدید می‌کند.',
  },
  seo_max_depth: {
    label: 'سئو — حداکثر عمق پیمایش',
    description: 'بیشترین عمق لینک (تعداد کلیک از صفحه‌ی اصلی) که خزنده‌ی سئو در یک اجرای ممیزی دنبال می‌کند.',
  },
  seo_workspace_concurrent_jobs: {
    label: 'سئو — ممیزی هم‌زمان',
    description: 'بیشترین تعداد ممیزی سئو که می‌تواند هم‌زمان در صف یا در حال اجرا باشد، برای کل فضای کاری و همه‌ی وب‌سایت‌های ثبت‌شده‌ی آن.',
  },
  seo_crawl_frequency_hours: {
    label: 'سئو — فاصله‌ی ممیزی دوباره (ساعت)',
    description: 'کمترین تعداد ساعتی که باید از آخرین ممیزی یک وب‌سایت بگذرد تا ممیزی تازه‌ای برای آن شروع شود.',
  },
  seo_backlinks: {
    label: 'سئو — تحلیل بک‌لینک',
    description: 'دریافت و مرور پروفایل بک‌لینک وب‌سایت ثبت‌شده در فضای کاری، از طریق سرویس‌دهنده‌ی داده‌ی بک‌لینک که پلتفرم تنظیم کرده است.',
  },
  seo_backlinks_max_per_scan: {
    label: 'سئو — حداکثر بک‌لینک در هر اسکن',
    description: 'بیشترین تعداد بک‌لینکی که در یک اسکن دریافت و ذخیره می‌شود.',
  },
  seo_backlinks_workspace_concurrent_scans: {
    label: 'سئو — اسکن بک‌لینک هم‌زمان',
    description: 'بیشترین تعداد اسکن بک‌لینک که می‌تواند هم‌زمان در صف یا در حال اجرا باشد، برای کل فضای کاری.',
  },
  seo_backlinks_scan_frequency_hours: {
    label: 'سئو — فاصله‌ی اسکن دوباره‌ی بک‌لینک (ساعت)',
    description: 'کمترین تعداد ساعتی که باید از آخرین اسکن بک‌لینک یک وب‌سایت بگذرد تا اسکن تازه‌ای برای آن شروع شود.',
  },
  seo_keywords: {
    label: 'سئو — تحقیق کلمات کلیدی',
    description: 'دریافت حجم جستجو، هزینه‌ی هر کلیک و میزان رقابت برای فهرستی از کلمات کلیدی، از طریق سرویس‌دهنده‌ی داده‌ی کلمات کلیدی که پلتفرم تنظیم کرده است.',
  },
  seo_keywords_max_per_lookup: {
    label: 'سئو — حداکثر کلمه‌ی کلیدی در هر جستجو',
    description: 'بیشترین تعداد کلمه‌ی کلیدی که در یک جستجوی تحقیق کلمات کلیدی پذیرفته می‌شود.',
  },
  seo_keywords_workspace_concurrent_runs: {
    label: 'سئو — جستجوی کلمه‌ی کلیدی هم‌زمان',
    description: 'بیشترین تعداد جستجوی کلمات کلیدی که می‌تواند هم‌زمان در صف یا در حال اجرا باشد، برای کل فضای کاری.',
  },
  seo_keywords_lookup_frequency_hours: {
    label: 'سئو — فاصله‌ی جستجوی دوباره‌ی کلمات کلیدی (ساعت)',
    description: 'کمترین تعداد ساعتی که باید از آخرین جستجوی کلمات کلیدی یک وب‌سایت بگذرد تا جستجوی تازه‌ای برای آن شروع شود.',
  },
  seo_rank_tracking: {
    label: 'سئو — ردیابی رتبه',
    description: 'دنبال کردن فهرستی از کلمات کلیدی و ثبت دوره‌ای رتبه‌ی گوگل آن‌ها برای وب‌سایت ثبت‌شده در فضای کاری.',
  },
  seo_rank_tracking_max_keywords: {
    label: 'سئو — حداکثر کلمه‌ی کلیدی تحت ردیابی برای هر سایت',
    description: 'بیشترین تعداد کلمه‌ی کلیدی که هر وب‌سایت در هر لحظه می‌تواند در فهرست ردیابی رتبه داشته باشد.',
  },
  seo_rank_tracking_check_frequency_hours: {
    label: 'سئو — فاصله‌ی بررسی دوباره‌ی رتبه (ساعت)',
    description: 'هر چند ساعت یک بار رتبه‌ی هر کلمه‌ی کلیدی تحت ردیابی دوباره بررسی شود. ۲۴ یعنی روزانه و ۱۶۸ یعنی هفتگی.',
  },
  seo_performance: {
    label: 'سئو — ممیزی عملکرد',
    description: 'دریافت شاخص‌های Core Web Vitals و امتیازهای Lighthouse برای صفحه‌های وب‌سایت، از طریق سرویس‌دهنده‌ی داده‌ی عملکرد که پلتفرم تنظیم کرده است.',
  },
  seo_performance_max_pages_per_audit: {
    label: 'سئو — حداکثر صفحه در هر ممیزی عملکرد',
    description: 'بیشترین تعداد صفحه‌ای که در یک اجرای ممیزی عملکرد از نظر Core Web Vitals بررسی می‌شود.',
  },
  seo_performance_audit_frequency_hours: {
    label: 'سئو — فاصله‌ی ممیزی دوباره‌ی عملکرد (ساعت)',
    description: 'کمترین تعداد ساعتی که باید از آخرین ممیزی عملکرد یک پیمایش بگذرد تا ممیزی تازه‌ای برای آن شروع شود.',
  },
  seo_gsc_insights: {
    label: 'سئو — تحلیل سرچ کنسول',
    description: 'اتصال یک پراپرتی گوگل سرچ کنسول و مرور داده‌های عملکرد جستجوی آن (کلیک، نمایش، نرخ کلیک و جایگاه) مستقیماً داخل فضای کاری.',
  },
  seo_gsc_max_properties: {
    label: 'سئو — حداکثر پراپرتی متصل سرچ کنسول',
    description: 'بیشترین تعداد پراپرتی گوگل سرچ کنسول که یک فضای کاری می‌تواند هم‌زمان متصل داشته باشد.',
  },
  seo_gsc_sync_frequency_hours: {
    label: 'سئو — فاصله‌ی به‌روزرسانی داده‌ی سرچ کنسول (ساعت)',
    description: 'کمترین تعداد ساعت بین دو به‌روزرسانی داده‌های ذخیره‌شده‌ی سرچ کنسول برای یک پراپرتی متصل.',
  },
  seo_site_explorer: {
    label: 'سئو — کاوشگر سایت',
    description: 'بررسی پروفایل بک‌لینک و کلمات کلیدی ارگانیک هر دامنه‌ای، از جمله رقبا، بدون ثبت آن به‌عنوان وب‌سایت فضای کاری.',
  },
  seo_explorer_max_backlinks_per_scan: {
    label: 'سئو — حداکثر بک‌لینک در هر اسکن کاوشگر',
    description: 'بیشترین تعداد بک‌لینکی که در یک جستجوی بک‌لینک کاوشگر سایت دریافت و ذخیره می‌شود.',
  },
  seo_explorer_max_keywords_per_scan: {
    label: 'سئو — حداکثر کلمه‌ی کلیدی در هر اسکن کاوشگر',
    description: 'بیشترین تعداد کلمه‌ی کلیدی ارگانیک که در یک جستجوی کلمات کلیدی کاوشگر سایت دریافت و ذخیره می‌شود.',
  },
  seo_explorer_workspace_concurrent_scans: {
    label: 'سئو — جستجوی هم‌زمان کاوشگر',
    description: 'بیشترین تعداد جستجوی کاوشگر سایت (بک‌لینک و کلمات کلیدی روی هم) که می‌تواند هم‌زمان در صف یا در حال اجرا باشد، برای کل فضای کاری.',
  },
  seo_explorer_scan_frequency_hours: {
    label: 'سئو — فاصله‌ی جستجوی دوباره در کاوشگر (ساعت)',
    description: 'کمترین تعداد ساعتی که باید از آخرین جستجوی همان نوع برای یک دامنه بگذرد تا جستجوی تازه‌ای برای آن شروع شود.',
  },
  web_analytics: {
    label: 'سئو — تحلیل وب',
    description: 'گزارش ترافیک، مخاطبان و رفتار کاربران (منابع ورودی، صفحه‌ها، موقعیت جغرافیایی، دستگاه‌ها، رویدادهای سفارشی و قیف‌ها) بر پایه‌ی داده‌ی ردیابی بازدیدکنندگان فضای کاری.',
  },
  web_analytics_max_funnels: {
    label: 'سئو — حداکثر قیف ذخیره‌شده',
    description: 'بیشترین تعداد قیف ذخیره‌شده‌ی تحلیل وب که یک فضای کاری می‌تواند تعریف کند.',
  },
  email_inbox: {
    label: 'صندوق ایمیل',
    description: 'یک برنامه‌ی ایمیل واقعی و مستقل داخل پلتفرم (فعلاً جیمیل؛ یاهو میل در برنامه است) — جدا از صندوق ورودی یکپارچه‌ی گفتگوها.',
  },
  bot_analytics: {
    label: 'سئو — تحلیل ربات‌ها',
    description: 'بارگذاری لاگ دسترسی وب‌سرور یا CDN برای دیدن اینکه کدام خزنده‌های موتور جستجو و هوش مصنوعی (Googlebot، GPTBot، ClaudeBot، PerplexityBot و …) از سایت بازدید کرده‌اند و به کدام صفحه‌ها سر زده‌اند.',
  },
  bot_analytics_max_log_lines: {
    label: 'سئو — حداکثر خط لاگ در هر بارگذاری',
    description: 'بیشترین تعداد خط از یک فایل لاگ بارگذاری‌شده که فضای کاری در هر بار ورود می‌تواند پردازش کند.',
  },
  brand_radar: {
    label: 'سئو — رادار برند',
    description: 'دیده‌شدن برند را در دستیارهای هوش مصنوعی (آیا ChatGPT از شما نام می‌برد؟)، رتبه‌های جستجوی ارگانیک و تقاضای واقعی نام برند در سرچ کنسول، در مقایسه با رقبای تحت ردیابی، دنبال می‌کند.',
  },
  brand_radar_max_topics: {
    label: 'سئو — حداکثر موضوع هوش مصنوعی در رادار برند',
    description: 'بیشترین تعداد موضوع یا پرسشی که فضای کاری برای سنجش دیده‌شدن در هوش مصنوعی تعریف می‌کند.',
  },
  brand_radar_max_competitors: {
    label: 'سئو — حداکثر رقیب در رادار برند',
    description: 'بیشترین تعداد نام برند رقیب که فضای کاری می‌تواند در رادار برند دنبال کند.',
  },
  brand_radar_check_frequency_hours: {
    label: 'سئو — فاصله‌ی بررسی رادار برند (ساعت)',
    description: 'کمترین تعداد ساعتی که فضای کاری باید بین دو اجرای کامل رادار برند صبر کند (هزینه‌ی اعتبار هوش مصنوعی و سرویس ردیابی رتبه را محدود می‌کند).',
  },
};

const TR: Record<string, CapabilityText> = {
  chat: { label: 'Canlı Sohbet' },
  knowledge_base: { label: 'Bilgi Bankası' },
  ai_assistant: { label: 'Yapay Zekâ Asistanı' },
  visitor_tracking: { label: 'Ziyaretçi Takibi' },
  email_campaigns: { label: 'E-posta Kampanyaları' },
  automation: { label: 'Otomasyon' },
  analytics: { label: 'Analitik' },
  omnichannel: { label: 'Çok Kanallı' },
  custom_branding: { label: 'Özel Marka' },
  api_access: { label: 'API Erişimi' },
  voice_video: { label: 'Sesli ve Görüntülü' },
  help_center: { label: 'Yardım Merkezi' },
  call_center: {
    label: 'Çağrı Merkezi',
    description: 'Çağrı kuyruğu, yönlendirme, arama davetleri ve geri arama paketi. "Sesli ve Görüntülü" modülü ve platformun genel çağrı denetimiyle sınırlıdır.',
  },
  contacts: {
    label: 'Kişiler',
    description: 'Kişi rehberi: kayıtlı kişiler, arama, etiketleme, notlar ve ayrıntı görünümü. Alt özellikler (içe/dışa aktarma, toplu işlemler, etiketler, notlar) "Kişiler" özellik grubunda ayarlanır.',
  },
  seo: {
    label: 'SEO / Web Sitesi Denetimi',
    description: 'Çalışma alanına kayıtlı bir web sitesinin teknik SEO sağlığını tarar ve analiz eder (Ayarlar → Alan adları).',
  },
  commerce: {
    label: 'Mağaza Entegrasyonları',
    description: 'Yapay zekâ asistanının ürün, fiyat ve sipariş sorularını gerçek mağaza verisiyle yanıtlayabilmesi için bir mağaza bağlayın (WooCommerce ve sonraki sağlayıcılar).',
  },
  commerce_catalog: {
    label: 'Mağaza — Ürün Kataloğu',
    description: 'Yapay zekâ, bağlı mağazadaki ürünleri, fiyatları ve stok durumunu arayabilir.',
  },
  commerce_orders: {
    label: 'Mağaza — Siparişler ve Takip',
    description: 'Yapay zekâ, kimlik doğrulamasından sonra sipariş durumu ve kargo takibi sorularını yanıtlayabilir.',
  },
  commerce_customer_history: {
    label: 'Mağaza — Müşteri Sipariş Geçmişi',
    description: 'Yapay zekâ, doğrulanmış bir müşterinin son siparişlerini listeleyebilir.',
  },
  commerce_max_connected_stores: { label: 'Mağaza — Bağlı Mağaza Sayısı' },
  chat_widget: { label: 'Sohbet Widget’ı' },
  email: { label: 'E-posta' },
  whatsapp: { label: 'WhatsApp' },
  sms: { label: 'SMS' },
  instagram: { label: 'Instagram' },
  telegram: { label: 'Telegram' },
  bale: { label: 'Bale' },
  gmail: { label: 'Gmail' },
  yahoomail: { label: 'Yahoo Mail' },
  voice: { label: 'Sesli Aramalar' },
  video: { label: 'Görüntülü Aramalar' },
  advanced_ai_agent: {
    label: 'Gelişmiş Yapay Zekâ Asistanı',
    description: 'Ayrılmış: henüz hiçbir özellik bu ayarı okumuyor, bu yüzden açmak şu an hiçbir şey sağlamaz. Mevcut planlarda tanımlı olabileceği için korunuyor.',
  },
  ai_operator_assist: { label: 'Yapay Zekâ Operatör Yardımı' },
  ai_kb_builder: { label: 'Yapay Zekâ Bilgi Bankası Oluşturucu' },
  priority_support: { label: 'Öncelikli Destek' },
  sso: { label: 'Tek Oturum Açma (SSO / SAML)' },
  audit_logs: { label: 'Denetim Kayıtları' },
  white_label: { label: 'Beyaz Etiket (White-label) Marka' },
  remove_powered_by: {
    label: '"Powered by" Kaldırma (eski)',
    description: 'Kullanımdan kaldırıldı — yerini "Widget’ta Powered by Alt Bilgisi" aldı. Yalnızca hiç taşınmamış planlar için yedek olarak okunur.',
  },
  widget_powered_by: {
    label: 'Widget’ta "Powered by" Alt Bilgisi',
    description: 'Sohbet widget’ının platform tanıtım alt bilgisini gösterip göstermeyeceği. Metin, marka adı ve bağlantı platform yöneticisine aittir (Yönetim → Widget Ayarları → Powered by). Bir plan için kapatılırsa alt bilgi tamamen gizlenir ve widget içeriği alt kenara kadar uzanır.',
  },
  widget_powered_by_toggle: {
    label: 'Çalışma Alanı "Powered by"ı Gizleyebilir',
    description: 'Çalışma alanı sahibinin Widget → Görünüm → Logo ve marka bölümünden "Powered by" alt bilgisini kapatmasına izin verir. Çalışma alanındaki anahtar varsayılan olarak açıktır; sahibi kapatana kadar alt bilgi görünmeye devam eder. "Widget’ta Powered by Alt Bilgisi"nin açık olmasını gerektirir.',
  },
  widget_attachments: {
    label: 'Widget’ta Dosya Eki',
    description: 'Ziyaretçiler sohbet widget’ının mesaj alanında dosya ekleyebilir.',
  },
  widget_voice_notes: {
    label: 'Widget’ta Sesli Not',
    description: 'Ziyaretçiler sohbet widget’ından sesli not kaydedip gönderebilir.',
  },
  widget_emoji: {
    label: 'Widget Emoji Seçici',
    description: 'Sohbet widget’ının mesaj alanında emoji seçici.',
  },
  widget_smart_engagement: {
    label: 'Widget Akıllı Etkileşim',
    description: 'Ziyaretçi davranışına göre tetiklenen hatırlatmalar, duyurular ve proaktif mesajlar (Widget → Akıllı Etkileşim).',
  },
  ai_proactive_nudge: {
    label: 'Yapay Zekâ Proaktif Öneri',
    description: 'Ziyaretçinin gezinme yoluna göre yapay zekânın oluşturduğu, widget düğmesinin yanında çıkan bağlamsal öneriler (Widget → Akıllı Etkileşim → Yapay Zekâ Proaktif Asistan). "Widget Akıllı Etkileşim" ve "Yapay Zekâ Asistanı" gerektirir.',
  },
  widget_business_hours: {
    label: 'Widget Çalışma Saatleri',
    description: 'Sohbet widget’ı için çalışma alanına özel yanıt saatleri ve çevrimdışı davranışı.',
  },
  widget_domain_allowlist: {
    label: 'Widget İzinli Alan Adları',
    description: 'Widget’ın hangi sitelere yerleştirilebileceğini izinli alan adları listesiyle kısıtlar. Üst sınırı "Maks. Widget Alan Adı" belirler.',
  },
  max_widget_domains: {
    label: 'Maks. Widget Alan Adı',
    description: 'Çalışma alanı başına izin verilen en fazla yerleştirme alan adı sayısı. İzinli liste kaydedilirken uygulanır. -1 = sınırsız.',
  },
  widget_assignment_routing: {
    label: 'Otomatik Sohbet Atama',
    description: 'Devredilen sohbetlerin operatörlere otomatik ya da sırayla (round-robin) atanması. Kapalıyken çalışma alanı yalnızca elle atama yapabilir.',
  },
  widget_raw_ip_storage: {
    label: 'Ziyaretçinin Tam IP’sini Sakla',
    description: 'Çalışma alanının ziyaretçinin tam (maskelenmemiş) IP adresini saklamasına izin verir. Gizlilik açısından hassastır — varsayılan olarak kapalıdır.',
  },
  widget_reply_time_text: {
    label: 'Özel Yanıt Süresi Notu',
    description: 'Çalışma alanı, widget’ta marka adının altındaki "genellikle … içinde yanıt verir" satırını kendisi yazabilir.',
  },
  widget_welcome_message: {
    label: 'Özel Karşılama Mesajı',
    description: 'Çalışma alanı widget karşılama mesajını kendisi yazabilir; aksi hâlde dilin varsayılan metni kullanılır.',
  },
  widget_launcher_label: {
    label: 'Özel Başlatıcı Balon Metni',
    description: 'Çalışma alanı, yüzen başlatıcı düğmesinin yanında görünen balon metnini kendisi yazabilir.',
  },
  widget_launcher_size: {
    label: 'Özel Başlatıcı Boyutu',
    description: 'Çalışma alanı yüzen başlatıcı düğmesini yeniden boyutlandırabilir; aksi hâlde varsayılan 56 px boyut kullanılır.',
  },
  widget_launcher_icon: {
    label: 'Özel Başlatıcı Simgesi',
    description: 'Çalışma alanı yüzen başlatıcı simgesini seçebilir; aksi hâlde varsayılan sohbet simgesi kullanılır.',
  },
  widget_composer_placeholder: {
    label: 'Özel Mesaj Alanı Yer Tutucusu',
    description: 'Çalışma alanı, widget mesaj alanındaki "mesajınızı yazın" yer tutucusunu kendisi yazabilir.',
  },
  widget_team_avatars: {
    label: 'Çevrimiçi Operatör Avatarları',
    description: 'Widget’ın "sohbeti başlat" düğmesinde çevrimiçi operatörlerin avatarlarını gösterir.',
  },
  widget_workspace_logo: {
    label: 'Widget’ta Çalışma Alanı Logosu',
    description: 'Çalışma alanı logosunu widget başlığında gösterir. İzin verilmezse widget yalnızca marka adını gösterir.',
  },
  widget_appearance: {
    label: 'Widget Görünüm Düzenleyici',
    description: 'Çalışma alanı widget’ın görünümünü özelleştirebilir (Widget → Görünüm). İzin verilmezse platform varsayılanları kullanılır.',
  },
  widget_behavior: {
    label: 'Widget Davranış Ayarları',
    description: 'Çalışma alanı widget davranışını yapılandırabilir (Widget → Davranış).',
  },
  widget_prechat_form: {
    label: 'Sohbet Öncesi Form',
    description: 'Sohbet başlamadan önce ziyaretçi bilgilerini toplar (Widget → Sohbet öncesi form).',
  },
  inbox_ai_queue: {
    label: 'Gelen Kutusu Yapay Zekâ Kuyruğu Sekmesi',
    description: 'Operatör gelen kutusunda, yapay zekânın yönettiği otomatik sohbetler sekmesi.',
  },
  inbox_needs_human: {
    label: 'Gelen Kutusu "İnsan Gerekli" Sekmesi',
    description: 'Yapay zekânın devrettiği ve bir operatör bekleyen sohbetler.',
  },
  inbox_team_chat: {
    label: 'Gelen Kutusu Ekip Sohbeti',
    description: 'Gelen kutusu içinde operatörler arası iç sohbet sekmesi.',
  },
  mobile_promo_banner: {
    label: 'Mobil Tanıtım Afişi',
    description: 'Bu plandaki çalışma alanları için iOS gelen kutusunun üstünde platformun kendi tanıtım afişini gösterir.',
  },
  mobile_promo_fullscreen: {
    label: 'Mobil Tam Ekran Tanıtım',
    description: 'Bu plandaki çalışma alanları için iOS uygulamasında ara sıra tam ekran bir tanıtım gösterir. Sıklığı aşağıdaki sınırlarla belirlenir ve her zaman kapatılabilir.',
  },
  mobile_promo_interval_minutes: {
    label: 'Tam Ekran Tanıtımlar Arası Dakika',
    description: 'iOS uygulamasının tam ekran tanıtımı en sık ne kadar aralıkla gösterebileceği. Platform ayarı daha katıysa o uygulanır.',
  },
  call_recording: {
    label: 'Çağrı Kaydı',
    description: 'Operatörlerin sesli ve görüntülü aramaları kaydetmesine izin verir. Platformun genel çağrı kaydı anahtarıyla sınırlıdır.',
  },
  call_queue: {
    label: 'Çağrı Kuyruğu',
    description: 'Planın çağrı kuyruğu ve yönlendirme ekranına erişimi. Platformun genel çağrı kuyruğu anahtarıyla sınırlıdır.',
  },
  call_callbacks: {
    label: 'Geri Arama',
    description: 'Yanıt süresi (SLA) aşıldığında ziyaretçilerin geri arama talep etmesine izin verir. Platformun genel geri arama teklifi ayarıyla sınırlıdır.',
  },
  contact_import: {
    label: 'Kişi İçe Aktarma',
    description: 'CSV içe aktarma sihirbazıyla toplu kişi oluşturma. "Kişiler" modülüyle sınırlıdır.',
  },
  contact_create: {
    label: 'Kişi Oluşturma',
    description: 'Kişi rehberinden elle yeni kişi oluşturma. "Kişiler" modülüyle sınırlıdır.',
  },
  contact_edit: {
    label: 'Kişi Düzenleme',
    description: 'Mevcut kişileri düzenleme (ad, e-posta, telefon, notlar, etiketler). "Kişiler" modülüyle sınırlıdır.',
  },
  contact_export: {
    label: 'Kişi Dışa Aktarma',
    description: 'Kişi rehberini CSV olarak dışa aktarma. "Kişiler" modülüyle sınırlıdır.',
  },
  contact_tags: {
    label: 'Kişi Etiketleri',
    description: 'Kişilerde etiketleme, etikete göre filtreleme ve gruplama. "Kişiler" modülüyle sınırlıdır.',
  },
  contact_notes: {
    label: 'Kişi Notları',
    description: 'Bir kişi kaydına eklenen serbest notlar. "Kişiler" modülüyle sınırlıdır.',
  },
  bulk_contact_actions: {
    label: 'Toplu Kişi İşlemleri',
    description: 'Kişi rehberinde çoklu seçim ve toplu işlemler (ör. toplu silme). "Kişiler" modülüyle sınırlıdır.',
  },
  contact_ip_visibility: {
    label: 'Kişi IP Görünürlüğü',
    description: 'Kişi ayrıntı sayfasında ziyaretçinin IP adresini gösterir. Kapalıyken IP tarayıcıya hiç gönderilmez (sunucuda çıkarılır). "Kişiler" modülüyle sınırlıdır.',
  },
  max_agents: { label: 'Maks. Operatör' },
  max_kb_articles: {
    label: 'Bilgi Bankası Makaleleri',
    description: 'Bir çalışma alanının aynı anda sahip olabileceği en fazla bilgi bankası makalesi; makale silmek kapasiteyi boşaltır. Makale oluşturulurken canlı sayımla uygulanır. Bu anahtar yoksa eski ai_kb_max_articles ve kb_articles anahtarları okunur. -1 = sınırsız.',
  },
  max_workspaces: { label: 'Maks. Çalışma Alanı' },
  max_conversations: { label: 'Aylık Sohbet' },
  max_visitors: { label: 'Aylık Takip Edilen Ziyaretçi' },
  ai_credits_per_month: { label: 'Aylık Yapay Zekâ Kredisi' },
  ai_kb_max_pages: {
    label: 'YZ Bilgi Bankası Oluşturucu — Tarama Başına Maks. Sayfa',
    description: 'Bilgi bankası oluşturucunun web sitesi taramasındaki sayfa sınırı. Eski anahtar: "YZ Asistanı — Web Sayfaları: Kaynak Başına Maks. Sayfa" ayarlanmamışsa onun için de kullanılır.',
  },
  ai_kb_max_depth: {
    label: 'YZ Bilgi Bankası Oluşturucu — Tarama Derinliği',
    description: 'Bilgi bankası oluşturucunun web sitesi taramasındaki derinlik sınırı. Eski anahtar: "YZ Asistanı — Web Sayfaları: Tarama Derinliği" ayarlanmamışsa onun için de kullanılır.',
  },
  ai_kb_jobs_per_month: {
    label: 'YZ Bilgi Bankası Oluşturucu — Aylık İş',
    description: 'Bilgi bankası oluşturucunun aylık tarama işi sayısı. Eski anahtar: "YZ Asistanı — Web Sayfaları: Aylık Eşitleme" ayarlanmamışsa onun için de kullanılır.',
  },
  ai_agent_web_source_max_pages: {
    label: 'YZ Asistanı — Web Sayfaları: Kaynak Başına Maks. Sayfa',
    description: 'Yalnızca YZ Asistanı "Web Sayfaları" (Veri Merkezi) kaynak alımı için tarama başına sayfa sınırının yerine geçer. Ortak/eski değeri kullanmaya devam etmek için boş bırakın.',
  },
  ai_agent_web_source_max_depth: {
    label: 'YZ Asistanı — Web Sayfaları: Tarama Derinliği',
    description: 'Yalnızca YZ Asistanı "Web Sayfaları" (Veri Merkezi) kaynak alımı için tarama derinliği sınırının yerine geçer. Ortak/eski değeri kullanmaya devam etmek için boş bırakın.',
  },
  ai_agent_web_source_jobs_per_month: {
    label: 'YZ Asistanı — Web Sayfaları: Aylık Eşitleme',
    description: 'Yalnızca YZ Asistanı "Web Sayfaları" (Veri Merkezi) kaynak alımı için aylık iş sınırının yerine geçer. Ortak/eski değeri kullanmaya devam etmek için boş bırakın.',
  },
  ai_kb_file_size_mb: { label: 'YZ Asistanı — Maks. Dosya Boyutu' },
  ai_kb_file_count: { label: 'YZ Asistanı — Maks. Dosya' },
  storage_gb: { label: 'Depolama' },
  data_retention_days: { label: 'Veri Saklama' },
  max_contacts: {
    label: 'Maks. Kişi',
    description: 'Bir çalışma alanının aynı anda sahip olabileceği en fazla kişi kaydı; silme kapasiteyi boşaltır, düzenleme/etiket/not kapasite tüketmez. Tekli ve toplu kişi oluştururken canlı sayımla uygulanır.',
  },
  max_concurrent_calls: {
    label: 'Maks. Eşzamanlı Çağrı',
    description: 'Tüm çalışma alanında aynı anda etkin olabilecek çağrı sınırı (bekleyen, çalan, bağlanan ve etkin; her kaynaktan). Operatörün başlattığı aramalarda ve ziyaretçinin widget’tan arama isteğinde uygulanır. Platform yöneticisinin widget aramaları için ayrı sınırıyla birlikte geçerlidir; hangisi önce dolarsa engeller. -1 = sınırsız.',
  },
  max_call_minutes_per_month: {
    label: 'Aylık Çağrı Dakikası',
    description: 'Çalışma alanı başına aylık faturalanabilir çağrı dakikası sınırı (UTC ayı). Yalnızca bağlanan çağrılar sayılır: her çağrının bağlanmasından bitişine kadarki süresi dakikaya yukarı yuvarlanır. Bağlantı öncesi, kuyruk, bekletme ve yalnızca kayıt süresi sayılmaz. Operatörün başlattığı aramalarda ve ziyaretçinin widget’tan arama isteğinde uygulanır. -1 = sınırsız.',
  },
  recording_retention_days: {
    label: 'Çağrı Kaydı Saklama',
    description: 'Bir çağrı kaydının kalıcı olarak silinmeden önce en fazla kaç gün saklanacağı; yasal saklamadaki kayıtlar hariçtir. Süre her kayıt oluşturulurken sabitlenir, bu nedenle plan değişikliği yalnızca sonraki kayıtları etkiler. -1 = sınırsız.',
  },
  max_call_recordings: {
    label: 'Maks. Çağrı Kaydı',
    description: 'Çalışma alanı için saklanan toplam çağrı kaydı sayısı sınırı. Her kayıt başlamadan önce canlı sayımla uygulanır; bir kaydı silmek kapasiteyi boşaltır. -1 = sınırsız.',
  },
  max_call_recording_storage_mb: {
    label: 'Kayıt Depolama',
    description: 'Çalışma alanının çağrı kayıtlarının toplam boyut sınırı (MiB). Her kayıt başlamadan önce uygulanır; bir kaydı silmek kapasiteyi boşaltır. -1 = sınırsız.',
  },
  included_ai_allowance_irr: {
    label: 'Aylık Yapay Zekâ Payı',
    description: 'Her fatura döneminin başında çalışma alanına bir kez verilen ve dönem sonunda sona eren parasal (IRR) yapay zekâ payı; kullanılmayan kısım devretmez ve satın alınmış krediye dönüşmez. Tüketim, sağlayıcıların gerçek kullanımından hesaplanan müşteri ücretidir. Sınır yalnızca yapay zekâ faturalandırması "uygulama" modundayken işler; "yalnızca ölçüm" modunda kullanım ölçülür ama engellenmez. 0 = pay yok.',
  },
  seo_max_pages_per_crawl: {
    label: 'SEO — Denetim Başına Maks. Sayfa',
    description: 'SEO tarayıcısının tek bir denetimde ziyaret edeceği en fazla sayfa sayısı.',
  },
  seo_max_depth: {
    label: 'SEO — Maks. Tarama Derinliği',
    description: 'SEO tarayıcısının tek bir denetimde izleyeceği en fazla bağlantı derinliği (ana sayfadan tıklama sayısı).',
  },
  seo_workspace_concurrent_jobs: {
    label: 'SEO — Eşzamanlı Denetim',
    description: 'Tüm çalışma alanında ve kayıtlı tüm web sitelerinde aynı anda kuyrukta veya çalışır durumda olabilecek en fazla SEO denetimi.',
  },
  seo_crawl_frequency_hours: {
    label: 'SEO — Yeniden Denetim Bekleme Süresi (saat)',
    description: 'Bir web sitesi için yeni bir denetim başlatılabilmesi için son denetimden bu yana geçmesi gereken en az saat.',
  },
  seo_backlinks: {
    label: 'SEO — Geri Bağlantı Analizi',
    description: 'Platformun yapılandırdığı geri bağlantı veri sağlayıcısı üzerinden, çalışma alanına kayıtlı bir web sitesinin geri bağlantı profilini getirir ve gösterir.',
  },
  seo_backlinks_max_per_scan: {
    label: 'SEO — Tarama Başına Maks. Geri Bağlantı',
    description: 'Tek bir geri bağlantı taramasında getirilip saklanan en fazla geri bağlantı satırı.',
  },
  seo_backlinks_workspace_concurrent_scans: {
    label: 'SEO — Eşzamanlı Geri Bağlantı Taraması',
    description: 'Tüm çalışma alanında aynı anda kuyrukta veya çalışır durumda olabilecek en fazla geri bağlantı taraması.',
  },
  seo_backlinks_scan_frequency_hours: {
    label: 'SEO — Geri Bağlantı Yeniden Tarama Bekleme Süresi (saat)',
    description: 'Bir web sitesi için yeni bir geri bağlantı taraması başlatılabilmesi için son taramadan bu yana geçmesi gereken en az saat.',
  },
  seo_keywords: {
    label: 'SEO — Anahtar Kelime Araştırması',
    description: 'Platformun yapılandırdığı anahtar kelime veri sağlayıcısı üzerinden, bir anahtar kelime listesi için arama hacmi, TBM (CPC) ve rekabet verisi getirir.',
  },
  seo_keywords_max_per_lookup: {
    label: 'SEO — Sorgu Başına Maks. Anahtar Kelime',
    description: 'Tek bir anahtar kelime araştırması sorgusunda kabul edilen en fazla anahtar kelime.',
  },
  seo_keywords_workspace_concurrent_runs: {
    label: 'SEO — Eşzamanlı Anahtar Kelime Sorgusu',
    description: 'Tüm çalışma alanında aynı anda kuyrukta veya çalışır durumda olabilecek en fazla anahtar kelime araştırması sorgusu.',
  },
  seo_keywords_lookup_frequency_hours: {
    label: 'SEO — Anahtar Kelime Sorgusu Bekleme Süresi (saat)',
    description: 'Bir web sitesi için yeni bir anahtar kelime sorgusu başlatılabilmesi için son sorgudan bu yana geçmesi gereken en az saat.',
  },
  seo_rank_tracking: {
    label: 'SEO — Sıralama Takibi',
    description: 'Çalışma alanına kayıtlı bir web sitesi için bir anahtar kelime izleme listesini takip eder ve Google sıralamalarını düzenli olarak kaydeder.',
  },
  seo_rank_tracking_max_keywords: {
    label: 'SEO — Site Başına Maks. Takip Edilen Anahtar Kelime',
    description: 'Tek bir web sitesinin sıralama takibi listesinde aynı anda bulunabilecek en fazla anahtar kelime.',
  },
  seo_rank_tracking_check_frequency_hours: {
    label: 'SEO — Sıralama Yeniden Kontrol Aralığı (saat)',
    description: 'Takip edilen her anahtar kelimenin sıralamasının kaç saatte bir yeniden kontrol edileceği. 24 = günlük, 168 = haftalık.',
  },
  seo_performance: {
    label: 'SEO — Performans Denetimi',
    description: 'Platformun yapılandırdığı performans veri sağlayıcısı üzerinden, bir web sitesinin sayfaları için Core Web Vitals ve Lighthouse kategori puanlarını getirir.',
  },
  seo_performance_max_pages_per_audit: {
    label: 'SEO — Performans Denetimi Başına Maks. Sayfa',
    description: 'Tek bir performans denetiminde Core Web Vitals için denetlenen en fazla sayfa.',
  },
  seo_performance_audit_frequency_hours: {
    label: 'SEO — Performans Yeniden Denetim Bekleme Süresi (saat)',
    description: 'Bir tarama için yeni bir performans denetimi başlatılabilmesi için son denetimden bu yana geçmesi gereken en az saat.',
  },
  seo_gsc_insights: {
    label: 'SEO — GSC İçgörüleri',
    description: 'Bir Google Search Console mülkünü bağlayıp arama performans verilerini (tıklama, gösterim, TO, konum) doğrudan çalışma alanında görüntüleyin.',
  },
  seo_gsc_max_properties: {
    label: 'SEO — Maks. Bağlı GSC Mülkü',
    description: 'Bir çalışma alanının aynı anda bağlayabileceği en fazla Google Search Console mülkü.',
  },
  seo_gsc_sync_frequency_hours: {
    label: 'SEO — GSC Veri Yenileme Bekleme Süresi (saat)',
    description: 'Bağlı bir mülkün önbellekteki Search Console verisi iki yenileme arasında en az kaç saat beklemeli.',
  },
  seo_site_explorer: {
    label: 'SEO — Site Gezgini',
    description: 'Rakipler dâhil herhangi bir alan adının geri bağlantı profilini ve organik anahtar kelimelerini, onu çalışma alanı web sitesi olarak kaydetmeden inceleyin.',
  },
  seo_explorer_max_backlinks_per_scan: {
    label: 'SEO — Gezgin Taraması Başına Maks. Geri Bağlantı',
    description: 'Tek bir Site Gezgini geri bağlantı sorgusunda getirilip saklanan en fazla geri bağlantı satırı.',
  },
  seo_explorer_max_keywords_per_scan: {
    label: 'SEO — Gezgin Taraması Başına Maks. Anahtar Kelime',
    description: 'Tek bir Site Gezgini anahtar kelime sorgusunda getirilip saklanan en fazla organik anahtar kelime satırı.',
  },
  seo_explorer_workspace_concurrent_scans: {
    label: 'SEO — Eşzamanlı Gezgin Sorgusu',
    description: 'Tüm çalışma alanında aynı anda kuyrukta veya çalışır durumda olabilecek en fazla Site Gezgini sorgusu (geri bağlantı ve anahtar kelime toplamı).',
  },
  seo_explorer_scan_frequency_hours: {
    label: 'SEO — Gezgin Yeniden Sorgu Bekleme Süresi (saat)',
    description: 'Aynı alan adı için aynı türde yeni bir Site Gezgini sorgusu başlatılabilmesi için son sorgudan bu yana geçmesi gereken en az saat.',
  },
  web_analytics: {
    label: 'SEO — Web Analitiği',
    description: 'Çalışma alanının ziyaretçi takibi verisine dayalı trafik, kitle ve davranış raporları (kaynaklar, sayfalar, coğrafya, cihazlar, özel olaylar ve hunilar).',
  },
  web_analytics_max_funnels: {
    label: 'SEO — Maks. Kayıtlı Huni',
    description: 'Bir çalışma alanının tanımlayabileceği en fazla kayıtlı Web Analitiği hunisi.',
  },
  email_inbox: {
    label: 'E-posta Gelen Kutusu',
    description: 'Platform içinde ayrı, gerçek bir e-posta istemcisi (şimdilik Gmail; Yahoo Mail planlanıyor) — birleşik sohbet gelen kutusundan ayrıdır.',
  },
  bot_analytics: {
    label: 'SEO — Bot Analitiği',
    description: 'Hangi arama motoru ve yapay zekâ/LLM tarayıcılarının (Googlebot, GPTBot, ClaudeBot, PerplexityBot, …) siteyi ziyaret ettiğini ve hangi sayfalara uğradığını görmek için web sunucusu/CDN erişim kayıtlarını yükleyin.',
  },
  bot_analytics_max_log_lines: {
    label: 'SEO — İçe Aktarma Başına Maks. Kayıt Satırı',
    description: 'Bir çalışma alanının yüklenen tek bir erişim kaydından her içe aktarmada işleyebileceği en fazla satır.',
  },
  brand_radar: {
    label: 'SEO — Marka Radarı',
    description: 'Markanızın yapay zekâ asistanlarındaki görünürlüğünü (ChatGPT sizden bahsediyor mu?), organik arama sıralamalarını ve marka adınız için Search Console’daki gerçek talebi, takip edilen rakiplerle karşılaştırmalı olarak izler.',
  },
  brand_radar_max_topics: {
    label: 'SEO — Maks. Marka Radarı YZ Konusu',
    description: 'Bir çalışma alanının yapay zekâ görünürlüğü için tanımlayabileceği en fazla konu/istem.',
  },
  brand_radar_max_competitors: {
    label: 'SEO — Maks. Marka Radarı Rakibi',
    description: 'Bir çalışma alanının Marka Radarı’nda takip edebileceği en fazla rakip marka adı.',
  },
  brand_radar_check_frequency_hours: {
    label: 'SEO — Marka Radarı Kontrol Sıklığı (saat)',
    description: 'Bir çalışma alanının iki tam Marka Radarı kontrolü arasında beklemesi gereken en az saat (yapay zekâ kredisi ve sıralama sağlayıcısı harcamasını sınırlar).',
  },
};

const GROUPS: Record<CapabilityLocale, Record<string, string>> = {
  en: {
    modules: 'Modules', channels: 'Channels', widget: 'Chat widget', ai: 'Artificial intelligence', seo: 'SEO',
    contacts: 'Contacts', calls: 'Calls', usage: 'Usage', commerce: 'Commerce', branding: 'Branding',
    inbox: 'Inbox', mobile: 'Mobile app', security: 'Security', team: 'Team', support: 'Support',
  },
  fa: {
    modules: 'ماژول‌ها', channels: 'کانال‌ها', widget: 'ویجت چت', ai: 'هوش مصنوعی', seo: 'سئو',
    contacts: 'مخاطبین', calls: 'تماس‌ها', usage: 'مصرف', commerce: 'فروشگاه', branding: 'برندینگ',
    inbox: 'صندوق ورودی', mobile: 'اپ موبایل', security: 'امنیت', team: 'تیم', support: 'پشتیبانی',
  },
  tr: {
    modules: 'Modüller', channels: 'Kanallar', widget: 'Sohbet widget’ı', ai: 'Yapay zekâ', seo: 'SEO',
    contacts: 'Kişiler', calls: 'Çağrılar', usage: 'Kullanım', commerce: 'Mağaza', branding: 'Marka',
    inbox: 'Gelen kutusu', mobile: 'Mobil uygulama', security: 'Güvenlik', team: 'Ekip', support: 'Destek',
  },
};

const UNITS: Record<CapabilityLocale, Record<string, string>> = {
  en: {
    count: 'count', bytes: 'bytes', mb: 'MB', gb: 'GB', seconds: 'seconds', minutes: 'minutes', hours: 'hours',
    per_month: 'per month', per_day: 'per day', percent: '%', boolean: 'on/off', days: 'days',
  },
  fa: {
    count: 'تعداد', bytes: 'بایت', mb: 'مگابایت', gb: 'گیگابایت', seconds: 'ثانیه', minutes: 'دقیقه', hours: 'ساعت',
    per_month: 'در ماه', per_day: 'در روز', percent: 'درصد', boolean: 'روشن/خاموش', days: 'روز',
  },
  tr: {
    count: 'adet', bytes: 'bayt', mb: 'MB', gb: 'GB', seconds: 'saniye', minutes: 'dakika', hours: 'saat',
    per_month: 'aylık', per_day: 'günlük', percent: '%', boolean: 'açık/kapalı', days: 'gün',
  },
};

const TYPES: Record<CapabilityLocale, Record<string, string>> = {
  en: { module: 'Module', channel: 'Channel', feature: 'Feature', limit: 'Limit' },
  fa: { module: 'ماژول', channel: 'کانال', feature: 'ویژگی', limit: 'محدودیت' },
  tr: { module: 'Modül', channel: 'Kanal', feature: 'Özellik', limit: 'Sınır' },
};

/** Keys with a translation in every language — the test compares this with the registry. */
export const TRANSLATED_CAPABILITY_KEYS: readonly string[] = Object.keys(EN_LABELS);

export function capabilityLabel(key: string, locale: string | null | undefined, fallback?: string): string {
  const lang = capabilityLocale(locale);
  if (lang === 'fa' && FA[key]) return FA[key].label;
  if (lang === 'tr' && TR[key]) return TR[key].label;
  return EN_LABELS[key] ?? fallback ?? key;
}

/** The description in this language; English comes from the registry (pass it as the fallback). */
export function capabilityDescription(key: string, locale: string | null | undefined, fallback?: string | null): string | undefined {
  const lang = capabilityLocale(locale);
  const own = lang === 'fa' ? FA[key]?.description : lang === 'tr' ? TR[key]?.description : undefined;
  return own ?? fallback ?? undefined;
}

export function capabilityGroupLabel(group: string, locale: string | null | undefined): string {
  return GROUPS[capabilityLocale(locale)][group] ?? GROUPS.en[group] ?? group;
}

export function capabilityUnitLabel(unit: string, locale: string | null | undefined): string {
  return UNITS[capabilityLocale(locale)][unit] ?? unit;
}

export function capabilityTypeLabel(type: string, locale: string | null | undefined): string {
  return TYPES[capabilityLocale(locale)][type] ?? type;
}

/** For the translation test only. */
export const __capabilityTranslations = { EN_LABELS, FA, TR, GROUPS, UNITS };
