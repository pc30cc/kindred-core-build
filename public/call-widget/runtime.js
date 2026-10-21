/*!
 * Call Center Widget Runtime — independent from Chat Widget.
 * Mounts inside a Shadow DOM root. Idempotent.
 */
(function () {
  'use strict';
  if (window.CallCenterWidget && window.CallCenterWidget.__mounted__) return;

  // The Iran region's local kit (its "powered by" words) is shipped only
  // where that region is served. The RESPOK build (scripts/build/
  // widgetBrand.mjs) deletes every block between the `@iran-kit` markers and
  // sets this to false, so the minifier drops each `if (LOCAL_KIT ...)`
  // branch too: every use of what those blocks define sits in such a branch.
  var LOCAL_KIT = true;

  var STATES = {
    LOADING: 'loading',
    ONLINE: 'online_available',
    OFFLINE: 'offline',
    PRE_CALL: 'pre_call_form',
    QUEUE: 'queue_waiting',
    IN_CALL: 'in_call',
    ENDED: 'ended',
    CALLBACK: 'callback_form',
    ERROR: 'error',
  };

  var SUPPORTED_LOCALES = ['en', 'fa', 'tr'];
  var LOCALE_META = {
    en: { label: 'English', short: 'EN', dir: 'ltr' },
    fa: { label: 'فارسی', short: 'فا', dir: 'rtl' },
    tr: { label: 'Türkçe', short: 'TR', dir: 'ltr' },
  };
  var I18N = {
    en: {
      talk_now: 'Talk now', callback: 'Callback', live_support: 'Live support', leave_details: 'Leave details', support: 'Support', required: 'Required',
      operators_available: 'Operators available', callback_desk: 'Callback desk', loading: 'Loading…', offline: 'Offline',
      leave_callback_request: 'Leave a callback request', offline_copy: 'Our team is offline right now, but we can call you back.', request_callback: 'Request callback',
      live_now: 'Live now', channels: 'Voice · Video · Callback', talk_to_team: 'Talk to our team', online_copy: 'Start a secure voice or video call with the next available operator.',
      secure_line: 'Secure line', queue_aware: 'Queue aware', fast_handoff: 'Fast handoff', voice_call: 'Voice call', video_call: 'Video call', request_callback_instead: 'Request a callback',
      you_are_next: 'You are next', holding_place: 'Holding your place', queue_copy_many: 'Your request is in the live call queue. Keep this window open while we connect the operator.', queue_copy_next: 'We are ringing the next available operator now.',
      ringing_enabled: 'Ringing enabled', ringing_operator: 'Ringing an operator', waiting_time: 'Waiting time', enable_ringing_sound: 'Enable ringing sound', mute_sound: 'Mute sound', unmute_sound: 'Unmute sound', you_next_line: 'You are next in line', you_queue_number: 'You are #{n} in the queue',
      queue_position: 'Queue position', eta: 'ETA', eta_under_min: 'Estimated wait: under 1 minute', eta_minutes: 'Estimated wait: ~{n} minutes', tired_waiting: 'Tired of waiting? We can call you back instead.', cancel_call: 'Cancel call',
      call_accepted_connecting: 'Call accepted, connecting…', connected: 'Connected', operator_joining: 'Operator joining…', operator_connected: 'Operator connected', operator_left: 'Operator left the call.', reconnecting_media: 'Reconnecting media…', media_disconnected: 'Media disconnected.', connecting_av: 'Connecting audio/video…',
      fallback: 'Call accepted. Please continue on the operator side.', accepted_no_sdk: 'Call accepted. Audio/video client unavailable on this page.', media_not_configured: 'Call accepted, media connection is not configured yet.', provider_not_configured: 'Call accepted, but the media server URL is not configured. Please request a callback.', provider_not_supported: 'Call accepted, but this provider has no in-browser client.', media_client_missing: 'Media client is not loaded. Call room is ready but the browser client is missing.', media_client_invalid: 'Media client loaded but is incompatible with this widget.', loading_media_client: 'Loading media client…', mic_denied: 'Microphone permission denied. Please allow access and try again.', camera_denied: 'Camera permission denied. Audio call continues without video.', room_failed: 'Failed to connect to the call room: {error}', token_expired: 'Your session expired. Please end and start a new call.',
      in_call: 'In call', connected_waiting: 'Connected, waiting', connecting: 'Connecting', recording_progress: 'Recording in progress', recording_may_start: 'Recording may start after the operator begins the call.', mute: 'Mute', unmute: 'Unmute', camera_off: 'Camera off', camera_on: 'Camera on', end: 'End',
      callback_scheduled: 'Callback scheduled', reach_out: 'Our team will reach out {when}.', asap: 'as soon as possible', video_callback: 'Video callback', phone_callback: 'Phone callback', reference: 'Reference', type: 'Type', done: 'Done', call_ended: 'Call ended.', error_prefix: 'Error: {error}', unknown: 'unknown', back: 'Back',
      request_callback_title: 'Request a callback', callback_intro: 'Tell us how to reach you and our team calls back fast.', callback_type: 'Callback type', phone: 'Phone', video: 'Video', department: 'Department', choose_department: 'Choose a department', known_contact: 'Known contact', contact_saved: 'Contact details already saved', subject: 'Subject', full_name: 'Full name', email: 'Email', email_required: 'Email *', phone_field: 'Phone', phone_required: 'Phone *', contact_required_note: 'Email or phone is required so we can reach you.', message_min: 'Message (min {n} chars)', message_optional: 'Message (optional)', message_placeholder: 'Briefly describe what you need help with…', when_call: 'When should we call?', schedule: 'Schedule', priority: 'Priority', normal: 'Normal', urgent: 'Urgent', consent_required: 'I consent to this call being recorded for quality and security.', call_may_record: 'This call may be recorded for quality and security.', start_call: 'Start call', send_request: 'Send request',
      err_recording_required: 'Recording consent is required to continue.', err_recording_accept: 'Please accept the recording consent to start the call.', err_department: 'This department is not available for this call type. Please choose another department.', err_failed_start: 'Failed to start call.', err_wait_seconds: 'Please wait {n}s before sending another request.', err_contact_required: 'Please provide your email or phone so we can reach you.', err_message_short: 'Please describe your request in at least {n} characters.', err_future_time: 'Please pick a valid future time.', err_too_fast: 'That was too fast. Please take a moment to fill in the form.', err_cooldown: 'You already requested a callback. Please wait {n}s before sending another.', err_rate_limited: 'Too many callback requests from your network. Please try again later.', err_callback_unavailable: 'Callback requests are currently unavailable.', err_failed: 'Failed.', err_try_again: 'Please try again.', err_media_unreachable: 'Could not reach the call media server. Please try again or contact support.', err_media_rtc_v1: 'The call media server does not support this client. Please ask the site owner to update it.',
      queue_wait_announce: 'You are in the waiting queue. Please wait, we will connect you shortly.',
      tap_to_hear: 'Tap to enable sound',
      operator_label: 'Operator',
      call_duration: 'Duration',
      transferring_call: 'Transferring to another operator…',
      rate_call_title: 'How was your call?',
      rate_call_sub: 'Your feedback helps our team improve.',
      rate_comment_ph: 'Add a comment (optional)',
      rate_submit: 'Submit rating',
      rate_skip: 'Skip',
      rate_thanks: 'Thank you for your feedback!',
      open_widget: 'Open the call widget', close: 'Close', launcher_pill: 'Call support', launcher_tab: 'Call us', queue_place_short: '#{n} in line', queue_next_short: 'Next',
      restore_call: 'Open the call', end_call: 'End call', video_minimized: 'Video call, minimized', minimize: 'Minimize', widget_language: 'Widget language', channel_voice: 'Voice',
      voice_tile_sub: 'Uses your microphone', video_tile_sub: 'Camera and microphone', edit: 'Edit', permission_note: 'Your browser will ask to use the camera and microphone.', you: 'You', eta_value_minutes: '~{n} minutes',
      eta_value_under_min: 'Under 1 minute', recording_short: 'Rec', quality_excellent: 'Excellent connection', quality_good: 'Good connection', quality_poor: 'Poor connection', quality_lost: 'Connection lost',
      transfer_hold: 'Please stay on the line.', mic_denied_title: 'Microphone permission denied', mic_denied_body: 'Please allow access and try again.', mic_denied_how: 'Click the lock next to the site address and turn the microphone on.', microphone: 'Microphone', retry: 'Try again',
      rtc_unsupported: 'Calls can\'t connect right now', rating: 'Rating', error_callback_hint: 'Leave a callback request and our team will call you as soon as possible.', step_of: 'Step {n} of {total}', asap_option: 'As soon as possible', today: 'Today',
      tomorrow: 'Tomorrow', continue: 'Continue', change: 'Change', at_time: 'at {time}', time: 'Time', copy_code: 'Copy code',
      summary_phone: 'Phone', summary_video: 'Video', no_operator_now: 'No operator available right now', copied: 'Copied',
      powered_by: 'Powered by {brand}'
    },
    fa: {
      talk_now: 'همین حالا تماس بگیرید', callback: 'درخواست تماس', live_support: 'پشتیبانی آنلاین', leave_details: 'ثبت اطلاعات', support: 'پشتیبانی', required: 'الزامی',
      operators_available: 'اپراتورها آماده‌اند', callback_desk: 'میز درخواست تماس', loading: 'در حال بارگذاری…', offline: 'آفلاین',
      leave_callback_request: 'درخواست تماس ثبت کنید', offline_copy: 'تیم ما الان آفلاین است، اما می‌توانیم با شما تماس بگیریم.', request_callback: 'درخواست تماس',
      live_now: 'آنلاین', channels: 'صوتی · تصویری · درخواست تماس', talk_to_team: 'با تیم ما صحبت کنید', online_copy: 'یک تماس صوتی یا تصویری امن را با اولین اپراتور آزاد شروع کنید.',
      secure_line: 'خط امن', queue_aware: 'مدیریت صف', fast_handoff: 'اتصال سریع', voice_call: 'تماس صوتی', video_call: 'تماس تصویری', request_callback_instead: 'درخواست تماس',
      you_are_next: 'نفر بعدی شما هستید', holding_place: 'جای شما محفوظ است', queue_copy_many: 'درخواست شما در صف تماس زنده است. این پنجره را باز نگه دارید تا اپراتور متصل شود.', queue_copy_next: 'در حال زنگ زدن به اولین اپراتور آزاد هستیم.',
      ringing_enabled: 'صدای زنگ فعال است', ringing_operator: 'در حال زنگ زدن به اپراتور', waiting_time: 'زمان انتظار', enable_ringing_sound: 'فعال کردن صدا', mute_sound: 'بی‌صدا کردن زنگ', unmute_sound: 'فعال کردن صدا', you_next_line: 'شما نفر بعدی صف هستید', you_queue_number: 'شما نفر {n} صف هستید',
      queue_position: 'جایگاه در صف', eta: 'زمان تقریبی', eta_under_min: 'زمان انتظار: کمتر از ۱ دقیقه', eta_minutes: 'زمان انتظار: حدود {n} دقیقه', tired_waiting: 'از انتظار خسته شدید؟ می‌توانیم با شما تماس بگیریم.', cancel_call: 'لغو تماس',
      call_accepted_connecting: 'تماس پذیرفته شد، در حال اتصال…', connected: 'متصل شد', operator_joining: 'اپراتور در حال ورود است…', operator_connected: 'اپراتور متصل شد', operator_left: 'اپراتور تماس را ترک کرد.', reconnecting_media: 'در حال اتصال مجدد رسانه…', media_disconnected: 'ارتباط رسانه قطع شد.', connecting_av: 'در حال اتصال صدا/تصویر…',
      fallback: 'تماس پذیرفته شد. لطفاً از سمت اپراتور ادامه دهید.', accepted_no_sdk: 'تماس پذیرفته شد. کلاینت صدا/تصویر در این صفحه در دسترس نیست.', media_not_configured: 'تماس پذیرفته شد، اما اتصال رسانه هنوز تنظیم نشده است.', provider_not_configured: 'تماس پذیرفته شد، اما آدرس سرور رسانه تنظیم نشده است. لطفاً درخواست تماس ثبت کنید.', provider_not_supported: 'تماس پذیرفته شد، اما این ارائه‌دهنده کلاینت مرورگری ندارد.', media_client_missing: 'کلاینت رسانه بارگذاری نشده است. اتاق تماس آماده است اما کلاینت مرورگر موجود نیست.', media_client_invalid: 'کلاینت رسانه بارگذاری شده با این ویجت سازگار نیست.', loading_media_client: 'در حال بارگذاری کلاینت رسانه…', mic_denied: 'دسترسی میکروفون رد شد. لطفاً اجازه دسترسی بدهید و دوباره تلاش کنید.', camera_denied: 'دسترسی دوربین رد شد. تماس صوتی بدون تصویر ادامه دارد.', room_failed: 'اتصال به اتاق تماس ناموفق بود: {error}', token_expired: 'جلسه شما منقضی شد. لطفاً تماس را پایان دهید و دوباره شروع کنید.',
      in_call: 'در تماس', connected_waiting: 'متصل، در انتظار اپراتور', connecting: 'در حال اتصال', recording_progress: 'ضبط در حال انجام است', recording_may_start: 'ممکن است ضبط پس از شروع تماس توسط اپراتور آغاز شود.', mute: 'بی‌صدا', unmute: 'صدا', camera_off: 'خاموش کردن دوربین', camera_on: 'روشن کردن دوربین', end: 'پایان',
      callback_scheduled: 'درخواست تماس ثبت شد', reach_out: 'تیم ما {when} با شما تماس می‌گیرد.', asap: 'در اولین فرصت', video_callback: 'تماس تصویری', phone_callback: 'تماس تلفنی', reference: 'کد پیگیری', type: 'نوع', done: 'تمام', call_ended: 'تماس پایان یافت.', error_prefix: 'خطا: {error}', unknown: 'نامشخص', back: 'بازگشت',
      request_callback_title: 'درخواست تماس', callback_intro: 'راه ارتباطی را وارد کنید؛ تیم ما سریع تماس می‌گیرد.', callback_type: 'نوع تماس', phone: 'تلفنی', video: 'تصویری', department: 'دپارتمان', choose_department: 'یک دپارتمان انتخاب کنید', known_contact: 'مخاطب شناخته‌شده', contact_saved: 'اطلاعات تماس قبلاً ذخیره شده است', subject: 'موضوع', full_name: 'نام کامل', email: 'ایمیل', email_required: 'ایمیل *', phone_field: 'تلفن', phone_required: 'تلفن *', contact_required_note: 'ایمیل یا تلفن برای تماس با شما الزامی است.', message_min: 'پیام (حداقل {n} کاراکتر)', message_optional: 'پیام (اختیاری)', message_placeholder: 'کوتاه توضیح دهید چه کمکی نیاز دارید…', when_call: 'چه زمانی تماس بگیریم؟', schedule: 'زمان‌بندی', priority: 'اولویت', normal: 'عادی', urgent: 'فوری', consent_required: 'رضایت می‌دهم این تماس برای کیفیت و امنیت ضبط شود.', call_may_record: 'ممکن است این تماس برای کیفیت و امنیت ضبط شود.', start_call: 'شروع تماس', send_request: 'ارسال درخواست',
      err_recording_required: 'برای ادامه، رضایت ضبط تماس الزامی است.', err_recording_accept: 'برای شروع تماس لطفاً رضایت ضبط را تأیید کنید.', err_department: 'این دپارتمان برای این نوع تماس در دسترس نیست. لطفاً دپارتمان دیگری انتخاب کنید.', err_failed_start: 'شروع تماس ناموفق بود.', err_wait_seconds: 'لطفاً {n} ثانیه قبل از ارسال درخواست بعدی صبر کنید.', err_contact_required: 'لطفاً ایمیل یا تلفن خود را وارد کنید تا بتوانیم با شما تماس بگیریم.', err_message_short: 'لطفاً درخواست خود را حداقل در {n} کاراکتر توضیح دهید.', err_future_time: 'لطفاً یک زمان معتبر در آینده انتخاب کنید.', err_too_fast: 'خیلی سریع بود. لطفاً کمی برای تکمیل فرم زمان بگذارید.', err_cooldown: 'قبلاً درخواست تماس ثبت کرده‌اید. لطفاً {n} ثانیه صبر کنید.', err_rate_limited: 'درخواست‌های زیادی از شبکه شما ارسال شده است. بعداً دوباره تلاش کنید.', err_callback_unavailable: 'درخواست تماس در حال حاضر در دسترس نیست.', err_failed: 'ناموفق بود.', err_try_again: 'لطفاً دوباره تلاش کنید.', err_media_unreachable: 'دسترسی به سرور رسانه تماس ممکن نشد. لطفاً دوباره تلاش کنید یا با پشتیبانی تماس بگیرید.', err_media_rtc_v1: 'سرور رسانه تماس از این کلاینت پشتیبانی نمی‌کند. لطفاً از مدیر سایت بخواهید آن را به‌روز کند.',
      queue_wait_announce: 'شما در صف انتظار هستید. لطفاً صبر کنید، به‌زودی شما را به اپراتور متصل می‌کنیم.',
      tap_to_hear: 'برای شنیدن صدا کلیک کنید',
      operator_label: 'اپراتور',
      call_duration: 'مدت مکالمه',
      transferring_call: 'در حال انتقال به اپراتور دیگر…',
      rate_call_title: 'تماس چطور بود؟',
      rate_call_sub: 'نظر شما به بهبود تیم ما کمک می‌کند.',
      rate_comment_ph: 'افزودن نظر (اختیاری)',
      rate_submit: 'ثبت امتیاز',
      rate_skip: 'رد کردن',
      rate_thanks: 'از بازخورد شما متشکریم!',
      open_widget: 'باز کردن ویجت تماس', close: 'بستن', launcher_pill: 'تماس با پشتیبانی', launcher_tab: 'تماس با ما', queue_place_short: 'نفر {n} صف', queue_next_short: 'نفر بعدی',
      restore_call: 'باز کردن تماس', end_call: 'پایان تماس', video_minimized: 'تماس تصویری کوچک‌شده', minimize: 'کوچک کردن', widget_language: 'زبان ویجت', channel_voice: 'صوتی',
      voice_tile_sub: 'با میکروفون مرورگر', video_tile_sub: 'با دوربین و میکروفون', edit: 'ویرایش', permission_note: 'مرورگر برای دوربین و میکروفون از شما اجازه می‌خواهد.', you: 'شما', eta_value_minutes: 'حدود {n} دقیقه',
      eta_value_under_min: 'کمتر از ۱ دقیقه', recording_short: 'ضبط', quality_excellent: 'کیفیت اتصال عالی است', quality_good: 'کیفیت اتصال خوب است', quality_poor: 'کیفیت اتصال ضعیف است', quality_lost: 'اتصال قطع شده است',
      transfer_hold: 'لطفاً پشت خط بمانید.', mic_denied_title: 'دسترسی میکروفون رد شد', mic_denied_body: 'لطفاً اجازه دسترسی بدهید و دوباره تلاش کنید.', mic_denied_how: 'روی نماد قفل کنار آدرس سایت بزنید و میکروفون را روشن کنید.', microphone: 'میکروفون', retry: 'تلاش دوباره',
      rtc_unsupported: 'فعلاً امکان برقراری تماس نیست', rating: 'امتیاز', error_callback_hint: 'درخواست تماس بگذارید تا تیم ما در اولین فرصت با شما تماس بگیرد.', step_of: 'قدم {n} از {total}', asap_option: 'در اولین فرصت', today: 'امروز',
      tomorrow: 'فردا', continue: 'ادامه', change: 'تغییر', at_time: 'ساعت {time}', time: 'زمان', copy_code: 'کپی کد',
      summary_phone: 'تماس تلفنی', summary_video: 'تماس تصویری', no_operator_now: 'فعلاً اپراتوری در دسترس نیست', copied: 'کپی شد',
      powered_by: 'قدرت گرفته از {brand}'
    },
    tr: {
      talk_now: 'Şimdi konuş', callback: 'Geri arama', live_support: 'Canlı destek', leave_details: 'Bilgilerini bırak', support: 'Destek', required: 'Zorunlu',
      operators_available: 'Operatörler müsait', callback_desk: 'Geri arama masası', loading: 'Yükleniyor…', offline: 'Çevrimdışı',
      leave_callback_request: 'Geri arama isteği bırakın', offline_copy: 'Ekibimiz şu anda çevrimdışı, ancak sizi geri arayabiliriz.', request_callback: 'Geri arama iste',
      live_now: 'Canlı', channels: 'Ses · Video · Geri arama', talk_to_team: 'Ekibimizle konuşun', online_copy: 'İlk uygun operatörle güvenli sesli veya görüntülü arama başlatın.',
      secure_line: 'Güvenli hat', queue_aware: 'Sıra takibi', fast_handoff: 'Hızlı aktarım', voice_call: 'Sesli arama', video_call: 'Görüntülü arama', request_callback_instead: 'Geri arama iste',
      you_are_next: 'Sıradaki sizsiniz', holding_place: 'Yeriniz korunuyor', queue_copy_many: 'İsteğiniz canlı arama kuyruğunda. Operatöre bağlanırken bu pencereyi açık tutun.', queue_copy_next: 'Şimdi ilk uygun operatörü arıyoruz.',
      ringing_enabled: 'Zil sesi açık', ringing_operator: 'Operatör aranıyor', waiting_time: 'Bekleme süresi', enable_ringing_sound: 'Zil sesini aç', mute_sound: 'Sesi kapat', unmute_sound: 'Sesi aç', you_next_line: 'Sıradaki sizsiniz', you_queue_number: 'Kuyrukta #{n} sıradasınız',
      queue_position: 'Kuyruk sırası', eta: 'Tahmini', eta_under_min: 'Tahmini bekleme: 1 dakikadan az', eta_minutes: 'Tahmini bekleme: ~{n} dakika', tired_waiting: 'Beklemekten sıkıldınız mı? Sizi geri arayabiliriz.', cancel_call: 'Aramayı iptal et',
      call_accepted_connecting: 'Arama kabul edildi, bağlanıyor…', connected: 'Bağlandı', operator_joining: 'Operatör katılıyor…', operator_connected: 'Operatör bağlandı', operator_left: 'Operatör aramadan ayrıldı.', reconnecting_media: 'Medya yeniden bağlanıyor…', media_disconnected: 'Medya bağlantısı koptu.', connecting_av: 'Ses/video bağlanıyor…',
      fallback: 'Arama kabul edildi. Lütfen operatör tarafında devam edin.', accepted_no_sdk: 'Arama kabul edildi. Bu sayfada ses/video istemcisi yok.', media_not_configured: 'Arama kabul edildi, medya bağlantısı henüz yapılandırılmamış.', provider_not_configured: 'Arama kabul edildi, ancak medya sunucusu URL’si yapılandırılmamış. Lütfen geri arama isteyin.', provider_not_supported: 'Arama kabul edildi, ancak bu sağlayıcının tarayıcı istemcisi yok.', media_client_missing: 'Medya istemcisi yüklenmedi. Arama odası hazır ancak tarayıcı istemcisi eksik.', media_client_invalid: 'Yüklenen medya istemcisi bu widget ile uyumlu değil.', loading_media_client: 'Medya istemcisi yükleniyor…', mic_denied: 'Mikrofon izni reddedildi. Lütfen izin verip tekrar deneyin.', camera_denied: 'Kamera izni reddedildi. Sesli arama video olmadan devam eder.', room_failed: 'Arama odasına bağlanılamadı: {error}', token_expired: 'Oturumunuz sona erdi. Lütfen aramayı bitirip yeniden başlatın.',
      in_call: 'Aramada', connected_waiting: 'Bağlandı, bekleniyor', connecting: 'Bağlanıyor', recording_progress: 'Kayıt devam ediyor', recording_may_start: 'Kayıt, operatör aramayı başlattıktan sonra başlayabilir.', mute: 'Sessize al', unmute: 'Sesi aç', camera_off: 'Kamerayı kapat', camera_on: 'Kamerayı aç', end: 'Bitir',
      callback_scheduled: 'Geri arama planlandı', reach_out: 'Ekibimiz {when} size ulaşacak.', asap: 'en kısa sürede', video_callback: 'Görüntülü geri arama', phone_callback: 'Telefonla geri arama', reference: 'Referans', type: 'Tür', done: 'Tamam', call_ended: 'Arama sona erdi.', error_prefix: 'Hata: {error}', unknown: 'bilinmiyor', back: 'Geri',
      request_callback_title: 'Geri arama iste', callback_intro: 'Size nasıl ulaşacağımızı yazın; ekibimiz hızlıca geri arar.', callback_type: 'Geri arama türü', phone: 'Telefon', video: 'Video', department: 'Departman', choose_department: 'Departman seçin', known_contact: 'Bilinen kişi', contact_saved: 'İletişim bilgileri kayıtlı', subject: 'Konu', full_name: 'Ad soyad', email: 'E-posta', email_required: 'E-posta *', phone_field: 'Telefon', phone_required: 'Telefon *', contact_required_note: 'Size ulaşabilmemiz için e-posta veya telefon gerekir.', message_min: 'Mesaj (en az {n} karakter)', message_optional: 'Mesaj (isteğe bağlı)', message_placeholder: 'Neye ihtiyacınız olduğunu kısaca yazın…', when_call: 'Ne zaman arayalım?', schedule: 'Planla', priority: 'Öncelik', normal: 'Normal', urgent: 'Acil', consent_required: 'Bu aramanın kalite ve güvenlik için kaydedilmesine izin veriyorum.', call_may_record: 'Bu arama kalite ve güvenlik için kaydedilebilir.', start_call: 'Aramayı başlat', send_request: 'İstek gönder',
      err_recording_required: 'Devam etmek için kayıt onayı gereklidir.', err_recording_accept: 'Aramayı başlatmak için lütfen kayıt onayını kabul edin.', err_department: 'Bu departman bu arama türü için uygun değil. Lütfen başka bir departman seçin.', err_failed_start: 'Arama başlatılamadı.', err_wait_seconds: 'Yeni istek göndermeden önce lütfen {n} sn bekleyin.', err_contact_required: 'Size ulaşabilmemiz için lütfen e-posta veya telefon girin.', err_message_short: 'Lütfen isteğinizi en az {n} karakterle açıklayın.', err_future_time: 'Lütfen gelecekte geçerli bir zaman seçin.', err_too_fast: 'Çok hızlı oldu. Lütfen formu doldurmak için biraz zaman ayırın.', err_cooldown: 'Zaten bir geri arama istediniz. Lütfen {n} sn bekleyin.', err_rate_limited: 'Ağınızdan çok fazla geri arama isteği geldi. Lütfen daha sonra deneyin.', err_callback_unavailable: 'Geri arama istekleri şu anda kullanılamıyor.', err_failed: 'Başarısız.', err_try_again: 'Lütfen tekrar deneyin.', err_media_unreachable: 'Arama medya sunucusuna ulaşılamadı. Lütfen tekrar deneyin veya destekle iletişime geçin.', err_media_rtc_v1: 'Arama medya sunucusu bu istemciyi desteklemiyor. Lütfen site sahibinden güncellemesini isteyin.',
      queue_wait_announce: 'Bekleme kuyruğundasınız. Lütfen bekleyin, kısa süre içinde sizi bir operatöre bağlayacağız.',
      tap_to_hear: 'Sesi açmak için dokunun',
      operator_label: 'Operatör',
      call_duration: 'Süre',
      transferring_call: 'Başka bir operatöre aktarılıyor…',
      rate_call_title: 'Arama nasıldı?',
      rate_call_sub: 'Geri bildiriminiz ekibimizin gelişmesine yardımcı olur.',
      rate_comment_ph: 'Yorum ekle (isteğe bağlı)',
      rate_submit: 'Puanı gönder',
      rate_skip: 'Atla',
      rate_thanks: 'Geri bildiriminiz için teşekkürler!',
      open_widget: 'Arama widget\'ını aç', close: 'Kapat', launcher_pill: 'Desteği ara', launcher_tab: 'Bizi arayın', queue_place_short: 'Sırada #{n}', queue_next_short: 'Sıradaki',
      restore_call: 'Aramayı aç', end_call: 'Aramayı bitir', video_minimized: 'Görüntülü arama, küçültüldü', minimize: 'Küçült', widget_language: 'Widget dili', channel_voice: 'Sesli',
      voice_tile_sub: 'Mikrofonunuzu kullanır', video_tile_sub: 'Kamera ve mikrofon', edit: 'Düzenle', permission_note: 'Tarayıcınız kamera ve mikrofonu kullanmak için izin isteyecek.', you: 'Siz', eta_value_minutes: '~{n} dakika',
      eta_value_under_min: '1 dakikadan az', recording_short: 'Kayıt', quality_excellent: 'Bağlantı mükemmel', quality_good: 'Bağlantı iyi', quality_poor: 'Bağlantı zayıf', quality_lost: 'Bağlantı koptu',
      transfer_hold: 'Lütfen hatta kalın.', mic_denied_title: 'Mikrofon izni reddedildi', mic_denied_body: 'Lütfen izin verip tekrar deneyin.', mic_denied_how: 'Site adresinin yanındaki kilide tıklayın ve mikrofonu açın.', microphone: 'Mikrofon', retry: 'Tekrar dene',
      rtc_unsupported: 'Arama şu anda bağlanamıyor', rating: 'Puan', error_callback_hint: 'Geri arama isteği bırakın, ekibimiz sizi en kısa sürede arasın.', step_of: 'Adım {n} / {total}', asap_option: 'En kısa sürede', today: 'Bugün',
      tomorrow: 'Yarın', continue: 'Devam', change: 'Değiştir', at_time: 'saat {time}', time: 'Saat', copy_code: 'Kodu kopyala',
      summary_phone: 'Telefon', summary_video: 'Görüntülü', no_operator_now: 'Şu anda müsait operatör yok', copied: 'Kopyalandı',
      powered_by: '{brand} tarafından desteklenmektedir'
    },
  };


  /**
   * CC-2H Phase 6 — Strip access_token query params and JWT-shaped
   * blobs from any string before it reaches the UI or console.log.
   */
  function sanitize(s) {
    if (s == null) return s;
    var str = String(s);
    str = str.replace(/access_token=[^&\s"']+/gi, 'access_token=[redacted]');
    str = str.replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[redacted-token]');
    return str;
  }

  /* @iran-kit:begin */
  /**
   * The platform the "powered by" line credits in the Iran region's edition —
   * and whenever the bootstrap names no edition (an older backend): exactly
   * the words it always showed.
   */
  var LOCAL_POWERED_BY_BRAND = { en: 'Web Yar', fa: 'وب‌یار', tr: 'Web Yar' };
  /* @iran-kit:end */

  function normalizeLocale(locale) {
    locale = String(locale || '').toLowerCase().slice(0, 2);
    return SUPPORTED_LOCALES.indexOf(locale) >= 0 ? locale : null;
  }

  /** `{name}` placeholders; `fa`: a number is written in Persian digits (E16). */
  function formatText(text, vars, fa) {
    text = String(text == null ? '' : text);
    vars = vars || {};
    Object.keys(vars).forEach(function (k) {
      var v = String(vars[k]);
      if (fa && typeof vars[k] === 'number') v = v.replace(/\d/g, function (d) { return String.fromCharCode(1776 + +d); });
      text = text.replace(new RegExp('\\{' + k + '\\}', 'g'), v);
    });
    return text;
  }

  function noop() {}

  /**
   * CC-2H Phase 5 — Map common LiveKit transport failures to
   * actionable, secret-free messages: the key of the widget's own
   * sentence (I18N), so it reads in the visitor's language; null for
   * anything else (the raw text is never shown).
   */
  function friendlyConnectError(raw) {
    var s = sanitize(String(raw || '')).toLowerCase();
    if (s.indexOf('v1 rtc path') >= 0 || s.indexOf('rtc/v1') >= 0 || s.indexOf('404') >= 0 && s.indexOf('validate') >= 0) {
      return 'err_media_rtc_v1';
    }
    if (s.indexOf('connection refused') >= 0 || s.indexOf('1006') >= 0) {
      return 'err_media_unreachable';
    }
    if (s.indexOf('expired') >= 0 || s.indexOf('unauthorized') >= 0 || s.indexOf('invalid token') >= 0) {
      return 'token_expired';
    }
    return null;
  }

  // ── Visitor-side ringback (on-hold) audio ────────────────────────────
  var Ringback = (function () {
    var ctx = null, timer = null, holdTimer = null, speakTimer = null, announceDelayTimer = null, active = false, audioEl = null, announceAudioEl = null, mode = 'off', lastCfg = null, needsGesture = false, unlockHandlersInstalled = false, muted = false;
    try {
      if (typeof window !== 'undefined' && window.sessionStorage) {
        muted = window.sessionStorage.getItem('ccw_ringback_muted') === '1';
      }
    } catch (_) {}
    var phase = 'hold';
    var locale = 'en';
    var announceText = '';
    var queuePosition = null;
    var lastSpeakAt = 0, pendingVoiceRetry = null, holdNodes = [];
    var LANG_MAP = { en: 'en-US', fa: 'fa-IR', tr: 'tr-TR' };
    function ensure() {
      try {
        if (typeof window === 'undefined') return null;
        var C = window.AudioContext || window.webkitAudioContext;
        if (!C) return null;
        if (!ctx) ctx = new C();
        return ctx;
      } catch (_) { return null; }
    }
    function installUnlockHandlers() {
      if (unlockHandlersInstalled || typeof window === 'undefined') return;
      unlockHandlersInstalled = true;
      var retry = function () {
        if (!active) return;
        try { Ringback.startFromGesture(lastCfg || {}); } catch (_) {}
      };
      window.addEventListener('pointerdown', retry, { capture: true, passive: true });
      window.addEventListener('touchstart', retry, { capture: true, passive: true });
      window.addEventListener('keydown', retry, { capture: true, passive: true });
    }
    function unlock() {
      var c = ensure();
      if (!c) return null;
      try {
        if (c.state === 'suspended' && c.resume) {
          var rp = c.resume();
          if (rp && rp.then) rp.then(function () { needsGesture = false; startPhase(); }).catch(function () { needsGesture = true; installUnlockHandlers(); });
        }
        // A near-silent oscillator is more reliable than a zero-length buffer
        // on mobile Safari for preserving the user-activation audio unlock.
        var osc = c.createOscillator();
        var g = c.createGain();
        g.gain.setValueAtTime(0.00001, c.currentTime);
        osc.connect(g).connect(c.destination);
        osc.start(c.currentTime);
        osc.stop(c.currentTime + 0.03);
      } catch (_) { needsGesture = true; installUnlockHandlers(); }
      return c;
    }
    function trackNode(n) {
      holdNodes.push(n);
      try { n.addEventListener('ended', function () {
        var i = holdNodes.indexOf(n);
        if (i >= 0) holdNodes.splice(i, 1);
      }); } catch (_) {}
      return n;
    }
    function stopHoldNodes() {
      var nodes = holdNodes.slice();
      holdNodes = [];
      nodes.forEach(function (n) { try { n.stop(0); } catch (_) {} });
    }
    function ringOnce() {
      var c = ensure(); if (!c || !active || mode !== 'tone' || muted) return;
      if (c.state && c.state !== 'running') {
        needsGesture = true; installUnlockHandlers();
        try {
          var p = c.resume && c.resume();
          if (p && p.then) p.then(function () { if (active) { needsGesture = false; ringOnce(); } }).catch(function () { needsGesture = true; });
        } catch (_) {}
        return;
      }
      needsGesture = false;
      try {
        var t0 = c.currentTime + 0.015;
        var pattern = [
          { f1: 440, f2: 480, at: 0.0, dur: 0.58 },
          { f1: 440, f2: 480, at: 0.72, dur: 0.58 },
        ];
        for (var i = 0; i < pattern.length; i++) {
          var n = pattern[i];
          [n.f1, n.f2].forEach(function (f, idx) {
            var osc = c.createOscillator();
            var g = c.createGain();
            osc.type = idx === 0 ? 'sine' : 'triangle';
            osc.frequency.setValueAtTime(f, t0 + n.at);
            g.gain.setValueAtTime(0.0001, t0 + n.at);
            g.gain.exponentialRampToValueAtTime(0.22, t0 + n.at + 0.035);
            g.gain.setValueAtTime(0.22, t0 + n.at + n.dur - 0.06);
            g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + n.dur);
            osc.connect(g).connect(c.destination);
            osc.start(t0 + n.at);
            osc.stop(t0 + n.at + n.dur + 0.04);
          });
        }
      } catch (_) { needsGesture = true; installUnlockHandlers(); }
    }
    function holdMusicLoop() {
      var c = ensure(); if (!c || !active || mode !== 'tone' || muted) return;
      if (c.state && c.state !== 'running') {
        needsGesture = true; installUnlockHandlers();
        try { var p = c.resume && c.resume(); if (p && p.then) p.then(function () { needsGesture = false; }).catch(function () {}); } catch (_) {}
        return;
      }
      try {
        var t0 = c.currentTime + 0.04;
        var master = c.createGain();
        master.gain.setValueAtTime(0.0001, t0);
        master.gain.exponentialRampToValueAtTime(0.16, t0 + 1.1);
        master.gain.setValueAtTime(0.16, t0 + 10.2);
        master.gain.exponentialRampToValueAtTime(0.0001, t0 + 11.6);
        master.connect(c.destination);
        // Calm generated hold music: warm pad + small bell melody. This avoids
        // the old short repeated tone that sounded like "داد داد" to visitors.
        [196.0, 246.94, 293.66].forEach(function (f, idx) {
          var osc = c.createOscillator();
          var g = c.createGain();
          osc.type = idx === 0 ? 'sine' : 'triangle';
          osc.frequency.setValueAtTime(f, t0);
          g.gain.setValueAtTime(0.0001, t0);
          g.gain.exponentialRampToValueAtTime(0.055 - idx * 0.01, t0 + 1.4);
          g.gain.setValueAtTime(0.055 - idx * 0.01, t0 + 10.0);
          g.gain.exponentialRampToValueAtTime(0.0001, t0 + 11.5);
          osc.connect(g).connect(master);
          osc.start(t0);
          osc.stop(t0 + 11.7);
          trackNode(osc);
        });
        var melody = [392.0, 329.63, 369.99, 293.66, 329.63, 246.94, 293.66, 329.63, 392.0, 493.88, 440.0, 392.0];
        melody.forEach(function (f, idx) {
          var at = t0 + 0.55 + idx * 0.78;
          var osc = c.createOscillator();
          var g = c.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(f, at);
          g.gain.setValueAtTime(0.0001, at);
          g.gain.exponentialRampToValueAtTime(0.045, at + 0.08);
          g.gain.exponentialRampToValueAtTime(0.0001, at + 0.58);
          osc.connect(g).connect(master);
          osc.start(at);
          osc.stop(at + 0.64);
          trackNode(osc);
        });
      } catch (_) { stopHoldNodes(); }
    }
    function getAnnouncementUrl() {
      var cfg = lastCfg || {};
      var q = cfg.ringback_queue_audio_urls || {};
      var key = queuePosition == null ? '' : String(queuePosition);
      return (key && q[key]) || cfg.ringback_announcement_audio_url || '';
    }
    function playAnnouncementAudio(force) {
      if (!active || phase !== 'hold' || muted) return false;
      var url = getAnnouncementUrl();
      if (!url) return false;
      var now = Date.now();
      if (!force && now - lastSpeakAt < 14000) return true;
      try {
        if (!announceAudioEl || announceAudioEl.src !== url) {
          if (announceAudioEl) { try { announceAudioEl.pause(); } catch (_) {} }
          announceAudioEl = new Audio(url);
        }
        announceAudioEl.loop = false;
        announceAudioEl.volume = 0.72;
        announceAudioEl.currentTime = 0;
        var p = announceAudioEl.play();
        lastSpeakAt = now;
        if (p && p.then) p.then(function () { needsGesture = false; }).catch(function () { needsGesture = true; installUnlockHandlers(); });
        return true;
      } catch (_) { needsGesture = true; installUnlockHandlers(); return true; }
    }
    function getVoices() {
      try { return (window.speechSynthesis && window.speechSynthesis.getVoices && window.speechSynthesis.getVoices()) || []; } catch (_) { return []; }
    }
    function pickVoice(loc) {
      var voices = getVoices();
      var lang = LANG_MAP[loc] || 'en-US';
      var prefix = String(lang).slice(0, 2).toLowerCase();
      for (var i = 0; i < voices.length; i++) {
        if (String(voices[i].lang || '').toLowerCase() === String(lang).toLowerCase()) return voices[i];
      }
      for (var j = 0; j < voices.length; j++) {
        if (String(voices[j].lang || '').toLowerCase().slice(0, 2) === prefix) return voices[j];
      }
      return null;
    }
    function speakAnnounce(force) {
      if (!active || phase !== 'hold' || !announceText || muted) return;
      if (playAnnouncementAudio(force)) return;
      // Persian browser TTS is unreliable on many systems and can read the
      // sentence with an English/default engine. For fa, only use an explicit
      // uploaded audio file; otherwise keep the generated hold music playing.
      if (locale === 'fa') return;
      var now = Date.now();
      if (!force && now - lastSpeakAt < 12000) return;
      try {
        if (typeof window === 'undefined' || !window.speechSynthesis) return;
        var voice = pickVoice(locale);
        if (!voice && locale !== 'en') {
          if (!pendingVoiceRetry) {
            pendingVoiceRetry = setTimeout(function () {
              pendingVoiceRetry = null;
              speakAnnounce(true);
            }, 900);
          }
          if (now - lastSpeakAt < 2600) return;
        }
        if (!voice && locale !== 'en') return;
        var spokenText = announceText;
        var u = new window.SpeechSynthesisUtterance(spokenText);
        u.lang = LANG_MAP[locale] || 'en-US';
        if (voice) u.voice = voice;
        u.rate = 0.88;
        u.pitch = 1;
        u.volume = 0.62;
        try { window.speechSynthesis.cancel(); } catch (_) {}
        lastSpeakAt = now;
        window.speechSynthesis.speak(u);
      } catch (_) {}
    }
    function clearTimers() {
      if (timer) { try { clearInterval(timer); } catch (_) {} timer = null; }
      if (holdTimer) { try { clearInterval(holdTimer); } catch (_) {} holdTimer = null; }
      if (speakTimer) { try { clearInterval(speakTimer); } catch (_) {} speakTimer = null; }
      if (announceDelayTimer) { try { clearTimeout(announceDelayTimer); } catch (_) {} announceDelayTimer = null; }
      if (pendingVoiceRetry) { try { clearTimeout(pendingVoiceRetry); } catch (_) {} pendingVoiceRetry = null; }
      stopHoldNodes();
    }
    function startPhase() {
      clearTimers();
      if (!active) return;
      if (audioEl) {
        try { audioEl.volume = muted ? 0 : (phase === 'ring' ? 0.62 : 0.38); } catch (_) {}
      }
      if (mode !== 'tone') {
        // music URL handles its own loop; only schedule announcements during hold
        if (phase === 'hold' && announceText) {
          announceDelayTimer = setTimeout(function () { announceDelayTimer = null; speakAnnounce(true); }, 1400);
          speakTimer = setInterval(function () { speakAnnounce(false); }, 18000);
        }
        return;
      }
      if (phase === 'ring') {
        ringOnce();
        timer = setInterval(ringOnce, 2800);
      } else {
        holdMusicLoop();
        holdTimer = setInterval(holdMusicLoop, 11000);
        if (announceText) {
          announceDelayTimer = setTimeout(function () { announceDelayTimer = null; speakAnnounce(true); }, 1400);
          speakTimer = setInterval(function () { speakAnnounce(false); }, 18000);
        }
      }
    }
    return {
      prime: function () { unlock(); },
      setLocale: function (loc, text) {
        if (loc) locale = String(loc);
        if (text != null) announceText = String(text || '');
      },
      setQueuePosition: function (pos) {
        var next = typeof pos === 'number' ? pos : null;
        if (next === queuePosition) return;
        queuePosition = next;
        // Position changed → force re-announcement so visitor hears the new
        // position-specific audio (or generic announcement) immediately.
        if (active && phase === 'hold') {
          try {
            if (announceAudioEl) { try { announceAudioEl.pause(); } catch (_) {} announceAudioEl = null; }
          } catch (_) {}
          lastSpeakAt = 0;
          try { speakAnnounce(true); } catch (_) {}
        }
      },
      setPhase: function (p) {
        var next = p === 'ring' ? 'ring' : 'hold';
        if (next === phase) return;
        phase = next;
        if (phase === 'ring') {
          try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (_) {}
        }
        if (active) startPhase();
      },
      getPhase: function () { return phase; },
      start: function (cfg) {
        lastCfg = cfg || lastCfg || {};
        mode = (lastCfg && lastCfg.ringback_mode) || 'tone';
        if ((lastCfg && lastCfg.ringback_enabled === false) || mode === 'off') { Ringback.stop(); return; }
        active = true;
        if (mode === 'music' && lastCfg.ringback_music_url) {
          try {
            if (!audioEl) audioEl = new Audio(lastCfg.ringback_music_url);
            audioEl.loop = true; audioEl.volume = phase === 'ring' ? 0.62 : 0.38;
            audioEl.onerror = function () {
              if (!active) return;
              try { audioEl && audioEl.pause(); } catch (_) {}
              audioEl = null;
              mode = 'tone';
              unlock();
              startPhase();
            };
            var p = audioEl.play();
            if (p && p.then) p.then(function () { needsGesture = false; }).catch(function (err) {
              var name = String((err && err.name) || '').toLowerCase();
              if (name && name !== 'notallowederror') {
                try { audioEl && audioEl.pause(); } catch (_) {}
                audioEl = null; mode = 'tone'; unlock(); startPhase(); return;
              }
              needsGesture = true; installUnlockHandlers();
            });
          } catch (_) { needsGesture = true; installUnlockHandlers(); }
          startPhase();
          return;
        }
        mode = 'tone';
        unlock();
        startPhase();
      },
      stop: function () {
        active = false; needsGesture = false;
        clearTimers();
        try { if (typeof window !== 'undefined' && window.speechSynthesis) window.speechSynthesis.cancel(); } catch (_) {}
        if (audioEl) { try { audioEl.pause(); audioEl.src = ''; } catch (_) {} audioEl = null; }
        if (announceAudioEl) { try { announceAudioEl.pause(); announceAudioEl.src = ''; } catch (_) {} announceAudioEl = null; }
      },
      // Never `this`: the presentation calls these on the facade it is lent.
      startFromGesture: function (cfg) {
        lastCfg = cfg || lastCfg || {};
        unlock();
        Ringback.start(lastCfg);
        // After refresh/navigation the first user tap must unlock the actual
        // uploaded queue-position announcement too, not only the background
        // hold music. Play it immediately while the gesture is still active.
        if (active && phase === 'hold' && !muted) {
          try { speakAnnounce(true); } catch (_) {}
        }
      },
      needsGesture: function () { return !!needsGesture; },
      isActive: function () { return active; },
      isMuted: function () { return !!muted; },
      setMuted: function (m) {
        muted = !!m;
        try {
          if (typeof window !== 'undefined' && window.sessionStorage) {
            window.sessionStorage.setItem('ccw_ringback_muted', muted ? '1' : '0');
          }
        } catch (_) {}
        if (audioEl) { try { audioEl.volume = muted ? 0 : (phase === 'ring' ? 0.62 : 0.38); } catch (_) {} }
        if (muted) {
          clearTimers();
          try { if (typeof window !== 'undefined' && window.speechSynthesis) window.speechSynthesis.cancel(); } catch (_) {}
          if (announceAudioEl) { try { announceAudioEl.pause(); } catch (_) {} }
        } else if (active) {
          startPhase();
        }
      },
    };
  })();

  function CallCenterWidgetCtor() {
    this.state = STATES.LOADING;
    this.bootstrap = null;
    this.apiBase = '';
    this.origin = '';
    this.assetsVersion = '';
    this.runtimeAssetSuffix = '';
    this.activeSessionKey = '';
    this.session = null;
    this.callId = null;
    this.call = null;
    this.callbackId = null;
    this.error = null;
    this.queueStartedAt = null;
    this.timer = null;
    this.poll = null;
    this.open = false;
    this.operatorName = null;
    this.callStartedAt = null;
    this.callTimer = null;
    this.transferring = false;
    this.endedCallId = null;
    this.endedDuration = 0;
    this.ratingSubmitted = false;
    this.ratingValue = 0;
    this.ratingComment = '';
    this.formData = {
      name: '', email: '', phone: '', subject: '', message: '',
      call_type: 'voice', consent: false, department_id: '',
      callback_channel: 'audio', callback_urgency: 'normal',
      callback_when: 'now', callback_scheduled_for: '',
      hp_company: '', custom: {},
    };
    this.callbackOpenedAt = 0;
    this.callbackCooldownUntil = 0;
    // Contract §3: the key of the callback form's error (E15), the camera
    // the browser refused (E7), the visitor's connection (E12), the level
    // meter running (E20), the label closed for the session (E14), the
    // callback booked for later (E11).
    this.errorKey = null;
    this.cameraDenied = false;
    this.connectionQuality = null;
    this.audioMeterLive = false;
    this.labelDismissed = false;
    this.callbackBooking = null;
    this.locale = 'en';
    this.availableLocales = ['en'];
    this.localeStorageKey = 'ccw_locale';
  }

  CallCenterWidgetCtor.prototype.t = function (key, vars) {
    var fa = this.locale === 'fa';
    // Per-workspace overrides (set in Identity & Branding) take priority, in
    // their own language only (E8: an English text never shows in Persian).
    try {
      var ct = this.bootstrap && this.bootstrap.config && this.bootstrap.config.custom_texts;
      var ov = ct && ct[this.locale] && ct[this.locale][key];
      if (ov && typeof ov === 'string' && ov.trim()) return formatText(ov, vars, fa);
    } catch (_) {}
    var pack = I18N[this.locale] || I18N.en;
    if (key === 'powered_by') {
      var brand = this.poweredByBrand();
      if (!brand) return '';
      vars = Object.assign({}, vars || {}, { brand: brand });
    }
    return formatText(pack[key] || I18N.en[key] || key, vars, fa);
  };

  /**
   * The platform the "powered by" line credits. The International edition
   * takes it from the bootstrap (the platform's own name, the same source
   * the chat widget uses; none = no line); anything else keeps the Iran
   * region's words exactly. (The RESPOK build has no such words: there every
   * edition takes the bootstrap's name.)
   */
  CallCenterWidgetCtor.prototype.poweredByBrand = function () {
    var b = this.bootstrap || {};
    if (LOCAL_KIT && b.edition !== 'international') return LOCAL_POWERED_BY_BRAND[this.locale] || LOCAL_POWERED_BY_BRAND.en;
    var pb = b.powered_by;
    if (!pb || typeof pb !== 'object') return '';
    var names = pb.brands && typeof pb.brands === 'object' ? pb.brands : {};
    var name = names[this.locale] || pb.brand || '';
    return typeof name === 'string' ? name.trim() : '';
  };

  /**
   * The International edition's credit drawn with the platform's logo: the
   * localized label split around the brand ("Powered by ‹logo›",
   * "‹logo› tarafından desteklenmektedir") and the logo's absolute URL.
   * The Iran region's edition draws its local logotype the same way when the
   * bootstrap carries `powered_by_logo`. null — draw the text as before —
   * without a logo, or when the workspace wrote its own "powered by" text.
   */
  CallCenterWidgetCtor.prototype.poweredByParts = function () {
    var b = this.bootstrap || {};
    // The Iranian edition (edition 'iran' exactly, never an unknown one)
    // draws its local Persian logotype in the brand's place when the server
    // names it (`powered_by_logo`); without it the words stay as they were.
    var iranKit = LOCAL_KIT && b.edition === 'iran' && typeof b.powered_by_logo === 'string' && !!b.powered_by_logo;
    if (!iranKit && (b.edition !== 'international' || !b.powered_by)) return null;
    var logo = iranKit ? b.powered_by_logo : b.powered_by.logo;
    if (typeof logo !== 'string' || !logo) return null;
    if (/^\//.test(logo) && !/^\/\//.test(logo)) logo = String(this.origin || '') + logo;
    if (!/^https?:\/\//i.test(logo)) return null;
    try {
      var ct = b.config && b.config.custom_texts;
      if (ct && ct[this.locale] && ct[this.locale].powered_by) return null;
    } catch (_) { return null; }
    var brand = this.poweredByBrand();
    if (!brand) return null;
    var pack = I18N[this.locale] || I18N.en;
    var full = formatText(pack.powered_by || I18N.en.powered_by, { brand: '\u0001' });
    var at = full.indexOf('\u0001');
    if (at < 0) return null;
    return { before: full.slice(0, at), after: full.slice(at + 1), logo: logo, brand: brand };
  };

  /** The "powered by" link (International edition only; null = not a link). */
  CallCenterWidgetCtor.prototype.poweredByUrl = function () {
    var b = this.bootstrap || {};
    if (b.edition !== 'international' || !b.powered_by) return null;
    var url = b.powered_by.url;
    return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
  };

  CallCenterWidgetCtor.prototype.setLocale = function (locale) {
    locale = normalizeLocale(locale) || this.locale || 'en';
    if (this.availableLocales.indexOf(locale) < 0) return;
    this.locale = locale;
    try { window.localStorage.setItem(this.localeStorageKey, locale); } catch (_) {}
    if (this.root) this.render();
  };

  CallCenterWidgetCtor.prototype.initLocale = function () {
    var i18n = (this.bootstrap && this.bootstrap.i18n) || {};
    var available = (i18n.available_locales || []).map(normalizeLocale).filter(Boolean);
    this.availableLocales = available.length ? available : ['en'];
    var stored = null;
    try { stored = normalizeLocale(window.localStorage.getItem(this.localeStorageKey)); } catch (_) {}
    var nav = normalizeLocale((navigator.languages && navigator.languages[0]) || navigator.language);
    var def = normalizeLocale(i18n.default_locale) || 'en';
    this.locale = this.availableLocales.indexOf(stored) >= 0 ? stored
      : this.availableLocales.indexOf(def) >= 0 ? def
      : this.availableLocales.indexOf(nav) >= 0 ? nav
      : this.availableLocales[0];
  };

  CallCenterWidgetCtor.prototype.mount = function (opts) {
    if (this.__mounted__) return;
    this.__mounted__ = true;
    this.apiBase = opts.apiBase;
    this.origin = opts.origin;
    this.assetsVersion = opts.assetsVersion || (opts.bootstrap && opts.bootstrap.assets_version) || '';
    this.runtimeAssetSuffix = opts.runtimeAssetSuffix || (this.assetsVersion ? ('?v=' + encodeURIComponent(String(this.assetsVersion).slice(0, 16))) : '');
    this.activeSessionKey = opts.activeSessionKey || '';
    this.bootstrap = opts.bootstrap;
    // The dashboard's preview remembers nothing from (or for) the visitor's session.
    if (opts.preview !== true) {
      try { this.labelDismissed = window.sessionStorage.getItem('ccw_label_dismissed') === '1'; } catch (_) {}
    }
    this.checkBooking(true);
    this.loadLiveKitSdk = opts.loadLiveKitSdk || null;
    // The loader's hook for the panel module (l.js ensurePanel): the
    // presentation asks for it on the visitor's first intent.
    this.loadPanel = typeof opts.loadPanel === 'function' ? opts.loadPanel : null;
    this.preview = opts.preview === true;
    this.pageTitle = opts.pageTitle || '';
    this.session = opts.bootstrap && opts.bootstrap.session;
    this.initLocale();

    // Pre-fill from previously identified contact (returning visitor).
    var prefill = opts.bootstrap && opts.bootstrap.visitor && opts.bootstrap.visitor.contact;
    if (prefill) {
      this.formData.name = prefill.name || '';
      this.formData.email = prefill.email || '';
      this.formData.phone = prefill.phone || '';
      this.identifiedContact = prefill;
    }

    var registry = window.CallWidgetPresentations;
    var requestedPresentation = this.bootstrap && this.bootstrap.config && this.bootstrap.config.widget_template_id;
    this.presentation = registry && registry.resolve(requestedPresentation);
    if (!this.presentation) return;
    var presentationHost = this.presentation.createHost({
      origin: this.origin,
      runtimeAssetSuffix: this.runtimeAssetSuffix,
      assetUrl: typeof opts.assetUrl === 'function' ? opts.assetUrl : null,
      fontsUrl: typeof opts.fontsUrl === 'string' ? opts.fontsUrl : null,
      bootstrap: this.bootstrap,
    });
    this.root = presentationHost.root;
    this.presentationInstance = null;

    if (!this.bootstrap || this.bootstrap.status !== 'ok') {
      this.state = STATES.OFFLINE; this.render(); return;
    }
    if (!this.bootstrap.provider_ready) {
      // still allow visit but warn — will block at request time
    }
    this.state = (this.isOnline() ? STATES.ONLINE : STATES.OFFLINE);
    this.render();
    // Resume any in-flight call across refresh / navigation.
    try { this.resumeActiveCall(); } catch (_) {}
  };

  CallCenterWidgetCtor.prototype.isOnline = function () {
    var caps = this.bootstrap && this.bootstrap.capabilities;
    return !!caps && (caps.voice || caps.video);
  };

  // The five placements (right, left, top_right, top_left, bottom_center)
  // and the spellings stored before them: a stored `bottom-left` is left.
  var POSITION_ALIASES = {
    right: 'right', 'bottom-right': 'right', bottom_right: 'right',
    left: 'left', 'bottom-left': 'left', bottom_left: 'left',
    top_right: 'top_right', 'top-right': 'top_right',
    top_left: 'top_left', 'top-left': 'top_left',
    bottom_center: 'bottom_center', 'bottom-center': 'bottom_center', center: 'bottom_center',
  };

  CallCenterWidgetCtor.prototype.position = function () {
    var p = this.bootstrap && this.bootstrap.config && this.bootstrap.config.widget_position;
    return (typeof p === 'string' && Object.prototype.hasOwnProperty.call(POSITION_ALIASES, p) && POSITION_ALIASES[p]) || 'right';
  };

  CallCenterWidgetCtor.prototype.persistActiveSession = function () {
    if (!this.activeSessionKey || !this.session || !this.callId) return;
    try { window.sessionStorage.setItem(this.activeSessionKey, this.session); } catch (_) {}
  };

  CallCenterWidgetCtor.prototype.clearActiveSession = function () {
    if (!this.activeSessionKey) return;
    try { window.sessionStorage.removeItem(this.activeSessionKey); } catch (_) {}
  };

  /**
   * E11: the callback booked for a time stays on the launcher until then, on
   * every visit (localStorage, scoped like the active call's session key:
   * `ccw_callback_booking:<workspace|key|default>:<apiBase>`).
   */
  CallCenterWidgetCtor.prototype.bookingKey = function () {
    var k = this.activeSessionKey, i = k.indexOf(':');
    return i > 0 ? 'ccw_callback_booking' + k.slice(i) : '';
  };
  CallCenterWidgetCtor.prototype.setBooking = function (b) {
    var key = this.bookingKey();
    this.callbackBooking = b;
    try {
      if (!key) return;
      if (b) window.localStorage.setItem(key, JSON.stringify(b));
      else window.localStorage.removeItem(key);
    } catch (_) {}
  };
  /** The booking (`stored`: the one kept in this browser), dropped once its time has passed. */
  CallCenterWidgetCtor.prototype.checkBooking = function (stored) {
    var b = this.callbackBooking, key = this.bookingKey();
    if (stored && key) {
      try { b = JSON.parse(window.localStorage.getItem(key)); } catch (_) { b = 0; }
    }
    if (b && typeof b.callbackId === 'string' && Date.parse(b.scheduled_for) > Date.now()) {
      this.callbackBooking = { callbackId: b.callbackId, scheduled_for: String(b.scheduled_for), channel: b.channel === 'video' ? 'video' : 'audio', urgency: b.urgency === 'urgent' ? 'urgent' : 'normal' };
    } else if (b !== null) {
      this.setBooking(null);
    }
  };

  /** E14: the visitor closed the launcher's label; it stays closed for the session. */
  CallCenterWidgetCtor.prototype.dismissLabel = function () {
    this.labelDismissed = true;
    try { if (!this.preview) window.sessionStorage.setItem('ccw_label_dismissed', '1'); } catch (_) {}
    this.render();
  };

  /** E2: leave the rating without sending one. */
  CallCenterWidgetCtor.prototype.skipRating = function () {
    this.reset();
  };

  CallCenterWidgetCtor.prototype.api = function (path, opts) {
    opts = opts || {};
    if (this.preview) {
      return Promise.resolve({ ok: false, status: 409, body: { error: 'preview_mode' } });
    }
    var headers = { 'Content-Type': 'application/json' };
    if (this.session) headers['x-cc-session'] = this.session;
    try {
      if (this.activeSessionKey) {
        var activeSession = window.sessionStorage.getItem(this.activeSessionKey);
        if (activeSession) headers['x-cc-active-call'] = activeSession;
      }
    } catch (_) {}
    return fetch(this.apiBase + path, {
      method: opts.method || 'GET',
      headers: Object.assign(headers, opts.headers || {}),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'include',
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, body: j }; }); });
  };

  CallCenterWidgetCtor.prototype.toggleOpen = function () {
    this.open = !this.open;
    if (this.open && this.state === STATES.OFFLINE) {
      // allow callback path
    }
    this.render();
  };

  CallCenterWidgetCtor.prototype.startCall = function (callType) {
    var cfg = this.bootstrap.config || {};
    // Prime audio output inside this click handler so the ringback can
    // actually play later, after the async /calls/request round-trip.
    try { Ringback.prime(); } catch (_) {}
    this.formData.call_type = callType;
    // Auto-select sole department for the chosen channel, otherwise reset.
    var depts = (this.bootstrap && this.bootstrap.departments) || {};
    var list = (callType === 'video' ? depts.video : depts.voice) || [];
    this.formData.department_id = (list.length === 1) ? list[0].id : '';
    var rec = (this.bootstrap && this.bootstrap.recording) || {};
    var consentNeeded = !!(rec.effective_enabled && rec.consent_required);
    var passiveNotice = !!(rec.effective_enabled && !rec.consent_required);
    var depts2 = (this.bootstrap && this.bootstrap.departments) || {};
    var list2 = (callType === 'video' ? depts2.video : depts2.voice) || [];
    var needsDepartmentChoice = list2.length > 1;
    // Returning visitors with a known contact identity skip the pre-call
    // form unless we still need consent / department choice / a notice.
    var alreadyIdentified = !!(this.identifiedContact && this.identifiedContact.id);
    var needFormFields = cfg.pre_call_form_enabled && !alreadyIdentified;
    if (needFormFields || consentNeeded || passiveNotice || needsDepartmentChoice) {
      this.state = STATES.PRE_CALL; this.render(); return;
    }
    this.submitCall();
  };

  CallCenterWidgetCtor.prototype.submitCall = function () {
    var self = this;
    // Re-prime in case the user reached submitCall via the pre-call form
    // (a different click than the initial Voice/Video button).
    try { Ringback.prime(); } catch (_) {}
    try {
      Ringback.setLocale(this.locale, this.t('queue_wait_announce'));
      Ringback.setQueuePosition(this.queuePosition);
      Ringback.setPhase('hold');
    } catch (_) {}
    try {
      // Start while still inside the click gesture. Starting after the
      // /calls/request promise resolves is blocked by Safari/Chrome autoplay
      // rules on many devices, even if the AudioContext was primed earlier.
      Ringback.startFromGesture((this.bootstrap && this.bootstrap.queue_experience) || {});
    } catch (_) {}
    var rec = (this.bootstrap && this.bootstrap.recording) || {};
    var invalidField = this.validatePreCallForm();
    if (invalidField) {
      try { Ringback.stop(); } catch (_) {}
      this.error = invalidField.label + ': ' + this.t('required');
      this.render(); return;
    }
    var consentNeeded = !!(rec.effective_enabled && rec.consent_required);
    if (consentNeeded && !this.formData.consent) {
      try { Ringback.stop(); } catch (_) {}
      this.error = this.t('err_recording_required');
      this.render(); return;
    }
    var consentAt = this.formData.consent ? new Date().toISOString() : null;
    this.error = null;
    this.state = STATES.LOADING; this.render();
    // E21: a cancel (any reset) while this request is on its way makes it stale.
    var gen = this._reqGen = (this._reqGen || 0) + 1;
    this.api('/api/call-widget/calls/request', {
      method: 'POST',
      body: {
        call_type: this.formData.call_type,
        visitor_name: this.formData.name || null,
        visitor_email: this.formData.email || null,
        visitor_phone: this.formData.phone || null,
        subject: this.formData.subject || null,
        page_url: location.href,
        page_title: this.pageTitle,
        consent_recording: !!this.formData.consent,
        recording_consent: !!this.formData.consent,
        recording_consent_at: consentAt,
        department_id: this.formData.department_id || null,
        form_data: Object.assign({}, this.formData.custom || {}),
      },
    }).then(function (r) {
      if (gen !== self._reqGen) {
        // The visitor cancelled meanwhile: cancel the call this made, with
        // the session its answer is bound to; no queue, no ring.
        var made = r.ok && r.body;
        if (made && made.call_id) self._sendCancel(made.call_id, made.session || self.session);
        return;
      }
      if (!r.ok) {
        try { Ringback.stop(); } catch (_) {}
        var code = r.body && r.body.error;
        if (code === 'recording_consent_required') {
          self.error = self.t('err_recording_accept');
          self.state = STATES.PRE_CALL; self.render(); return;
        }
        if (code === 'department_channel_disabled' || code === 'department_not_found') {
          self.error = self.t('err_department');
          self.state = STATES.PRE_CALL; self.render(); return;
        }
        // Any other refusal: the widget's own sentence, never the server's
        // `message` (English) or its code.
        self.error = self.t('err_failed_start');
        self.state = STATES.ERROR; self.render(); return;
      }
      self.session = r.body.session || self.session;
      if (r.body.contact && r.body.contact.id) {
        self.identifiedContact = r.body.contact;
        self.formData.name = r.body.contact.name || self.formData.name || '';
        self.formData.email = r.body.contact.email || self.formData.email || '';
        self.formData.phone = r.body.contact.phone || self.formData.phone || '';
      }
      self.callId = r.body.call_id;
      self.persistActiveSession();
      var startedAt = r.body.created_at ? Date.parse(r.body.created_at) : NaN;
      self.queueStartedAt = isNaN(startedAt) ? Date.now() : startedAt;
      self.queuePosition = typeof r.body.queue_position === 'number' ? r.body.queue_position : null;
      self.queueEta = null;
      if (r.body.call_type) self.formData.call_type = (r.body.call_type === 'video') ? 'video' : 'voice';
      if (['active', 'ringing', 'connecting'].indexOf(String(r.body.call_state || '')) >= 0) {
        self.state = STATES.IN_CALL;
        self.render();
        try { Ringback.stop(); } catch (_) {}
        self.startPolling();
        self.requestJoinToken();
        return;
      }
      self.state = STATES.QUEUE;
      self.render();
      // Start ringback (visitor-side on-hold audio).
      try {
        var qe = (self.bootstrap && self.bootstrap.queue_experience) || {};
        Ringback.setLocale(self.locale, self.t('queue_wait_announce'));
        Ringback.setQueuePosition(self.queuePosition);
        // Always begin in hold phase — gentle pad + spoken "please wait"
        // announcement. Phase only flips to 'ring' when the server reports
        // call.state = 'ringing' / 'connecting' / 'active' (operator is
        // actually being rung). Queue position alone never triggers ringing.
        Ringback.setPhase('hold');
        Ringback.start(qe);
        if (Ringback.needsGesture && Ringback.needsGesture()) self.render();
      } catch (_) {}
      self.startPolling();
      self.startTimer();
    }).catch(function () {
      if (gen !== self._reqGen) return;
      // A network or script error: the widget's own sentence, never the
      // browser's English ('Failed to fetch').
      try { Ringback.stop(); } catch (_) {}
      self.error = self.t('err_failed_start');
      self.state = STATES.ERROR; self.render();
    });
  };

  CallCenterWidgetCtor.prototype.validatePreCallForm = function () {
    var cfg = (this.bootstrap && this.bootstrap.config) || {};
    var schema = Array.isArray(cfg.pre_call_form_schema) ? cfg.pre_call_form_schema : [];
    if (!cfg.pre_call_form_enabled || !schema.length) return null;
    for (var i = 0; i < schema.length; i++) {
      var field = schema[i];
      if (!field || !field.required) continue;
      var value = ['name', 'email', 'phone', 'subject'].indexOf(field.id) >= 0
        ? this.formData[field.id]
        : this.formData.custom && this.formData.custom[field.id];
      if (field.type === 'checkbox' ? value !== true : !String(value || '').trim()) return field;
    }
    return null;
  };

  CallCenterWidgetCtor.prototype.startTimer = function () {
    var self = this;
    this.stopTimer();
    this.timer = setInterval(function () {
      if (self.state === STATES.QUEUE) self.render();
      // Re-render once when the offer-callback threshold is crossed so the
      // button appears without waiting for the next status poll.
      if (self.state === STATES.QUEUE && !self._calloutShown) {
        var qe = (self.bootstrap && self.bootstrap.queue_experience) || {};
        var caps = (self.bootstrap && self.bootstrap.capabilities) || {};
        var th = qe.offer_callback_after_seconds || 0;
        var elapsed = self.queueStartedAt ? Math.floor((Date.now() - self.queueStartedAt) / 1000) : 0;
        if (caps.callback && th > 0 && elapsed >= th) {
          self._calloutShown = true;
          self.render();
        }
      }
    }, 1000);
  };
  CallCenterWidgetCtor.prototype.stopTimer = function () {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this._calloutShown = false;
  };

  // ── In-call duration timer (visitor-side) ──────────────────────────
  CallCenterWidgetCtor.prototype.startCallTimer = function () {
    var self = this;
    this.stopCallTimer();
    this.callTimer = setInterval(function () {
      if (self.callStartedAt && self.state === STATES.IN_CALL) self.render();
    }, 1000);
  };
  CallCenterWidgetCtor.prototype.stopCallTimer = function () {
    if (this.callTimer) { try { clearInterval(this.callTimer); } catch (_) {} this.callTimer = null; }
  };

  CallCenterWidgetCtor.prototype.submitRating = function () {
    var self = this;
    if (!self.endedCallId || !self.ratingValue) return;
    var id = self.endedCallId;
    self.api('/api/call-widget/calls/' + id + '/rate', {
      method: 'POST',
      body: { rating: self.ratingValue, comment: self.ratingComment || null },
    }).then(function () {
      self.ratingSubmitted = true;
      self.render();
    }).catch(function () {
      // Even on failure, treat as submitted so the visitor isn't stuck.
      self.ratingSubmitted = true;
      self.render();
    });
  };

  CallCenterWidgetCtor.prototype.startPolling = function () {
    var self = this;
    this.stopPolling();
    this.poll = setInterval(function () { self.pollOnce(); }, 5000);
    self.pollOnce();
  };
  CallCenterWidgetCtor.prototype.stopPolling = function () { if (this.poll) clearInterval(this.poll); this.poll = null; };

  /** The status's operator reference as this release sends it (callWidget.ts operatorReference). */
  var AGENT_REF = /^[0-9a-f]{16}$/;

  CallCenterWidgetCtor.prototype.pollOnce = function () {
    var id = this.callId;
    if (!id) return;
    var self = this;
    return this.api('/api/call-widget/calls/' + id + '/status').then(function (r) {
      // A call cancelled (or replaced) meanwhile: its answer changes nothing.
      if (!r.ok || self.callId !== id) return;
      var c = r.body.call; if (!c) return;
      self.call = c;
      if (typeof r.body.position === 'number') self.queuePosition = r.body.position;
      try { Ringback.setQueuePosition(self.queuePosition); } catch (_) {}
      if (typeof r.body.eta_seconds === 'number') self.queueEta = r.body.eta_seconds;
      // Track operator name + detect transfer (operator changed mid-call).
      var newOpName = r.body.operator_name || null;
      var prevAgent = self._lastAgentId || null;
      var nextAgent = c.assigned_agent_id || null;
      // A backend deploy (or its rollback) during the call: an older server
      // sends the operator's id, this one their opaque reference. One turning
      // into the other, the name unchanged, is the same operator: no transfer.
      if (prevAgent && nextAgent && AGENT_REF.test(prevAgent) !== AGENT_REF.test(nextAgent)
        && (!newOpName || !self.operatorName || newOpName === self.operatorName)) prevAgent = nextAgent;
      self._lastAgentId = nextAgent;
      self._polledName = newOpName;
      if (self.state === STATES.IN_CALL && self.transferring) {
        // The reference is back on the operator still in the room: no transfer after all.
        if (nextAgent === self._xferFrom && self._remoteCount > 0) {
          self._endTransfer();
          try { Ringback.stop(); } catch (_) {}
          self.render();
        }
      } else if (self.state === STATES.IN_CALL && prevAgent && prevAgent !== nextAgent && self._opJoined && !(self._joinedSincePoll && self._remoteCount)) {
        // E19: a transfer, from the reference changing (to another operator,
        // or to none while a department is rung) until the next operator is
        // in the room; before anyone joined, a change is routing re-offering
        // the ring; someone who joined since the last poll is the next
        // operator already (the transfer is over). The call's time runs on
        // (E10); the hold plays meanwhile.
        self.transferring = true;
        self._xferFrom = prevAgent;
        self.operatorName = null;
        // The old operator may have left before this poll saw why.
        if (self.connectStatus === 'operator_left') self.connectStatus = 'waiting_for_operator';
        self._xferTimer = setTimeout(function () {
          // Nobody joined within 120 s: the failure screen, with its callback
          // way out; the call goes on when the old operator is still in (the
          // hand-off is manual: they stay until they hang up).
          self._endTransfer();
          self._live(self._remoteCount ? 'in_call' : 'operator_left');
          try { Ringback.stop(); } catch (_) {}
          self.render();
        }, 120000);
        try {
          Ringback.setLocale(self.locale, self.t('queue_wait_announce'));
          Ringback.setPhase('hold');
          Ringback.start((self.bootstrap && self.bootstrap.queue_experience) || {});
        } catch (_) {}
        self.render();
      }
      self._joinedSincePoll = false;
      if (newOpName && newOpName !== self.operatorName && !self.transferring) {
        self.operatorName = newOpName;
        self.render();
      }
      // Initialise call-duration timer the first time the server reports a started_at.
      // Initialise call-duration timer as soon as the call is connected.
      // Prefer server `started_at`; fall back to "now" the first time we
      // observe an active/ringing/connecting state so the visitor never
      // sees a stuck 0:00 just because the DB column lags behind.
      if (!self.callStartedAt) {
        var ts = c.started_at ? Date.parse(c.started_at) : NaN;
        if (!isNaN(ts)) {
          self.callStartedAt = ts;
        } else if (['active', 'ringing', 'connecting'].indexOf(c.state) >= 0) {
          self.callStartedAt = Date.now();
        }
        if (self.callStartedAt && self.state === STATES.IN_CALL) self.startCallTimer();
      }
      if (['cancelled', 'ended', 'missed', 'failed'].indexOf(c.state) >= 0) {
        self.stopPolling(); self.stopTimer(); self.stopCallTimer();
        self._endTransfer();
        try { Ringback.stop(); } catch (_) {}
        self.endedCallId = self.callId;
        self.endedDuration = self.callStartedAt ? Math.floor((Date.now() - self.callStartedAt) / 1000) : 0;
        self.clearActiveSession();
        self.state = STATES.ENDED; self.render(); return;
      }
      if (['active', 'ringing', 'connecting'].indexOf(c.state) >= 0) {
        if (!self.transferring) { try { Ringback.setPhase('ring'); } catch (_) {} }
        if (self.state !== STATES.IN_CALL) {
          try { Ringback.stop(); } catch (_) {}
          self.state = STATES.IN_CALL; self.render();
          self.requestJoinToken();
        }
        // If we've reached connected state and have a start time, ensure
        // the duration ticker is running (survives across re-renders).
        if (self.callStartedAt && !self.callTimer) self.startCallTimer();
      } else {
        // Still queued — refresh queue UI with latest position/eta.
        // Keep playing soft hold music + announcement; do NOT ring just
        // because the visitor is first in queue. Ringing is reserved for
        // when the server actually marks the call as ringing/active.
        try { Ringback.setPhase('hold'); } catch (_) {}
        if (self.state === STATES.QUEUE) self.render();
      }
    });
  };

  CallCenterWidgetCtor.prototype.requestJoinToken = function () {
    var self = this, id = this.callId;
    this.api('/api/call-widget/calls/' + id + '/join-token', { method: 'POST' }).then(function (r) {
      if (self.callId !== id) return;
      if (!r.ok) {
        self.connectStatus = 'pending';
        self.render(); return;
      }
      self.joinInfo = r.body;
      self.connectStatus = 'token_ready';
      self.render();
      self.connectMedia();
    }).catch(function () { if (self.callId === id) { self.connectStatus = 'pending'; self.render(); } });
  };

  // ─── Room tuning + early device capture ────────────────────────────
  // Same numbers as src/lib/livekit-tuning.ts and public/widget/runtime-call.js.
  // The room used to ask for video sized from CSS pixels (a quarter of what a
  // 2x phone shows) and opened the microphone, then the camera, only AFTER
  // the room had connected. The devices are now opened while it connects, in
  // one request; a refusal falls back to the original call below.
  function lkRoomOptions() {
    return {
      adaptiveStream: { pixelDensity: 'screen' },
      dynacast: true,
      publishDefaults: {
        videoCodec: 'vp8',
        dtx: true,
        red: true,
        audioPreset: { maxBitrate: 32000 },
      },
    };
  }

  // Never rejects.
  function precaptureMedia(theRoom, wantAudio, wantVideo) {
    var held = { audio: null, video: null };
    var disposed = false;
    var stopTrack = function (t) { if (t) { try { t.stop(); } catch (_) {} } };
    var ready = Promise.resolve();
    if (wantAudio || wantVideo) {
      try {
        ready = theRoom.localParticipant.createTracks({
          audio: !!wantAudio,
          video: !!wantVideo,
        }).then(function (tracks) {
          tracks.forEach(function (t) {
            if (disposed) { stopTrack(t); return; }
            if (t.kind === 'audio') held.audio = t;
            else if (t.kind === 'video') held.video = t;
          });
        }).catch(function () { /* the fallback at publish time reports it */ });
      } catch (_) { ready = Promise.resolve(); }
    }
    return {
      take: function (kind) { return ready.then(function () { var t = held[kind]; held[kind] = null; return t; }); },
      dispose: function () {
        disposed = true;
        stopTrack(held.audio); held.audio = null;
        stopTrack(held.video); held.video = null;
      },
    };
  }

  // Publishes what the early capture got, else runs `fallback` (the original call).
  function publishEarlyOr(theRoom, pre, kind, source, fallback) {
    if (!pre) return fallback();
    return pre.take(kind).then(function (track) {
      if (!track) return fallback();
      return theRoom.localParticipant.publishTrack(track, { source: source }).catch(function () {
        try { track.stop(); } catch (_) {}
        return fallback();
      });
    });
  }

  CallCenterWidgetCtor.prototype.connectMedia = function () {
    var self = this;
    var info = this.joinInfo || {};
    var connect = info.connect || {};
    if (!connect.supported || !connect.server_url || !info.token) {
      var reason = connect.reason || 'media_not_configured';
      self.connectStatus = reason === 'livekit_url_missing' ? 'provider_client_not_configured'
        : reason === 'provider_client_not_supported' ? 'provider_client_not_supported'
        : 'media_not_configured';
      self.render();
      return;
    }
    if (connect.provider !== 'livekit') {
      self.connectStatus = 'provider_client_not_supported';
      self.render();
      return;
    }
    self.connectStatus = 'loading_media_client';
    self.render();
    var LK = window.LivekitClient || window.LiveKit || null;
    if (!LK && this.loadLiveKitSdk) {
      if (this._mediaLoadPending) return;
      this._mediaLoadPending = true;
      var pendingCallId = this.callId;
      var pendingJoinInfo = this.joinInfo;
      var pendingGeneration = this._mediaLoadGeneration || 0;
      this.loadLiveKitSdk(function (ready) {
        self._mediaLoadPending = false;
        // A cancelled call must never connect after the SDK arrives.
        if (self.callId !== pendingCallId || self.joinInfo !== pendingJoinInfo ||
            (self._mediaLoadGeneration || 0) !== pendingGeneration) return;
        if (ready) { self.connectMedia(); return; }
        self.connectStatus = 'media_client_missing';
        self.render();
      });
      return;
    }
    if (!LK) {
      self.connectStatus = 'media_client_missing';
      self.render();
      return;
    }
    if (!LK.Room) {
      self.connectStatus = 'media_client_invalid';
      self.render();
      return;
    }
    self.connectStatus = 'connecting_media';
    self.render();
    try {
      var room = new LK.Room(lkRoomOptions());
      self.lkRoom = room;
      self._attachedTracks = self._attachedTracks || {};
      var wantVideo = (self.call && self.call.call_type === 'video') || self.formData.call_type === 'video';
      var SRC = (LK.Track && LK.Track.Source) || {};
      var pre = precaptureMedia(room, true, wantVideo);
      self._pre = pre;
      var RE = LK.RoomEvent || {};
      // The events of a room the widget has left (a cancel, a reset) change nothing.
      var on = function (name, fallback, fn) {
        room.on(RE[name] || fallback, function (a, b, c) { if (self.lkRoom === room) fn(a, b, c); });
      };
      // E6: the operator is in the room: the ring stops (a resumed call's
      // ring; a transfer's hold stops with the transfer, E19).
      var joined = function () {
        self._opJoined = true;
        if (!self.transferring) { try { Ringback.stop(); } catch (_) {} }
      };
      on('Disconnected', 'disconnected', function (reason) {
        var r = String(reason || '').toLowerCase();
        if (r.indexOf('expired') >= 0 || r.indexOf('token') >= 0) {
          self.connectStatus = 'token_expired';
        } else if (self.connectStatus !== 'in_call_ended') {
          self.connectStatus = 'media_disconnected';
        }
        self.render();
      });
      on('Reconnecting', 'reconnecting', function () {
        self.connectStatus = 'media_reconnecting'; self.render();
      });
      on('Reconnected', 'reconnected', function () {
        self._live(self._remoteCount > 0 ? 'in_call' : 'waiting_for_operator');
        if (self._remoteCount > 0) joined();
        self.render();
      });
      function attach(track, participant) {
        try {
          var sid = track.sid || track.trackSid || (participant && participant.identity) + ':' + track.kind;
          if (self._attachedTracks[sid]) return;
          // Workspace can hide the operator's camera from the visitor. We
          // still subscribe to the audio so the call is functional.
          if (track.kind === 'video') {
            var caps_ = (self.bootstrap && self.bootstrap.capabilities) || {};
            if (caps_.operator_video_visible === false) return;
          }
          var el = track.attach();
          el.autoplay = true;
          if (track.kind === 'video') el.playsInline = true;
          self._attachedTracks[sid] = el;
          self.render();
          if (track.kind === 'audio') {
            try {
              var ms = el.srcObject || (track.mediaStreamTrack ? new MediaStream([track.mediaStreamTrack]) : null);
              if (ms) self._startAudioMeter(ms);
            } catch (_) {}
          }
        } catch (_) {}
      }
      function attachAll(p) {
        try {
          var pubs = p.trackPublications || p.tracks;
          pubs && pubs.forEach && pubs.forEach(function (pub) {
            if (pub && pub.track) attach(pub.track, p);
          });
        } catch (_) {}
      }
      function detach(track) {
        try {
          var sid = track.sid || track.trackSid;
          var el = sid && self._attachedTracks[sid];
          if (el) delete self._attachedTracks[sid];
          try { track.detach && track.detach(); } catch (_) {}
        } catch (_) {}
      }
      on('TrackSubscribed', 'trackSubscribed', function (track, _pub, participant) {
        attach(track, participant);
      });
      on('TrackUnsubscribed', 'trackUnsubscribed', function (track) {
        detach(track);
      });
      on('ParticipantConnected', 'participantConnected', function (p) {
        self._remoteCount = (self._remoteCount || 0) + 1;
        self._joinedSincePoll = true;
        self._live('operator_connected');
        // E19: the next operator is in: the transfer is over, their name applies.
        if (self.transferring) {
          self._endTransfer();
          self.operatorName = self._polledName || null;
        }
        joined();
        self.render();
        attachAll(p);
      });
      on('ParticipantDisconnected', 'participantDisconnected', function () {
        self._remoteCount = Math.max(0, (self._remoteCount || 1) - 1);
        if (self._remoteCount || self.transferring) return;
        // The last operator left. Ask the server first: a transfer (E19: the
        // old operator leaving is part of it) or the call's end shows as
        // such, never as "operator left" before it.
        var left = function () {
          if (self.lkRoom !== room || self._remoteCount || self.transferring || self.state !== STATES.IN_CALL) return;
          self.connectStatus = 'operator_left';
          self.render();
        };
        var asked = self.pollOnce();
        if (asked) asked.then(left, left); else left();
      });
      // E12: the visitor's own connection; LiveKit's `unknown` counts as none.
      on('ConnectionQualityChanged', 'connectionQualityChanged', function (q, p) {
        if (!p || (p !== room.localParticipant && !p.isLocal)) return;
        q = /^(excellent|good|poor|lost)$/.test(q) ? q : null;
        if (q !== self.connectionQuality) { self.connectionQuality = q; self.render(); }
      });
      // After the microphone, on the first connect and on retryMicrophone()
      // (E13): the camera of a video call, the operators already in the
      // room, the live status.
      var afterMic = function () {
        self.micOn = true;
        return (wantVideo ? publishEarlyOr(room, pre, 'video', SRC.Camera, function () {
          return room.localParticipant.setCameraEnabled(true);
        }).then(function (pub) {
          if (self.lkRoom === room) self._attachLocal(pub);
        }, function () {
          // E7: no camera: the call goes on with the microphone.
          if (self.lkRoom !== room) return;
          self.cameraDenied = true;
          self.error = self.t('camera_denied');
        }) : Promise.resolve()).then(function () {
          if (self.lkRoom !== room) return;
          var existing = [];
          try {
            if (room.remoteParticipants && room.remoteParticipants.forEach) {
              room.remoteParticipants.forEach(function (p) { existing.push(p); });
            }
          } catch (_) {}
          self._remoteCount = existing.length;
          existing.forEach(attachAll);
          if (existing.length) joined();
          self.connectStatus = existing.length ? 'in_call' : 'waiting_for_operator';
          self.camOn = !!wantVideo && !self.cameraDenied;
          self.render();
        });
      };
      self._afterMic = afterMic;
      room.connect(connect.server_url, info.token).then(function () {
        if (self.lkRoom !== room) { pre.dispose(); return; }
        return publishEarlyOr(room, pre, 'audio', SRC.Microphone, function () {
          return room.localParticipant.setMicrophoneEnabled(true);
        }).then(afterMic, function () {
          pre.dispose();
          if (self.lkRoom !== room) return;
          self.connectStatus = 'microphone_permission_denied';
          self.error = self.t('mic_denied');
          self.render();
        });
      }).catch(function (err) {
        pre.dispose();
        if (self.lkRoom !== room) return;
        var rawEm = String(err && err.message || err);
        var em = sanitize(rawEm).toLowerCase();
        var friendly = friendlyConnectError(rawEm);
        if (em.indexOf('expired') >= 0 || em.indexOf('unauthorized') >= 0 || em.indexOf('invalid token') >= 0) {
          self.connectStatus = 'token_expired';
        } else if (em.indexOf('rtc/v1') >= 0 || em.indexOf('v1 rtc') >= 0) {
          self.connectStatus = 'rtc_v1_unsupported';
          self.error = self.t(friendly || 'err_media_rtc_v1');
        } else {
          self.connectStatus = 'room_connect_failed';
          self.error = self.t(friendly || 'err_try_again');
        }
        self.render();
      });
    } catch (err) {
      self.connectStatus = 'room_connect_failed';
      self.error = self.t('err_try_again');
      self.render();
    }
  };

  /** E13: ask for the microphone again after the browser refused it. */
  CallCenterWidgetCtor.prototype.retryMicrophone = function () {
    var self = this, room = this.lkRoom, after = this._afterMic;
    if (!room || !after) return Promise.resolve();
    return room.localParticipant.setMicrophoneEnabled(true).then(function () {
      if (self.lkRoom !== room) return;
      self.error = null;
      return after();
    }).catch(function () {
      if (self.lkRoom !== room) return;
      self.connectStatus = 'microphone_permission_denied';
      self.render();
    });
  };

  /** The self-view of the local camera track (`pub`, else the participant's first video). */
  CallCenterWidgetCtor.prototype._attachLocal = function (pub) {
    try {
      var track = pub && pub.track, lp = this.lkRoom.localParticipant;
      if (!track) {
        var lpubs = lp.videoTrackPublications || lp.videoTracks;
        lpubs && lpubs.forEach && lpubs.forEach(function (p) { if (p && p.track && !track) track = p.track; });
      }
      if (track) {
        var lv = track.attach();
        lv.autoplay = true; lv.playsInline = true; lv.muted = true;
        this._localVideoEl = lv;
        this._localVideoTrack = track;
      }
    } catch (_) {}
  };

  CallCenterWidgetCtor.prototype.toggleMic = function () {
    if (!this.lkRoom) return;
    var next = !this.micOn;
    var self = this;
    this.lkRoom.localParticipant.setMicrophoneEnabled(next).then(function () {
      self.micOn = next; self.render();
    });
  };
  CallCenterWidgetCtor.prototype.toggleCam = function () {
    if (!this.lkRoom) return;
    var next = !this.camOn;
    var self = this;
    this.lkRoom.localParticipant.setCameraEnabled(next).then(function (pub) {
      self.camOn = next;
      if (next) {
        self._attachLocal(pub);
        // E7: the camera works after all.
        if (self.cameraDenied) {
          self.cameraDenied = false;
          if (self.error === self.t('camera_denied')) self.error = null;
        }
      } else {
        try {
          if (self._localVideoTrack && self._localVideoEl) { self._localVideoTrack.detach(self._localVideoEl); }
        } catch (_) {}
        self._localVideoEl = null; self._localVideoTrack = null;
      }
      self.render();
    });
  };
  CallCenterWidgetCtor.prototype.disconnectRoom = function () {
    try { if (this._pre) this._pre.dispose(); } catch (_) {}
    this._pre = null;
    try { if (this.lkRoom) this.lkRoom.disconnect(); } catch (_) {}
    this.lkRoom = null;
    this._attachedTracks = {};
    this._remoteCount = 0;
    this._opJoined = this._joinedSincePoll = false;
    this.connectionQuality = null;
    this._endTransfer();
    try {
      if (this._localVideoTrack && this._localVideoEl) { this._localVideoTrack.detach(this._localVideoEl); }
    } catch (_) {}
    this._localVideoEl = null; this._localVideoTrack = null;
    this._stopAudioMeter();
  };

  /** The call's live status; a refused microphone keeps its screen (and its retry, E13) whoever joins. */
  CallCenterWidgetCtor.prototype._live = function (status) {
    if (this.connectStatus !== 'microphone_permission_denied') this.connectStatus = status;
  };

  /** E19: the transfer is over (joined, timed out, withdrawn, or the call ended). */
  CallCenterWidgetCtor.prototype._endTransfer = function () {
    clearTimeout(this._xferTimer);
    this._xferTimer = null;
    this.transferring = false;
  };

  CallCenterWidgetCtor.prototype._startAudioMeter = function (mediaStream) {
    if (!mediaStream || this._audioMeterStream === mediaStream) return;
    var self = this;
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!this._audioCtx) {
        this._audioCtx = new Ctx();
        try { this._audioCtx.addEventListener('statechange', function () { self._meterLive(); }); } catch (_) {}
      }
      if (this._audioCtx.state === 'suspended') { try { this._audioCtx.resume(); } catch (_) {} }
      try { this._audioSource && this._audioSource.disconnect(); } catch (_) {}
      this._audioSource = this._audioCtx.createMediaStreamSource(mediaStream);
      this._audioAnalyser = this._audioCtx.createAnalyser();
      this._audioAnalyser.fftSize = 64;
      this._audioAnalyser.smoothingTimeConstant = 0.75;
      this._audioSource.connect(this._audioAnalyser);
      this._audioMeterStream = mediaStream;
      this._audioBuf = new Uint8Array(this._audioAnalyser.frequencyBinCount);
      this._meterLive();
      if (this._audioRaf) cancelAnimationFrame(this._audioRaf);
      var loop = function () {
        self._audioRaf = requestAnimationFrame(loop);
        if (!self._audioAnalyser) return;
        try { self._audioAnalyser.getByteFrequencyData(self._audioBuf); } catch (_) { return; }
        var bars = self._waveBars;
        if (!bars || !bars.length) return;
        var n = bars.length;
        var binStep = Math.max(1, Math.floor(self._audioBuf.length / n));
        for (var i = 0; i < n; i++) {
          var v = self._audioBuf[i * binStep] || 0;
          var pct = Math.max(0.16, Math.min(1, v / 180));
          bars[i].style.transform = 'scaleY(' + pct.toFixed(3) + ')';
        }
      };
      loop();
    } catch (_) {}
  };

  /**
   * E20: the level bars follow the meter only while its context runs on a
   * remote stream (a suspended context, as after a restored call without a
   * gesture, writes only their floor); renders on a change.
   */
  CallCenterWidgetCtor.prototype._meterLive = function () {
    var live = !!(this._audioAnalyser && this._audioCtx && this._audioCtx.state === 'running');
    if (live !== this.audioMeterLive) { this.audioMeterLive = live; this.render(); }
  };

  CallCenterWidgetCtor.prototype._stopAudioMeter = function () {
    try { if (this._audioRaf) cancelAnimationFrame(this._audioRaf); } catch (_) {}
    this._audioRaf = null;
    try { this._audioSource && this._audioSource.disconnect(); } catch (_) {}
    this._audioSource = null;
    this._audioAnalyser = null;
    this._audioMeterStream = null;
    this._waveBars = null;
    this.audioMeterLive = false;
  };

  CallCenterWidgetCtor.prototype.resumeActiveCall = function () {
    var ac = this.bootstrap && this.bootstrap.active_call;
    if (!ac || !ac.call_id) return;
    if (ac.session) this.session = ac.session;
    this.callId = ac.call_id;
    this.persistActiveSession();
    this.formData.call_type = (ac.call_type === 'video') ? 'video' : 'voice';
    var startedAt = null;
    if (ac.created_at) {
      var ts = Date.parse(ac.created_at);
      if (!isNaN(ts)) startedAt = ts;
    }
    this.queueStartedAt = startedAt || Date.now();
    this.queuePosition = typeof ac.queue_position === 'number' ? ac.queue_position : null;
    this.open = true;
    if (['active', 'ringing', 'connecting'].indexOf(ac.state) >= 0) {
      this.state = STATES.IN_CALL;
      this.render();
      try {
        var qe = (this.bootstrap && this.bootstrap.queue_experience) || {};
        Ringback.setLocale(this.locale, this.t('queue_wait_announce'));
        Ringback.setPhase('ring');
        Ringback.start(qe);
      } catch (_) {}
      this.startPolling();
      this.requestJoinToken();
    } else {
      this.state = STATES.QUEUE;
      this.render();
      try {
        var qe2 = (this.bootstrap && this.bootstrap.queue_experience) || {};
        Ringback.setLocale(this.locale, this.t('queue_wait_announce'));
        Ringback.setQueuePosition(this.queuePosition);
        Ringback.setPhase('hold');
        Ringback.start(qe2);
      } catch (_) {}
      this.startPolling();
      this.startTimer();
    }
  };

  /**
   * E4: a promise, settled when the widget has left the call (resolved also
   * without a call id, never rejected). A cancel that failed or got no JSON
   * back counts as answered; it is sent once more in the background 1.5 s
   * later with the call's own session, since the server reaps no abandoned
   * queued call (an unsent cancel rings an operator for nobody).
   */
  CallCenterWidgetCtor.prototype.cancelCall = function () {
    // A second press while the cancel is on its way leaves at once (a hung
    // request never traps the visitor) and sends nothing more.
    if (this._cancelDone) { this._cancelDone(); return Promise.resolve(); }
    var self = this, id = this.callId, sess = this.session;
    this._mediaLoadGeneration = (this._mediaLoadGeneration || 0) + 1;
    this.disconnectRoom();
    try { Ringback.stop(); } catch (_) {}
    // E21: no call id yet (the start request on its way): home at once.
    if (!id) { this.reset(); return Promise.resolve(); }
    this.stopPolling(); this.stopTimer(); this.stopCallTimer();
    // Snapshot for the rating screen.
    this.endedCallId = id;
    this.endedDuration = this.callStartedAt ? Math.floor((Date.now() - this.callStartedAt) / 1000) : 0;
    this.callId = null;
    var done = this._cancelDone = function () {
      if (self._cancelDone !== done) return;
      self._cancelDone = null;
      if (self.endedCallId !== id) return;
      self.clearActiveSession();
      self.call = null;
      // If the call actually connected, go to ENDED so the visitor can rate.
      if (self.endedDuration > 0) {
        self.state = STATES.ENDED;
        self.render();
      } else {
        self.reset();
      }
    };
    return this._sendCancel(id, sess).then(done);
  };

  /**
   * POSTs the cancel of call `id` with its own session; settles once
   * answered, never rejects. A failed answer (no answer, not JSON, 5xx, 429)
   * is sent once more 1.5 s later (E4; also the call a cancelled start
   * request made, E21).
   */
  CallCenterWidgetCtor.prototype._sendCancel = function (id, sess) {
    var self = this;
    var send = function () {
      return self.api('/api/call-widget/calls/' + id + '/cancel', { method: 'POST', headers: { 'x-cc-session': sess } });
    };
    var retry = function () { setTimeout(function () { send().catch(noop); }, 1500); };
    return send().then(function (r) { if (r.status >= 500 || r.status === 429) retry(); }, retry);
  };

  CallCenterWidgetCtor.prototype.reset = function () {
    this._mediaLoadGeneration = (this._mediaLoadGeneration || 0) + 1;
    // E21: a start request still on its way is stale from now on.
    this._reqGen = (this._reqGen || 0) + 1;
    this.disconnectRoom();
    try { Ringback.stop(); } catch (_) {}
    this.clearActiveSession();
    this.stopCallTimer();
    this.callId = null; this.call = null; this.queueStartedAt = null;
    this.queuePosition = null; this.queueEta = null;
    this.connectStatus = null; this.joinInfo = null; this.error = null; this.errorKey = null;
    this.micOn = false; this.camOn = false; this._remoteHolder = null;
    this.cameraDenied = false;
    this.operatorName = null;
    this.callStartedAt = null;
    this.endedCallId = null;
    this.endedDuration = 0;
    // E3: the last callback request goes too (the booked one stays on the
    // launcher until its time, E11).
    this.callbackId = null;
    this.checkBooking();
    this.ratingSubmitted = false;
    this.ratingValue = 0;
    this.ratingComment = '';
    this._lastAgentId = null;
    this.state = this.isOnline() ? STATES.ONLINE : STATES.OFFLINE;
    this.render();
  };

  CallCenterWidgetCtor.prototype.openCallback = function () {
    var depts = (this.bootstrap && this.bootstrap.departments) || {};
    var list = depts.callback || [];
    this.formData.department_id = (list.length === 1) ? list[0].id : '';
    this.formData.hp_company = '';
    this.callbackOpenedAt = Date.now();
    this.error = null; this.errorKey = null;
    this.state = STATES.CALLBACK;
    this.render();
  };

  // The server's refusals of a callback request and the widget's sentence for each.
  var CALLBACK_ERRORS = {
    department_channel_disabled: 'err_department', department_not_found: 'err_department', contact_required: 'err_contact_required',
    too_fast: 'err_too_fast', rate_limited_ip: 'err_rate_limited', feature_not_available: 'err_callback_unavailable',
    // A time the server refuses (not a bookable slot, out of range): pick another (E15).
    slot_unavailable: 'err_future_time', invalid_scheduled_for: 'err_future_time',
  };

  CallCenterWidgetCtor.prototype.submitCallback = function () {
    var self = this;
    // E15: the error's key travels with it (the form steps back to the time choice for err_future_time).
    var fail = function (key, vars) { self.error = self.t(key, vars); self.errorKey = key; self.render(); };
    this.error = null; this.errorKey = null;
    var policy = (this.bootstrap && this.bootstrap.callback_policy) || {};
    // Client-side cooldown guard (server still enforces).
    if (this.callbackCooldownUntil && Date.now() < this.callbackCooldownUntil) {
      return fail('err_wait_seconds', { n: Math.ceil((this.callbackCooldownUntil - Date.now()) / 1000) });
    }
    // Require contact if the platform demands it.
    if (policy.require_contact) {
      var email = (this.formData.email || '').trim();
      var phone = (this.formData.phone || '').trim();
      var alreadyId = !!(this.identifiedContact && this.identifiedContact.id);
      if (!alreadyId && !email && !phone) return fail('err_contact_required');
    }
    // Minimum message length.
    var minMsg = Number(policy.min_message_length || 0);
    if (minMsg > 0 && (this.formData.message || '').trim().length < minMsg) return fail('err_message_short', { n: minMsg });
    var scheduledIso = null;
    if (this.formData.callback_when === 'later' && this.formData.callback_scheduled_for) {
      var t = new Date(this.formData.callback_scheduled_for);
      if (isNaN(t.getTime()) || t.getTime() <= Date.now() - 60000) return fail('err_future_time');
      scheduledIso = t.toISOString();
    }
    var body = {
      name: this.formData.name || null,
      email: this.formData.email || null,
      phone: this.formData.phone || null,
      subject: this.formData.subject || null,
      message: this.formData.message || null,
      channel: this.formData.callback_channel || 'audio',
      urgency: this.formData.callback_urgency || 'normal',
      scheduled_for: scheduledIso,
      page_url: location.href,
      department_id: this.formData.department_id || null,
      hp_company: this.formData.hp_company || '',
      form_opened_at: this.callbackOpenedAt || null,
    };
    this.api('/api/call-widget/callbacks/request', { method: 'POST', body: body }).then(function (r) {
      var a = r.body || {};
      if (!r.ok) {
        var code = a.error;
        if (code === 'message_too_short') return fail('err_message_short', { n: Number(a.min) || 1 });
        if (code === 'cooldown_active') {
          var ra = Number(a.retry_after) || 60;
          self.callbackCooldownUntil = Date.now() + ra * 1000;
          return fail('err_cooldown', { n: ra });
        }
        // Any other refusal: the widget's own sentence, never the server's
        // `message` (English) or its code.
        return fail((typeof code === 'string' && Object.prototype.hasOwnProperty.call(CALLBACK_ERRORS, code) && CALLBACK_ERRORS[code]) || 'err_failed');
      }
      self.callbackId = a.callback_id;
      // E11: a time booked stays on the launcher until then (the server's
      // echo when it sends one); "as soon as possible" books nothing.
      if (scheduledIso && a.callback_id) {
        self.setBooking({
          callbackId: String(a.callback_id),
          scheduled_for: typeof a.scheduled_for === 'string' && a.scheduled_for ? a.scheduled_for : scheduledIso,
          channel: (a.channel || body.channel) === 'video' ? 'video' : 'audio',
          urgency: (a.urgency || body.urgency) === 'urgent' ? 'urgent' : 'normal',
        });
      }
      var pol = (self.bootstrap && self.bootstrap.callback_policy) || {};
      if (pol.cooldown_seconds) {
        self.callbackCooldownUntil = Date.now() + Number(pol.cooldown_seconds) * 1000;
      }
      self.state = STATES.ENDED;
      self.render();
    });
  };

  CallCenterWidgetCtor.prototype.render = function () {
    if (!this.root) return;
    var self = this;
    var theme = (this.bootstrap && this.bootstrap.config && this.bootstrap.config.widget_theme) || {};
    var context = {
      contractVersion: 1,
      root: this.root,
      theme: theme,
      viewModel: this.getPresentationViewModel(),
      intents: this.getPresentationIntents(),
      controller: this,
      loadPanel: this.loadPanel || null,
      audio: Object.freeze({
        isActive: Ringback.isActive,
        isMuted: Ringback.isMuted,
        needsGesture: Ringback.needsGesture,
        setMuted: Ringback.setMuted,
        startFromGesture: Ringback.startFromGesture,
      }),
    };
    if (!this.presentation) return;
    if (!this.presentationInstance) {
      this.presentationInstance = this.presentation.mount(context);
    } else {
      this.presentation.update(this.presentationInstance, context);
    }
  };

  CallCenterWidgetCtor.prototype.getPresentationViewModel = function () {
    return Object.freeze({
      state: this.state,
      open: !!this.open,
      locale: this.locale,
      direction: (LOCALE_META[this.locale] && LOCALE_META[this.locale].dir) || 'ltr',
      online: this.isOnline(),
      position: this.position(),
      config: Object.freeze(Object.assign({}, (this.bootstrap && this.bootstrap.config) || {})),
      capabilities: Object.freeze(Object.assign({}, (this.bootstrap && this.bootstrap.capabilities) || {})),
      error: this.error || null,
      queuePosition: this.queuePosition,
      queueEta: this.queueEta,
      connectStatus: this.connectStatus || null,
    });
  };

  CallCenterWidgetCtor.prototype.getPresentationIntents = function () {
    var self = this;
    return Object.freeze({
      toggleOpen: function () { self.toggleOpen(); },
      startVoiceCall: function () { self.startCall('voice'); },
      startVideoCall: function () { self.startCall('video'); },
      requestCallback: function () { self.openCallback(); },
      cancelCall: function () { return self.cancelCall(); },
      reset: function () { self.reset(); },
      setLocale: function (locale) { self.setLocale(locale); },
    });
  };

  window.CallCenterWidget = new CallCenterWidgetCtor();
})();
