/*!
 * Call Center Widget Runtime — independent from Chat Widget.
 * Mounts inside a Shadow DOM root. Idempotent.
 */
(function () {
  'use strict';
  if (window.CallCenterWidget && window.CallCenterWidget.__mounted__) return;

  var STATES = {
    LOADING: 'loading',
    ONLINE: 'online_available',
    OFFLINE: 'offline',
    PRE_CALL: 'pre_call_form',
    QUEUE: 'queue_waiting',
    RINGING: 'ringing',
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
      talk_now: 'Talk now', callback: 'Callback', live_support: 'Live support', leave_details: 'Leave details', support: 'Support',
      operators_available: 'Operators available', callback_desk: 'Callback desk', loading: 'Loading…', offline: 'Offline',
      leave_callback_request: 'Leave a callback request', offline_copy: 'Our team is offline right now, but we can call you back.', request_callback: 'Request callback',
      live_now: 'Live now', channels: 'Voice · Video · Callback', talk_to_team: 'Talk to our team', online_copy: 'Start a secure voice or video call with the next available operator.',
      secure_line: 'Secure line', queue_aware: 'Queue aware', fast_handoff: 'Fast handoff', voice_call: 'Voice call', video_call: 'Video call', request_callback_instead: 'Request a callback',
      you_are_next: 'You are next', holding_place: 'Holding your place', queue_copy_many: 'Your request is in the live call queue. Keep this window open while we connect the operator.', queue_copy_next: 'We are ringing the next available operator now.',
      ringing_enabled: 'Ringing enabled', ringing_operator: 'Ringing operator', waiting_time: 'Waiting time', enable_ringing_sound: '🔊 Enable ringing sound', mute_sound: 'Mute sound', unmute_sound: 'Unmute sound', you_next_line: 'You are next in line', you_queue_number: 'You are #{n} in the queue',
      queue_position: 'Queue position', eta: 'ETA', eta_under_min: 'Estimated wait: under 1 minute', eta_minutes: 'Estimated wait: ~{n} minutes', tired_waiting: 'Tired of waiting? We can call you back instead.', cancel_call: 'Cancel call',
      call_accepted_connecting: 'Call accepted, connecting…', connected: 'Connected', operator_joining: 'Operator joining…', operator_connected: 'Operator connected', operator_left: 'Operator left the call.', reconnecting_media: 'Reconnecting media…', media_disconnected: 'Media disconnected.', connecting_av: 'Connecting audio/video…',
      fallback: 'Call accepted. Please continue on the operator side.', accepted_no_sdk: 'Call accepted. Audio/video client unavailable on this page.', media_not_configured: 'Call accepted, media connection is not configured yet.', provider_not_configured: 'Call accepted, but the media server URL is not configured. Please request a callback.', provider_not_supported: 'Call accepted, but this provider has no in-browser client.', media_client_missing: 'Media client is not loaded. Call room is ready but the browser client is missing.', media_client_invalid: 'Media client loaded but is incompatible with this widget.', loading_media_client: 'Loading media client…', mic_denied: 'Microphone permission denied. Please allow access and try again.', camera_denied: 'Camera permission denied. Audio call continues without video.', room_failed: 'Failed to connect to the call room: {error}', token_expired: 'Your session expired. Please end and start a new call.',
      in_call: 'In call', connected_waiting: 'Connected — waiting', connecting: 'Connecting', recording_progress: '● Recording in progress', recording_may_start: 'Recording may start after the operator begins the call.', mute: '🎙 Mute', unmute: '🎙 Unmute', camera_off: '🎥 Camera off', camera_on: '🎥 Camera on', end: 'End',
      callback_scheduled: 'Callback scheduled', reach_out: 'Our team will reach out {when}.', asap: 'as soon as possible', video_callback: 'Video callback', phone_callback: 'Phone callback', reference: 'Reference', type: 'Type', done: 'Done', call_ended: 'Call ended.', error_prefix: 'Error: {error}', unknown: 'unknown', back: 'Back',
      request_callback_title: 'Request a callback', callback_intro: 'Tell us how to reach you — our team calls back fast.', callback_type: 'Callback type', phone: '🎙 Phone', video: '🎥 Video', department: 'Department', choose_department: 'Choose a department', known_contact: 'Known contact', contact_saved: 'Contact details already saved', subject: 'Subject', full_name: 'Full name', email: 'Email', email_required: 'Email *', phone_field: 'Phone', phone_required: 'Phone *', contact_required_note: '* Email or phone is required so we can reach you.', message_min: 'Message (min {n} chars)', message_optional: 'Message (optional)', message_placeholder: 'Briefly describe what you need help with…', when_call: 'When should we call?', schedule: '🗓 Schedule', priority: 'Priority', normal: 'Normal', urgent: '🔥 Urgent', consent_required: ' I consent to this call being recorded for quality and security. (required)', call_may_record: 'This call may be recorded for quality and security.', start_call: 'Start call', send_request: 'Send request',
      err_recording_required: 'Recording consent is required to continue.', err_recording_accept: 'Please accept the recording consent to start the call.', err_department: 'This department is not available for this call type. Please choose another department.', err_failed_start: 'Failed to start call.', err_wait_seconds: 'Please wait {n}s before sending another request.', err_contact_required: 'Please provide your email or phone so we can reach you.', err_message_short: 'Please describe your request in at least {n} characters.', err_future_time: 'Please pick a valid future time.', err_too_fast: 'That was too fast. Please take a moment to fill in the form.', err_cooldown: 'You already requested a callback. Please wait {n}s before sending another.', err_rate_limited: 'Too many callback requests from your network. Please try again later.', err_callback_unavailable: 'Callback requests are currently unavailable.', err_failed: 'Failed.',
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
      rate_thanks: 'Thank you for your feedback!'
    },
    fa: {
      talk_now: 'همین حالا تماس بگیرید', callback: 'درخواست تماس', live_support: 'پشتیبانی آنلاین', leave_details: 'ثبت اطلاعات', support: 'پشتیبانی',
      operators_available: 'اپراتورها آماده‌اند', callback_desk: 'میز درخواست تماس', loading: 'در حال بارگذاری…', offline: 'آفلاین',
      leave_callback_request: 'درخواست تماس ثبت کنید', offline_copy: 'تیم ما الان آفلاین است، اما می‌توانیم با شما تماس بگیریم.', request_callback: 'درخواست تماس',
      live_now: 'آنلاین', channels: 'صوتی · تصویری · درخواست تماس', talk_to_team: 'با تیم ما صحبت کنید', online_copy: 'یک تماس صوتی یا تصویری امن را با اولین اپراتور آزاد شروع کنید.',
      secure_line: 'خط امن', queue_aware: 'مدیریت صف', fast_handoff: 'اتصال سریع', voice_call: 'تماس صوتی', video_call: 'تماس تصویری', request_callback_instead: 'درخواست تماس',
      you_are_next: 'نفر بعدی شما هستید', holding_place: 'جای شما محفوظ است', queue_copy_many: 'درخواست شما در صف تماس زنده است. این پنجره را باز نگه دارید تا اپراتور متصل شود.', queue_copy_next: 'در حال زنگ زدن به اولین اپراتور آزاد هستیم.',
      ringing_enabled: 'صدای زنگ فعال است', ringing_operator: 'در حال زنگ زدن به اپراتور', waiting_time: 'زمان انتظار', enable_ringing_sound: '🔊 فعال کردن صدا', mute_sound: 'بی‌صدا کردن', unmute_sound: 'فعال کردن صدا', you_next_line: 'شما نفر بعدی صف هستید', you_queue_number: 'شما نفر {n} صف هستید',
      queue_position: 'جایگاه در صف', eta: 'زمان تقریبی', eta_under_min: 'زمان انتظار: کمتر از ۱ دقیقه', eta_minutes: 'زمان انتظار: حدود {n} دقیقه', tired_waiting: 'از انتظار خسته شدید؟ می‌توانیم با شما تماس بگیریم.', cancel_call: 'لغو تماس',
      call_accepted_connecting: 'تماس پذیرفته شد، در حال اتصال…', connected: 'متصل شد', operator_joining: 'اپراتور در حال ورود است…', operator_connected: 'اپراتور متصل شد', operator_left: 'اپراتور تماس را ترک کرد.', reconnecting_media: 'در حال اتصال مجدد رسانه…', media_disconnected: 'ارتباط رسانه قطع شد.', connecting_av: 'در حال اتصال صدا/تصویر…',
      fallback: 'تماس پذیرفته شد. لطفاً از سمت اپراتور ادامه دهید.', accepted_no_sdk: 'تماس پذیرفته شد. کلاینت صدا/تصویر در این صفحه در دسترس نیست.', media_not_configured: 'تماس پذیرفته شد، اما اتصال رسانه هنوز تنظیم نشده است.', provider_not_configured: 'تماس پذیرفته شد، اما آدرس سرور رسانه تنظیم نشده است. لطفاً درخواست تماس ثبت کنید.', provider_not_supported: 'تماس پذیرفته شد، اما این ارائه‌دهنده کلاینت مرورگری ندارد.', media_client_missing: 'کلاینت رسانه بارگذاری نشده است. اتاق تماس آماده است اما کلاینت مرورگر موجود نیست.', media_client_invalid: 'کلاینت رسانه بارگذاری شده با این ویجت سازگار نیست.', loading_media_client: 'در حال بارگذاری کلاینت رسانه…', mic_denied: 'دسترسی میکروفون رد شد. لطفاً اجازه دسترسی بدهید و دوباره تلاش کنید.', camera_denied: 'دسترسی دوربین رد شد. تماس صوتی بدون تصویر ادامه دارد.', room_failed: 'اتصال به اتاق تماس ناموفق بود: {error}', token_expired: 'جلسه شما منقضی شد. لطفاً تماس را پایان دهید و دوباره شروع کنید.',
      in_call: 'در تماس', connected_waiting: 'متصل — در انتظار', connecting: 'در حال اتصال', recording_progress: '● ضبط در حال انجام است', recording_may_start: 'ممکن است ضبط پس از شروع تماس توسط اپراتور آغاز شود.', mute: '🎙 بی‌صدا', unmute: '🎙 فعال‌کردن صدا', camera_off: '🎥 خاموش کردن دوربین', camera_on: '🎥 روشن کردن دوربین', end: 'پایان',
      callback_scheduled: 'درخواست تماس ثبت شد', reach_out: 'تیم ما {when} با شما تماس می‌گیرد.', asap: 'در اولین فرصت', video_callback: 'تماس تصویری', phone_callback: 'تماس تلفنی', reference: 'کد پیگیری', type: 'نوع', done: 'تمام', call_ended: 'تماس پایان یافت.', error_prefix: 'خطا: {error}', unknown: 'نامشخص', back: 'بازگشت',
      request_callback_title: 'درخواست تماس', callback_intro: 'راه ارتباطی را وارد کنید — تیم ما سریع تماس می‌گیرد.', callback_type: 'نوع تماس', phone: '🎙 تلفنی', video: '🎥 تصویری', department: 'دپارتمان', choose_department: 'یک دپارتمان انتخاب کنید', known_contact: 'مخاطب شناخته‌شده', contact_saved: 'اطلاعات تماس قبلاً ذخیره شده است', subject: 'موضوع', full_name: 'نام کامل', email: 'ایمیل', email_required: 'ایمیل *', phone_field: 'تلفن', phone_required: 'تلفن *', contact_required_note: '* ایمیل یا تلفن برای تماس با شما الزامی است.', message_min: 'پیام (حداقل {n} کاراکتر)', message_optional: 'پیام (اختیاری)', message_placeholder: 'کوتاه توضیح دهید چه کمکی نیاز دارید…', when_call: 'چه زمانی تماس بگیریم؟', schedule: '🗓 زمان‌بندی', priority: 'اولویت', normal: 'عادی', urgent: '🔥 فوری', consent_required: ' رضایت می‌دهم این تماس برای کیفیت و امنیت ضبط شود. (الزامی)', call_may_record: 'ممکن است این تماس برای کیفیت و امنیت ضبط شود.', start_call: 'شروع تماس', send_request: 'ارسال درخواست',
      err_recording_required: 'برای ادامه، رضایت ضبط تماس الزامی است.', err_recording_accept: 'برای شروع تماس لطفاً رضایت ضبط را تأیید کنید.', err_department: 'این دپارتمان برای این نوع تماس در دسترس نیست. لطفاً دپارتمان دیگری انتخاب کنید.', err_failed_start: 'شروع تماس ناموفق بود.', err_wait_seconds: 'لطفاً {n} ثانیه قبل از ارسال درخواست بعدی صبر کنید.', err_contact_required: 'لطفاً ایمیل یا تلفن خود را وارد کنید تا بتوانیم با شما تماس بگیریم.', err_message_short: 'لطفاً درخواست خود را حداقل در {n} کاراکتر توضیح دهید.', err_future_time: 'لطفاً یک زمان معتبر در آینده انتخاب کنید.', err_too_fast: 'خیلی سریع بود. لطفاً کمی برای تکمیل فرم زمان بگذارید.', err_cooldown: 'قبلاً درخواست تماس ثبت کرده‌اید. لطفاً {n} ثانیه صبر کنید.', err_rate_limited: 'درخواست‌های زیادی از شبکه شما ارسال شده است. بعداً دوباره تلاش کنید.', err_callback_unavailable: 'درخواست تماس در حال حاضر در دسترس نیست.', err_failed: 'ناموفق بود.',
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
      rate_thanks: 'از بازخورد شما متشکریم!'
    },
    tr: {
      talk_now: 'Şimdi konuş', callback: 'Geri arama', live_support: 'Canlı destek', leave_details: 'Bilgilerini bırak', support: 'Destek',
      operators_available: 'Operatörler müsait', callback_desk: 'Geri arama masası', loading: 'Yükleniyor…', offline: 'Çevrimdışı',
      leave_callback_request: 'Geri arama isteği bırakın', offline_copy: 'Ekibimiz şu anda çevrimdışı, ancak sizi geri arayabiliriz.', request_callback: 'Geri arama iste',
      live_now: 'Canlı', channels: 'Ses · Video · Geri arama', talk_to_team: 'Ekibimizle konuşun', online_copy: 'İlk uygun operatörle güvenli sesli veya görüntülü arama başlatın.',
      secure_line: 'Güvenli hat', queue_aware: 'Sıra takibi', fast_handoff: 'Hızlı aktarım', voice_call: 'Sesli arama', video_call: 'Görüntülü arama', request_callback_instead: 'Geri arama iste',
      you_are_next: 'Sıradaki sizsiniz', holding_place: 'Yeriniz korunuyor', queue_copy_many: 'İsteğiniz canlı arama kuyruğunda. Operatöre bağlanırken bu pencereyi açık tutun.', queue_copy_next: 'Şimdi ilk uygun operatörü arıyoruz.',
      ringing_enabled: 'Zil sesi açık', ringing_operator: 'Operatör aranıyor', waiting_time: 'Bekleme süresi', enable_ringing_sound: '🔊 Zil sesini aç', mute_sound: 'Sesi kapat', unmute_sound: 'Sesi aç', you_next_line: 'Sıradaki sizsiniz', you_queue_number: 'Kuyrukta #{n} sıradasınız',
      queue_position: 'Kuyruk sırası', eta: 'Tahmini', eta_under_min: 'Tahmini bekleme: 1 dakikadan az', eta_minutes: 'Tahmini bekleme: ~{n} dakika', tired_waiting: 'Beklemekten sıkıldınız mı? Sizi geri arayabiliriz.', cancel_call: 'Aramayı iptal et',
      call_accepted_connecting: 'Arama kabul edildi, bağlanıyor…', connected: 'Bağlandı', operator_joining: 'Operatör katılıyor…', operator_connected: 'Operatör bağlandı', operator_left: 'Operatör aramadan ayrıldı.', reconnecting_media: 'Medya yeniden bağlanıyor…', media_disconnected: 'Medya bağlantısı koptu.', connecting_av: 'Ses/video bağlanıyor…',
      fallback: 'Arama kabul edildi. Lütfen operatör tarafında devam edin.', accepted_no_sdk: 'Arama kabul edildi. Bu sayfada ses/video istemcisi yok.', media_not_configured: 'Arama kabul edildi, medya bağlantısı henüz yapılandırılmamış.', provider_not_configured: 'Arama kabul edildi, ancak medya sunucusu URL’si yapılandırılmamış. Lütfen geri arama isteyin.', provider_not_supported: 'Arama kabul edildi, ancak bu sağlayıcının tarayıcı istemcisi yok.', media_client_missing: 'Medya istemcisi yüklenmedi. Arama odası hazır ancak tarayıcı istemcisi eksik.', media_client_invalid: 'Yüklenen medya istemcisi bu widget ile uyumlu değil.', loading_media_client: 'Medya istemcisi yükleniyor…', mic_denied: 'Mikrofon izni reddedildi. Lütfen izin verip tekrar deneyin.', camera_denied: 'Kamera izni reddedildi. Sesli arama video olmadan devam eder.', room_failed: 'Arama odasına bağlanılamadı: {error}', token_expired: 'Oturumunuz sona erdi. Lütfen aramayı bitirip yeniden başlatın.',
      in_call: 'Aramada', connected_waiting: 'Bağlandı — bekliyor', connecting: 'Bağlanıyor', recording_progress: '● Kayıt devam ediyor', recording_may_start: 'Kayıt, operatör aramayı başlattıktan sonra başlayabilir.', mute: '🎙 Sessize al', unmute: '🎙 Sesi aç', camera_off: '🎥 Kamerayı kapat', camera_on: '🎥 Kamerayı aç', end: 'Bitir',
      callback_scheduled: 'Geri arama planlandı', reach_out: 'Ekibimiz {when} size ulaşacak.', asap: 'en kısa sürede', video_callback: 'Görüntülü geri arama', phone_callback: 'Telefonla geri arama', reference: 'Referans', type: 'Tür', done: 'Tamam', call_ended: 'Arama sona erdi.', error_prefix: 'Hata: {error}', unknown: 'bilinmiyor', back: 'Geri',
      request_callback_title: 'Geri arama iste', callback_intro: 'Size nasıl ulaşacağımızı yazın — ekibimiz hızlıca döner.', callback_type: 'Geri arama türü', phone: '🎙 Telefon', video: '🎥 Video', department: 'Departman', choose_department: 'Departman seçin', known_contact: 'Bilinen kişi', contact_saved: 'İletişim bilgileri kayıtlı', subject: 'Konu', full_name: 'Ad soyad', email: 'E-posta', email_required: 'E-posta *', phone_field: 'Telefon', phone_required: 'Telefon *', contact_required_note: '* Size ulaşabilmemiz için e-posta veya telefon gerekir.', message_min: 'Mesaj (en az {n} karakter)', message_optional: 'Mesaj (isteğe bağlı)', message_placeholder: 'Neye ihtiyacınız olduğunu kısaca yazın…', when_call: 'Ne zaman arayalım?', schedule: '🗓 Planla', priority: 'Öncelik', normal: 'Normal', urgent: '🔥 Acil', consent_required: ' Bu aramanın kalite ve güvenlik için kaydedilmesine izin veriyorum. (gerekli)', call_may_record: 'Bu arama kalite ve güvenlik için kaydedilebilir.', start_call: 'Aramayı başlat', send_request: 'İstek gönder',
      err_recording_required: 'Devam etmek için kayıt onayı gereklidir.', err_recording_accept: 'Aramayı başlatmak için lütfen kayıt onayını kabul edin.', err_department: 'Bu departman bu arama türü için uygun değil. Lütfen başka bir departman seçin.', err_failed_start: 'Arama başlatılamadı.', err_wait_seconds: 'Yeni istek göndermeden önce lütfen {n} sn bekleyin.', err_contact_required: 'Size ulaşabilmemiz için lütfen e-posta veya telefon girin.', err_message_short: 'Lütfen isteğinizi en az {n} karakterle açıklayın.', err_future_time: 'Lütfen gelecekte geçerli bir zaman seçin.', err_too_fast: 'Çok hızlı oldu. Lütfen formu doldurmak için biraz zaman ayırın.', err_cooldown: 'Zaten bir geri arama istediniz. Lütfen {n} sn bekleyin.', err_rate_limited: 'Ağınızdan çok fazla geri arama isteği geldi. Lütfen daha sonra deneyin.', err_callback_unavailable: 'Geri arama istekleri şu anda kullanılamıyor.', err_failed: 'Başarısız.',
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
      rate_thanks: 'Geri bildiriminiz için teşekkürler!'
    },
  };

  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'on') Object.keys(attrs[k]).forEach(function (ev) { n.addEventListener(ev, attrs[k][ev]); });
      else if (k === 'html') n.innerHTML = attrs[k];
      else n.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c == null) return; n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }

  function fmtTime(ms) {
    var s = Math.floor(ms / 1000);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

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

  function normalizeLocale(locale) {
    locale = String(locale || '').toLowerCase().slice(0, 2);
    return SUPPORTED_LOCALES.indexOf(locale) >= 0 ? locale : null;
  }

  function formatText(text, vars) {
    text = String(text == null ? '' : text);
    vars = vars || {};
    Object.keys(vars).forEach(function (k) {
      text = text.replace(new RegExp('\\{' + k + '\\}', 'g'), String(vars[k]));
    });
    return text;
  }

  /**
   * CC-2H Phase 5 — Map common LiveKit transport failures to
   * actionable, secret-free messages.
   */
  function friendlyConnectError(raw) {
    var s = sanitize(String(raw || '')).toLowerCase();
    if (s.indexOf('v1 rtc path') >= 0 || s.indexOf('rtc/v1') >= 0 || s.indexOf('404') >= 0 && s.indexOf('validate') >= 0) {
      return 'The call media server does not support the RTC v1 path required by this client. Please ask the platform admin to upgrade LiveKit or fix the reverse proxy.';
    }
    if (s.indexOf('connection refused') >= 0 || s.indexOf('1006') >= 0) {
      return 'Could not reach the call media server. Please try again or contact support.';
    }
    if (s.indexOf('expired') >= 0 || s.indexOf('unauthorized') >= 0 || s.indexOf('invalid token') >= 0) {
      return 'Your call session expired. Please end and start a new call.';
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
        if ((lastCfg && lastCfg.ringback_enabled === false) || mode === 'off') { this.stop(); return; }
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
      startFromGesture: function (cfg) {
        lastCfg = cfg || lastCfg || {};
        unlock();
        this.start(lastCfg);
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
      hp_company: '',
    };
    this.callbackOpenedAt = 0;
    this.callbackCooldownUntil = 0;
    this.locale = 'en';
    this.availableLocales = ['en'];
    this.localeStorageKey = 'ccw_locale';
  }

  CallCenterWidgetCtor.prototype.t = function (key, vars) {
    // Per-workspace overrides (set in Identity & Branding) take priority.
    try {
      var ct = this.bootstrap && this.bootstrap.config && this.bootstrap.config.custom_texts;
      if (ct) {
        var ov = (ct[this.locale] && ct[this.locale][key]) || (ct.en && ct.en[key]);
        if (ov && typeof ov === 'string' && ov.trim()) return formatText(ov, vars);
      }
    } catch (_) {}
    var pack = I18N[this.locale] || I18N.en;
    return formatText(pack[key] || I18N.en[key] || key, vars);
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

    var host = document.createElement('div');
    host.id = 'call-center-widget-host';
    host.style.all = 'initial';
    document.body.appendChild(host);
    var shadow = host.attachShadow({ mode: 'open' });
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = this.origin + '/call-widget/runtime.css' + this.runtimeAssetSuffix;
    shadow.appendChild(link);
    // Self-hosted font faces (no third-party CDN). Injected at document level
    // so the shadow root can use them; idempotent per page.
    try {
      if (!document.getElementById('ccw-widget-fonts')) {
        var fl = document.createElement('link'); fl.id = 'ccw-widget-fonts';
        fl.rel = 'stylesheet';
        fl.href = this.origin + '/call-widget/runtime.css' + this.runtimeAssetSuffix;
        document.head.appendChild(fl);
      }
    } catch (_) {}
    var root = document.createElement('div');
    root.className = 'ccw-root';
    shadow.appendChild(root);
    this.root = root;

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

  CallCenterWidgetCtor.prototype.position = function () {
    var p = (this.bootstrap && this.bootstrap.config && this.bootstrap.config.widget_position) || 'right';
    return p === 'left' ? 'left' : 'right';
  };

  CallCenterWidgetCtor.prototype.persistActiveSession = function () {
    if (!this.activeSessionKey || !this.session || !this.callId) return;
    try { window.sessionStorage.setItem(this.activeSessionKey, this.session); } catch (_) {}
  };

  CallCenterWidgetCtor.prototype.clearActiveSession = function () {
    if (!this.activeSessionKey) return;
    try { window.sessionStorage.removeItem(this.activeSessionKey); } catch (_) {}
  };

  CallCenterWidgetCtor.prototype.api = function (path, opts) {
    opts = opts || {};
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
    var consentNeeded = !!(rec.effective_enabled && rec.consent_required);
    if (consentNeeded && !this.formData.consent) {
      try { Ringback.stop(); } catch (_) {}
      this.error = this.t('err_recording_required');
      this.render(); return;
    }
    var consentAt = this.formData.consent ? new Date().toISOString() : null;
    this.error = null;
    this.state = STATES.LOADING; this.render();
    this.api('/api/call-widget/calls/request', {
      method: 'POST',
      body: {
        call_type: this.formData.call_type,
        visitor_name: this.formData.name || null,
        visitor_email: this.formData.email || null,
        visitor_phone: this.formData.phone || null,
        subject: this.formData.subject || null,
        page_url: location.href,
        page_title: document.title,
        consent_recording: !!this.formData.consent,
        recording_consent: !!this.formData.consent,
        recording_consent_at: consentAt,
        department_id: this.formData.department_id || null,
      },
    }).then(function (r) {
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
        self.error = (r.body && (r.body.message || r.body.error)) || self.t('err_failed_start');
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
    }).catch(function (e) {
      try { Ringback.stop(); } catch (_) {}
      self.error = sanitize(String(e && e.message || e));
      self.state = STATES.ERROR; self.render();
    });
  };

  CallCenterWidgetCtor.prototype.startTimer = function () {
    var self = this;
    this.stopTimer();
    this.timer = setInterval(function () {
      var t = self.root.querySelector('.ccw-wait-timer');
      if (t && self.queueStartedAt) t.textContent = fmtTime(Date.now() - self.queueStartedAt);
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
      if (!self.callStartedAt) return;
      var el = self.root.querySelector('.ccw-call-duration-value');
      if (el) el.textContent = fmtTime(Date.now() - self.callStartedAt);
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

  CallCenterWidgetCtor.prototype.pollOnce = function () {
    if (!this.callId) return;
    var self = this;
    this.api('/api/call-widget/calls/' + this.callId + '/status').then(function (r) {
      if (!r.ok) return;
      var c = r.body.call; if (!c) return;
      self.call = c;
      if (typeof r.body.position === 'number') self.queuePosition = r.body.position;
      try { Ringback.setQueuePosition(self.queuePosition); } catch (_) {}
      if (typeof r.body.eta_seconds === 'number') self.queueEta = r.body.eta_seconds;
      // Track operator name + detect transfer (operator changed mid-call).
      var newOpName = r.body.operator_name || null;
      var prevAgent = self._lastAgentId || null;
      var nextAgent = c.assigned_agent_id || null;
      if (prevAgent && nextAgent && prevAgent !== nextAgent && self.state === STATES.IN_CALL) {
        // Operator transfer detected — flip to "transferring" affordance,
        // resume hold music briefly, then surface new operator name.
        self.transferring = true;
        self.operatorName = null;
        self.callStartedAt = null;
        self.stopCallTimer();
        try {
          var qe = (self.bootstrap && self.bootstrap.queue_experience) || {};
          Ringback.setLocale(self.locale, self.t('queue_wait_announce'));
          Ringback.setPhase('hold');
          Ringback.start(qe);
        } catch (_) {}
        self.render();
      }
      self._lastAgentId = nextAgent;
      if (newOpName && newOpName !== self.operatorName) {
        self.operatorName = newOpName;
        if (self.transferring) self.transferring = false;
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
        try { Ringback.stop(); } catch (_) {}
        self.endedCallId = self.callId;
        self.endedDuration = self.callStartedAt ? Math.floor((Date.now() - self.callStartedAt) / 1000) : 0;
        self.clearActiveSession();
        self.state = STATES.ENDED; self.render(); return;
      }
      if (['active', 'ringing', 'connecting'].indexOf(c.state) >= 0) {
        try { Ringback.setPhase('ring'); } catch (_) {}
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
    var self = this;
    this.api('/api/call-widget/calls/' + this.callId + '/join-token', { method: 'POST' }).then(function (r) {
      if (!r.ok) {
        self.connectStatus = 'pending';
        self.render(); return;
      }
      self.joinInfo = r.body;
      self.connectStatus = 'token_ready';
      self.render();
      self.connectMedia();
    }).catch(function () { self.connectStatus = 'pending'; self.render(); });
  };

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
      var room = new LK.Room({ adaptiveStream: true, dynacast: true });
      self.lkRoom = room;
      self._attachedTracks = self._attachedTracks || {};
      var wantVideo = (self.call && self.call.call_type === 'video') || self.formData.call_type === 'video';
      var RE = LK.RoomEvent || {};
      room.on(RE.Disconnected || 'disconnected', function (reason) {
        var r = String(reason || '').toLowerCase();
        if (r.indexOf('expired') >= 0 || r.indexOf('token') >= 0) {
          self.connectStatus = 'token_expired';
        } else if (self.connectStatus !== 'in_call_ended') {
          self.connectStatus = 'media_disconnected';
        }
        self.render();
      });
      room.on(RE.Reconnecting || 'reconnecting', function () {
        self.connectStatus = 'media_reconnecting'; self.render();
      });
      room.on(RE.Reconnected || 'reconnected', function () {
        self.connectStatus = self._remoteCount > 0 ? 'in_call' : 'waiting_for_operator';
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
          if (track.kind === 'video') {
            el.playsInline = true;
            el.setAttribute('data-remote-video', 'true');
            el.setAttribute('data-orientation-correction', 'scaleX(-1)');
            try { el.style.transform = 'scaleX(-1)'; } catch (_) {}
            try { el.style.scale = '1'; } catch (_) {}
            try { el.style.rotate = '0deg'; } catch (_) {}
          }
          el.setAttribute('data-track-sid', sid);
          self._attachedTracks[sid] = el;
          self._remoteHolder && self._remoteHolder.appendChild(el);
          if (track.kind === 'audio') {
            try {
              var ms = el.srcObject || (track.mediaStreamTrack ? new MediaStream([track.mediaStreamTrack]) : null);
              if (ms) self._startAudioMeter(ms);
            } catch (_) {}
          }
        } catch (_) {}
      }
      function detach(track) {
        try {
          var sid = track.sid || track.trackSid;
          var el = sid && self._attachedTracks[sid];
          if (el) { try { el.remove(); } catch (_) {} delete self._attachedTracks[sid]; }
          try { track.detach && track.detach(); } catch (_) {}
        } catch (_) {}
      }
      room.on(RE.TrackSubscribed || 'trackSubscribed', function (track, _pub, participant) {
        attach(track, participant);
      });
      room.on(RE.TrackUnsubscribed || 'trackUnsubscribed', function (track) {
        detach(track);
      });
      room.on(RE.ParticipantConnected || 'participantConnected', function (p) {
        self._remoteCount = (self._remoteCount || 0) + 1;
        self.connectStatus = 'operator_connected';
        self.render();
        try {
          var pubs = p.trackPublications || p.tracks;
          pubs && pubs.forEach && pubs.forEach(function (pub) {
            if (pub && pub.track) attach(pub.track, p);
          });
        } catch (_) {}
      });
      room.on(RE.ParticipantDisconnected || 'participantDisconnected', function () {
        self._remoteCount = Math.max(0, (self._remoteCount || 1) - 1);
        if (self._remoteCount === 0) {
          self.connectStatus = 'operator_left';
          self.render();
        }
      });
      room.connect(connect.server_url, info.token).then(function () {
        return room.localParticipant.setMicrophoneEnabled(true).catch(function (err) {
          self.connectStatus = 'microphone_permission_denied';
          self.error = sanitize(String(err && err.message || err));
          self.render();
          throw err;
        });
      }).then(function () {
        if (wantVideo) {
          return room.localParticipant.setCameraEnabled(true).then(function (pub) {
            try {
              var track = pub && pub.track;
              if (!track) {
                var lpubs = room.localParticipant.videoTrackPublications || room.localParticipant.videoTracks;
                lpubs && lpubs.forEach && lpubs.forEach(function (p) { if (p && p.track && !track) track = p.track; });
              }
              if (track) {
                if (self._localVideoEl) { try { self._localVideoEl.remove(); } catch(_) {} }
                var lv = track.attach();
                lv.autoplay = true; lv.playsInline = true; lv.muted = true;
                lv.setAttribute('data-local-video', 'true');
                lv.setAttribute('data-orientation-correction', 'scaleX(-1)');
                try { lv.style.transform = 'scaleX(-1)'; } catch (_) {}
                try { lv.style.scale = '1'; } catch (_) {}
                try { lv.style.rotate = '0deg'; } catch (_) {}
                self._localVideoEl = lv;
                self._localVideoTrack = track;
                self.render();
              }
            } catch (_) {}
          }).catch(function (err) {
            self.connectStatus = 'camera_permission_denied';
            self.error = sanitize(String(err && err.message || err));
            self.render();
          });
        }
      }).then(function () {
        if (self.connectStatus !== 'microphone_permission_denied' && self.connectStatus !== 'camera_permission_denied') {
          // Detect already-present remote participants
          try {
            var existing = [];
            if (room.remoteParticipants && room.remoteParticipants.forEach) {
              room.remoteParticipants.forEach(function (p) { existing.push(p); });
            }
            self._remoteCount = existing.length;
            existing.forEach(function (p) {
              var pubs = p.trackPublications || p.tracks;
              pubs && pubs.forEach && pubs.forEach(function (pub) {
                if (pub && pub.track) attach(pub.track, p);
              });
            });
          } catch (_) {}
          self.connectStatus = self._remoteCount > 0 ? 'in_call' : 'waiting_for_operator';
          self.micOn = true; self.camOn = !!wantVideo;
          self.render();
        }
      }).catch(function (err) {
        if (self.connectStatus !== 'microphone_permission_denied' && self.connectStatus !== 'camera_permission_denied') {
          var rawEm = String(err && err.message || err);
          var em = sanitize(rawEm).toLowerCase();
          var friendly = friendlyConnectError(rawEm);
          if (em.indexOf('expired') >= 0 || em.indexOf('unauthorized') >= 0 || em.indexOf('invalid token') >= 0) {
            self.connectStatus = 'token_expired';
          } else if (em.indexOf('rtc/v1') >= 0 || em.indexOf('v1 rtc') >= 0) {
            self.connectStatus = 'rtc_v1_unsupported';
            self.error = friendly;
          } else {
            self.connectStatus = 'room_connect_failed';
            self.error = friendly || sanitize(rawEm);
          }
          self.render();
        }
      });
    } catch (err) {
      self.connectStatus = 'room_connect_failed';
      self.error = sanitize(String(err && err.message || err));
      self.render();
    }
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
        try {
          var track = pub && pub.track;
          if (!track) {
            var lpubs = self.lkRoom.localParticipant.videoTrackPublications || self.lkRoom.localParticipant.videoTracks;
            lpubs && lpubs.forEach && lpubs.forEach(function (p) { if (p && p.track && !track) track = p.track; });
          }
          if (track) {
            if (self._localVideoEl) { try { self._localVideoEl.remove(); } catch(_) {} }
            var lv = track.attach();
            lv.autoplay = true; lv.playsInline = true; lv.muted = true;
            lv.setAttribute('data-local-video', 'true');
            lv.setAttribute('data-orientation-correction', 'scaleX(-1)');
            try { lv.style.transform = 'scaleX(-1)'; } catch (_) {}
            try { lv.style.scale = '1'; } catch (_) {}
            try { lv.style.rotate = '0deg'; } catch (_) {}
            self._localVideoEl = lv;
            self._localVideoTrack = track;
          }
        } catch (_) {}
      } else {
        try {
          if (self._localVideoTrack && self._localVideoEl) { self._localVideoTrack.detach(self._localVideoEl); }
          if (self._localVideoEl) { self._localVideoEl.remove(); }
        } catch (_) {}
        self._localVideoEl = null; self._localVideoTrack = null;
      }
      self.render();
    });
  };
  CallCenterWidgetCtor.prototype.disconnectRoom = function () {
    try { if (this.lkRoom) this.lkRoom.disconnect(); } catch (_) {}
    this.lkRoom = null;
    if (this._attachedTracks) {
      var keys = Object.keys(this._attachedTracks);
      for (var i = 0; i < keys.length; i++) {
        try { this._attachedTracks[keys[i]].remove(); } catch (_) {}
      }
    }
    this._attachedTracks = {};
    this._remoteCount = 0;
    try {
      if (this._localVideoTrack && this._localVideoEl) { this._localVideoTrack.detach(this._localVideoEl); }
      if (this._localVideoEl) { this._localVideoEl.remove(); }
    } catch (_) {}
    this._localVideoEl = null; this._localVideoTrack = null;
    this._stopAudioMeter();
  };

  CallCenterWidgetCtor.prototype._startAudioMeter = function (mediaStream) {
    if (!mediaStream || this._audioMeterStream === mediaStream) return;
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!this._audioCtx) this._audioCtx = new Ctx();
      if (this._audioCtx.state === 'suspended') { try { this._audioCtx.resume(); } catch (_) {} }
      try { this._audioSource && this._audioSource.disconnect(); } catch (_) {}
      this._audioSource = this._audioCtx.createMediaStreamSource(mediaStream);
      this._audioAnalyser = this._audioCtx.createAnalyser();
      this._audioAnalyser.fftSize = 64;
      this._audioAnalyser.smoothingTimeConstant = 0.75;
      this._audioSource.connect(this._audioAnalyser);
      this._audioMeterStream = mediaStream;
      this._audioBuf = new Uint8Array(this._audioAnalyser.frequencyBinCount);
      var self = this;
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

  CallCenterWidgetCtor.prototype._stopAudioMeter = function () {
    try { if (this._audioRaf) cancelAnimationFrame(this._audioRaf); } catch (_) {}
    this._audioRaf = null;
    try { this._audioSource && this._audioSource.disconnect(); } catch (_) {}
    this._audioSource = null;
    this._audioAnalyser = null;
    this._audioMeterStream = null;
    this._waveBars = null;
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

  CallCenterWidgetCtor.prototype.cancelCall = function () {
    var self = this;
    this.disconnectRoom();
    try { Ringback.stop(); } catch (_) {}
    if (!this.callId) { this.reset(); return; }
    // Snapshot for the rating screen.
    this.endedCallId = this.callId;
    this.endedDuration = this.callStartedAt ? Math.floor((Date.now() - this.callStartedAt) / 1000) : 0;
    this.api('/api/call-widget/calls/' + this.callId + '/cancel', { method: 'POST' }).then(function () {
      self.stopPolling(); self.stopTimer(); self.stopCallTimer();
      // If the call actually connected, go to ENDED so the visitor can rate.
      if (self.endedDuration > 0) {
        self.clearActiveSession();
        self.callId = null; self.call = null;
        self.state = STATES.ENDED;
        self.render();
      } else {
        self.reset();
      }
    });
  };

  CallCenterWidgetCtor.prototype.reset = function () {
    this.disconnectRoom();
    try { Ringback.stop(); } catch (_) {}
    this.clearActiveSession();
    this.stopCallTimer();
    this.callId = null; this.call = null; this.queueStartedAt = null;
    this.queuePosition = null; this.queueEta = null;
    this.connectStatus = null; this.joinInfo = null; this.error = null;
    this.micOn = false; this.camOn = false; this._remoteHolder = null;
    this.operatorName = null;
    this.callStartedAt = null;
    this.transferring = false;
    this.endedCallId = null;
    this.endedDuration = 0;
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
    this.error = null;
    this.state = STATES.CALLBACK;
    this.render();
  };

  CallCenterWidgetCtor.prototype.submitCallback = function () {
    var self = this;
    this.error = null;
    var policy = (this.bootstrap && this.bootstrap.callback_policy) || {};
    // Client-side cooldown guard (server still enforces).
    if (this.callbackCooldownUntil && Date.now() < this.callbackCooldownUntil) {
      var leftSec = Math.ceil((this.callbackCooldownUntil - Date.now()) / 1000);
      this.error = this.t('err_wait_seconds', { n: leftSec });
      this.render(); return;
    }
    // Require contact if the platform demands it.
    if (policy.require_contact) {
      var email = (this.formData.email || '').trim();
      var phone = (this.formData.phone || '').trim();
      var alreadyId = !!(this.identifiedContact && this.identifiedContact.id);
      if (!alreadyId && !email && !phone) {
        this.error = this.t('err_contact_required');
        this.render(); return;
      }
    }
    // Minimum message length.
    var minMsg = Number(policy.min_message_length || 0);
    if (minMsg > 0) {
      var msg = (this.formData.message || '').trim();
      if (msg.length < minMsg) {
        this.error = this.t('err_message_short', { n: minMsg });
        this.render(); return;
      }
    }
    var scheduledIso = null;
    if (this.formData.callback_when === 'later' && this.formData.callback_scheduled_for) {
      var t = new Date(this.formData.callback_scheduled_for);
      if (!isNaN(t.getTime()) && t.getTime() > Date.now() - 60000) {
        scheduledIso = t.toISOString();
      } else {
        this.error = this.t('err_future_time');
        this.render(); return;
      }
    }
    this.api('/api/call-widget/callbacks/request', {
      method: 'POST',
      body: {
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
      },
    }).then(function (r) {
      if (!r.ok) {
        var code = r.body && r.body.error;
        if (code === 'department_channel_disabled' || code === 'department_not_found') {
          self.error = self.t('err_department');
        } else if (code === 'contact_required') {
          self.error = self.t('err_contact_required');
        } else if (code === 'message_too_short') {
          var m = (r.body && r.body.min) || 1;
          self.error = self.t('err_message_short', { n: m });
        } else if (code === 'too_fast') {
          self.error = self.t('err_too_fast');
        } else if (code === 'cooldown_active') {
          var ra = (r.body && r.body.retry_after) || 60;
          self.callbackCooldownUntil = Date.now() + ra * 1000;
          self.error = self.t('err_cooldown', { n: ra });
        } else if (code === 'rate_limited_ip') {
          self.error = self.t('err_rate_limited');
        } else if (code === 'feature_not_available') {
          self.error = self.t('err_callback_unavailable');
        } else {
          self.error = (r.body && (r.body.error || r.body.message)) || self.t('err_failed');
        }
        self.render(); return;
      }
      self.callbackId = r.body.callback_id;
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
    var tr = function (key, vars) { return self.t(key, vars); };
    var pos = this.position();
    this.root.innerHTML = '';
    this.root.setAttribute('lang', this.locale);
    this.root.setAttribute('dir', (LOCALE_META[this.locale] && LOCALE_META[this.locale].dir) || 'ltr');
    var caps = (this.bootstrap && this.bootstrap.capabilities) || {};
    var cfg = (this.bootstrap && this.bootstrap.config) || {};

    // Launcher always present
    var launcherText = this.isOnline() ? tr('talk_now') : tr('callback');
    var launcher = el('button', {
      class: 'ccw-launcher ' + pos,
      'aria-label': launcherText,
      on: { click: function () { self.toggleOpen(); } },
    }, [
      el('span', { class: 'ccw-launcher-pulse' }, [el('span', { class: 'ccw-launcher-icon' }, ['☎'])]),
      el('span', { class: 'ccw-launcher-copy' }, [
        el('span', { class: 'ccw-launcher-text' }, [launcherText]),
        el('span', { class: 'ccw-launcher-sub' }, [this.isOnline() ? tr('live_support') : tr('leave_details')]),
      ]),
      this.isOnline() ? el('span', { class: 'ccw-launcher-dot' }) : null,
    ]);
    this.root.appendChild(launcher);

    if (!this.open) return;

    var panel = el('div', { class: 'ccw-panel ' + pos });
    var header = el('div', { class: 'ccw-header' }, [
      el('div', { class: 'ccw-brand-wrap' }, [
        cfg.avatar_url ? el('img', { src: cfg.avatar_url, alt: '' }) : el('div', { class: 'ccw-avatar-fallback' }, ['☎']),
        el('span', { class: 'ccw-avatar-badge' }),
      ]),
      el('div', { class: 'ccw-header-copy' }, [
        el('div', { class: 'ccw-title' }, [cfg.display_name || tr('support')]),
        el('div', { class: 'ccw-sub' }, [
          el('span', { class: 'ccw-status-dot ' + (this.isOnline() ? 'online' : 'offline') }),
          this.isOnline() ? tr('operators_available') : tr('callback_desk'),
        ]),
      ]),
      this.renderLocaleSwitcher(),
      el('button', { class: 'ccw-close', on: { click: function () { self.toggleOpen(); } } }, ['×']),
    ]);
    panel.appendChild(header);

    var body = el('div', { class: 'ccw-body' });
    body.appendChild(this.renderState(caps, cfg));
    panel.appendChild(body);
    this.root.appendChild(panel);
  };

  CallCenterWidgetCtor.prototype.renderLocaleSwitcher = function () {
    var self = this;
    if (!this.availableLocales || this.availableLocales.length <= 1) return null;
    var select = el('select', { class: 'ccw-lang', 'aria-label': 'Widget language' });
    this.availableLocales.forEach(function (code) {
      var meta = LOCALE_META[code] || { label: code.toUpperCase(), short: code.toUpperCase() };
      var option = el('option', { value: code }, [meta.short]);
      if (self.locale === code) option.selected = true;
      select.appendChild(option);
    });
    select.addEventListener('change', function (e) { self.setLocale(e.target.value); });
    return select;
  };

  CallCenterWidgetCtor.prototype.renderState = function (caps, cfg) {
    var self = this;
    var tr = function (key, vars) { return self.t(key, vars); };
    switch (this.state) {
      case STATES.LOADING:
        return el('div', { class: 'ccw-loading' }, [el('div', { class: 'ccw-spinner' }), el('div', { class: 'ccw-muted' }, [tr('loading')])]);

      case STATES.OFFLINE: {
        var off = el('div', { class: 'ccw-stack' }, [
          el('div', { class: 'ccw-mini-hero offline' }, [
            el('div', { class: 'ccw-mini-title' }, [tr('leave_callback_request')]),
            el('div', { class: 'ccw-mini-sub' }, [tr('offline_copy')]),
          ]),
        ]);
        if (caps.callback) off.appendChild(el('button', { class: 'ccw-btn primary', on: { click: function () { self.openCallback(); } } }, [tr('request_callback')]));
        return off;
      }

      case STATES.ONLINE: {
        var pol = (self.bootstrap && self.bootstrap.callback_policy) || {};
        var showCbOnline = pol.show_when_online !== false; // default true
        var box = el('div', { class: 'ccw-stack' });
        var row = el('div', { class: 'ccw-row' });
        if (caps.voice) row.appendChild(el('button', { class: 'ccw-btn primary', on: { click: function () { self.startCall('voice'); } } }, [el('span', { class: 'ccw-btn-ico' }, ['☎']), tr('voice_call')]));
        if (caps.video) row.appendChild(el('button', { class: 'ccw-btn secondary', on: { click: function () { self.startCall('video'); } } }, [el('span', { class: 'ccw-btn-ico' }, ['◉']), tr('video_call')]));
        box.appendChild(row);
        if (caps.callback && showCbOnline) {
          box.appendChild(el('button', { class: 'ccw-btn secondary', on: { click: function () { self.openCallback(); } } }, [tr('request_callback_instead')]));
        }
        return box;
      }

      case STATES.PRE_CALL:
        return this.renderForm(cfg, /*forCall*/true);

      case STATES.CALLBACK:
        return this.renderForm(cfg, /*forCall*/false);

      case STATES.QUEUE: {
        var qe = (self.bootstrap && self.bootstrap.queue_experience) || {};
        var capsForCallback = (self.bootstrap && self.bootstrap.capabilities) || {};
        var queueTitle = self.queuePosition === 1 ? tr('you_are_next') : tr('holding_place');
        var queueCopy = self.queuePosition && self.queuePosition > 1
          ? tr('queue_copy_many')
          : tr('queue_copy_next');
        var card = el('div', { class: 'ccw-queue-card' }, [
          el('div', { class: 'ccw-queue-head' }, [
            el('div', { class: 'ccw-queue-orbit' }, [
              el('span', { class: 'ccw-ring r1' }),
              el('span', { class: 'ccw-ring r2' }),
              el('span', { class: 'ccw-ring r3' }),
              el('span', { class: 'ccw-phone-core' }, ['☎']),
            ]),
            el('div', { class: 'ccw-queue-copy-block' }, [
              el('div', { class: 'ccw-pill live' }, [Ringback.isActive && Ringback.isActive() ? tr('ringing_enabled') : tr('ringing_operator')]),
              el('div', { class: 'ccw-queue-title' }, [queueTitle]),
              el('div', { class: 'ccw-queue-copy' }, [queueCopy]),
            ]),
          ]),
          el('div', { class: 'ccw-queue-progress' }, [
            el('span', { class: 'ccw-progress-bar b1' }),
            el('span', { class: 'ccw-progress-bar b2' }),
            el('span', { class: 'ccw-progress-bar b3' }),
            el('span', { class: 'ccw-progress-bar b4' }),
            el('span', { class: 'ccw-progress-bar b5' }),
          ]),
          el('div', { class: 'ccw-wait-wrap' }, [
            el('div', { class: 'ccw-wait-row' }, [
              el('span', { class: 'ccw-wait-label' }, [tr('waiting_time')]),
              el('div', { class: 'ccw-wait-timer', html: fmtTime(self.queueStartedAt ? (Date.now() - self.queueStartedAt) : 0) }),
              el('button', {
              class: 'ccw-sound-toggle' + ((Ringback.isMuted && Ringback.isMuted()) || (Ringback.needsGesture && Ringback.needsGesture()) ? ' muted' : ''),
              type: 'button',
              title: Ringback.isMuted && Ringback.isMuted() ? tr('unmute_sound') : tr('mute_sound'),
              'aria-label': Ringback.isMuted && Ringback.isMuted() ? tr('unmute_sound') : tr('mute_sound'),
              on: { click: function (ev) {
                try { ev && ev.stopPropagation && ev.stopPropagation(); } catch (_) {}
                var nowMuted = !(Ringback.isMuted && Ringback.isMuted());
                if (nowMuted) {
                  Ringback.setMuted(true);
                } else {
                  Ringback.setMuted(false);
                  if (Ringback.needsGesture && Ringback.needsGesture()) {
                    try { Ringback.startFromGesture((self.bootstrap && self.bootstrap.queue_experience) || {}); } catch (_) {}
                  }
                }
                self.render();
              } },
              }, [(Ringback.isMuted && Ringback.isMuted()) || (Ringback.needsGesture && Ringback.needsGesture()) ? '🔇' : '🔊']),
            ]),
            (Ringback.needsGesture && Ringback.needsGesture())
              ? el('div', { class: 'ccw-wait-hint' }, [tr('tap_to_hear')])
              : null,
          ]),
        ]);
        if (Ringback.needsGesture && Ringback.needsGesture()) {
          // Audio is locked by browser autoplay policy — show the same
          // small toggle styling but in "unlock" affordance. Visitor taps
          // it once to allow the queue audio without ending the call.
          var waitWrap = card.querySelector('.ccw-wait-wrap');
          if (waitWrap) {
            var unlockBtn = waitWrap.querySelector('.ccw-sound-toggle');
            if (unlockBtn) {
              unlockBtn.classList.add('locked');
              unlockBtn.setAttribute('title', tr('enable_ringing_sound'));
              unlockBtn.setAttribute('aria-label', tr('enable_ringing_sound'));
            }
          }
          // Any click anywhere on the queue card counts as a user gesture —
          // use it to unlock and resume the queue audio immediately, then
          // re-render so the locked icon disappears.
          card.addEventListener('click', function onceUnlock() {
            try { card.removeEventListener('click', onceUnlock); } catch (_) {}
            try { Ringback.startFromGesture((self.bootstrap && self.bootstrap.queue_experience) || {}); } catch (_) {}
            setTimeout(function () { try { self.render(); } catch (_) {} }, 60);
          }, { once: true, capture: true });
        }
        // Position-in-queue chip
        if (qe.show_position !== false && self.queuePosition) {
          var posLabel = self.queuePosition === 1
            ? tr('you_next_line')
            : tr('you_queue_number', { n: self.queuePosition });
          card.appendChild(el('div', { class: 'ccw-queue-pos' }, [el('span', {}, [tr('queue_position')]), el('strong', {}, [posLabel])]));
        }
        // ETA chip
        if (qe.show_eta !== false && typeof self.queueEta === 'number' && self.queueEta > 0) {
          var mins = Math.max(1, Math.round(self.queueEta / 60));
          var etaLbl = mins <= 1 ? tr('eta_under_min') : tr('eta_minutes', { n: mins });
          card.appendChild(el('div', { class: 'ccw-queue-eta' }, [el('span', {}, [tr('eta')]), el('strong', {}, [etaLbl])]));
        }
        var stack = [card];
        // Offer a callback after the configured wait threshold
        var threshold = qe.offer_callback_after_seconds;
        var elapsed = self.queueStartedAt ? Math.floor((Date.now() - self.queueStartedAt) / 1000) : 0;
        if (capsForCallback.callback && threshold && threshold > 0 && elapsed >= threshold) {
          stack.push(el('div', { class: 'ccw-callback-offer' }, [
            el('div', { class: 'ccw-callback-offer-text' }, [tr('tired_waiting')]),
            el('button', { class: 'ccw-btn primary', on: { click: function () { self.cancelCall(); setTimeout(function () { self.openCallback(); }, 50); } } }, [tr('request_callback')]),
          ]));
        }
        stack.push(el('button', { class: 'ccw-btn danger', on: { click: function () { self.cancelCall(); } } }, [tr('cancel_call')]));
        return el('div', { class: 'ccw-stack' }, stack);
      }

      case STATES.IN_CALL: {
        var status = self.connectStatus || 'connecting';
        var msg = tr('call_accepted_connecting');
        if (status === 'in_call') msg = tr('connected');
        if (status === 'waiting_for_operator') msg = tr('operator_joining');
        if (status === 'operator_connected') msg = tr('operator_connected');
        if (status === 'operator_left') msg = tr('operator_left');
        if (status === 'media_reconnecting') msg = tr('reconnecting_media');
        if (status === 'media_disconnected') msg = tr('media_disconnected');
        if (status === 'connecting_media') msg = tr('connecting_av');
        if (status === 'fallback') msg = tr('fallback');
        if (status === 'accepted_no_sdk') msg = tr('accepted_no_sdk');
        if (status === 'media_not_configured') msg = tr('media_not_configured');
        if (status === 'provider_client_not_configured') msg = tr('provider_not_configured');
        if (status === 'provider_client_not_supported') msg = tr('provider_not_supported');
        if (status === 'media_client_missing') msg = tr('media_client_missing');
        if (status === 'media_client_invalid') msg = tr('media_client_invalid');
        if (status === 'loading_media_client') msg = tr('loading_media_client');
        if (status === 'microphone_permission_denied') msg = tr('mic_denied');
        if (status === 'camera_permission_denied') msg = tr('camera_denied');
        if (status === 'room_connect_failed') msg = tr('room_failed', { error: self.error || tr('unknown') });
        if (status === 'token_expired') msg = tr('token_expired');
        var isLive = (status === 'in_call' || status === 'operator_connected');
        var isVideoCall = (self.call && self.call.call_type === 'video') || self.formData.call_type === 'video';
        var hideHeader = isVideoCall && isLive && !self.transferring;
        var cardChildren = hideHeader ? [] : [
          el('div', { class: 'ccw-pill' }, [isLive ? tr('in_call') : status === 'waiting_for_operator' ? tr('connected_waiting') : tr('connecting')]),
          el('div', { class: 'ccw-label' }, [self.transferring ? tr('transferring_call') : msg]),
        ];
        var card = el('div', { class: 'ccw-card ccw-incall' + (isLive ? ' live' : '') + (self.transferring ? ' transferring' : '') + (isVideoCall ? ' video' : '') }, cardChildren);
        // Beautiful "connected" hero — voice only. Video calls show the
        // video stream as the centerpiece with an overlay instead.
        if (isLive && !self.transferring && !isVideoCall) {
          var waveBars = [];
          for (var _wi = 1; _wi <= 7; _wi++) {
            waveBars.push(el('span', { class: 'b' + _wi }));
          }
          self._waveBars = waveBars;
          var waveEl = el('div', { class: 'ccw-wave live' }, waveBars);
          card.appendChild(el('div', { class: 'ccw-live-hero' }, [
            el('div', { class: 'ccw-live-avatar' }, [
              el('span', { class: 'ccw-live-pulse p1' }),
              el('span', { class: 'ccw-live-pulse p2' }),
              el('span', { class: 'ccw-live-pulse p3' }),
              el('span', { class: 'ccw-live-core' }, [self.operatorName ? self.operatorName.charAt(0).toUpperCase() : '☎']),
            ]),
            el('div', { class: 'ccw-live-meta' }, [
              self.operatorName ? el('div', { class: 'ccw-live-op-name' }, [self.operatorName]) : null,
              el('div', { class: 'ccw-live-op-role' }, [tr('operator_label')]),
              el('div', { class: 'ccw-live-duration' }, [
                el('span', { class: 'ccw-live-duration-label' }, [tr('call_duration')]),
                el('span', { class: 'ccw-call-duration-value' }, [fmtTime(self.callStartedAt ? (Date.now() - self.callStartedAt) : 0)]),
              ]),
              waveEl,
            ]),
          ]));
        } else if (self.transferring) {
          card.appendChild(el('div', { class: 'ccw-transfer-hero' }, [
            el('span', { class: 'ccw-transfer-spinner' }),
            el('div', { class: 'ccw-transfer-text' }, [tr('transferring_call')]),
          ]));
        } else if (isLive && isVideoCall) {
          // Video calls: no header strip; we overlay name + timer on the
          // video tile itself (see ccw-video-overlay).
        }
        // Recording indicator (passive). Backend status drives this; never trust client.
        var recBoot = (self.bootstrap && self.bootstrap.recording) || {};
        var callRecState = self.call && self.call.recording_state;
        if (callRecState === 'recording') {
          card.appendChild(el('div', { class: 'ccw-pill recording' }, [tr('recording_progress')]));
        } else if (recBoot.effective_enabled) {
          card.appendChild(el('div', { class: 'ccw-muted', style: 'margin-top:6px;' }, [
            tr('recording_may_start'),
          ]));
        }
        var media = el('div', { class: 'ccw-media' });
        self._remoteHolder = media;
        // Re-attach existing tracks if any (re-render can wipe DOM)
        if (self._attachedTracks) {
          var keys = Object.keys(self._attachedTracks);
          for (var i = 0; i < keys.length; i++) {
            try { media.appendChild(self._attachedTracks[keys[i]]); } catch (_) {}
          }
        }
        if (isLive && isVideoCall && !self.transferring) {
          if (self._localVideoEl && self.camOn) {
            var pip = el('div', { class: 'ccw-local-pip' });
            try { pip.appendChild(self._localVideoEl); } catch (_) {}
            media.appendChild(pip);
          }
          media.appendChild(el('div', { class: 'ccw-video-info' }, [
            el('div', { class: 'ccw-video-info-name' }, [self.operatorName || tr('operator') || 'Operator']),
            el('div', { class: 'ccw-video-info-duration' }, [
              el('span', { class: 'ccw-call-duration-value' }, [fmtTime(self.callStartedAt ? (Date.now() - self.callStartedAt) : 0)]),
            ]),
          ]));
        }
        card.appendChild(media);
        var controls = el('div', { class: 'ccw-row' });
        if (status === 'in_call' || status === 'operator_connected' || status === 'waiting_for_operator' || status === 'media_reconnecting') {
          controls.appendChild(el('button', { class: 'ccw-btn secondary', on: { click: function () { self.toggleMic(); } } }, [self.micOn ? tr('mute') : tr('unmute')]));
          var wantVideo = (self.call && self.call.call_type === 'video') || self.formData.call_type === 'video';
          if (wantVideo) {
            controls.appendChild(el('button', { class: 'ccw-btn secondary', on: { click: function () { self.toggleCam(); } } }, [self.camOn ? tr('camera_off') : tr('camera_on')]));
          }
        }
        controls.appendChild(el('button', { class: 'ccw-btn danger', on: { click: function () { self.cancelCall(); } } }, [tr('end')]));
        return el('div', { class: 'ccw-stack' }, [card, controls]);
      }

      case STATES.ENDED: {
        if (self.callbackId) {
          var ref = String(self.callbackId).slice(0, 8).toUpperCase();
          var when = self.formData.callback_when === 'later' && self.formData.callback_scheduled_for
            ? new Date(self.formData.callback_scheduled_for).toLocaleString()
            : tr('asap');
          var chLabel = self.formData.callback_channel === 'video' ? tr('video_callback') : tr('phone_callback');
          return el('div', { class: 'ccw-stack' }, [
            el('div', { class: 'ccw-success-card' }, [
              el('div', { class: 'ccw-success-icon' }, ['✓']),
              el('div', { class: 'ccw-success-title' }, [tr('callback_scheduled')]),
              el('div', { class: 'ccw-muted', style: 'text-align:center;' }, [tr('reach_out', { when: when })]),
              el('div', { class: 'ccw-ref-row' }, [
                el('span', { class: 'ccw-ref-label' }, [tr('reference')]),
                el('code', { class: 'ccw-ref-code' }, [ref]),
              ]),
              el('div', { class: 'ccw-ref-row' }, [
                el('span', { class: 'ccw-ref-label' }, [tr('type')]),
                el('span', {}, [chLabel]),
              ]),
            ]),
            el('button', { class: 'ccw-btn primary', on: { click: function () { self.reset(); } } }, [tr('done')]),
          ]);
        }
        // Post-call rating screen (only when the call actually started).
        var stack = [];
        var durLabel = self.endedDuration > 0 ? fmtTime(self.endedDuration * 1000) : null;
        var endedCard = el('div', { class: 'ccw-card ccw-ended-card' }, [
          el('div', { class: 'ccw-ended-icon' }, ['✓']),
          el('div', { class: 'ccw-ended-title' }, [tr('call_ended')]),
        ]);
        if (self.operatorName) {
          endedCard.appendChild(el('div', { class: 'ccw-muted', style: 'text-align:center;' }, [self.operatorName]));
        }
        if (durLabel) {
          endedCard.appendChild(el('div', { class: 'ccw-ended-duration' }, [
            el('span', {}, [tr('call_duration')]),
            el('strong', {}, [durLabel]),
          ]));
        }
        stack.push(endedCard);
        if (self.endedCallId && !self.ratingSubmitted) {
          var rateBox = el('div', { class: 'ccw-rate-box' }, [
            el('div', { class: 'ccw-rate-title' }, [tr('rate_call_title')]),
            el('div', { class: 'ccw-rate-sub' }, [tr('rate_call_sub')]),
          ]);
          var stars = el('div', { class: 'ccw-rate-stars' });
          var renderStars = function () {
            stars.innerHTML = '';
            for (var i = 1; i <= 5; i++) {
              (function (n) {
                var btn = el('button', {
                  class: 'ccw-star' + (self.ratingValue >= n ? ' filled' : ''),
                  type: 'button',
                  'aria-label': String(n),
                  on: { click: function () { self.ratingValue = n; renderStars(); } },
                }, ['★']);
                stars.appendChild(btn);
              })(i);
            }
          };
          renderStars();
          rateBox.appendChild(stars);
          var ta = el('textarea', { class: 'ccw-textarea', placeholder: tr('rate_comment_ph') });
          ta.value = self.ratingComment || '';
          ta.addEventListener('input', function (e) { self.ratingComment = e.target.value; });
          rateBox.appendChild(ta);
          rateBox.appendChild(el('div', { class: 'ccw-row' }, [
            el('button', { class: 'ccw-btn secondary', on: { click: function () { self.reset(); } } }, [tr('rate_skip')]),
            el('button', { class: 'ccw-btn primary', on: { click: function () { self.submitRating(); } } }, [tr('rate_submit')]),
          ]));
          stack.push(rateBox);
        } else if (self.ratingSubmitted) {
          stack.push(el('div', { class: 'ccw-rate-thanks' }, [tr('rate_thanks')]));
          stack.push(el('button', { class: 'ccw-btn primary', on: { click: function () { self.reset(); } } }, [tr('done')]));
        } else {
          stack.push(el('button', { class: 'ccw-btn primary', on: { click: function () { self.reset(); } } }, [tr('done')]));
        }
        return el('div', { class: 'ccw-stack' }, stack);
      }

      case STATES.ERROR:
        return el('div', { class: 'ccw-stack' }, [
          el('div', { class: 'ccw-error' }, [tr('error_prefix', { error: self.error || tr('unknown') })]),
          el('button', { class: 'ccw-btn secondary', on: { click: function () { self.reset(); } } }, [tr('back')]),
        ]);
    }
    return el('div', {}, ['…']);
  };

  CallCenterWidgetCtor.prototype.renderForm = function (cfg, forCall) {
    var self = this;
    var tr = function (key, vars) { return self.t(key, vars); };
    var policy = (self.bootstrap && self.bootstrap.callback_policy) || {};
    var box = el('div', { class: 'ccw-stack' });
    if (!forCall) {
      box.appendChild(el('div', { class: 'ccw-cb-intro' }, [
        el('div', { class: 'ccw-cb-intro-title' }, [tr('request_callback_title')]),
        el('div', { class: 'ccw-muted' }, [tr('callback_intro')]),
      ]));
    }
    // Channel segmented control (callback only)
    if (!forCall) {
      var caps2 = (self.bootstrap && self.bootstrap.capabilities) || {};
      box.appendChild(el('label', { class: 'ccw-label' }, [tr('callback_type')]));
      var seg = el('div', { class: 'ccw-segment' });
      function mkSeg(val, label) {
        var active = (self.formData.callback_channel === val);
        var b = el('button', { class: 'ccw-seg-btn' + (active ? ' active' : ''), type: 'button',
          on: { click: function () { self.formData.callback_channel = val; self.render(); } } }, [label]);
        return b;
      }
      seg.appendChild(mkSeg('audio', tr('phone')));
      if (caps2.video) seg.appendChild(mkSeg('video', tr('video')));
      box.appendChild(seg);
    }
    // Department dropdown (only if backend exposed options for this channel).
    var depts = (self.bootstrap && self.bootstrap.departments) || {};
    var deptList;
    if (forCall) {
      var ct = self.formData.call_type === 'video' ? 'video' : 'voice';
      deptList = depts[ct] || [];
    } else {
      deptList = depts.callback || [];
    }
    if (deptList.length > 0) {
      box.appendChild(el('label', { class: 'ccw-label' }, [tr('department')]));
      var sel = el('select', { class: 'ccw-input' });
      var ph = el('option', { value: '' }, [tr('choose_department')]);
      sel.appendChild(ph);
      for (var di = 0; di < deptList.length; di++) {
        var d = deptList[di];
        var opt = el('option', { value: d.id }, [d.name]);
        if (self.formData.department_id === d.id) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.addEventListener('change', function (e) { self.formData.department_id = e.target.value; });
      box.appendChild(sel);
    }
    var alreadyIdentified = !!(self.identifiedContact && self.identifiedContact.id);
    if (alreadyIdentified) {
      var knownName = self.identifiedContact.name || self.formData.name || tr('known_contact');
      box.appendChild(el('div', { class: 'ccw-known-contact' }, [
        el('div', { class: 'ccw-known-dot' }, ['✓']),
        el('div', {}, [
          el('div', { class: 'ccw-known-title' }, [knownName]),
          el('div', { class: 'ccw-muted' }, [tr('contact_saved')]),
        ]),
      ]));
    }
    var fields = alreadyIdentified
      ? [['subject', tr('subject'), 'text']]
      : [
        ['name', tr('full_name'), 'text'],
        ['email', !forCall && policy.require_contact ? tr('email_required') : tr('email'), 'email'],
        ['phone', !forCall && policy.require_contact ? tr('phone_required') : tr('phone_field'), 'tel'],
        ['subject', tr('subject'), 'text'],
      ];
    fields.forEach(function (f) {
      var label = el('label', { class: 'ccw-label' }, [f[1]]);
      var input = el('input', { class: 'ccw-input', type: f[2], value: self.formData[f[0]] || '' });
      input.addEventListener('input', function (e) { self.formData[f[0]] = e.target.value; });
      box.appendChild(label);
      box.appendChild(input);
    });
    if (!forCall && policy.require_contact && !alreadyIdentified) {
      box.appendChild(el('div', { class: 'ccw-muted', style: 'font-size:11px;margin-top:-4px;' }, [
        tr('contact_required_note'),
      ]));
    }
    if (!forCall) {
      // Honeypot (anti-bot): visually hidden, never tabbable.
      if (policy.honeypot_enabled !== false) {
        var hp = el('input', {
          type: 'text', name: 'company_website', autocomplete: 'off', tabindex: '-1', 'aria-hidden': 'true',
          style: 'position:absolute;left:-10000px;top:auto;width:1px;height:1px;overflow:hidden;opacity:0;',
        });
        hp.value = self.formData.hp_company || '';
        hp.addEventListener('input', function (e) { self.formData.hp_company = e.target.value; });
        box.appendChild(hp);
      }
      // Message textarea
      var msgLabel = policy.min_message_length > 0
        ? tr('message_min', { n: policy.min_message_length })
        : tr('message_optional');
      box.appendChild(el('label', { class: 'ccw-label' }, [msgLabel]));
      var ta = el('textarea', { class: 'ccw-textarea', placeholder: tr('message_placeholder') });
      ta.value = self.formData.message || '';
      ta.addEventListener('input', function (e) { self.formData.message = e.target.value; });
      box.appendChild(ta);
      // When
      box.appendChild(el('label', { class: 'ccw-label' }, [tr('when_call')]));
      var when = el('div', { class: 'ccw-segment' });
      function mkWhen(val, label) {
        var active = (self.formData.callback_when === val);
        return el('button', { class: 'ccw-seg-btn' + (active ? ' active' : ''), type: 'button',
          on: { click: function () { self.formData.callback_when = val; self.render(); } } }, [label]);
      }
      when.appendChild(mkWhen('now', '⚡ ' + tr('asap')));
      when.appendChild(mkWhen('later', tr('schedule')));
      box.appendChild(when);
      if (self.formData.callback_when === 'later') {
        var dt = el('input', { class: 'ccw-input', type: 'datetime-local' });
        dt.value = self.formData.callback_scheduled_for || '';
        var minDate = new Date(Date.now() + 5 * 60000);
        dt.min = new Date(minDate.getTime() - minDate.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
        dt.addEventListener('input', function (e) { self.formData.callback_scheduled_for = e.target.value; });
        box.appendChild(dt);
      }
      // Urgency
      box.appendChild(el('label', { class: 'ccw-label' }, [tr('priority')]));
      var ur = el('div', { class: 'ccw-segment' });
      function mkUr(val, label) {
        var active = (self.formData.callback_urgency === val);
        return el('button', { class: 'ccw-seg-btn' + (active ? ' active' : '') + (val === 'urgent' && active ? ' danger' : ''), type: 'button',
          on: { click: function () { self.formData.callback_urgency = val; self.render(); } } }, [label]);
      }
      ur.appendChild(mkUr('normal', tr('normal')));
      ur.appendChild(mkUr('urgent', tr('urgent')));
      box.appendChild(ur);
    }
    if (forCall) {
      var rec = (self.bootstrap && self.bootstrap.recording) || {};
      if (rec.effective_enabled && rec.consent_required) {
        var cb = el('label', { class: 'ccw-checkbox' });
        var ci = el('input', { type: 'checkbox' });
        ci.checked = !!self.formData.consent;
        ci.addEventListener('change', function (e) { self.formData.consent = !!e.target.checked; });
        cb.appendChild(ci);
        cb.appendChild(document.createTextNode(tr('consent_required')));
        box.appendChild(cb);
      } else if (rec.effective_enabled) {
        box.appendChild(el('div', { class: 'ccw-muted' }, [
          tr('call_may_record'),
        ]));
      }
    }
    if (self.error) box.appendChild(el('div', { class: 'ccw-error' }, [self.error]));
    var actions = el('div', { class: 'ccw-row' }, [
      el('button', { class: 'ccw-btn secondary', on: { click: function () { self.reset(); } } }, [tr('back')]),
      el('button', { class: 'ccw-btn primary', on: { click: function () { forCall ? self.submitCall() : self.submitCallback(); } } },
        [forCall ? tr('start_call') : tr('send_request')]),
    ]);
    box.appendChild(actions);
    return box;
  };

  window.CallCenterWidget = new CallCenterWidgetCtor();
})();