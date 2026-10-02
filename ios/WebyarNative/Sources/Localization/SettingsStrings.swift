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
        }
    }

    static func signOutOtherDevicesHelp(_ l: Language) -> String {
        switch l {
        case .en: "Every other phone, computer and browser signed in to this account is signed out. This device stays signed in."
        case .fa: "همهٔ گوشی‌ها، رایانه‌ها و مرورگرهای دیگری که با این حساب وارد شده‌اند خارج می‌شوند. این دستگاه وارد می‌ماند."
        case .tr: "Bu hesapla oturum açmış diğer tüm telefon, bilgisayar ve tarayıcılardan çıkış yapılır. Bu cihaz oturumda kalır."
        }
    }

    static func signOutOtherDevicesConfirm(_ l: Language) -> String {
        switch l {
        case .en: "Sign out of every other device?"
        case .fa: "از همهٔ دستگاه‌های دیگر خارج شوید؟"
        case .tr: "Diğer tüm cihazlardan çıkış yapılsın mı?"
        }
    }

    static func signOutOtherDevicesConfirmBody(_ l: Language) -> String {
        switch l {
        case .en: "They will need to sign in again. This device stays signed in."
        case .fa: "برای ادامه باید دوباره وارد شوند. این دستگاه وارد می‌ماند."
        case .tr: "Yeniden oturum açmaları gerekecek. Bu cihaz oturumda kalır."
        }
    }

    static func signedOutOthers(_ l: Language, _ count: Int) -> String {
        let n = Format.number(count, language: l)
        switch l {
        case .en: return count == 1 ? "Signed out of 1 other device." : "Signed out of \(n) other devices."
        case .fa: return "از \(n) دستگاه دیگر خارج شدید."
        case .tr: return "\(n) diğer cihazdan çıkış yapıldı."
        }
    }

    static func noOtherDevices(_ l: Language) -> String {
        switch l {
        case .en: "No other device is signed in."
        case .fa: "دستگاه دیگری با این حساب وارد نیست."
        case .tr: "Başka bir cihazda oturum açık değil."
        }
    }

    // MARK: About

    /// Settings → About: the platform's website, unless Super Admin named it otherwise.
    static func website(_ l: Language) -> String {
        switch l {
        case .en: "Website"
        case .fa: "وب‌سایت"
        case .tr: "Web sitesi"
        }
    }

    /// The build of the version, beside it.
    static func build(_ l: Language) -> String {
        switch l {
        case .en: "Build"
        case .fa: "شمارهٔ ساخت"
        case .tr: "Derleme"
        }
    }
}
