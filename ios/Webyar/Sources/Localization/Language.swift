import SwiftUI

/// The languages the app ships in: the product's three, and Arabic, which
/// only this app speaks so far.
///
/// The web app deliberately never reads the device language — the operator
/// picks one and it sticks. This app keeps that contract so a user who
/// set Türkçe on the web does not get something else here.
enum Language: String, CaseIterable, Identifiable, Sendable {
    case en
    case fa
    case tr
    case ar

    var id: String { rawValue }

    /// Written in the language itself, which is the only form a language
    /// picker should ever show.
    var endonym: String {
        switch self {
        case .en: "English"
        case .fa: "فارسی"
        case .tr: "Türkçe"
        case .ar: "العربية"
        }
    }

    var layoutDirection: LayoutDirection {
        switch self {
        case .fa, .ar: .rightToLeft
        case .en, .tr: .leftToRight
        }
    }

    /// What goes between the items of a list written in a sentence: the
    /// Arabic comma in Persian and Arabic.
    var listSeparator: String {
        layoutDirection == .rightToLeft ? "، " : ", "
    }

    var locale: Locale {
        switch self {
        case .en: Locale(identifier: "en_US")
        case .fa: Locale(identifier: "fa_IR")
        case .tr: Locale(identifier: "tr_TR")
        // Arabic-Indic digits (٠١٢٣) and the Gregorian calendar, spelled out:
        // some Arabic regions default to Latin digits or the Hijri calendar.
        case .ar: Locale(identifier: "ar@calendar=gregorian;numbers=arab")
        }
    }

    /// The language to name to the server, which speaks the product's
    /// three: canned responses, promotions and the password-reset email are
    /// in English for an operator reading the app in Arabic.
    var serverLocale: String {
        self == .ar ? Language.en.rawValue : rawValue
    }

    /// Persian dates are far more legible to a Persian reader in the Persian
    /// calendar, and iOS will use it automatically for `fa_IR`.
    var calendarLocale: Locale { locale }
}
