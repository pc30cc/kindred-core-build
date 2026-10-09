import Foundation

/// The lines of copy that name the product, per brand.
///
/// `Str` and `SupportStr` hold WebYar's wording, and `Str` stays a plain
/// `switch` of literals on purpose: scripts/android/strings-from-ios.mjs turns
/// it into the Android app's Strings.kt and accepts nothing else. So the
/// brand is chosen here, one level up: WebYar's build returns `Str`'s line
/// unchanged, RESPOK's build (BRAND_RESPOK) its own. Every view that shows one
/// of these asks `BrandStr`, never `Str` directly.
///
/// RESPOK's English, Persian and Turkish are the desktop apps' own
/// (windows-native/src/Webyar.Core/Localization/strings.respok.json), with
/// the Turkish suffixes that agree with the name (RESPOK'tan). Its Arabic is
/// this app's Arabic with the name in place: the Arabic copy writes the name
/// as a Latin word that takes no suffix, so nothing else changes. A line
/// whose WebYar wording does not name the product is the same in both.
/// src/test/ios/iosBrands.test.ts keeps this file and those tables in step.
enum BrandStr {

    /// The product's name inside a sentence and for VoiceOver. RESPOK is Latin in every
    /// language, as on its desktop apps and its site.
    static func appName(_ l: Language) -> String {
        #if BRAND_RESPOK
        return AppBrand.name
        #else
        return Str.appName(l)
        #endif
    }

    /// The wordmark: Latin and capitalised in every language (see `Str.brandWordmark`).
    static var brandWordmark: String { AppBrand.wordmark }

    static func pushPrimerBody(_ l: Language) -> String {
        #if BRAND_RESPOK
        switch l {
        case .en: return "RESPOK can tell you about new messages, mentions and internal notes — even when the app is closed. You choose exactly which, and you can change it any time in Settings."
        case .fa: return "RESPOK می‌تواند پیام‌های تازه، نام‌بردن‌ها و یادداشت‌های داخلی را به شما خبر دهد — حتی وقتی برنامه بسته است. خودتان انتخاب می‌کنید کدام‌ها، و هر وقت خواستید از تنظیمات عوضش می‌کنید."
        case .tr: return "RESPOK yeni mesajları, bahsetmeleri ve dahili notları — uygulama kapalıyken bile — size bildirebilir. Hangilerini istediğinizi siz seçersiniz ve istediğiniz zaman Ayarlar'dan değiştirebilirsiniz."
        case .ar: return "يمكن لـ RESPOK إعلامك بالرسائل الجديدة والإشارات والملاحظات الداخلية — حتى عندما يكون التطبيق مغلقًا. أنت تختار ما تريده بالضبط، ويمكنك تغييره في أي وقت من الإعدادات."
        }
        #else
        return Str.pushPrimerBody(l)
        #endif
    }

    static func pushDeniedTitle(_ l: Language) -> String {
        #if BRAND_RESPOK
        switch l {
        case .en: return "Notifications are off for RESPOK"
        case .fa: return "اعلان‌های RESPOK خاموش است"
        case .tr: return "RESPOK için bildirimler kapalı"
        case .ar: return "الإشعارات متوقفة لتطبيق RESPOK"
        }
        #else
        return Str.pushDeniedTitle(l)
        #endif
    }

    /// Turkish never named the product here, so that line is the same for both.
    static func pushPresenceFooter(_ l: Language) -> String {
        #if BRAND_RESPOK
        switch l {
        case .en: return "RESPOK knows you are at your desk while the web console is open. Turn the first off to keep the phone quiet while you are already answering there."
        case .fa: return "RESPOK وقتی کنسول وب باز است می‌داند پشت میزتان هستید. اولی را خاموش کنید تا وقتی همان‌جا پاسخ می‌دهید، گوشی ساکت بماند."
        case .tr: return Str.pushPresenceFooter(l)
        case .ar: return "يعرف RESPOK أنك على مكتبك ما دامت لوحة التحكم على الويب مفتوحة. أوقف الخيار الأول ليبقى الهاتف هادئًا بينما تجيب من هناك."
        }
        #else
        return Str.pushPresenceFooter(l)
        #endif
    }

    static func signOutConfirm(_ l: Language) -> String {
        #if BRAND_RESPOK
        switch l {
        case .en: return "Sign out of RESPOK?"
        case .fa: return "از RESPOK خارج می‌شوید؟"
        case .tr: return "RESPOK'tan çıkılsın mı?"
        case .ar: return "تسجيل الخروج من RESPOK؟"
        }
        #else
        return Str.signOutConfirm(l)
        #endif
    }

    /// The support chat's empty state: who the operator is writing to.
    static func greetingBody(_ l: Language) -> String {
        #if BRAND_RESPOK
        switch l {
        case .en: return "Write to the RESPOK team here. Your message starts a new conversation."
        case .fa: return "پیام خود را برای تیم RESPOK همین‌جا بنویسید؛ با اولین پیام، گفتگوی تازه‌ای شروع می‌شود."
        case .tr: return "RESPOK ekibine buradan yazın. İlk mesajınız yeni bir görüşme başlatır."
        case .ar: return "اكتب إلى فريق RESPOK هنا. تبدأ رسالتك محادثة جديدة."
        }
        #else
        return SupportStr.greetingBody(l)
        #endif
    }
}
