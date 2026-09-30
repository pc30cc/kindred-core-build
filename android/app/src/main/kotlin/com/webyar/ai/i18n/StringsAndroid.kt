package com.webyar.ai.i18n

/**
 * Strings this platform needs and iOS does not.
 *
 * Kept apart from both [Str] (generated from `Strings.swift`) and [StrManual]
 * (the fourteen the generator refuses) so that the sync between the two apps
 * stays legible: anything in those two files has a Swift counterpart and must
 * keep agreeing with it, and anything here does not and never will.
 *
 * The reason there is anything here at all is that the two platforms hand
 * different amounts of chrome to the developer. SwiftUI's `NavigationStack`
 * draws its own back button with the system's own translated label; Compose's
 * `TopAppBar` gives you an empty slot and expects a content description, so
 * the word has to exist somewhere.
 */
object StrAndroid {

    /**
     * The loader's spoken label while a launch confirms the session — the
     * Mac's `checkingSession`. Not on screen: the loader says it alone.
     */
    fun restoringSession(l: Language): String = when (l) {
        Language.EN -> "Restoring your session…"
        Language.FA -> "در حال بازیابی نشست…"
        Language.TR -> "Oturum geri yükleniyor…"
    }

    // Super Admin's maintenance notice, in the Mac app's words.

    fun maintenanceTitle(l: Language): String = when (l) {
        Language.EN -> "Webyar is under maintenance"
        Language.FA -> "وب‌یار در حال تعمیر و نگهداری است"
        Language.TR -> "Webyar bakımda"
    }

    /** When Super Admin wrote no message of their own. */
    fun maintenanceBody(l: Language): String = when (l) {
        Language.EN -> "We are working on the service and will be back shortly. Your conversations are safe and waiting for you."
        Language.FA -> "در حال کار روی سرویس هستیم و به‌زودی برمی‌گردیم. گفتگوهای شما محفوظ است و منتظرتان می‌ماند."
        Language.TR -> "Hizmet üzerinde çalışıyoruz, kısa süre içinde geri döneceğiz. Konuşmalarınız güvende ve sizi bekliyor."
    }

    fun maintenanceUntil(l: Language, time: String): String = when (l) {
        Language.EN -> "Expected back by $time"
        Language.FA -> "بازگشت پیش‌بینی‌شده: $time"
        Language.TR -> "Tahmini dönüş: $time"
    }

    /** The back arrow's spoken label. Drawn as a glyph, never as text. */
    fun back(l: Language): String = when (l) {
        Language.EN -> "Back"
        Language.FA -> "بازگشت"
        Language.TR -> "Geri"
    }

    /** The overflow menu's spoken label. */
    fun moreOptions(l: Language): String = when (l) {
        Language.EN -> "More options"
        Language.FA -> "گزینه‌های بیشتر"
        Language.TR -> "Diğer seçenekler"
    }

    /** Clears a search field. Drawn as an ×. */
    fun clearSearch(l: Language): String = when (l) {
        Language.EN -> "Clear search"
        Language.FA -> "پاک کردن جست‌وجو"
        Language.TR -> "Aramayı temizle"
    }

    // MARK: - Offline and the outbox

    /**
     * The line above a list that is on screen from the cache while the server
     * cannot be reached. Says what the operator is looking at, not what went
     * wrong with the socket.
     */
    fun showingSaved(l: Language): String = when (l) {
        Language.EN -> "Offline — showing what was saved on this phone"
        Language.FA -> "آفلاین — آنچه روی این گوشی ذخیره شده نمایش داده می‌شود"
        Language.TR -> "Çevrimdışı — bu telefonda kayıtlı olanlar gösteriliyor"
    }

    /** Under a bubble the server has not confirmed yet. */
    fun messageSending(l: Language): String = when (l) {
        Language.EN -> "Sending…"
        Language.FA -> "در حال ارسال…"
        Language.TR -> "Gönderiliyor…"
    }

    /** Under a bubble that could not be sent. The bubble itself is the button. */
    fun messageNotSent(l: Language): String = when (l) {
        Language.EN -> "Not sent. Tap for options."
        Language.FA -> "ارسال نشد. برای گزینه‌ها ضربه بزنید."
        Language.TR -> "Gönderilmedi. Seçenekler için dokunun."
    }

    /** Takes an unsent message out of the thread. It was never on the server. */
    fun discardMessage(l: Language): String = when (l) {
        Language.EN -> "Delete"
        Language.FA -> "حذف"
        Language.TR -> "Sil"
    }

    /** On a photo that Data Saver kept from downloading by itself. */
    fun tapToLoad(l: Language): String = when (l) {
        Language.EN -> "Tap to load"
        Language.FA -> "برای بارگیری ضربه بزنید"
        Language.TR -> "Yüklemek için dokunun"
    }

    // MARK: - Storage

    fun storage(l: Language): String = when (l) {
        Language.EN -> "Storage"
        Language.FA -> "فضای ذخیره‌سازی"
        Language.TR -> "Depolama"
    }

    fun storageConversations(l: Language): String = when (l) {
        Language.EN -> "Conversations and messages"
        Language.FA -> "گفت‌وگوها و پیام‌ها"
        Language.TR -> "Görüşmeler ve mesajlar"
    }

    fun storageImages(l: Language): String = when (l) {
        Language.EN -> "Pictures"
        Language.FA -> "تصاویر"
        Language.TR -> "Görseller"
    }

    fun storageMedia(l: Language): String = when (l) {
        Language.EN -> "Files, voice notes and videos"
        Language.FA -> "فایل‌ها، پیام‌های صوتی و ویدیوها"
        Language.TR -> "Dosyalar, sesli notlar ve videolar"
    }

    fun storageTotal(l: Language): String = when (l) {
        Language.EN -> "Total"
        Language.FA -> "مجموع"
        Language.TR -> "Toplam"
    }

    fun storageCalculating(l: Language): String = when (l) {
        Language.EN -> "Calculating…"
        Language.FA -> "در حال محاسبه…"
        Language.TR -> "Hesaplanıyor…"
    }

    fun clearCache(l: Language): String = when (l) {
        Language.EN -> "Clear cache"
        Language.FA -> "پاک کردن حافظهٔ موقت"
        Language.TR -> "Önbelleği temizle"
    }

    /**
     * What Clear Cache does and, as importantly, what it does not: nothing
     * leaves the account, nobody is signed out, no setting changes.
     */
    fun clearCacheBody(l: Language): String = when (l) {
        Language.EN -> "Saved conversations, pictures and files are removed from this phone. " +
            "Nothing is deleted from your account, you stay signed in, and everything is " +
            "downloaded again when you need it. Messages still waiting to send are kept."
        Language.FA -> "گفت‌وگوها، تصاویر و فایل‌های ذخیره‌شده از این گوشی پاک می‌شوند. " +
            "چیزی از حساب شما حذف نمی‌شود، از حساب خارج نمی‌شوید و هر چیز در صورت نیاز " +
            "دوباره دریافت می‌شود. پیام‌هایی که هنوز در انتظار ارسال‌اند نگه داشته می‌شوند."
        Language.TR -> "Kayıtlı görüşmeler, görseller ve dosyalar bu telefondan kaldırılır. " +
            "Hesabınızdan hiçbir şey silinmez, oturumunuz açık kalır ve her şey gerektiğinde " +
            "yeniden indirilir. Gönderilmeyi bekleyen mesajlar korunur."
    }

    fun cacheCleared(l: Language): String = when (l) {
        Language.EN -> "Cache cleared"
        Language.FA -> "حافظهٔ موقت پاک شد"
        Language.TR -> "Önbellek temizlendi"
    }

    // MARK: - Notifications
    //
    // Channel names are shown by the SYSTEM, in its notification settings, so
    // they are written in the operator's chosen language when the channel is
    // created and rewritten when the language changes.

    fun channelMessages(l: Language): String = when (l) {
        Language.EN -> "Messages"
        Language.FA -> "پیام‌ها"
        Language.TR -> "Mesajlar"
    }

    fun channelMessagesDescription(l: Language): String = when (l) {
        Language.EN -> "New messages in your conversations"
        Language.FA -> "پیام‌های تازه در گفت‌وگوهای شما"
        Language.TR -> "Görüşmelerinizdeki yeni mesajlar"
    }

    /** A notification whose push carried no title of its own. */
    fun newMessage(l: Language): String = when (l) {
        Language.EN -> "New message"
        Language.FA -> "پیام تازه"
        Language.TR -> "Yeni mesaj"
    }

    fun channelCalls(l: Language): String = when (l) {
        Language.EN -> "Calls"
        Language.FA -> "تماس‌ها"
        Language.TR -> "Aramalar"
    }

    fun channelCallsDescription(l: Language): String = when (l) {
        Language.EN -> "Visitors calling the call centre"
        Language.FA -> "تماس بازدیدکنندگان با مرکز تماس"
        Language.TR -> "Çağrı merkezini arayan ziyaretçiler"
    }

    /** Under the caller's name while a call rings. */
    fun incomingCall(l: Language, video: Boolean): String = when (l) {
        Language.EN -> if (video) "Incoming video call" else "Incoming voice call"
        Language.FA -> if (video) "تماس تصویری ورودی" else "تماس صوتی ورودی"
        Language.TR -> if (video) "Gelen görüntülü arama" else "Gelen sesli arama"
    }

    fun answerCall(l: Language): String = when (l) {
        Language.EN -> "Answer"
        Language.FA -> "پاسخ"
        Language.TR -> "Yanıtla"
    }

    fun declineCall(l: Language): String = when (l) {
        Language.EN -> "Decline"
        Language.FA -> "رد"
        Language.TR -> "Reddet"
    }

    /** A call that stopped ringing with nobody having answered it. */
    fun missedCall(l: Language): String = when (l) {
        Language.EN -> "Missed call"
        Language.FA -> "تماس بی‌پاسخ"
        Language.TR -> "Cevapsız arama"
    }

    /** The call was taken by someone else, or ended, before this phone answered. */
    fun callNoLongerAvailable(l: Language): String = when (l) {
        Language.EN -> "This call is no longer waiting"
        Language.FA -> "این تماس دیگر در انتظار نیست"
        Language.TR -> "Bu arama artık beklemiyor"
    }

        // MARK: - Adaptive layout and appearance

    /** The detail pane beside the inbox on a tablet, before a row is picked. */
    fun pickConversation(l: Language): String = when (l) {
        Language.EN -> "Pick a conversation to read it here"
        Language.FA -> "یک گفتگو را انتخاب کنید تا اینجا نمایش داده شود"
        Language.TR -> "Burada okumak için bir konuşma seçin"
    }

    /** The detail pane beside the contacts on a tablet. */
    fun pickContact(l: Language): String = when (l) {
        Language.EN -> "Pick a contact to see their details"
        Language.FA -> "یک مخاطب را انتخاب کنید تا جزئیاتش را ببینید"
        Language.TR -> "Ayrıntıları görmek için bir kişi seçin"
    }

    /** Any other detail pane beside a list, before anything is picked. */
    fun pickItem(l: Language): String = when (l) {
        Language.EN -> "Pick an item to see it here"
        Language.FA -> "یک مورد را انتخاب کنید تا اینجا نمایش داده شود"
        Language.TR -> "Burada görmek için bir öğe seçin"
    }

    /** Settings → Appearance: Material You colours from the wallpaper. */
    fun wallpaperColors(l: Language): String = when (l) {
        Language.EN -> "Wallpaper colours"
        Language.FA -> "رنگ‌های والپیپر"
        Language.TR -> "Duvar kâğıdı renkleri"
    }

    fun wallpaperColorsBody(l: Language): String = when (l) {
        Language.EN -> "Use colours from your wallpaper instead of the brand's"
        Language.FA -> "به‌جای رنگ‌های برند، از رنگ‌های والپیپر استفاده شود"
        Language.TR -> "Marka renkleri yerine duvar kâğıdındaki renkleri kullan"
    }

    /** Spoken label of the button that jumps to the newest message. */
    fun jumpToLatest(l: Language): String = when (l) {
        Language.EN -> "Jump to the latest message"
        Language.FA -> "رفتن به آخرین پیام"
        Language.TR -> "Son mesaja git"
    }

    /** What tapping the visitor's face or name in a chat does, for a screen reader. */
    fun openContact(l: Language): String = when (l) {
        Language.EN -> "Open contact"
        Language.FA -> "باز کردن مخاطب"
        Language.TR -> "Kişiyi aç"
    }

    /** Ends a recording and keeps it, to be heard and then sent or thrown away. */
    fun stopRecording(l: Language): String = when (l) {
        Language.EN -> "Stop recording"
        Language.FA -> "پایان ضبط"
        Language.TR -> "Kaydı durdur"
    }

    /** The operator's name on the profile, when it is shown as a fact. */
    fun fullName(l: Language): String = when (l) {
        Language.EN -> "Name"
        Language.FA -> "نام و نام خانوادگی"
        Language.TR -> "Ad soyad"
    }

    /** Under the profile's read-only rows: why they are not fields. */
    fun profileManaged(l: Language): String = when (l) {
        Language.EN -> "Set by your workspace. To change it, use the web console or ask an admin."
        Language.FA -> "این موارد را فضای کاری شما تعیین می‌کند. برای تغییرشان از پنل وب استفاده کنید یا به مدیر بگویید."
        Language.TR -> "Bunları çalışma alanınız belirler. Değiştirmek için web panelini kullanın ya da bir yöneticiye sorun."
    }

    /** The inbox strip's last button, and the sheet it opens. */
    fun everyInbox(l: Language): String = when (l) {
        Language.EN -> "All inboxes"
        Language.FA -> "همهٔ صندوق‌ها"
        Language.TR -> "Tüm gelen kutuları"
    }

    /** The sheet's section for the colleagues' chat and the mailbox. */
    fun teamAndMail(l: Language): String = when (l) {
        Language.EN -> "Team and email"
        Language.FA -> "همکاران و ایمیل"
        Language.TR -> "Ekip ve e-posta"
    }

    /** The emoji panel's way back to typing. */
    fun keyboard(l: Language): String = when (l) {
        Language.EN -> "Keyboard"
        Language.FA -> "صفحه‌کلید"
        Language.TR -> "Klavye"
    }

    /**
     * The AI's queue on the inbox strip, written out in full. The shared
     * strings (generated from iOS) say «هوش», which is short for a tab bar;
     * on a chip beside «باز» and «همکاران» it reads as a word cut off.
     */
    fun filterAI(l: Language): String = when (l) {
        Language.EN -> "AI"
        Language.FA -> "هوش مصنوعی"
        Language.TR -> "Yapay zekâ"
    }

    /**
     * A list the server answered with a failure: not "can't reach the
     * server", which is for a request that never got an answer.
     */
    fun loadFailedTitle(l: Language): String = when (l) {
        Language.EN -> "Couldn't load this"
        Language.FA -> "بارگذاری ناموفق بود"
        Language.TR -> "Yüklenemedi"
    }

    /** The Visitors tab in the bar: the Mac's "Online visitors", short enough for a phone's bar. */
    fun tabVisitors(l: Language): String = when (l) {
        Language.EN -> "Visitors"
        Language.FA -> "بازدیدکنندگان"
        Language.TR -> "Ziyaretçiler"
    }

    /** The Website analytics tab in the bar. */
    fun tabAnalytics(l: Language): String = when (l) {
        Language.EN -> "Analytics"
        Language.FA -> "تحلیل سایت"
        Language.TR -> "Analitik"
    }

    fun pickReport(l: Language): String = when (l) {
        Language.EN -> "Pick a report to see it"
        Language.FA -> "یک گزارش را انتخاب کنید"
        Language.TR -> "Görmek için bir rapor seçin"
    }

    fun pickVisitor(l: Language): String = when (l) {
        Language.EN -> "Pick a visitor to see who they are and where they have been"
        Language.FA -> "یک بازدیدکننده را انتخاب کنید تا ببینید کیست و کجاها رفته"
        Language.TR -> "Kim olduğunu ve nerelerde gezindiğini görmek için bir ziyaretçi seçin"
    }

    /** Hours beside Website analytics' «دقیقه» and «ثانیه», for a long average visit. */
    fun waHours(l: Language): String = when (l) {
        Language.EN -> "h"
        Language.FA -> "ساعت"
        Language.TR -> "sa"
    }

    /** The operator's own camera, floating over a video call. */
    fun callSelfView(l: Language): String = when (l) {
        Language.EN -> "Your camera — drag to a corner, pinch to resize"
        Language.FA -> "تصویر شما — برای جابه‌جایی بکشید، برای تغییر اندازه دو انگشتی بزرگ یا کوچک کنید"
        Language.TR -> "Kameranız — köşeye sürükleyin, boyut için iki parmakla sıkıştırın"
    }

    fun callSelfViewMove(l: Language): String = when (l) {
        Language.EN -> "Move to the next corner"
        Language.FA -> "انتقال به گوشهٔ بعدی"
        Language.TR -> "Sonraki köşeye taşı"
    }

    fun callSelfViewSmaller(l: Language): String = when (l) {
        Language.EN -> "Smaller"
        Language.FA -> "کوچک‌تر"
        Language.TR -> "Küçült"
    }

    fun callSelfViewLarger(l: Language): String = when (l) {
        Language.EN -> "Larger"
        Language.FA -> "بزرگ‌تر"
        Language.TR -> "Büyüt"
    }

    /** A picked photo that could not be read or turned into one the server takes. */
    fun photoUnreadable(l: Language): String = when (l) {
        Language.EN -> "That photo could not be read. Try another one."
        Language.FA -> "این عکس خوانده نشد. عکس دیگری را امتحان کنید."
        Language.TR -> "Bu fotoğraf okunamadı. Başka bir tane deneyin."
    }

    /** A team message over the server's length limit, said before it is sent. */
    fun messageTooLong(l: Language, limit: Int): String = when (l) {
        Language.EN -> "This message is too long — ${Format.number(limit, l)} characters at most."
        Language.FA -> "این پیام خیلی طولانی است — حداکثر ${Format.number(limit, l)} نویسه."
        Language.TR -> "Bu mesaj çok uzun — en fazla ${Format.number(limit, l)} karakter."
    }

    /**
     * Sign-in refused because the account has never had a password —
     * migrated, or invited and never finished. The reset link chooses the
     * first one.
     */
    fun passwordSetupRequired(l: Language): String = when (l) {
        Language.EN -> "This account doesn't have a password yet. Choose one with “Forgot password?” or on the web, then sign in here."
        Language.FA -> "این حساب هنوز رمز عبور ندارد. با «رمز عبور را فراموش کرده‌اید؟» یا از نسخهٔ وب یکی انتخاب کنید و سپس اینجا وارد شوید."
        Language.TR -> "Bu hesabın henüz bir parolası yok. “Parolanızı mı unuttunuz?” ile ya da web'den bir parola seçin, sonra buradan giriş yapın."
    }

    /** Sign-in refused until a captcha is solved, which this app cannot show. */
    fun captchaRequired(l: Language): String = when (l) {
        Language.EN -> "Too many attempts to sign in. Wait a few minutes and try again, or sign in on the web."
        Language.FA -> "تلاش‌های ورود بیش از حد بوده است. چند دقیقه صبر کنید و دوباره امتحان کنید، یا از نسخهٔ وب وارد شوید."
        Language.TR -> "Çok fazla giriş denemesi yapıldı. Birkaç dakika bekleyip tekrar deneyin ya da web'den giriş yapın."
    }

    // The Colleagues list (the iOS app has no such grouping yet).

    /** Under the Colleagues title: how many there are. */
    fun colleaguesCount(l: Language, count: Int): String = when (l) {
        Language.EN -> if (count == 1) "1 colleague" else "$count colleagues"
        Language.FA -> "${Format.number(count, l)} همکار"
        Language.TR -> "$count meslektaş"
    }

    /** The colleagues there is already a conversation with. */
    fun colleaguesChats(l: Language): String = when (l) {
        Language.EN -> "Chats"
        Language.FA -> "گفت‌وگوها"
        Language.TR -> "Sohbetler"
    }

    /** The colleagues nobody has written to yet. */
    fun colleaguesStartChat(l: Language): String = when (l) {
        Language.EN -> "Start a chat"
        Language.FA -> "شروع گفت‌وگو"
        Language.TR -> "Sohbet başlat"
    }

    // MARK: - Platform support

    /** Settings: the section that reaches the platform's own team. */
    fun supportSection(l: Language): String = when (l) {
        Language.EN -> "Online support"
        Language.FA -> "پشتیبانی آنلاین"
        Language.TR -> "Canlı destek"
    }

    /** The chat's title when the team's workspace has no name. */
    fun supportTitle(l: Language): String = when (l) {
        Language.EN -> "Support"
        Language.FA -> "پشتیبانی"
        Language.TR -> "Destek"
    }

    fun supportChat(l: Language): String = when (l) {
        Language.EN -> "Chat with support"
        Language.FA -> "گفتگو با پشتیبانی"
        Language.TR -> "Destekle sohbet et"
    }

    fun supportOnline(l: Language): String = when (l) {
        Language.EN -> "Online"
        Language.FA -> "آنلاین"
        Language.TR -> "Çevrimiçi"
    }

    /** Nobody on the team now: a message still reaches them. */
    fun supportOfflineLeaveMessage(l: Language): String = when (l) {
        Language.EN -> "Offline · Leave a message"
        Language.FA -> "آفلاین · پیغام بگذارید"
        Language.TR -> "Çevrimdışı · Mesaj bırakın"
    }

    /** The chat's banner while nobody on the team is online. */
    fun supportOfflineBanner(l: Language): String = when (l) {
        Language.EN -> "Nobody is online right now. Leave a message — we'll answer right here as soon as we can."
        Language.FA -> "الان کسی آنلاین نیست. پیغام بگذارید؛ در اولین فرصت همین‌جا پاسخ می‌دهیم."
        Language.TR -> "Şu anda kimse çevrimiçi değil. Mesaj bırakın; en kısa sürede buradan yanıt vereceğiz."
    }

    /** Over the team's week, in the offline banner. */
    fun supportHoursTitle(l: Language): String = when (l) {
        Language.EN -> "Hours"
        Language.FA -> "ساعات پاسخگویی"
        Language.TR -> "Çalışma saatleri"
    }

    /** A day of the team's week, by the key `/status` files it under (`sat`…`fri`). */
    fun supportWeekday(l: Language, key: String): String = when (key) {
        "sat" -> when (l) {
            Language.EN -> "Saturday"
            Language.FA -> "شنبه"
            Language.TR -> "Cumartesi"
        }
        "sun" -> when (l) {
            Language.EN -> "Sunday"
            Language.FA -> "یکشنبه"
            Language.TR -> "Pazar"
        }
        "mon" -> when (l) {
            Language.EN -> "Monday"
            Language.FA -> "دوشنبه"
            Language.TR -> "Pazartesi"
        }
        "tue" -> when (l) {
            Language.EN -> "Tuesday"
            Language.FA -> "سه‌شنبه"
            Language.TR -> "Salı"
        }
        "wed" -> when (l) {
            Language.EN -> "Wednesday"
            Language.FA -> "چهارشنبه"
            Language.TR -> "Çarşamba"
        }
        "thu" -> when (l) {
            Language.EN -> "Thursday"
            Language.FA -> "پنجشنبه"
            Language.TR -> "Perşembe"
        }
        else -> when (l) {
            Language.EN -> "Friday"
            Language.FA -> "جمعه"
            Language.TR -> "Cuma"
        }
    }

    /** Several days in a row with the same hours: "Saturday–Wednesday". */
    fun supportDayRange(l: Language, first: String, last: String): String = when (l) {
        Language.EN -> "$first–$last"
        Language.FA -> "$first تا $last"
        Language.TR -> "$first–$last"
    }

    /** One opening: "9:00–17:00". */
    fun supportInterval(l: Language, from: String, to: String): String = when (l) {
        Language.EN -> "$from–$to"
        Language.FA -> "$from تا $to"
        Language.TR -> "$from–$to"
    }

    /** A line of the week: the days, then their hours. */
    fun supportHoursLine(l: Language, days: String, times: String): String = when (l) {
        Language.EN -> "$days: $times"
        Language.FA -> "$days $times"
        Language.TR -> "$days: $times"
    }

    fun supportClosedDays(l: Language, days: String): String = when (l) {
        Language.EN -> "$days: closed"
        Language.FA -> "$days تعطیل"
        Language.TR -> "$days: kapalı"
    }

    /** Under the week, when the team keeps another clock than this phone's. */
    fun supportTimeZone(l: Language, zone: String): String = when (l) {
        Language.EN -> "Time zone: $zone"
        Language.FA -> "منطقهٔ زمانی: $zone"
        Language.TR -> "Saat dilimi: $zone"
    }

    /**
     * When the hours open again. [day] is "tomorrow", a weekday or a date,
     * and null for later today.
     */
    fun supportNextOpen(l: Language, day: String?, time: String): String = when (l) {
        Language.EN -> if (day == null) "We'll be back at $time" else "We'll be back $day at $time"
        Language.FA -> if (day == null) "از ساعت $time پاسخگو هستیم" else "از $day ساعت $time پاسخگو هستیم"
        Language.TR -> if (day == null) {
            "Saat $time itibarıyla yanıt veriyoruz"
        } else {
            "${day.replaceFirstChar { it.titlecase(java.util.Locale.forLanguageTag("tr")) }} saat $time itibarıyla yanıt veriyoruz"
        }
    }

    /** Before each conversation after the first, with the day it began. */
    fun supportNewConversation(l: Language, date: String?): String {
        val label = when (l) {
            Language.EN -> "New conversation"
            Language.FA -> "گفتگوی تازه"
            Language.TR -> "Yeni görüşme"
        }
        return if (date.isNullOrBlank()) label else "$label · $date"
    }

    /** An agent was assigned, or the conversation transferred to them. */
    fun supportJoined(l: Language, name: String?): String {
        val who = name?.takeIf { it.isNotBlank() } ?: supportTeam(l)
        return when (l) {
            Language.EN -> "$who joined the conversation"
            Language.FA -> "$who به گفتگو پیوست"
            Language.TR -> "$who görüşmeye katıldı"
        }
    }

    /** Who joined, when the join names nobody. */
    fun supportTeam(l: Language): String = when (l) {
        Language.EN -> "Support team"
        Language.FA -> "تیم پشتیبانی"
        Language.TR -> "Destek ekibi"
    }

    /** The line under an ended conversation, by its status. */
    fun supportEnded(l: Language, status: String): String = if (status == "closed") {
        when (l) {
            Language.EN -> "This conversation was closed"
            Language.FA -> "این گفتگو بسته شد"
            Language.TR -> "Bu görüşme kapatıldı"
        }
    } else {
        when (l) {
            Language.EN -> "This conversation was resolved"
            Language.FA -> "این گفتگو حل شد"
            Language.TR -> "Bu görüşme çözüldü"
        }
    }

    /** Above the composer once the operator has chosen to start a new conversation. */
    fun supportNewConversationHint(l: Language): String = when (l) {
        Language.EN -> "Your message starts a new conversation."
        Language.FA -> "پیام شما گفتگوی جدیدی شروع می‌کند."
        Language.TR -> "Mesajınız yeni bir görüşme başlatır."
    }

    /** Under an ended conversation, in place of the composer. */
    fun supportEndedPanelBody(l: Language): String = when (l) {
        Language.EN -> "It can't be continued. Need more help? Start a new conversation."
        Language.FA -> "ادامهٔ این گفتگو ممکن نیست. اگر باز هم کمک لازم دارید، گفتگوی جدیدی شروع کنید."
        Language.TR -> "Bu görüşme sürdürülemez. Yardıma mı ihtiyacınız var? Yeni bir görüşme başlatın."
    }

    fun supportStartNew(l: Language): String = when (l) {
        Language.EN -> "Start a new conversation"
        Language.FA -> "شروع گفتگوی جدید"
        Language.TR -> "Yeni görüşme başlat"
    }

    /** The team ended the conversation while a message was on its way to it. */
    fun supportConversationEnded(l: Language): String = when (l) {
        Language.EN -> "This conversation has ended, so your message wasn't sent. Start a new conversation to send it."
        Language.FA -> "این گفتگو بسته شده و پیام شما ارسال نشد. برای ارسال، گفتگوی جدیدی شروع کنید."
        Language.TR -> "Bu görüşme sona erdi, mesajınız gönderilmedi. Göndermek için yeni bir görüşme başlatın."
    }

    fun supportRateTitle(l: Language): String = when (l) {
        Language.EN -> "Rate this conversation"
        Language.FA -> "به این گفتگو امتیاز دهید"
        Language.TR -> "Bu görüşmeyi değerlendirin"
    }

    /** One star's spoken label: "4 stars". */
    fun supportStars(l: Language, count: Int): String = when (l) {
        Language.EN -> if (count == 1) "1 star" else "$count stars"
        Language.FA -> "${Format.number(count, l)} ستاره"
        Language.TR -> "$count yıldız"
    }

    fun supportRateComment(l: Language): String = when (l) {
        Language.EN -> "Anything to add? (optional)"
        Language.FA -> "نظر شما (اختیاری)"
        Language.TR -> "Eklemek istedikleriniz (isteğe bağlı)"
    }

    fun supportRateSubmit(l: Language): String = when (l) {
        Language.EN -> "Submit rating"
        Language.FA -> "ثبت امتیاز"
        Language.TR -> "Puanı gönder"
    }

    fun supportYourRating(l: Language): String = when (l) {
        Language.EN -> "Your rating"
        Language.FA -> "امتیاز شما"
        Language.TR -> "Puanınız"
    }

    /** An empty chat, before the first message. */
    fun supportGreeting(l: Language): String = when (l) {
        Language.EN -> "Hi! How can we help?"
        Language.FA -> "سلام! چطور می‌توانیم کمکتان کنیم؟"
        Language.TR -> "Merhaba! Size nasıl yardımcı olabiliriz?"
    }

    fun supportNotSent(l: Language): String = when (l) {
        Language.EN -> "Not sent — tap to try again"
        Language.FA -> "ارسال نشد — برای تلاش دوباره بزنید"
        Language.TR -> "Gönderilmedi — tekrar denemek için dokunun"
    }

    /** A file over the support limit (2 MB), refused before the upload. */
    fun supportFileTooLarge(l: Language): String = when (l) {
        Language.EN -> "The file must be 2 MB or smaller"
        Language.FA -> "حجم فایل باید حداکثر ۲ مگابایت باشد"
        Language.TR -> "Dosya en fazla 2 MB olmalı"
    }

    fun supportRateLimited(l: Language): String = when (l) {
        Language.EN -> "That's a lot of messages — wait a moment."
        Language.FA -> "پیام‌ها زیاد شد؛ کمی صبر کنید."
        Language.TR -> "Çok fazla mesaj; biraz bekleyin."
    }

    fun supportUnavailable(l: Language): String = when (l) {
        Language.EN -> "Support isn't available right now."
        Language.FA -> "پشتیبانی در حال حاضر در دسترس نیست."
        Language.TR -> "Destek şu anda kullanılamıyor."
    }

    /** Before a preview the operator wrote themselves: "You: …". */
    fun youPrefix(l: Language): String = when (l) {
        Language.EN -> "You: "
        Language.FA -> "شما: "
        Language.TR -> "Sen: "
    }

    /** A colleague's role, shown only where it sets them apart (the owner, an admin). */
    fun colleagueRole(l: Language, role: String?): String? = when (role) {
        "owner" -> when (l) {
            Language.EN -> "Owner"
            Language.FA -> "مالک"
            Language.TR -> "Sahip"
        }
        "admin" -> when (l) {
            Language.EN -> "Admin"
            Language.FA -> "مدیر"
            Language.TR -> "Yönetici"
        }
        else -> null
    }
}
