import SwiftUI
import UIKit

/// The colleague call's screen, in a window of its own above the app's.
///
/// Not an overlay on `RootView`: whatever the app presents — a sheet, a photo
/// opened full screen from a chat (`fullScreenCover`), an alert — is
/// presented above the root view, and so above its overlays. A call answered
/// from CallKit's banner while one of those was up would carry the voice with
/// its controls and the colleague's picture hidden under it, and CallKit
/// draws no in-call screen of its own for an app in the foreground: this is
/// the only one. The contract has the call screen "drawn above everything"
/// (docs/operations/TEAM_CALLS.md, "iOS"); a window at `.alert + 1` is.
///
/// Shown while `CallManager` has a call, an ended one included for as long as
/// its outcome lingers (`TeamCallWindowAnchor`), and hidden by its own
/// content once the call is gone (`TeamCallLayer`), when the app's window is
/// given the keyboard and VoiceOver back. Dark whatever the app's appearance,
/// like the call screen it holds — so the status bar over it is drawn light —
/// while the app's own window underneath keeps its own.
@MainActor
final class TeamCallWindow {
    static let shared = TeamCallWindow()

    private var window: UIWindow?
    /// The app's window under it, made key again when the call goes.
    private weak var appWindow: UIWindow?

    /// Over `appWindow`, in its scene. A scene the app opened anew (the old
    /// one was discarded while the call went on) gets a window of its own.
    func show(over appWindow: UIWindow, appState: AppState) {
        guard let scene = appWindow.windowScene else { return }
        self.appWindow = appWindow
        if let window, window.windowScene === scene {
            guard window.isHidden else { return }
            window.makeKeyAndVisible()
            UIAccessibility.post(notification: .screenChanged, argument: nil)
            return
        }
        window?.isHidden = true
        let window = UIWindow(windowScene: scene)
        window.windowLevel = .alert + 1
        window.overrideUserInterfaceStyle = .dark
        let host = UIHostingController(rootView: TeamCallLayer(manager: .shared).environment(appState))
        host.view.backgroundColor = .clear
        window.rootViewController = host
        window.makeKeyAndVisible()
        self.window = window
        UIAccessibility.post(notification: .screenChanged, argument: nil)
    }

    func hide() {
        guard let window, !window.isHidden else { return }
        window.isHidden = true
        appWindow?.makeKey()
        UIAccessibility.post(notification: .screenChanged, argument: nil)
    }
}

/// What the call's window draws: the call screen, in the operator's
/// language and its direction and type, as `WebyarApp` sets them for the
/// app's own window — this one is not under it.
private struct TeamCallLayer: View {
    @Environment(AppState.self) private var appState
    let manager: CallManager

    var body: some View {
        ZStack {
            if let call = manager.call {
                TeamCallScreen(manager: manager, call: call, language: appState.language)
            }
        }
        .environment(\.locale, appState.language.locale)
        .environment(\.layoutDirection, appState.language.layoutDirection)
        .font(.app(.body))
        // A new language is a new hierarchy, for the reason `WebyarApp`
        // keys its root on it.
        .id(appState.language)
        // Hidden from here rather than by the anchor that showed it: only
        // once the screen has gone from this window's own hierarchy, so what
        // it does on the way out (`onDisappear`, the idle timer) has been
        // done — a window hidden first may never draw that update. From the
        // first frame too: a call that ended before this window drew at all
        // must not leave an empty window over the app, taking its touches.
        .onChange(of: manager.call == nil, initial: true) { _, gone in
            if gone { TeamCallWindow.shared.hide() }
        }
    }
}

/// Where `RootView` hands its window to `TeamCallWindow`: a view in the
/// root's background, which knows the window — and so the scene — the app
/// is drawn in, and shows the call's window over it while there is a call.
///
/// Without a window — between one root and the next, which a change of
/// language makes — it changes nothing: the call's window stays as it is
/// until the new root's anchor says.
struct TeamCallWindowAnchor: UIViewRepresentable {
    @Environment(AppState.self) private var appState
    let active: Bool

    func makeUIView(context: Context) -> Anchor {
        let anchor = Anchor()
        anchor.isUserInteractionEnabled = false
        return anchor
    }

    func updateUIView(_ anchor: Anchor, context: Context) {
        anchor.appState = appState
        anchor.active = active
        anchor.sync()
    }

    final class Anchor: UIView {
        var appState: AppState?
        var active = false

        override func didMoveToWindow() {
            super.didMoveToWindow()
            sync()
        }

        func sync() {
            guard active, let window, let appState else { return }
            TeamCallWindow.shared.show(over: window, appState: appState)
        }
    }
}
