/**
 * The call widget texts the settings page lets an owner override
 * (config.custom_texts in the bootstrap; public/call-widget/runtime.js `t`).
 * src/test/callWidget/callWidgetCustomTexts.test.ts checks them against the widget.
 */

/** Shown only while visitors can ask for a callback (platform and workspace). */
export const CALLBACK_TEXT_KEYS = new Set([
  'callback', 'leave_details', 'callback_desk',
  'leave_callback_request', 'offline_copy',
  'request_callback', 'request_callback_instead', 'callback_intro',
]);

/** The server's cap on one widget text (server/routes/callCenter.ts); a longer one fails the whole save. */
export const WIDGET_TEXT_MAX = 200;

export type WidgetTextGroup = 'launcher' | 'header' | 'home' | 'offline';
export const WIDGET_TEXT_GROUPS: readonly WidgetTextGroup[] = ['launcher', 'header', 'home', 'offline'];

/**
 * The widget texts an owner may override, with the widget's own copy as the
 * placeholder (public/call-widget/runtime.js I18N, the 2026-10 design): every
 * text of the launcher, the header, the home screen and the offline screen.
 * A key reads the same wherever the widget uses it; `state` is the preview
 * state that shows it (focusing the field switches the preview to it).
 */
export const WIDGET_TEXT_KEYS: { key: string; group: WidgetTextGroup; state: 'online' | 'offline'; label: string; placeholder: Record<string, string> }[] = [
  { key: 'talk_now',            group: 'launcher', state: 'online',  label: 'Launcher text (online)',     placeholder: { en: 'Talk now',            fa: 'همین حالا تماس بگیرید', tr: 'Şimdi konuş' } },
  { key: 'live_support',        group: 'launcher', state: 'online',  label: 'Launcher subtitle (online)', placeholder: { en: 'Live support',        fa: 'پشتیبانی آنلاین',     tr: 'Canlı destek' } },
  { key: 'launcher_pill',       group: 'launcher', state: 'online',  label: 'Pill launcher text',         placeholder: { en: 'Call support',        fa: 'تماس با پشتیبانی',    tr: 'Desteği ara' } },
  { key: 'launcher_tab',        group: 'launcher', state: 'online',  label: 'Edge tab text',              placeholder: { en: 'Call us',             fa: 'تماس با ما',          tr: 'Bizi arayın' } },
  { key: 'callback',            group: 'launcher', state: 'offline', label: 'Callback label (offline launcher, buttons)', placeholder: { en: 'Callback', fa: 'درخواست تماس', tr: 'Geri arama' } },
  { key: 'leave_details',       group: 'launcher', state: 'offline', label: 'Launcher subtitle (offline, callback)', placeholder: { en: 'Leave details', fa: 'ثبت اطلاعات', tr: 'Bilgilerini bırak' } },
  { key: 'support',             group: 'launcher', state: 'offline', label: 'Launcher text (offline, no callback) and header name', placeholder: { en: 'Support', fa: 'پشتیبانی', tr: 'Destek' } },
  { key: 'operators_available', group: 'header',   state: 'online',  label: 'Header subtitle (online)',   placeholder: { en: 'Operators available', fa: 'اپراتورها آماده‌اند', tr: 'Operatörler müsait' } },
  { key: 'no_operator_now',     group: 'header',   state: 'online',  label: 'Header subtitle (no operator free)', placeholder: { en: 'No operator available right now', fa: 'فعلاً اپراتوری در دسترس نیست', tr: 'Şu anda müsait operatör yok' } },
  { key: 'callback_desk',       group: 'header',   state: 'offline', label: 'Header subtitle (offline, callback)', placeholder: { en: 'Callback desk', fa: 'میز درخواست تماس', tr: 'Geri arama masası' } },
  { key: 'offline',             group: 'header',   state: 'offline', label: 'Offline status (header, launcher)', placeholder: { en: 'Offline', fa: 'آفلاین', tr: 'Çevrimdışı' } },
  { key: 'live_now',            group: 'home',     state: 'online',  label: 'Home badge',                 placeholder: { en: 'Live now',            fa: 'آنلاین',              tr: 'Canlı' } },
  { key: 'channel_voice',       group: 'home',     state: 'online',  label: 'Voice, short (badge)',       placeholder: { en: 'Voice',               fa: 'صوتی',                tr: 'Sesli' } },
  { key: 'video',               group: 'home',     state: 'online',  label: 'Video, short (badge, split launcher)', placeholder: { en: 'Video', fa: 'تصویری', tr: 'Video' } },
  { key: 'talk_to_team',        group: 'home',     state: 'online',  label: 'Hero title (online)',        placeholder: { en: 'Talk to our team',    fa: 'با تیم ما صحبت کنید', tr: 'Ekibimizle konuşun' } },
  { key: 'online_copy',         group: 'home',     state: 'online',  label: 'Hero subtitle (online)',     placeholder: { en: 'Start a secure voice or video call with the next available operator.', fa: 'یک تماس صوتی یا تصویری امن را با اولین اپراتور آزاد شروع کنید.', tr: 'İlk uygun operatörle güvenli sesli veya görüntülü arama başlatın.' } },
  { key: 'voice_call',          group: 'home',     state: 'online',  label: 'Voice call label (buttons, launcher)', placeholder: { en: 'Voice call', fa: 'تماس صوتی', tr: 'Sesli arama' } },
  { key: 'video_call',          group: 'home',     state: 'online',  label: 'Video call label (buttons, launcher)', placeholder: { en: 'Video call', fa: 'تماس تصویری', tr: 'Görüntülü arama' } },
  { key: 'request_callback_instead', group: 'home', state: 'online', label: 'Home callback row title', placeholder: { en: 'Request a callback', fa: 'درخواست تماس', tr: 'Geri arama iste' } },
  { key: 'callback_intro',      group: 'home',     state: 'online',  label: 'Home callback row subtitle', placeholder: { en: 'Tell us how to reach you and our team calls back fast.', fa: 'راه ارتباطی را وارد کنید؛ تیم ما سریع تماس می‌گیرد.', tr: 'Size nasıl ulaşacağımızı yazın; ekibimiz hızlıca geri arar.' } },
  { key: 'leave_callback_request', group: 'offline', state: 'offline', label: 'Hero title (offline)',   placeholder: { en: 'Leave a callback request', fa: 'درخواست تماس ثبت کنید', tr: 'Geri arama isteği bırakın' } },
  { key: 'offline_copy',        group: 'offline',  state: 'offline', label: 'Hero subtitle (offline)',    placeholder: { en: 'Our team is offline right now, but we can call you back.', fa: 'تیم ما الان آفلاین است، اما می‌توانیم با شما تماس بگیریم.', tr: 'Ekibimiz şu anda çevrimdışı, ancak sizi geri arayabiliriz.' } },
  { key: 'request_callback',    group: 'offline',  state: 'offline', label: 'Callback button',            placeholder: { en: 'Request callback',    fa: 'درخواست تماس',        tr: 'Geri arama iste' } },
  { key: 'offline_title',       group: 'offline',  state: 'offline', label: 'Offline message title (no callback)', placeholder: { en: 'We are offline', fa: 'در حال حاضر آفلاین هستیم', tr: 'Şu anda çevrimdışıyız' } },
  { key: 'offline_message',     group: 'offline',  state: 'offline', label: 'Offline message text (no callback)', placeholder: { en: 'Our team is offline right now. Please try again later.', fa: 'تیم ما الان آفلاین است. لطفاً بعداً دوباره تلاش کنید.', tr: 'Ekibimiz şu anda çevrimdışı. Lütfen daha sonra tekrar deneyin.' } },
];
