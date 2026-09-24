// Compiled only into Debug builds.
#if DEBUG
import AppKit
import SwiftUI

/// Development aids, off unless asked for by environment:
///
/// - `WEBYAR_SAMPLE=1` answers every API call from memory (SampleBackend), so
///   every screen can be laid out and reviewed without a server or an account.
/// - `WEBYAR_DEBUG_DIR=<folder>` writes a PNG of each window there every two
///   seconds, and reads one-line commands from `<folder>/command.txt`
///   (`route contacts`, `open c-2`, `lang en`, `appearance dark`, `settings`,
///   `details off`) — a way to drive and see the app from a script on a Mac
///   whose screen cannot be recorded.
@MainActor
enum DebugTools {
    static var sample: Bool { ProcessInfo.processInfo.environment["WEBYAR_SAMPLE"] == "1" }
    private static var timer: Timer?
    private static var lastCommand = ""

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
        for (i, window) in NSApp.windows.enumerated() where window.isVisible {
            guard let view = window.contentView?.superview ?? window.contentView else { continue }
            let bounds = view.bounds
            guard bounds.width > 10, let rep = view.bitmapImageRepForCachingDisplay(in: bounds) else { continue }
            view.cacheDisplay(in: bounds, to: rep)
            guard let png = rep.representation(using: .png, properties: [:]) else { continue }
            let name = window.identifier?.rawValue.replacingOccurrences(of: "/", with: "_") ?? "window"
            try? png.write(to: folder.appendingPathComponent("\(i)-\(name).png"))
        }
    }

    private static func runCommand(_ folder: URL, _ app: AppModel) {
        let file = folder.appendingPathComponent("command.txt")
        guard let text = try? String(contentsOf: file, encoding: .utf8) else { return }
        let line = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !line.isEmpty, line != lastCommand else { return }
        lastCommand = line
        let parts = line.split(separator: " ").map(String.init)
        let arg = parts.count > 1 ? parts[1] : ""
        switch parts.first {
        case "route":
            switch arg {
            case "contacts": app.route = .contacts
            case "visitors": app.route = .visitors
            case "calls": app.route = .calls
            case "colleagues": app.route = .colleagues
            case "ai": app.route = .inbox(.ai)
            case "pending": app.route = .inbox(.pending)
            case "resolved": app.route = .inbox(.resolved)
            default: app.route = .inbox(.open)
            }
        case "open": app.openConversation(arg)
        case "lang": if let l = Language.parse(arg) { app.setLanguage(l) }
        case "appearance": app.setAppearance(Appearance(rawValue: arg) ?? .system)
        case "settings": NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
        case "details": app.settings.detailsOpen = arg != "off"
        case "ring": app.debugRing()
        case "size":
            let wh = arg.split(separator: "x").compactMap { Double($0) }
            if wh.count == 2, let w = NSApp.windows.first(where: { $0.identifier?.rawValue.hasPrefix("main") == true }) {
                w.setContentSize(NSSize(width: wh[0], height: wh[1]))
            }
        default: break
        }
    }
}
#endif
