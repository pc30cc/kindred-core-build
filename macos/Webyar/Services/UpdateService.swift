import Foundation
import Observation
import Sparkle

/// Self-update through Sparkle, the Mac's standard updater: it reads the
/// appcast (SUFeedURL in Info.plist), downloads the new build, checks its
/// EdDSA signature and replaces the app. Super Admin → Desktop app decides
/// whether it checks by itself, how often, and the oldest build still
/// supported — below that the shell shows a banner that cannot be closed.
///
/// A build without a public key (a local build from source) has nothing to
/// verify an update against, so updating is off there, as on Windows when
/// the app was not installed through its installer.
@MainActor
@Observable
final class UpdateService: NSObject {
    enum Status { case idle, unavailable }

    @ObservationIgnored private var controller: SPUStandardUpdaterController?

    private(set) var status: Status = .idle
    /// This build is older than the platform's minimum supported version.
    private(set) var required = false

    var currentVersion: String { AppModel.version }

    var canCheck: Bool { controller?.updater.canCheckForUpdates ?? false }

    override init() {
        super.init()
        let key = (Bundle.main.object(forInfoDictionaryKey: "SUPublicEDKey") as? String)?.trimmingCharacters(in: .whitespaces) ?? ""
        let feed = (Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") as? String) ?? ""
        guard !key.isEmpty, !feed.isEmpty else {
            status = .unavailable
            return
        }
        controller = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)
    }

    /// Applies the platform's settings; safe to call again whenever they are re-read.
    func configure(_ settings: UpdateSettings) {
        required = settings.isBelowMinimum(currentVersion)
        guard let updater = controller?.updater else { return }
        updater.automaticallyChecksForUpdates = settings.autoUpdate || required
        updater.automaticallyDownloadsUpdates = settings.autoUpdate
        updater.updateCheckInterval = TimeInterval(settings.checkIntervalMinutes * 60)
        if required { updater.checkForUpdatesInBackground() }
    }

    func checkForUpdates() {
        controller?.checkForUpdates(nil)
    }
}
