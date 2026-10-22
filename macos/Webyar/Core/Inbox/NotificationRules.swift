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

/// Which colleagues have written since the last look — the team-chat counterpart of
/// NotificationRules.fresh: their newest message is theirs (not mine), newer than before,
/// and still unread. The first call only sets the baseline.
struct TeamNotificationRules {
    private var seen: [String: Date]?

    mutating func fresh(_ colleagues: [Colleague]) -> [Colleague] {
        guard var seen else {
            seen = Dictionary(colleagues.map { ($0.userId, Self.stamp($0)) }, uniquingKeysWith: { a, _ in a })
            return []
        }
        let fresh = colleagues.filter { c in
            Self.stamp(c) > (seen[c.userId] ?? .distantPast)
                && c.lastMessage?.outgoing != true
                && (c.unread ?? 0) > 0
        }
        for c in colleagues { seen[c.userId] = Self.stamp(c) }
        self.seen = seen
        return fresh
    }

    mutating func reset() { seen = nil }

    private static func stamp(_ c: Colleague) -> Date { c.lastMessage?.createdAt ?? .distantPast }
}

/// A system notice rebuilt in the operator's language from its metadata, since
/// the stored body is an English sentence frozen when it was written.
enum SystemText {
    static func of(_ meta: JSONValue?, _ s: Strings) -> String? {
        guard let meta, meta.object != nil else { return nil }
        func str(_ key: String) -> String { meta[key]?.string?.trimmingCharacters(in: .whitespaces) ?? "" }
        // A person's name, or "" for none: the English stand-ins once stored
        // as a name ('a colleague') read as the generic sentence instead.
        func person(_ key: String) -> String {
            let name = str(key)
            return placeholderNames.contains(name.lowercased()) ? "" : name
        }
        switch str("kind") {
        case "conversation_transferred":
            let actor = person("actor_name"), to = person("to_name")
            if to.isEmpty { return s["sysTransferredGeneric"] }
            return actor.isEmpty ? s.get("sysTransferredTo", "to", to) : s.get("sysTransferred", ["actor": actor, "to": to])
        case "conversation_unassigned":
            let actor = person("actor_name")
            return actor.isEmpty ? s["sysUnassignedGeneric"] : s.get("sysUnassigned", "actor", actor)
        case "routing_agent_joined":
            let agent = person("agent_name")
            return agent.isEmpty ? s["sysAgentJoinedGeneric"] : s.get("sysAgentJoined", "name", agent)
        case "conversation_closed":
            // The visitor-visible line an operator's close writes.
            let agent = person("agent_name")
            return agent.isEmpty ? s["sysClosed"] : s.get("sysClosedBy", "name", agent)
        case "routing_no_agent_available":
            return s["sysNoAgentAvailable"]
        case "routing_in_queue":
            // Everyone at capacity (auto routing), or the manual queue.
            return str("reason") == "all_busy" ? s["sysInQueueAllBusy"] : s["sysInQueue"]
        case "platform_support_requester":
            // The "who is asking" card as one line.
            let raw = meta["user"]?["name"]?.string?.trimmingCharacters(in: .whitespaces) ?? ""
            let name = placeholderNames.contains(raw.lowercased()) ? "" : raw
            return name.isEmpty ? s["requesterTitle"] : "\(s["requesterTitle"]) · \(name)"
        case "support_rating":
            // Without a whole score from 1 to 5 there is nothing to say; the stored body is better.
            guard let score = meta["score"]?.int, (1...5).contains(score) else { return nil }
            let rated = s.get("sysSupportRating", "score", String(score))
            let comment = str("comment")
            return comment.isEmpty ? rated : s.get("sysSupportRatingComment", ["rating": rated, "comment": comment])
        case "call_invitation":
            let video = str("channel") == "video"
            let op = person("operator_name")
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

    /// English stand-ins once stored as a name (chatRouting's 'a colleague',
    /// the inbox PATCH's 'An operator') — shared/systemMessages.ts.
    private static let placeholderNames: Set<String> = ["a colleague", "an operator"]

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
