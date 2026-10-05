import SwiftUI
import UIKit

/// Turns the *window* around, not just our own views.
///
/// Everything this app draws follows `\.layoutDirection`, and that was enough
/// until the first menu opened. A menu, an alert, an action sheet, a swipe
/// action and the text-selection callout are drawn by UIKit in its own
/// window, and UIKit does not read SwiftUI's environment — it reads
/// `semanticContentAttribute`. With the device in English and the app in
/// Persian, every one of those came out left-aligned inside a right-to-left
/// screen: the inbox switcher put "باز" hard against the left edge with half
/// the menu empty beside it.
///
/// It takes both levers, because a menu is not in our window at all. UIKit
/// puts a context menu in a window of its own, made the moment the menu opens
/// and gone when it closes — so setting the app's windows turns everything
/// except the one thing the operator complained about. The appearance proxy
/// is what that later window inherits from. The window call still earns its
/// place: it turns what is already on screen, which the proxy never does.
///
/// This is the same lever `AppleLanguages` used to pull, and it is worth being
/// precise about why that was a bug and this is not. `AppleLanguages` was read
/// once at launch, so the window's direction and the operator's chosen
/// language could disagree for the rest of the process — and SwiftUI draws a
/// mismatched subtree by mirroring it, which is how "Language" came to read
/// "egaugnaL". Here the two are set from the same value, in the same breath,
/// and the root is keyed on the language so the whole interface is rebuilt
/// under the new direction rather than re-draped over the old one.
enum WindowDirection {
    @MainActor
    static func apply(_ language: Language) {
        let attribute: UISemanticContentAttribute =
            language.layoutDirection == .rightToLeft ? .forceRightToLeft : .forceLeftToRight

        // Every UIKit view made from here on, including the window a menu
        // opens in.
        UIView.appearance().semanticContentAttribute = attribute

        for scene in UIApplication.shared.connectedScenes {
            guard let windowScene = scene as? UIWindowScene else { continue }
            for window in windowScene.windows where window.semanticContentAttribute != attribute {
                window.semanticContentAttribute = attribute
            }
        }
    }
}
