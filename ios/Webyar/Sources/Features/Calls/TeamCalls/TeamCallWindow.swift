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
///
/// Minimised (owner, 2026-11-04: "the user can keep working"), the window
/// shrinks to a small floating view of the call (`TeamCallBubble`) that is
/// dragged anywhere, settles against the nearer side, and opens the call
/// again when tapped. The window itself becomes that small, so everything
/// else on screen is the app's again — its touches, its keyboard, VoiceOver
/// — with no hit-testing tricks. Coming back to the app from the background
/// (CallKit's green pill or Dynamic Island, the app's icon) or from PiP opens
/// the call full again.
@MainActor
final class TeamCallWindow {
    static let shared = TeamCallWindow()

    private var window: UIWindow?
    /// The app's window under it, made key again when the call goes.
    private weak var appWindow: UIWindow?
    private var pan: UIPanGestureRecognizer?
    /// Where the floating view was left, for the next time: its side, and
    /// its height as a share of the room it moves in.
    private var bubbleOnLeft = false
    private var bubbleHeightShare: CGFloat = 0.12
    private var panStart: CGPoint = .zero

    /// The floating view, with the margin its shadow is drawn in.
    static let bubbleSize = CGSize(width: 104, height: 148)
    static let bubbleMargin: CGFloat = 10

    private init() {
        NotificationCenter.default.addObserver(
            forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main
        ) { _ in
            MainActor.assumeIsolated {
                guard TeamCallPresentation.shared.isMinimized,
                      let call = CallManager.shared.call, !call.phase.isOver
                else { return }
                TeamCallPresentation.shared.expand()
            }
        }
    }

    /// Over `appWindow`, in its scene. A scene the app opened anew (the old
    /// one was discarded while the call went on) gets a window of its own.
    func show(over appWindow: UIWindow, appState: AppState) {
        guard let scene = appWindow.windowScene else { return }
        self.appWindow = appWindow
        if let window, window.windowScene === scene {
            guard window.isHidden else { return }
            window.frame = appWindow.bounds
            window.makeKeyAndVisible()
            UIAccessibility.post(notification: .screenChanged, argument: nil)
            return
        }
        window?.isHidden = true
        let window = UIWindow(windowScene: scene)
        window.windowLevel = .alert + 1
        window.overrideUserInterfaceStyle = .dark
        let host = UIHostingController(rootView: TeamCallLayer(manager: .shared).environment(appState))
        // Clear for the floating view's rounded corners and shadow; the call
        // screen itself is opaque from its first layer (`CallBackdrop`).
        host.view.backgroundColor = .clear
        window.rootViewController = host
        window.makeKeyAndVisible()
        self.window = window
        UIAccessibility.post(notification: .screenChanged, argument: nil)
    }

    func hide() {
        TeamCallPresentation.shared.reset()
        guard let window, !window.isHidden else { return }
        window.isHidden = true
        restoreFullFrame(window)
        appWindow?.makeKey()
        UIAccessibility.post(notification: .screenChanged, argument: nil)
    }

    // MARK: - Minimised

    /// The call to its floating view; the app takes the keyboard and touches.
    @discardableResult
    fileprivate func minimize() -> Bool {
        guard let window, !window.isHidden, let appWindow else { return false }
        let frame = bubbleFrame(in: appWindow)
        UIView.animate(withDuration: 0.38, delay: 0, usingSpringWithDamping: 0.86, initialSpringVelocity: 0, options: []) {
            window.frame = frame
        }
        if pan == nil {
            let pan = UIPanGestureRecognizer(target: PanTarget.shared, action: #selector(PanTarget.moved(_:)))
            window.addGestureRecognizer(pan)
            self.pan = pan
        }
        pan?.isEnabled = true
        appWindow.makeKey()
        UIAccessibility.post(notification: .screenChanged, argument: nil)
        return true
    }

    /// The floating view back to the whole screen.
    fileprivate func expand() {
        guard let window, !window.isHidden else { return }
        pan?.isEnabled = false
        UIView.animate(withDuration: 0.38, delay: 0, usingSpringWithDamping: 0.9, initialSpringVelocity: 0, options: []) {
            self.restoreFullFrame(window)
        }
        window.makeKey()
        UIAccessibility.post(notification: .screenChanged, argument: nil)
    }

    private func restoreFullFrame(_ window: UIWindow) {
        pan?.isEnabled = false
        window.frame = appWindow?.bounds ?? window.windowScene?.coordinateSpace.bounds ?? window.frame
    }

    /// The room the floating view moves in: the app's window inside its safe
    /// area, above the floating tab bar.
    private func room(in appWindow: UIWindow) -> CGRect {
        let insets = appWindow.safeAreaInsets
        let bounds = appWindow.bounds
        let size = Self.windowSize
        let top = insets.top + 4
        let bottom = bounds.height - insets.bottom - Theme.Size.floatingBarHeight - Theme.Size.floatingBarBottomGap - size.height
        return CGRect(x: insets.left + 2, y: top, width: max(0, bounds.width - insets.left - insets.right - 4 - size.width), height: max(0, bottom - top))
    }

    private static var windowSize: CGSize {
        CGSize(width: bubbleSize.width + bubbleMargin * 2, height: bubbleSize.height + bubbleMargin * 2)
    }

    private func bubbleFrame(in appWindow: UIWindow) -> CGRect {
        let room = room(in: appWindow)
        let x = bubbleOnLeft ? room.minX : room.maxX
        let y = room.minY + room.height * bubbleHeightShare
        return CGRect(origin: CGPoint(x: x, y: y), size: Self.windowSize)
    }

    fileprivate func panned(_ pan: UIPanGestureRecognizer) {
        guard let window, let appWindow else { return }
        switch pan.state {
        case .began:
            panStart = window.frame.origin
        case .changed:
            let move = pan.translation(in: appWindow)
            window.frame.origin = CGPoint(x: panStart.x + move.x, y: panStart.y + move.y)
        case .ended, .cancelled:
            let room = room(in: appWindow)
            // A flick carries it to the side it was thrown at.
            let thrown = window.frame.midX + pan.velocity(in: appWindow).x * 0.15
            bubbleOnLeft = thrown < appWindow.bounds.midX
            let y = min(max(window.frame.minY, room.minY), room.maxY)
            bubbleHeightShare = room.height > 0 ? (y - room.minY) / room.height : 0
            let frame = bubbleFrame(in: appWindow)
            let reduceMotion = UIAccessibility.isReduceMotionEnabled
            UIView.animate(withDuration: reduceMotion ? 0 : 0.42, delay: 0, usingSpringWithDamping: 0.8, initialSpringVelocity: 0.4, options: []) {
                window.frame = frame
            }
        default:
            break
        }
    }

    /// The pan's target: an `NSObject`, which the window class is not.
    private final class PanTarget: NSObject {
        static let shared = PanTarget()

        @objc func moved(_ pan: UIPanGestureRecognizer) {
            MainActor.assumeIsolated { TeamCallWindow.shared.panned(pan) }
        }
    }
}

/// Whether the colleague call is full screen or minimised to its floating
/// view: the call screen's minimise button, a tap on the floating view, PiP's
/// return and the app's own return from the background change it.
@MainActor
@Observable
final class TeamCallPresentation {
    static let shared = TeamCallPresentation()

    private(set) var isMinimized = false

    func minimize() {
        guard !isMinimized, TeamCallWindow.shared.minimize() else { return }
        isMinimized = true
    }

    func expand() {
        guard isMinimized else { return }
        isMinimized = false
        TeamCallWindow.shared.expand()
    }

    /// The call's window went: the next call opens full.
    fileprivate func reset() {
        isMinimized = false
    }
}

/// What the call's window draws: the call screen, in the operator's
/// language and its direction and type, as `WebyarApp` sets them for the
/// app's own window — this one is not under it.
private struct TeamCallLayer: View {
    @Environment(AppState.self) private var appState
    let manager: CallManager
    private let presentation = TeamCallPresentation.shared

    var body: some View {
        ZStack {
            if let call = manager.call {
                if presentation.isMinimized {
                    TeamCallBubble(manager: manager, call: call, language: appState.language)
                        .transition(.opacity)
                } else {
                    TeamCallScreen(manager: manager, call: call, language: appState.language)
                        .transition(.opacity)
                }
            }
        }
        .animation(.easeInOut(duration: 0.25), value: presentation.isMinimized)
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
