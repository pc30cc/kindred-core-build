import Foundation

/// The numbers across the top of the Call Center.
///
/// `GET /api/call-center/overview`.
struct CallOverview: Codable, Sendable {
    let todayCalls: Int?
    let waitingCalls: Int?
    let activeCalls: Int?
    let missedToday: Int?
    let callbacksPending: Int?

    enum CodingKeys: String, CodingKey {
        case todayCalls = "today_calls"
        case waitingCalls = "waiting_calls"
        case activeCalls = "active_calls"
        case missedToday = "missed_today"
        case callbacksPending = "callbacks_pending"
    }
}

/// Someone waiting to be answered.
struct QueueEntry: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let channel: String?
    let status: String?
    let contactName: String?
    let contactEmail: String?
    let visitorCode: String?
    let createdAt: Date?
    let waitingSince: Date?

    enum CodingKeys: String, CodingKey {
        case id, channel, status
        case contactName = "contact_name"
        case contactEmail = "contact_email"
        case visitorCode = "visitor_code"
        case createdAt = "created_at"
        case waitingSince = "waiting_since"
    }

    /// How long they have been waiting, which is the only number that matters
    /// on a queue screen.
    func waitedSeconds(now: Date = Date()) -> Int? {
        guard let since = waitingSince ?? createdAt else { return nil }
        return max(0, Int(now.timeIntervalSince(since)))
    }
}

/// A call that has already happened.
struct CallRecord: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let status: String?
    let direction: String?
    let kind: String?
    let contactName: String?
    let visitorCode: String?
    let startedAt: Date?
    let endedAt: Date?
    let durationSeconds: Int?

    enum CodingKeys: String, CodingKey {
        case id, status, direction, kind
        case contactName = "contact_name"
        case visitorCode = "visitor_code"
        case startedAt = "started_at"
        case endedAt = "ended_at"
        case durationSeconds = "duration_seconds"
    }

    /// Prefers the server's own duration; falls back to the timestamps so a
    /// row is never blank just because one field is missing.
    var duration: Int? {
        if let durationSeconds { return durationSeconds }
        guard let startedAt, let endedAt else { return nil }
        return max(0, Int(endedAt.timeIntervalSince(startedAt)))
    }

    /// Whether this call was answered — the distinction a history list is read
    /// for.
    var wasMissed: Bool {
        guard let status = status?.lowercased() else { return false }
        return status.contains("missed") || status.contains("no_answer") || status.contains("rejected")
    }
}

struct CallOverviewResponse: Decodable, Sendable {
    let todayCalls: Int?
    let waitingCalls: Int?
    let activeCalls: Int?
    let missedToday: Int?
    let callbacksPending: Int?

    enum CodingKeys: String, CodingKey {
        case todayCalls = "today_calls"
        case waitingCalls = "waiting_calls"
        case activeCalls = "active_calls"
        case missedToday = "missed_today"
        case callbacksPending = "callbacks_pending"
    }

    var overview: CallOverview {
        CallOverview(
            todayCalls: todayCalls,
            waitingCalls: waitingCalls,
            activeCalls: activeCalls,
            missedToday: missedToday,
            callbacksPending: callbacksPending
        )
    }
}

struct QueueResponse: Decodable, Sendable {
    let queue: [QueueEntry]
}

struct CallsResponse: Decodable, Sendable {
    let calls: [CallRecord]
}

/// The counters behind each inbox filter. `GET /api/conversations/inbox-tab-counts`.
struct InboxCounts: Codable, Sendable {
    let open: Int?
    let pending: Int?
    let resolved: Int?
    let all: Int?
    let needsHuman: Int?
    let automated: Int?

    enum CodingKeys: String, CodingKey {
        case open, pending, resolved, all
        case needsHuman = "needs_human"
        case automated
    }

    func count(for filter: InboxFilter) -> Int? {
        switch filter {
        case .open: open
        case .ai: automated
        case .needsHuman: needsHuman
        case .resolved: resolved
        }
    }
}

// MARK: - Visitor intelligence

/// What the widget captured about a visitor's device and where they are.
///
/// `POST /api/visitor-intel/network/batch`. The server applies the IP privacy
/// and entitlement policy, so the app never decides what it is allowed to see.
struct VisitorProfile: Decodable, Sendable {
    struct Geo: Decodable, Sendable {
        let countryCode: String?
        let country: String?
        let city: String?

        enum CodingKeys: String, CodingKey {
            case countryCode = "country_code"
            case country, city
        }
    }

    struct Device: Decodable, Sendable {
        let browser: String?
        let os: String?
        let device: String?
    }

    let geo: Geo?
    let device: Device?
}

struct VisitorIntelResponse: Decodable, Sendable {
    let byConversation: [String: VisitorProfile]?

    enum CodingKeys: String, CodingKey {
        case byConversation = "by_conversation"
    }
}
