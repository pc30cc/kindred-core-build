import Foundation

// Whether visitors can see this operator. Mirrors `/api/availability` and
// `src/lib/availability-api.ts`.
//
// Three switches decide it, and they are not independent: invisible mode wins
// over everything, and the other two are what turn presence on. The app sends
// each change on its own and takes the server's recomputed status back, rather
// than working the rule out a second time here — one place deciding who is
// online is the whole point.

struct AvailabilityPrefs: Codable, Hashable, Sendable {
    var forceOffline: Bool
    var availableWhenUsingApp: Bool
    var scheduleEnabled: Bool
    var timezone: String?

    enum CodingKeys: String, CodingKey {
        case forceOffline = "force_offline"
        case availableWhenUsingApp = "available_when_using_app"
        case scheduleEnabled = "schedule_enabled"
        case timezone
    }
}

struct AvailabilityStatus: Decodable, Hashable, Sendable {
    /// `online` or `offline`, as the server computes it.
    let state: String?
    /// Why — a key the server uses for its own copy. Not shown.
    let reason: String?

    var isOnline: Bool { state == "online" }
}

struct AvailabilityResponse: Decodable, Sendable {
    let prefs: AvailabilityPrefs
    let status: AvailabilityStatus
}

/// The one field of a PATCH. Sent alone so a toggle can never carry a stale
/// copy of the other two back to the server.
struct AvailabilityUpdate: Encodable, Sendable {
    var force_offline: Bool?
    var available_when_using_app: Bool?
    var schedule_enabled: Bool?
}
