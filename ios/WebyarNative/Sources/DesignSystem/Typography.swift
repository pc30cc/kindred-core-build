import SwiftUI
import UIKit

/// Which face the interface is set in, and the one place that decides it.
///
/// Persian in the system face is legible but it is not *this product*. The
/// console and the Windows app have both been set in IRANSans since before
/// this app existed, so an operator moving between their desk and their phone
/// was reading two different companies. The file here is the same one the
/// Windows app ships — `windows-native/.../IRANSans.ttc`, three faces in one
/// collection — so there is one font in the product rather than one per
/// platform.
///
/// ## Why the language decides it and not the script
///
/// IRANSans carries Latin glyphs too, so it *could* be set for the whole app
/// in every language. It is not, on purpose: San Francisco is the face iOS is
/// drawn in, and an English screen set in anything else reads as a web page
/// in a wrapper. The rule is the interface language — Persian gets IRANSans,
/// English and Turkish keep the system face.
///
/// ## Why this is a global rather than an environment value
///
/// The same reason `WindowDirection` is. The root is keyed on the language,
/// so changing it rebuilds the whole interface rather than re-draping it, and
/// every view body re-reads this on the way through. An environment value
/// would have meant a modifier at all hundred-and-twenty call sites to say
/// the thing the language already says.
@MainActor
enum AppTypeface {
    case system
    case iranSans

    private(set) static var current: AppTypeface = .system

    /// Set alongside `WindowDirection.apply`, from the same value in the same
    /// breath — the two have to agree or the interface is half one language.
    static func apply(_ language: Language) {
        current = language == .fa ? .iranSans : .system
        applyToNavigationBar()
    }

    /// The navigation bar's title is drawn by UIKit, not by us.
    ///
    /// This is why "مخاطبین" and "تنظیمات" stayed in the system face while
    /// every row beneath them changed: `.navigationTitle` hands a string to a
    /// `UINavigationBar`, and no SwiftUI `.font` modifier reaches inside one.
    /// The only lever is the appearance proxy — the same lever
    /// `WindowDirection` already pulls for `semanticContentAttribute`.
    ///
    /// The existing appearance objects are mutated and put back rather than
    /// replaced with fresh ones. A new `UINavigationBarAppearance` starts
    /// with a transparent background, so configuring one from scratch would
    /// take the bar's own material with it -- and on iOS 26 that material is
    /// the Liquid Glass this app was just rebuilt around.
    private static func applyToNavigationBar() {
        let bar = UINavigationBar.appearance()
        for appearance in [bar.standardAppearance, bar.scrollEdgeAppearance, bar.compactAppearance] {
            guard let appearance else { continue }
            appearance.titleTextAttributes = titleAttributes(size: 17, weight: .semibold)
            appearance.largeTitleTextAttributes = titleAttributes(size: 34, weight: .bold)
        }
        bar.standardAppearance = bar.standardAppearance
    }

    /// Empty for the system face, which is what puts English and Turkish back
    /// to the bar UIKit would have drawn on its own.
    private static func titleAttributes(size: CGFloat, weight: Font.Weight) -> [NSAttributedString.Key: Any] {
        guard let name = current.faceName(for: weight),
              let font = UIFont(name: name, size: size)
        else { return [:] }
        return [.font: font]
    }

    /// The face for a weight.
    ///
    /// Three cuts have to cover nine `Font.Weight` values, so the mapping is
    /// deliberate rather than nearest-neighbour: semibold goes to Bold, not
    /// Medium. SF's semibold is a good deal heavier than IRANSans Medium, and
    /// a row title that stopped standing out from its own preview line would
    /// be a worse bug than a title half a step too heavy.
    fileprivate func faceName(for weight: Font.Weight) -> String? {
        guard case .iranSans = self else { return nil }
        switch weight {
        case .ultraLight, .thin, .light, .regular:
            return "IRANSans-Regular"
        case .medium:
            return "IRANSans-Medium"
        default:
            return "IRANSans-Bold"
        }
    }
}

extension Font {

    /// A text style in the app's current face.
    ///
    /// Always built with `relativeTo:`, never as a fixed size, so IRANSans
    /// grows with the reader's Dynamic Type setting exactly as the system
    /// face does. A custom font that ignores Dynamic Type is the single most
    /// common way an app fails accessibility review.
    @MainActor
    static func app(_ style: Font.TextStyle, weight: Font.Weight? = nil) -> Font {
        let resolved = weight ?? Self.defaultWeight(for: style)
        guard let name = AppTypeface.current.faceName(for: resolved) else {
            return .system(style, weight: resolved)
        }
        return .custom(name, size: Self.baseSize(for: style), relativeTo: style)
    }

    /// A fixed point size in the app's current face.
    ///
    /// For the handful of labels that are drawn at a specific size rather than
    /// at a text style. `relativeTo` still ties them to Dynamic Type.
    @MainActor
    static func app(
        size: CGFloat,
        weight: Font.Weight = .regular,
        relativeTo style: Font.TextStyle = .body
    ) -> Font {
        guard let name = AppTypeface.current.faceName(for: weight) else {
            return .system(size: size, weight: weight)
        }
        return .custom(name, size: size, relativeTo: style)
    }

    /// What the system draws a style at before Dynamic Type scales it.
    ///
    /// `Font.custom(_:size:relativeTo:)` needs a number, and these are the
    /// numbers iOS uses at the Large setting. Getting one wrong would make a
    /// Persian caption a different size from an English one.
    private static func baseSize(for style: Font.TextStyle) -> CGFloat {
        switch style {
        case .largeTitle: return 34
        case .title: return 28
        case .title2: return 22
        case .title3: return 20
        case .headline: return 17
        case .body: return 17
        case .callout: return 16
        case .subheadline: return 15
        case .footnote: return 13
        case .caption: return 12
        case .caption2: return 11
        @unknown default: return 17
        }
    }

    /// Headline is semibold in the system face; everything else is regular.
    /// Without this, `.app(.headline)` would come out lighter in Persian than
    /// the same call in English.
    private static func defaultWeight(for style: Font.TextStyle) -> Font.Weight {
        style == .headline ? .semibold : .regular
    }
}
