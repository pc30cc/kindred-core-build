import SwiftUI
import UIKit
import CoreText
import os

/// The Persian font for Persian, San Francisco for English, Turkish and
/// Arabic.
///
/// The Persian font is the web console's own, and the Mac and Windows apps
/// bundle the same file (here `Resources/fa.ttc`: Regular, Medium, Bold) —
/// so Persian reads the same in every Webyar app, and the same as the
/// Capacitor app this one replaced. The system's own Persian fallback is a
/// different face with different proportions, which is what made the app
/// look like somebody else's.
///
/// Every piece of text asks `Font.app(…)` for its font rather than naming
/// a system style, and the answer depends on the language. The language flag
/// is set before the interface is rebuilt for a new language (`AppState`
/// sets it in `language.didSet`, and the root is keyed on the language), so
/// no screen is ever drawn in the previous language's type.
enum Typeface {

    /// The three faces in the collection, lightest first.
    enum Face: CaseIterable {
        case regular
        case medium
        case bold

        /// The face that carries a weight, the way the web console maps them:
        /// its 600 is set in the Bold file, so a semibold title is bold here
        /// too rather than the much lighter Medium.
        init(_ weight: Font.Weight) {
            switch weight {
            case .semibold, .bold, .heavy, .black: self = .bold
            case .medium: self = .medium
            default: self = .regular
            }
        }

        /// The face's PostScript name, as the font file itself gives it —
        /// read from `fa.ttc` when it is registered, so the code names the
        /// file and never the font.
        var name: String { Typeface.faces[self] ?? "" }
    }

    /// Whether text is being set in the Persian font. Read from any thread —
    /// a `Font` is a value and nothing stops a background task building one —
    /// so it sits behind a lock rather than on the main actor.
    static var isPersian: Bool { state.withLock { $0 } }

    private static let state = OSAllocatedUnfairLock(initialState: false)

    /// The faces of `fa.ttc` by weight, registered with this process once,
    /// the first time a language is chosen — which is `AppState`'s
    /// initialiser, before the first frame. Empty if the file is missing or
    /// not the three faces it should be, which leaves Persian in the system
    /// face, which still reads.
    fileprivate static let faces: [Face: String] = {
        let log = Logger(subsystem: AppBrand.logSubsystem, category: "font")
        guard let url = Bundle.main.url(forResource: "fa", withExtension: "ttc") else {
            log.error("fa.ttc is missing from the bundle")
            return [:]
        }
        var error: Unmanaged<CFError>?
        if !CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error) {
            // Already registered is not a failure worth a word; anything
            // else shows up below as faces that do not load.
            let reason = error.map { String(describing: $0.takeRetainedValue()) } ?? "unknown"
            log.error("Persian font registration: \(reason, privacy: .public)")
        }
        let descriptors = CTFontManagerCreateFontDescriptorsFromURL(url as CFURL) as? [CTFontDescriptor] ?? []
        let byWeight = descriptors
            .map { CTFontCreateWithFontDescriptor($0, 12, nil) }
            .map { font -> (name: String, weight: Double) in
                let traits = CTFontCopyTraits(font) as? [CFString: Any]
                let weight = (traits?[kCTFontWeightTrait] as? NSNumber)?.doubleValue ?? 0
                return (CTFontCopyPostScriptName(font) as String, weight)
            }
            .sorted { $0.weight < $1.weight }
        guard byWeight.count == Face.allCases.count else {
            log.error("fa.ttc has \(byWeight.count, privacy: .public) faces, not \(Face.allCases.count, privacy: .public)")
            return [:]
        }
        return Dictionary(uniqueKeysWithValues: zip(Face.allCases, byWeight.map(\.name)))
    }()

    private static let registered: Bool = UIFont(name: Face.regular.name, size: 12) != nil

    /// Chooses the type for a language, and tells UIKit.
    @MainActor
    static func use(_ language: Language) {
        let persian = language == .fa && registered
        state.withLock { $0 = persian }
        UIKitAppearance.apply(persian: persian)
    }

    /// A text style's size at the default Dynamic Type setting (Large).
    /// The Persian font is then scaled from it with the reader's setting,
    /// exactly as the system face is.
    static func pointSize(_ style: Font.TextStyle) -> CGFloat {
        switch style {
        case .largeTitle: 34
        case .title: 28
        case .title2: 22
        case .title3: 20
        case .headline, .body: 17
        case .callout: 16
        case .subheadline: 15
        case .footnote: 13
        case .caption: 12
        case .caption2: 11
        default: 17
        }
    }

    /// The UIKit font for a text style and weight, scaled for Dynamic Type —
    /// for the few places UIKit draws the text itself.
    @MainActor
    static func uiFont(_ style: UIFont.TextStyle, _ weight: Font.Weight = .regular) -> UIFont {
        let base = UIFont.preferredFont(
            forTextStyle: style,
            compatibleWith: UITraitCollection(preferredContentSizeCategory: .large)
        )
        guard let face = UIFont(name: Face(weight).name, size: base.pointSize) else { return base }
        return UIFontMetrics(forTextStyle: style).scaledFont(for: face)
    }
}

extension Font {
    /// Text at a Dynamic Type style, in the app's typeface for the current
    /// language.
    ///
    /// `nil` weight is the style's own: regular, and semibold for
    /// `.headline`, as the system styles are.
    static func app(
        _ style: Font.TextStyle,
        _ weight: Font.Weight? = nil,
        design: Font.Design = .default
    ) -> Font {
        guard Typeface.isPersian else { return .system(style, design: design, weight: weight) }
        let resolved = weight ?? (style == .headline ? .semibold : .regular)
        return .custom(
            Typeface.Face(resolved).name,
            size: Typeface.pointSize(style),
            relativeTo: style
        )
    }

    /// Text at a fixed size — only for the places laid out to a measured
    /// size rather than to a text style, like the tab bar's labels.
    static func app(size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        guard Typeface.isPersian else { return .system(size: size, weight: weight) }
        return .custom(Typeface.Face(weight).name, fixedSize: size)
    }
}

/// The text UIKit draws for SwiftUI: navigation bar titles, the bar's text
/// buttons, segmented pickers and the search field.
///
/// Set on the appearance proxies, which apply to every bar and control made
/// afterwards — and the root is rebuilt when the language changes, so that is
/// every one on screen. Back in English they are cleared, which returns the
/// system's own fonts rather than a copy of them.
///
/// Alerts, menus and confirmation dialogs cannot be given a font without
/// private API, so they stay in the system face.
private enum UIKitAppearance {
    @MainActor
    static func apply(persian: Bool) {
        let bar = UINavigationBar.appearance()
        let button = UIBarButtonItem.appearance()
        let segmented = UISegmentedControl.appearance()
        let search = UITextField.appearance(whenContainedInInstancesOf: [UISearchBar.self])

        guard persian else {
            bar.titleTextAttributes = nil
            bar.largeTitleTextAttributes = nil
            for state in [UIControl.State.normal, .highlighted, .disabled] {
                button.setTitleTextAttributes(nil, for: state)
            }
            segmented.setTitleTextAttributes(nil, for: .normal)
            segmented.setTitleTextAttributes(nil, for: .selected)
            search.font = nil
            return
        }

        bar.titleTextAttributes = [.font: Typeface.uiFont(.headline, .semibold)]
        bar.largeTitleTextAttributes = [.font: Typeface.uiFont(.largeTitle, .bold)]
        let buttonFont: [NSAttributedString.Key: Any] = [.font: Typeface.uiFont(.body)]
        for state in [UIControl.State.normal, .highlighted, .disabled] {
            button.setTitleTextAttributes(buttonFont, for: state)
        }
        segmented.setTitleTextAttributes([.font: Typeface.uiFont(.subheadline, .medium)], for: .normal)
        segmented.setTitleTextAttributes([.font: Typeface.uiFont(.subheadline, .semibold)], for: .selected)
        search.font = Typeface.uiFont(.body)
    }
}
