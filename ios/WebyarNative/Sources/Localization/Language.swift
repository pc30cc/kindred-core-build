import SwiftUI

/// The three languages the product ships in.
///
/// The web app deliberately never reads the device language — the operator
/// picks one and it sticks. The native app keeps that contract so a user who
/// set Türkçe on the web does not get something else here.
enum Language: String, CaseIterable, Identifiable, Sendable {
    case en
    case fa
    case tr

    var id: String { rawValue }

    /// Written in the language itself, which is the only form a language
    /// picker should ever show.
    var endonym: String {
        switch self {
        case .en: "English"
        case .fa: "فارسی"
        case .tr: "Türkçe"
        }
    }

    var layoutDirection: LayoutDirection {
        self == .fa ? .rightToLeft : .leftToRight
    }

    var locale: Locale {
        switch self {
        case .en: Locale(identifier: "en_US")
        case .fa: Locale(identifier: "fa_IR")
        case .tr: Locale(identifier: "tr_TR")
        }
    }

    /// Persian dates are far more legible to a Persian reader in the Persian
    /// calendar, and iOS will use it automatically for `fa_IR`.
    var calendarLocale: Locale { locale }
}
