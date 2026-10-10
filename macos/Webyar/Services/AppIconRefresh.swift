import AppKit
import CoreServices

/// Makes the Mac show the app's current icon after a Sparkle update. Sparkle replaces the bundle
/// in place, and the Dock and Finder keep the icon they cached for its path (seen after WebYar's
/// new brand kit, 2026-10-10) until Launch Services re-reads the bundle. On the first launch of
/// each build: the bundle's date is moved on and it is registered again, and the running app's
/// Dock tile takes the icon from the bundle itself. Both brands.
enum AppIconRefresh {
    private static let key = "iconRefreshedForBuild"

    @MainActor
    static func afterUpdate() {
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""
        let defaults = UserDefaults.standard
        guard !build.isEmpty, defaults.string(forKey: key) != build else { return }
        let url = Bundle.main.bundleURL
        try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: url.path)
        _ = LSRegisterURL(url as CFURL, true)
        NSWorkspace.shared.noteFileSystemChanged(url.path)
        if let icon = NSImage(named: NSImage.applicationIconName) {
            NSApp.applicationIconImage = icon
        }
        defaults.set(build, forKey: key)
    }
}
