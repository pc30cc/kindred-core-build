import AppKit
import Observation
import SwiftUI

/// Runs the one call the operator can be on — the static half of the Windows
/// CallWindow (`Start`, `StartDesk`, `IsBusy`, `DeskCallEnded`).
///
/// A call lives in the page it belongs to: it slides down under the
/// conversation's header, or over the call on the call-center desk, and slides
/// back up when it ends. The operator can go to any other page meanwhile — the
/// call bar in the corner keeps it at hand and leads back — or take the call
/// out into a window of its own, full screen if they like, and put it back.
/// A second call while one is up leads to the running one instead.
@MainActor
@Observable
final class CallCoordinator {
    static let shared = CallCoordinator()

    enum Presentation {
        /// Inside the page: the conversation, or the call on the desk.
        case docked
        /// In a window of its own.
        case window
    }

    /// The call under way, if any.
    private(set) var call: LiveCall?
    private(set) var presentation: Presentation = .docked
    /// The window floats above other apps' windows.
    private(set) var isFloating = false
    /// The call's window is full screen.
    private(set) var isFullScreen = false
    /// How many in-page call panels are on screen: none means the operator is on
    /// another page, and the call bar takes over.
    private(set) var dockedPanels = 0

    /// A call is up.
    var isBusy: Bool { call != nil }

    /// The call session the operator is on: the desk call's id, or an outgoing
    /// call's session once the visitor joined.
    var activeCallId: String? { call?.sessionId }

    /// The call bar shows while the call is in the page but that page is not on screen.
    var showsCallBar: Bool { call != nil && presentation == .docked && dockedPanels == 0 }

    /// Whether a page should hold the call: this conversation's call, docked.
    func docksHere(conversationId: String?) -> LiveCall? {
        guard presentation == .docked, let call, let id = conversationId, call.conversation?.id == id else { return nil }
        return call
    }

    /// Whether the desk should hold the call: the desk call on show, docked.
    func docksHere(deskCallId: String?) -> LiveCall? {
        guard presentation == .docked, let call, let id = deskCallId, call.desk?.callId == id else { return nil }
        return call
    }

    /// Raised when a call answered from the call-center queue ends; carries the call id.
    @ObservationIgnored let deskCallEnded = Signal<String>()

    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private var window: NSWindow?
    @ObservationIgnored private var windowDelegate: CallWindowDelegate?
    /// The width a voice call had before the notes widened it.
    @ObservationIgnored private var narrowWidth: CGFloat?

    /// The operator calls the visitor from a conversation.
    func start(app: AppModel, conversation: Conversation, channel: String) {
        if showRunningCall() { return }
        // The buttons hide with the plan and the platform's switches; this holds even if one lingers.
        guard channel == "video" ? app.plan.videoCalls : app.plan.voiceCalls else { return }
        let workspaceId = app.workspace?.id ?? conversation.workspaceId
        let name = Display.conversationName(conversation, app.strings)
        let c = LiveCall(app: app, conversation: conversation, desk: nil, workspaceId: workspaceId, channel: channel, name: name)
        begin(c, app: app)
    }

    /// Opens the media for a call just accepted on the call-center desk.
    func joinAccepted(app: AppModel, accept: CallAccept, call: CallSession?, callId: String) {
        if showRunningCall() { return }
        let workspaceId = app.workspace?.id ?? call?.workspaceId ?? ""
        let name = CallNames.caller(call, fallbackId: call?.contactId ?? call?.visitorSessionId ?? callId, app.strings)
        // With video switched off, a video call is answered by voice.
        let channel = call?.isVideo == true && app.plan.videoCalls ? "video" : "audio"
        let c = LiveCall(app: app, conversation: nil, desk: LiveCall.Desk(callId: callId, accept: accept, session: call),
                         workspaceId: workspaceId, channel: channel, name: name)
        begin(c, app: app)
    }

    private func begin(_ c: LiveCall, app: AppModel) {
        self.app = app
        presentation = .docked
        c.onFinished = { [weak self, weak c] in
            guard let self, let c, c === self.call else { return }
            self.finished()
        }
        call = c
        c.start()
    }

    // MARK: Where the call is shown

    /// The page the call belongs to: the conversation, or the call on the desk.
    func showCallPage() {
        guard let call, let app else { return }
        NSApp.activate(ignoringOtherApps: true)
        NSApp.windows.first { $0.identifier?.rawValue.hasPrefix("main") == true }?.makeKeyAndOrderFront(nil)
        if let conversation = call.conversation {
            app.openConversation(conversation.id)
        } else if let desk = call.desk {
            app.openCall(desk.callId, answer: false)
        }
    }

    /// A call is already up: show it rather than start another.
    private func showRunningCall() -> Bool {
        guard call != nil else { return false }
        if presentation == .window, let window {
            NSApp.activate(ignoringOtherApps: true)
            window.makeKeyAndOrderFront(nil)
        } else {
            showCallPage()
        }
        return true
    }

    func panelAppeared() { dockedPanels += 1 }
    func panelDisappeared() { dockedPanels = max(0, dockedPanels - 1) }

    /// Takes the call out of the page into a window of its own.
    func popOut() {
        guard let call, presentation == .docked, let app else { return }
        presentation = .window
        openWindow(call, app: app)
    }

    /// Puts the call back into its page and closes its window — the call goes on.
    func dockBack() {
        guard presentation == .window else { return }
        presentation = .docked
        narrowWidth = nil
        isFullScreen = false
        let w = window
        window = nil
        windowDelegate = nil
        w?.delegate = nil
        if w?.styleMask.contains(.fullScreen) == true {
            w?.toggleFullScreen(nil)
            // Out of full screen first, or the space it had is left behind.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { w?.close() }
        } else {
            w?.close()
        }
        showCallPage()
    }

    /// Full screen and back: from the page, the call goes to its own window first.
    func toggleFullScreen() {
        if presentation == .docked {
            popOut()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in self?.window?.toggleFullScreen(nil) }
        } else {
            window?.toggleFullScreen(nil)
        }
    }

    /// Keeps the call window above every other window, or lets it sit among them again.
    func setFloating(_ on: Bool) {
        isFloating = on
        window?.level = on ? .floating : .normal
    }

    /// Makes room for the notes beside a narrow (voice) call window, and gives it back when they close.
    func fitSidePanel(_ open: Bool) {
        guard let window, !window.styleMask.contains(.fullScreen) else { return }
        let wide: CGFloat = 780
        var frame = window.frame
        if open {
            guard frame.width < wide else { return }
            narrowWidth = frame.width
            frame.origin.x -= (wide - frame.width) / 2
            frame.size.width = wide
        } else {
            guard let narrow = narrowWidth else { return }
            narrowWidth = nil
            frame.origin.x += (frame.width - narrow) / 2
            frame.size.width = narrow
        }
        window.setFrame(frame, display: true, animate: true)
    }

    // MARK: Window

    private func openWindow(_ c: LiveCall, app: AppModel) {
        let s = app.strings
        let video = c.isVideo
        let root = CallView(call: c)
            .frame(minWidth: 320, maxWidth: .infinity, minHeight: 400, maxHeight: .infinity)
            .environment(app)
            .appEnvironment(app)
        let host = NSHostingController(rootView: AnyView(root))
        // The window keeps the size given here; the view follows it rather than the other way round.
        host.sizingOptions = []
        let size = NSSize(width: video ? 960 : 420, height: video ? 640 : 560)

        let w = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                         styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                         backing: .buffered, defer: false)
        w.contentViewController = host
        w.setContentSize(size)
        w.contentMinSize = video ? NSSize(width: 560, height: 400) : NSSize(width: 360, height: 460)
        w.title = "\(c.name) — \(s[video ? "videoCall" : "voiceCall"])"
        w.titlebarAppearsTransparent = true
        w.appearance = NSAppearance(named: .darkAqua)
        w.backgroundColor = NSColor(srgbRed: 0x0C / 255, green: 0x0E / 255, blue: 0x14 / 255, alpha: 1)
        w.isReleasedWhenClosed = false
        w.collectionBehavior = video ? [.fullScreenPrimary, .managed] : [.fullScreenAuxiliary, .managed]
        w.identifier = NSUserInterfaceItemIdentifier("call")
        w.level = isFloating ? .floating : .normal
        w.center()

        let d = CallWindowDelegate()
        d.fullScreenChanged = { [weak self] on in self?.isFullScreen = on }
        d.shouldClose = { [weak self, weak c] in
            // Closing the window puts the call back into its page; an ended call just closes.
            guard let self, let c, !c.isEnded else { return true }
            self.dockBack()
            return false
        }
        w.delegate = d

        window = w
        windowDelegate = d
        NSApp.activate(ignoringOtherApps: true)
        w.makeKeyAndOrderFront(nil)
    }

    // MARK: Ending

    /// The ended call has shown why for a moment: its panel slides away, its window closes.
    private func finished() {
        guard let c = call else { return }
        c.onFinished = nil
        isFullScreen = false
        let deskId = c.desk?.callId
        call = nil
        presentation = .docked
        narrowWidth = nil
        let w = window
        window = nil
        windowDelegate = nil
        w?.delegate = nil
        w?.close()
        if let deskId { deskCallEnded.send(deskId) }
    }

    /// The app is quitting: the call ends properly rather than just vanishing.
    func hangUpForQuit() {
        guard let c = call, !c.isEnded else { return }
        if c.transferredTo != nil { c.leave() } else { c.hangUp() }
    }
}

/// Turns the window's close button into "back into the page".
@MainActor
private final class CallWindowDelegate: NSObject, NSWindowDelegate {
    var shouldClose: (() -> Bool)?
    var fullScreenChanged: ((Bool) -> Void)?

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        shouldClose?() ?? true
    }

    func windowDidEnterFullScreen(_ notification: Notification) { fullScreenChanged?(true) }
    func windowDidExitFullScreen(_ notification: Notification) { fullScreenChanged?(false) }
}
