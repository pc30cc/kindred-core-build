import UIKit

/// The window's own safe-area insets.
///
/// SwiftUI will hand a view its safe area, but only through a
/// `GeometryReader`, and wrapping a whole screen in one changes how that
/// screen lays out. The floating tab bar needs the bottom inset for the
/// opposite reason to everyone else: it sits *inside* the home-indicator
/// strip on purpose, so it has to know how tall that strip is — and on a
/// device with a home button it is not there at all.
@MainActor
enum ScreenInsets {
    static var bottom: CGFloat {
        let scene = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive }
            ?? UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .first
        return scene?.keyWindow?.safeAreaInsets.bottom ?? 0
    }
}
