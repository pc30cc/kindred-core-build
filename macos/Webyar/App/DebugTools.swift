// Compiled only into Debug builds.
#if DEBUG
import AppKit
import SwiftUI
import WebKit

/// Development aids, off unless asked for by environment:
///
/// - `WEBYAR_SAMPLE=1` answers every API call from memory (SampleBackend), so
///   every screen can be laid out and reviewed without a server or an account.
/// - `WEBYAR_DEBUG_DIR=<folder>` writes a PNG of each window there every two
///   seconds, and reads one-line commands from `<folder>/command.txt`
///   (`route contacts`, `open c-2`, `lang en`, `appearance dark`, `settings`,
///   `details off`, `maintenance on`) — a way to drive and see the app from a script on a Mac
///   whose screen cannot be recorded.
@MainActor
enum DebugTools {
    static var sample: Bool { ProcessInfo.processInfo.environment["WEBYAR_SAMPLE"] == "1" }
    private static var timer: Timer?
    private static var lastCommand = ""
    private static var queue: [String] = []

    static func start(app: AppModel) {
        guard let dir = ProcessInfo.processInfo.environment["WEBYAR_DEBUG_DIR"] else { return }
        let folder = URL(fileURLWithPath: dir, isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in
            Task { @MainActor in
                runCommand(folder, app)
                snapshot(folder)
            }
        }
    }

    private static func snapshot(_ folder: URL) {
        for (i, window) in NSApp.windows.enumerated() where window.isVisible && window.windowNumber > 0 {
            // An app may always capture its own windows; no screen-recording permission is involved.
            guard let id = CGWindowID(exactly: window.windowNumber), let image = capture(id) else { continue }
            let rep = NSBitmapImageRep(cgImage: image)
            guard let png = rep.representation(using: .png, properties: [:]) else { continue }
            let name = window.identifier?.rawValue.replacingOccurrences(of: "/", with: "_") ?? "window"
            try? png.write(to: folder.appendingPathComponent("\(i)-\(name).png"))
        }
    }

    /// CGWindowListCreateImage, looked up at run time: the SDK marks it obsolete, the OS still answers.
    private static func capture(_ id: CGWindowID) -> CGImage? {
        typealias Fn = @convention(c) (CGRect, UInt32, UInt32, UInt32) -> Unmanaged<CGImage>?
        guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGWindowListCreateImage") else { return nil }
        let fn = unsafeBitCast(sym, to: Fn.self)
        // optionIncludingWindow = 1 << 3, boundsIgnoreFraming = 1 << 0, bestResolution = 1 << 3
        return fn(.null, 1 << 3, id, (1 << 0) | (1 << 3))?.takeRetainedValue()
    }

    private static func runCommand(_ folder: URL, _ app: AppModel) {
        let file = folder.appendingPathComponent("command.txt")
        guard let text = try? String(contentsOf: file, encoding: .utf8) else { return }
        // Several commands separated by ";" run one per tick.
        let all = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !all.isEmpty, all != lastCommand {
            lastCommand = all
            queue = all.split(separator: ";").map { $0.trimmingCharacters(in: .whitespaces) }
        }
        guard !queue.isEmpty else { return }
        let line = queue.removeFirst()
        let parts = line.split(separator: " ").map(String.init)
        let arg = parts.count > 1 ? parts[1] : ""
        switch parts.first {
        case "route":
            switch arg {
            case "contacts": app.route = .contacts
            case "visitors": app.route = .visitors
            case "calls": app.route = .calls
            case "colleagues": app.route = .colleagues
            case "email": app.route = .email
            case "ai": app.route = .inbox(.ai)
            case "pending": app.route = .inbox(.pending)
            case "resolved": app.route = .inbox(.resolved)
            default: app.route = .inbox(.open)
            }
        case "open": app.openConversation(arg)
        case "mail": EmailModel.debugCurrent?.select(arg)
        case "compose": EmailModel.debugCurrent?.composing = arg != "off"
        case "replymode": EmailModel.debugCurrent?.replyMode = ReplyMode(rawValue: arg) ?? .reply
        case "lang": if let l = Language.parse(arg) { app.setLanguage(l) }
        case "appearance": app.setAppearance(Appearance(rawValue: arg) ?? .system)
        case "settings": app.showSettings?()
        case "signout": app.debugSignOut()
        case "details": app.settings.detailsOpen = arg != "off"
        case "ring": app.debugRing()
        case "maintenance":
            // Super Admin's switch in the sample platform, then the app asks again at once.
            SampleBackend.maintenance = arg != "off"
            Task { await app.refreshPlatform() }
        case "size":
            let wh = arg.split(separator: "x").compactMap { Double($0) }
            if wh.count == 2, let w = NSApp.windows.first(where: { $0.isVisible && $0.frame.width > 500 }) {
                w.setFrame(NSRect(x: 60, y: 40, width: wh[0], height: wh[1]), display: true, animate: false)
            }
        case "websnap":
            // What a web view itself drew, apart from the window capture.
            for w in NSApp.windows { for web in webViews(w.contentView) {
                web.takeSnapshot(with: nil) { image, error in
                    guard let tiff = image?.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
                          let png = rep.representation(using: .png, properties: [:]) else {
                        try? "no image: \(String(describing: error))".write(to: folder.appendingPathComponent("web.txt"), atomically: true, encoding: .utf8)
                        return
                    }
                    try? png.write(to: folder.appendingPathComponent("web-snap.png"))
                }
                if let html = (web.navigationDelegate as? MailWebView.Coordinator)?.shown {
                    try? html.write(to: folder.appendingPathComponent("web.html"), atomically: true, encoding: .utf8)
                }
            } }
        default: break
        }
    }

    private static func webViews(_ view: NSView?) -> [WKWebView] {
        guard let view else { return [] }
        if let web = view as? WKWebView { return [web] }
        return view.subviews.flatMap { webViews($0) }
    }
}
#endif
