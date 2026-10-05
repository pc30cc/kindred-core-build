import Foundation

// What the app may show as a promotion, already resolved for one language by
// `GET /api/mobile-app/promotions`.
//
// Nothing here is an advert in the App Store sense: the words and the picture
// come from the platform's own settings, no third-party SDK is involved, and
// no identifier or impression ever leaves the device. That is deliberate and
// it is what keeps the feature clear of App Tracking Transparency rather than
// relying on a prompt.

struct PromoCreative: Decodable, Hashable, Sendable {
    let title: String
    let body: String
    /// Absent when the server has stripped an unreviewed external link — the
    /// promotion still says its piece, it just has no button.
    let ctaLabel: String?
    let ctaURL: String?
    let imageURL: String?

    var link: URL? {
        guard let ctaURL, let url = URL(string: ctaURL), url.scheme?.lowercased() == "https"
        else { return nil }
        return url
    }
}

struct Promotions: Decodable, Sendable {
    let enabled: Bool
    let banner: PromoCreative?
    let fullscreen: PromoCreative?
    let minIntervalMinutes: Int?
    let maxPerDay: Int?
    let startAfterLaunches: Int?

    static let none = Promotions(
        enabled: false, banner: nil, fullscreen: nil,
        minIntervalMinutes: nil, maxPerDay: nil, startAfterLaunches: nil
    )
}
