import SwiftUI
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
    static var top: CGFloat { insets.top }
    static var bottom: CGFloat { insets.bottom }

    private static var insets: UIEdgeInsets {
        let scene = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive }
            ?? UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .first
        return scene?.keyWindow?.safeAreaInsets ?? .zero
    }
}

/// Blurs whatever scrolls under the status bar.
///
/// A screen with no navigation bar has nothing to give the status bar a
/// background, so a list slides its rows up behind the clock and leaves them
/// there in plain sight. This puts back the one thing a navigation bar was
/// doing that is still wanted.
private struct StatusBarScrim: ViewModifier {
    func body(content: Content) -> some View {
        content.overlay(alignment: .top) {
            Color.clear
                .frame(height: ScreenInsets.top)
                .background(.ultraThinMaterial)
                .ignoresSafeArea(edges: .top)
                .allowsHitTesting(false)
        }
    }
}

extension View {
    /// Apply to a screen that scrolls with no navigation bar above it.
    func statusBarScrim() -> some View {
        modifier(StatusBarScrim())
    }
}
