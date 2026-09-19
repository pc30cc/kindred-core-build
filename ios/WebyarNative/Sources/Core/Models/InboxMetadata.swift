import Foundation

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
    /// The same profiles keyed by contact, for surfaces that have a contact
    /// and no conversation — the Contacts list and a contact's own page.
    let byContact: [String: VisitorProfile]?

    enum CodingKeys: String, CodingKey {
        case byConversation = "by_conversation"
        case byContact = "by_contact"
    }
}
