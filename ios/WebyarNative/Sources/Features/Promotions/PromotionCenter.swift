import SwiftUI
import Observation

/// Decides whether a promotion may be shown, and remembers that it was.
///
/// Three things have to agree before a full-screen promotion appears:
///
///   * the plan grants it (`mobile_promo_fullscreen`),
///   * the platform has one written and switched on,
///   * and the pacing allows it — not during the first launches, not twice
///     inside the interval, not more than the daily cap.
///
/// The counters are per device and live in `UserDefaults`. Nothing about who
/// saw what leaves the phone: there is no impression endpoint, and adding one
/// would turn a first-party promotion into tracking, with everything that
/// implies for the privacy manifest and App Tracking Transparency.
@MainActor
@Observable
final class PromotionCenter {
    private(set) var promotions: Promotions = .none
    /// Set when a full-screen promotion is on screen.
    var fullscreen: PromoCreative?
    /// Cleared for the rest of the session once the operator dismisses the
    /// banner, so closing it means something.
    private(set) var bannerDismissed = false

    private let api: any WebyarAPI
    private let defaults: UserDefaults

    private static let launchCountKey = "promo.launches"
    private static let lastShownKey = "promo.lastShownAt"
    private static let dayKey = "promo.day"
    private static let dayCountKey = "promo.dayCount"

    init(api: any WebyarAPI = Backend.current, defaults: UserDefaults = .standard) {
        self.api = api
        self.defaults = defaults
    }

    /// Counted once per launch, before anything is shown, so "skip the first
    /// two launches" means the first two and not the first two that asked.
    ///
    /// Static because the app counts launches, not this object: the shell
    /// rebuilds its `PromotionCenter` whenever the language changes, and a
    /// counter that reset with it would let a promotion in on a first run.
    static func noteLaunch(defaults: UserDefaults = .standard) {
        defaults.set(defaults.integer(forKey: launchCountKey) + 1, forKey: launchCountKey)
    }

    func load(workspaceID: String?, language: Language) async {
        guard let workspaceID else { return }
        promotions = (try? await api.promotions(
            workspaceID: workspaceID, locale: language.rawValue
        )) ?? .none
    }

    /// The banner, when the plan grants it and it has not been dismissed.
    func banner(for appState: AppState) -> PromoCreative? {
        guard promotions.enabled, !bannerDismissed,
              appState.featureEnabled("mobile_promo_banner")
        else { return nil }
        return promotions.banner
    }

    func dismissBanner() {
        bannerDismissed = true
    }

    /// Offers the full-screen promotion if everything lines up. Called when
    /// the inbox appears, never from a chat, a call or a compose field: a
    /// promotion that interrupts work is the kind Apple rejects and operators
    /// remember.
    func offerFullScreen(for appState: AppState) {
        guard fullscreen == nil,
              promotions.enabled,
              appState.featureEnabled("mobile_promo_fullscreen"),
              let creative = promotions.fullscreen,
              isPaceClear(for: appState)
        else { return }

        fullscreen = creative
        recordShown()
    }

    func dismissFullScreen() {
        fullscreen = nil
    }

    // MARK: - Pacing

    private func isPaceClear(for appState: AppState) -> Bool {
        let launches = defaults.integer(forKey: Self.launchCountKey)
        if launches <= (promotions.startAfterLaunches ?? 2) { return false }

        // The plan may ask for a longer gap than the platform's, never a
        // shorter one — a paid plan that still carries promotions should be
        // able to make them rarer.
        let platformMinutes = promotions.minIntervalMinutes ?? 360
        let planMinutes = appState.entitlements.value?.limit("mobile_promo_interval_minutes") ?? 0
        let minutes = max(platformMinutes, planMinutes)
        if let last = defaults.object(forKey: Self.lastShownKey) as? Date,
           Date().timeIntervalSince(last) < Double(minutes) * 60 {
            return false
        }

        let cap = promotions.maxPerDay ?? 3
        if cap <= 0 { return false }
        return todayCount() < cap
    }

    private func recordShown() {
        defaults.set(Date(), forKey: Self.lastShownKey)
        defaults.set(today(), forKey: Self.dayKey)
        defaults.set(todayCount() + 1, forKey: Self.dayCountKey)
    }

    private func todayCount() -> Int {
        guard defaults.string(forKey: Self.dayKey) == today() else { return 0 }
        return defaults.integer(forKey: Self.dayCountKey)
    }

    /// The device's own day, not the server's. A cap of three a day should
    /// mean the operator's day.
    private func today() -> String {
        let components = Calendar.current.dateComponents([.year, .month, .day], from: Date())
        return "\(components.year ?? 0)-\(components.month ?? 0)-\(components.day ?? 0)"
    }
}
