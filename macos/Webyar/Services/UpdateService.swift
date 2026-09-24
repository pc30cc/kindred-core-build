import Foundation
import Observation
import os
import Sparkle

/// Self-update through Sparkle, the Mac's standard updater: it reads the
/// appcast, downloads the new build, checks its EdDSA signature and replaces
/// the app. Super Admin → macOS app decides the appcast, and nothing else
/// does: the app carries no address of its own and does not reuse one
/// remembered from an earlier launch, so it looks only where the platform
/// says right now — and until the platform has answered in this launch, it
/// does not look at all. The platform also decides the channel, whether it
/// checks and downloads by itself, how often, and which builds may keep
/// running: one below the minimum, or one withdrawn outright, gets a banner
/// that cannot be closed.
///
/// A build without a public key (a local build from source) has nothing to
/// verify an update against, so updating is off there, as on Windows when
/// the app was not installed through its installer.
@MainActor
@Observable
final class UpdateService: NSObject {
    enum Status { case idle, unavailable }

    @ObservationIgnored private var controller: SPUStandardUpdaterController?
    @ObservationIgnored private var started = false
    /// What Sparkle asks its delegate for, on whatever thread it asks.
    private let feed = OSAllocatedUnfairLock<(url: String?, beta: Bool)>(initialState: (nil, false))

    private(set) var status: Status = .idle
    /// Why this build must update, if it must.
    private(set) var requirement = UpdateSettings.Requirement.none
    /// Where to fetch the build by hand when Sparkle cannot.
    private(set) var downloadUrl: String?

    /// This build is older than the platform's minimum, or withdrawn.
    var required: Bool { requirement != .none }

    var currentVersion: String { AppModel.version }

    var canCheck: Bool { controller?.updater.canCheckForUpdates ?? false }

    override init() {
        super.init()
        let key = (Bundle.main.object(forInfoDictionaryKey: "SUPublicEDKey") as? String)?.trimmingCharacters(in: .whitespaces) ?? ""
        guard !key.isEmpty else {
            status = .unavailable
            return
        }
        // Started once the platform has had its say, so the first check already uses its appcast and channel.
        controller = SPUStandardUpdaterController(startingUpdater: false, updaterDelegate: self, userDriverDelegate: nil)
    }

    /// Applies the platform's settings; safe to call again whenever they are re-read.
    /// `live` is false for the answer remembered from an earlier launch: its
    /// appcast is never used.
    func configure(_ settings: UpdateSettings, live: Bool) {
        requirement = settings.requirement(for: currentVersion)
        downloadUrl = settings.downloadUrl
        if live { feed.withLock { $0 = (settings.appcastUrl, settings.channel == "beta") } }
        guard let controller else { return }
        if !started {
            // The platform has not said where to look in this launch: nothing to start.
            guard live, settings.appcastUrl != nil else { return }
            started = true
            controller.startUpdater()
        }
        let updater = controller.updater
        updater.automaticallyChecksForUpdates = settings.autoCheck || required
        updater.automaticallyDownloadsUpdates = settings.autoDownload
        updater.updateCheckInterval = TimeInterval(settings.checkIntervalMinutes * 60)
        if required { updater.checkForUpdatesInBackground() }
    }

    func checkForUpdates() {
        controller?.checkForUpdates(nil)
    }
}

extension UpdateService: SPUUpdaterDelegate {
    /// The appcast the platform gave in this launch — the only one; the updater is not started without it.
    nonisolated func feedURLString(for updater: SPUUpdater) -> String? {
        feed.withLock { $0.url }
    }

    /// Beta builds are offered only to copies the platform put on the beta channel.
    nonisolated func allowedChannels(for updater: SPUUpdater) -> Set<String> {
        feed.withLock { $0.beta } ? ["beta"] : []
    }
}
