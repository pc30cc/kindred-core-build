import AppKit
import ServiceManagement
import SwiftUI

@main
struct WebyarApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        let app = delegate.app
        Window(app.strings["appName"], id: "main") {
            RootView()
                .environment(app)
                .appEnvironment(app)
        }
        .defaultSize(width: 1440, height: 900)
        .windowToolbarStyle(.unified(showsTitle: false))
        .commands { AppCommands(app: app) }

        Settings {
            SettingsView()
                .environment(app)
                .appEnvironment(app)
        }

        MenuBarExtra(isInserted: Binding(get: { app.showsMenuBarItem && app.phase == .signedIn }, set: { _ in })) {
            MenuBarContent()
                .environment(app)
        } label: {
            MenuBarLabel(app: app)
        }
        .menuBarExtraStyle(.menu)
    }
}

extension View {
    /// Language, direction and appearance for every window.
    func appEnvironment(_ app: AppModel) -> some View {
        environment(\.layoutDirection, app.strings.isRightToLeft ? .rightToLeft : .leftToRight)
            .environment(\.locale, app.strings.language.locale)
            .font(Typeface.font(13))
            .tint(Palette.brand)
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let app: AppModel

    override init() {
        // The columns start at their designed widths each launch: a width
        // AppKit saved from an earlier layout (another language, another
        // window size) would otherwise win over them.
        AppModel.forgetSplitFrames()
        Typeface.register()
        app = AppModel()
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        app.applyAppearance()
        // Opened at login: stay in the menu bar until the operator asks for the window.
        if LoginItem.launchedAtLogin && app.config.system.menuBarExtra {
            NSApp.windows.forEach { $0.orderOut(nil) }
        }
        #if DEBUG
        DebugTools.start(app: app)
        #endif
        Task { await app.start() }
    }

    /// Without a menu bar item to live in, closing the window quits.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        !app.closesToMenuBar
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        app.setForeground(true)
        Task { await app.refreshNotificationPermission() }
    }

    func applicationDidResignActive(_ notification: Notification) {
        app.setForeground(false)
    }

    func applicationWillTerminate(_ notification: Notification) {
        app.engagement.stop()
        CallCoordinator.shared.hangUpForQuit()
    }
}

/// "Open at login", through the Mac's own login items.
enum LoginItem {
    static var isEnabled: Bool { SMAppService.mainApp.status == .enabled }

    static func set(_ on: Bool) {
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
        } catch {
            Log.error("login item", error)
        }
    }

    /// True when macOS started the app as a login item.
    static var launchedAtLogin: Bool {
        guard let event = NSAppleEventManager.shared().currentAppleEvent else { return false }
        return event.eventID == kAEOpenApplication
            && event.paramDescriptor(forKeyword: keyAEPropData)?.enumCodeValue == keyAELaunchedAsLogInItem
    }
}

/// The menus: Webyar's own items in the app menu, the sections in View, the
/// conversation shortcuts, and the platform's help links in Help.
struct AppCommands: Commands {
    let app: AppModel
    @Environment(\.openWindow) private var openWindow

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button(app.strings["menuOpenInbox"]) {
                openWindow(id: "main")
                app.route = .inbox(.open)
            }
            .keyboardShortcut("0", modifiers: .command)
        }
        CommandGroup(after: .appInfo) {
            if app.updates.status != .unavailable {
                Button(app.strings["checkForUpdates"] + "…") { app.updates.checkForUpdates() }
            }
        }
        CommandMenu(app.strings["tabInbox"]) {
            Button(app.strings["navInboxOpen"]) { app.route = .inbox(.open) }.keyboardShortcut("1", modifiers: .command)
            Button(app.strings["navInboxPending"]) { app.route = .inbox(.pending) }.keyboardShortcut("2", modifiers: .command)
            Button(app.strings["navInboxResolved"]) { app.route = .inbox(.resolved) }.keyboardShortcut("3", modifiers: .command)
            Divider()
            Button(app.strings["tabContacts"]) { app.route = .contacts }.keyboardShortcut("4", modifiers: .command).disabled(!app.plan.contacts)
            Button(app.strings["navVisitors"]) { app.route = .visitors }.keyboardShortcut("5", modifiers: .command).disabled(!app.plan.visitors)
            Button(app.strings["navCallCenter"]) { app.route = .calls }.keyboardShortcut("6", modifiers: .command).disabled(!app.plan.callCenter)
            Button(app.strings["navColleagues"]) { app.route = .colleagues }.keyboardShortcut("7", modifiers: .command).disabled(!app.plan.teamChat)
            Button(app.strings["emailInbox"]) { app.route = .email }.keyboardShortcut("8", modifiers: .command).disabled(!app.plan.emailInbox)
        }
        // A help book Webyar does not have would only say "Help isn't available".
        CommandGroup(replacing: .help) {
            HelpLinks(links: app.config.links, strings: app.strings)
        }
    }
}

/// Super Admin's help links, each only when it is set: the Help menu and Settings → General.
struct HelpLinks: View {
    let links: MacAppConfig.Links
    let strings: Strings

    var body: some View {
        ForEach(Self.items(links, strings), id: \.title) { item in
            Button(item.title) { NSWorkspace.shared.openHttps(item.url) }
        }
    }

    struct Item {
        let title: String
        let url: String
        let systemImage: String
    }

    static func items(_ links: MacAppConfig.Links, _ s: Strings) -> [Item] {
        [(links.support, s["helpSupport"], "questionmark.bubble"),
         (links.status, s["helpStatus"], "waveform.path.ecg"),
         (links.privacy, s["helpPrivacy"], "hand.raised"),
         (links.terms, s["helpTerms"], "doc.text")]
            .compactMap { url, title, image in url.map { Item(title: title, url: $0, systemImage: image) } }
    }
}
