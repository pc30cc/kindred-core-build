import Foundation

/// Which conversations deserve a notification — the rules the web console and
/// the Windows app apply, over the operator's own notification preferences
/// (the same row the web console edits).
struct NotificationRules {
    private var seen: [String: Date]?

    /// Conversations whose newest message is a visitor's, is newer than when we
    /// last looked, and is still unread. The first call only sets the baseline:
    /// nothing already there when the app opens is "new".
    mutating func fresh(_ conversations: [Conversation]) -> [Conversation] {
        guard var seen else {
            seen = Dictionary(conversations.map { ($0.id, Self.stamp($0)) }, uniquingKeysWith: { a, _ in a })
            return []
        }
        let fresh = conversations.filter { c in
            Self.stamp(c) > (seen[c.id] ?? .distantPast)
                && c.lastMessage?.senderType == SenderType.contact
                && (c.unreadCount ?? 1) > 0
        }
        for c in conversations { seen[c.id] = Self.stamp(c) }
        self.seen = seen
        return fresh
    }

    /// Forget the baseline, e.g. after switching workspace.
    mutating func reset() { seen = nil }

    private static func stamp(_ c: Conversation) -> Date { c.lastMessage?.createdAt ?? .distantPast }

    static func allowed(_ prefs: NotificationPrefs, now: Date = Date()) -> Bool {
        !prefs.disableAll && prefs.pushScope != "none" && !inQuietHours(prefs, now: now)
    }

    /// "Assigned" and "mentions" both mean: not every thread in the workspace.
    static func inScope(_ prefs: NotificationPrefs, _ c: Conversation, me: String?) -> Bool {
        prefs.pushScope == "all" || (me != nil && c.assignedTo == me)
    }

    static func inQuietHours(_ p: NotificationPrefs, now: Date) -> Bool {
        guard p.quietHoursEnabled, let start = minutes(p.quietHoursStart), let end = minutes(p.quietHoursEnd) else { return false }
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = p.quietHoursTimezone.flatMap(TimeZone.init(identifier:)) ?? .current
        let c = cal.dateComponents([.hour, .minute], from: now)
        let m = (c.hour ?? 0) * 60 + (c.minute ?? 0)
        return start <= end ? (m >= start && m < end) : (m >= start || m < end)
    }

    private static func minutes(_ hhmm: String?) -> Int? {
        guard let parts = hhmm?.split(separator: ":"), parts.count >= 2, let h = Int(parts[0]), let m = Int(parts[1]) else { return nil }
        return h * 60 + m
    }
}

/// A system notice rebuilt in the operator's language from its metadata, since
/// the stored body is an English sentence frozen when it was written.
enum SystemText {
    static func of(_ meta: JSONValue?, _ s: Strings) -> String? {
        guard let meta, meta.object != nil else { return nil }
        func str(_ key: String) -> String { meta[key]?.string?.trimmingCharacters(in: .whitespaces) ?? "" }
        switch str("kind") {
        case "conversation_transferred":
            return s.get("sysTransferred", ["actor": str("actor_name"), "to": str("to_name")])
        case "conversation_unassigned":
            return s.get("sysUnassigned", "actor", str("actor_name"))
        case "routing_agent_joined":
            let agent = str("agent_name")
            return agent.isEmpty ? s["sysAgentJoinedGeneric"] : s.get("sysAgentJoined", "name", agent)
        case "routing_no_agent_available":
            return s["sysNoAgentAvailable"]
        case "routing_in_queue":
            return s["sysInQueue"]
        case "call_invitation":
            let video = str("channel") == "video"
            let op = str("operator_name")
            let text = op.isEmpty ? s[video ? "sysCallInviteVideo" : "sysCallInviteAudio"]
                : s.get(video ? "sysCallInviteVideoFrom" : "sysCallInviteAudioFrom", "op", op)
            let status = str("status")
            return "\(text) · \(invitationStatus(status.isEmpty ? "pending" : status, s))"
        case "call_ended":
            let seconds = meta["duration_seconds"]?.int ?? 0
            if str("end_reason") == "failed" || seconds <= 0 { return s["callEndedNotConnected"] }
            let by = str("ended_by")
            let key = by == "operator" ? "callEndedByOperator" : by == "visitor" ? "callEndedByVisitor" : "callEndedBySystem"
            return s.get(key, "duration", Display.duration(seconds, s.language))
        default:
            return nil
        }
    }

    static func invitationStatus(_ status: String, _ s: Strings) -> String {
        switch status {
        case "joined": return s["inviteStatusJoined"]
        case "expired": return s["inviteStatusExpired"]
        case "cancelled": return s["inviteStatusCancelled"]
        case "declined": return s["inviteStatusDeclined"]
        default: return s["inviteStatusPending"]
        }
    }
}
