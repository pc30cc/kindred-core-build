import Foundation

/// Who is asking — the card the server writes at the top of every new
/// platform-support conversation, for the support team alone
/// (docs/PLATFORM_SUPPORT.md, "Who is asking"): the person, the workspaces
/// they belong to, each one's plan — when it was bought and when it runs out
/// — and what it has used this month.
///
/// Read from the message's `metadata` (`kind: platform_support_requester`),
/// the same snapshot the web, Android and Windows apps draw; its `body` is the
/// plain-English fallback for a client that does not know the kind. A
/// snapshot as of the person's first message, not a live view.
struct RequesterCard: Equatable, Sendable {
    static let kind = "platform_support_requester"

    /// A used amount against its limit: `limit` nil when the plan sets none,
    /// negative when it is unlimited.
    struct Metered: Equatable, Sendable {
        let used: Double
        let limit: Double?

        var isUnlimited: Bool { (limit ?? 0) < 0 }

        /// How full, from 0 to 1 — only against a real limit.
        var fraction: Double? {
            guard let limit, limit > 0 else { return nil }
            return min(max(used / limit, 0), 1)
        }
    }

    struct Plan: Equatable, Sendable {
        let name: String
        /// The plan's names by language, as Super Admin wrote them.
        let names: [String: String]
        let status: String?
        let isFree: Bool
        /// When the period being paid for began: the plan bought or renewed.
        let periodStart: Date?
        /// When it ends: the plan's expiry, or its renewal.
        let periodEnd: Date?
        let trialEnd: Date?
        let cancelAtPeriodEnd: Bool
        /// `monthly`, `yearly`…
        let billingInterval: String?
        /// When the workspace first subscribed.
        let startedAt: Date?

        func title(_ language: Language) -> String {
            names[language.rawValue].flatMap { $0.isEmpty ? nil : $0 } ?? name
        }

        var isTrial: Bool { status == "trialing" }

        /// When the plan as it stands runs out: the trial's end while on
        /// trial, otherwise the paid period's.
        var endsAt: Date? { isTrial ? (trialEnd ?? periodEnd) : periodEnd }

        /// Whole days from `now` until it runs out — negative once it has.
        func daysLeft(now: Date = Date()) -> Int? {
            guard let end = endsAt else { return nil }
            let days = end.timeIntervalSince(now) / 86_400
            // A part of a day still to go is a day left; one gone by counts
            // whole days only, and never less than one.
            return days >= 0 ? Int(days.rounded(.up)) : -max(1, Int((-days).rounded(.down)))
        }

        /// How much of the period is behind it, from 0 to 1.
        func elapsed(now: Date = Date()) -> Double? {
            guard let start = periodStart, let end = endsAt, end > start else { return nil }
            return min(max(now.timeIntervalSince(start) / end.timeIntervalSince(start), 0), 1)
        }
    }

    struct Workspace: Equatable, Sendable, Identifiable {
        let id: String
        let name: String
        let role: String?
        let plan: Plan?
        let operators: Metered
        let contacts: Metered
        let conversations: Metered
        let visitors: Metered
        let aiCredits: Metered
        let messages: Double
        let storageBytes: Double
        let storageLimitGB: Double?

        /// Storage as a metered amount, in bytes.
        var storage: Metered {
            Metered(used: storageBytes, limit: storageLimitGB.map { $0 < 0 ? -1 : $0 * 1_073_741_824 })
        }
    }

    let name: String?
    let email: String?
    let phone: String?
    let company: String?
    let website: String?
    let memberSince: Date?
    /// "Android", "iOS", "macOS", "Windows", "Web" — the app the person wrote from.
    let clientPlatform: String?
    /// The workspace they wrote from, when the app said.
    let sourceWorkspace: String?
    /// Every workspace they belong to; `workspaces` holds the first few.
    let workspaceCount: Int
    let workspaces: [Workspace]
    let capturedAt: Date?

    /// The card in `metadata`, or nil when this is some other message.
    static func parse(_ metadata: [String: JSONValue]?) -> RequesterCard? {
        guard let metadata, metadata["kind"]?.stringValue == kind else { return nil }
        let user = metadata["user"]
        let workspaces = (metadata["workspaces"]?.arrayValue ?? []).compactMap(workspace)
        return RequesterCard(
            name: text(user?["name"]),
            email: text(user?["email"]),
            phone: text(user?["phone"]),
            company: text(user?["company"]),
            website: text(user?["website"]),
            memberSince: date(user?["member_since"]),
            clientPlatform: platformName(text(user?["client_platform"])),
            sourceWorkspace: text(user?["source_workspace"]),
            workspaceCount: max(metadata["workspace_count"]?.intValue ?? workspaces.count, workspaces.count),
            workspaces: workspaces,
            capturedAt: date(metadata["captured_at"])
        )
    }

    private static func workspace(_ value: JSONValue) -> Workspace? {
        guard value.objectValue != nil else { return nil }
        let usage = value["usage"]
        guard let id = text(value["id"]) ?? text(value["name"]) else { return nil }
        return Workspace(
            id: id,
            name: text(value["name"]) ?? id,
            role: text(value["role"]),
            plan: plan(value["plan"]),
            operators: metered(value["operators"]),
            contacts: metered(value["contacts"]),
            conversations: metered(usage?["conversations"]),
            visitors: metered(usage?["visitors"]),
            aiCredits: metered(usage?["ai_credits"]),
            messages: usage?["messages"]?.doubleValue ?? 0,
            storageBytes: usage?["storage_bytes"]?.doubleValue ?? 0,
            storageLimitGB: usage?["storage_limit_gb"]?.doubleValue
        )
    }

    private static func plan(_ value: JSONValue?) -> Plan? {
        guard let value, value.objectValue != nil else { return nil }
        var names: [String: String] = [:]
        for (language, name) in value["names"]?.objectValue ?? [:] {
            if let name = text(name) { names[language] = name }
        }
        return Plan(
            name: text(value["name"]) ?? text(value["slug"]) ?? "",
            names: names,
            status: text(value["status"]),
            isFree: value["is_free"]?.boolValue == true,
            periodStart: date(value["period_start"]),
            periodEnd: date(value["period_end"]),
            trialEnd: date(value["trial_end"]),
            cancelAtPeriodEnd: value["cancel_at_period_end"]?.boolValue == true,
            billingInterval: text(value["billing_interval"]),
            startedAt: date(value["started_at"])
        )
    }

    private static func metered(_ value: JSONValue?) -> Metered {
        Metered(used: value?["used"]?.doubleValue ?? 0, limit: value?["limit"]?.doubleValue)
    }

    private static func text(_ value: JSONValue?) -> String? {
        guard let raw = value?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return nil }
        return raw
    }

    private static func date(_ value: JSONValue?) -> Date? {
        text(value).flatMap(DateParsing.parse)
    }

    static func platformName(_ raw: String?) -> String? {
        switch raw?.lowercased() {
        case "android": "Android"
        case "ios": "iOS"
        case "macos": "macOS"
        case "windows": "Windows"
        case "web": "Web"
        default: nil
        }
    }
}
