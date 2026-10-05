import Foundation

/// Settings words added after `Strings.swift` stopped being the only copy:
/// that file generates the Android app's strings, and these have Android
/// wording of its own (`StrManual`) or none.
enum SettingsStr {
    // MARK: Security

    static func signOutOtherDevices(_ l: Language) -> String {
        switch l {
        case .en: "Sign out of all other devices"
        case .fa: "خروج از همهٔ دستگاه‌های دیگر"
        case .tr: "Diğer tüm cihazlardan çık"
        case .ar: "تسجيل الخروج من جميع الأجهزة الأخرى"
        }
    }

    static func signOutOtherDevicesHelp(_ l: Language) -> String {
        switch l {
        case .en: "Every other phone, computer and browser signed in to this account is signed out. This device stays signed in."
        case .fa: "همهٔ گوشی‌ها، رایانه‌ها و مرورگرهای دیگری که با این حساب وارد شده‌اند خارج می‌شوند. این دستگاه وارد می‌ماند."
        case .tr: "Bu hesapla oturum açmış diğer tüm telefon, bilgisayar ve tarayıcılardan çıkış yapılır. Bu cihaz oturumda kalır."
        case .ar: "سيُسجَّل خروج كل هاتف وحاسوب ومتصفح آخر مسجّل الدخول إلى هذا الحساب. يبقى هذا الجهاز مسجّل الدخول."
        }
    }

    static func signOutOtherDevicesConfirm(_ l: Language) -> String {
        switch l {
        case .en: "Sign out of every other device?"
        case .fa: "از همهٔ دستگاه‌های دیگر خارج شوید؟"
        case .tr: "Diğer tüm cihazlardan çıkış yapılsın mı?"
        case .ar: "تسجيل الخروج من كل الأجهزة الأخرى؟"
        }
    }

    static func signOutOtherDevicesConfirmBody(_ l: Language) -> String {
        switch l {
        case .en: "They will need to sign in again. This device stays signed in."
        case .fa: "برای ادامه باید دوباره وارد شوند. این دستگاه وارد می‌ماند."
        case .tr: "Yeniden oturum açmaları gerekecek. Bu cihaz oturumda kalır."
        case .ar: "ستحتاج تلك الأجهزة إلى تسجيل الدخول مجددًا. يبقى هذا الجهاز مسجّل الدخول."
        }
    }

    static func signedOutOthers(_ l: Language, _ count: Int) -> String {
        let n = Format.number(count, language: l)
        switch l {
        case .en: return count == 1 ? "Signed out of 1 other device." : "Signed out of \(n) other devices."
        case .fa: return "از \(n) دستگاه دیگر خارج شدید."
        case .tr: return "\(n) diğer cihazdan çıkış yapıldı."
        case .ar: return "تم تسجيل الخروج من " + Format.arabicCount(count, one: "جهاز آخر", two: "جهازين آخرين", few: "أجهزة أخرى", many: "جهازًا آخر", other: "جهاز آخر") + "."
        }
    }

    static func noOtherDevices(_ l: Language) -> String {
        switch l {
        case .en: "No other device is signed in."
        case .fa: "دستگاه دیگری با این حساب وارد نیست."
        case .tr: "Başka bir cihazda oturum açık değil."
        case .ar: "لا يوجد جهاز آخر مسجّل الدخول."
        }
    }

    // MARK: Calls

    /// A call is not offered while the microphone is refused.
    static func callNeedsMicrophone(_ l: Language) -> String {
        switch l {
        case .en: "Allow microphone access in Settings to call a visitor."
        case .fa: "برای تماس با بازدیدکننده، دسترسی به میکروفون را در تنظیمات اجازه دهید."
        case .tr: "Bir ziyaretçiyi aramak için Ayarlar'dan mikrofon erişimine izin verin."
        case .ar: "اسمح بالوصول إلى الميكروفون من الإعدادات للاتصال بالزائر."
        }
    }

    // MARK: Notifications

    /// The one button on the screen before iOS asks about notifications.
    static func continueAction(_ l: Language) -> String {
        switch l {
        case .en: "Continue"
        case .fa: "ادامه"
        case .tr: "Devam"
        case .ar: "متابعة"
        }
    }

    // MARK: The foot of Settings

    /// The foot of Settings: the platform's website, unless Super Admin named it otherwise.
    static func website(_ l: Language) -> String {
        switch l {
        case .en: "Website"
        case .fa: "وب‌سایت"
        case .tr: "Web sitesi"
        case .ar: "الموقع الإلكتروني"
        }
    }

    static func privacyPolicy(_ l: Language) -> String {
        switch l {
        case .en: "Privacy Policy"
        case .fa: "سیاست حفظ حریم خصوصی"
        case .tr: "Gizlilik Politikası"
        case .ar: "سياسة الخصوصية"
        }
    }

    static func termsOfUse(_ l: Language) -> String {
        switch l {
        case .en: "Terms of Use"
        case .fa: "شرایط استفاده"
        case .tr: "Kullanım Koşulları"
        case .ar: "شروط الاستخدام"
        }
    }

    /// The build of the version, beside it.
    static func build(_ l: Language) -> String {
        switch l {
        case .en: "Build"
        case .fa: "شمارهٔ ساخت"
        case .tr: "Derleme"
        case .ar: "رقم البناء"
        }
    }
}
