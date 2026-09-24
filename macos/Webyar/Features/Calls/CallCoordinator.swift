import AppKit
import Observation
import SwiftUI

/// Runs the one call the operator can be on, in its own window — the static
/// half of the Windows CallWindow (`Start`, `StartDesk`, `IsBusy`,
/// `DeskCallEnded`). A second call while one is up brings the running one to
/// the front instead.
@MainActor
@Observable
final class CallCoordinator {
    static let shared = CallCoordinator()

    /// The call on screen, if any.
    private(set) var call: LiveCall?
    /// The window floats above other apps' windows.
    private(set) var isFloating = false

    /// A call window is up.
    var isBusy: Bool { call != nil }

    /// The call session the operator is on: the desk call's id, or an outgoing
    /// call's session once the visitor joined.
    var activeCallId: String? { call?.sessionId }

    /// Raised when a call answered from the call-center queue ends; carries the call id.
    @ObservationIgnored let deskCallEnded = Signal<String>()

    @ObservationIgnored private var window: NSWindow?
    @ObservationIgnored private var windowDelegate: CallWindowDelegate?

    /// The operator calls the visitor from a conversation.
    func start(app: AppModel, conversation: Conversation, channel: String) {
        if bringToFront() { return }
        // The buttons hide with the plan and the platform's switches; this holds even if one lingers.
        guard channel == "video" ? app.plan.videoCalls : app.plan.voiceCalls else { return }
        let workspaceId = app.workspace?.id ?? conversation.workspaceId
        let name = Display.conversationName(conversation, app.strings)
        let c = LiveCall(app: app, conversation: conversation, desk: nil, workspaceId: workspaceId, channel: channel, name: name)
        open(c, app: app)
    }

    /// Opens the media for a call just accepted on the call-center desk.
    func joinAccepted(app: AppModel, accept: CallAccept, call: CallSession?, callId: String) {
        if bringToFront() { return }
        let workspaceId = app.workspace?.id ?? call?.workspaceId ?? ""
        let name = CallNames.caller(call, fallbackId: call?.contactId ?? call?.visitorSessionId ?? callId, app.strings)
        // With video switched off, a video call is answered by voice.
        let channel = call?.isVideo == true && app.plan.videoCalls ? "video" : "audio"
        let c = LiveCall(app: app, conversation: nil, desk: LiveCall.Desk(callId: callId, accept: accept),
                         workspaceId: workspaceId, channel: channel, name: name)
        open(c, app: app)
    }

    /// Keeps the call window above every other window, or lets it sit among them again.
    func setFloating(_ on: Bool) {
        isFloating = on
        window?.level = on ? .floating : .normal
    }

    // MARK: Window

    private func bringToFront() -> Bool {
        guard call != nil, let window else { return false }
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        return true
    }

    private func open(_ c: LiveCall, app: AppModel) {
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
        d.shouldClose = { [weak c] in
            // Closing the window is hanging up; an ended call closes on its own.
            guard let c, !c.isEnded else { return true }
            c.hangUp()
            return false
        }
        d.willClose = { [weak self, weak w] in
            guard let self, let w, w === self.window else { return }
            self.closed()
        }
        w.delegate = d

        c.onFinished = { [weak self, weak w] in
            guard let self, let w, w === self.window else { return }
            w.close()
        }

        call = c
        window = w
        windowDelegate = d
        NSApp.activate(ignoringOtherApps: true)
        w.makeKeyAndOrderFront(nil)
        c.start()
    }

    private func closed() {
        guard let c = call else { return }
        // A window closed some other way (the app quitting, say) still tells the server.
        if !c.isEnded { c.finish(.hungUp, nil) }
        c.onFinished = nil
        let deskId = c.desk?.callId
        call = nil
        window?.delegate = nil
        window = nil
        windowDelegate = nil
        if let deskId { deskCallEnded.send(deskId) }
    }
}

/// Turns the window's close button into "hang up".
@MainActor
private final class CallWindowDelegate: NSObject, NSWindowDelegate {
    var shouldClose: (() -> Bool)?
    var willClose: (() -> Void)?

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        shouldClose?() ?? true
    }

    func windowWillClose(_ notification: Notification) {
        willClose?()
    }
}
