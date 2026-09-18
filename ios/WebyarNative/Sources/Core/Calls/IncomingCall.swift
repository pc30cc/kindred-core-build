import Foundation

/// What a VoIP push is telling the phone to do.
enum CallPushEvent: String, Sendable {
    /// Somebody is calling. Ring.
    case incoming
    /// Stop ringing: answered elsewhere, declined, or the visitor gave up.
    case cancel
}

/// Why a ring stopped, so the phone can say something truthful about it.
enum CallEndReason: String, Sendable {
    case answered, declined, ended, cancelled, timeout

    /// What CallKit should record in the system call log.
    var isMissed: Bool {
        switch self {
        case .cancelled, .timeout: true
        case .answered, .declined, .ended: false
        }
    }
}

/// A visitor calling, as the VoIP push describes them.
///
/// Parsed by hand from the push dictionary rather than through `Codable`,
/// because this runs in the few hundred milliseconds iOS gives the app between
/// waking it and requiring a call on screen — and because a payload the server
/// changes must degrade to a ring with a plainer name, never to a crash or to
/// no ring at all. Every field except the call id has a fallback.
struct IncomingCall: Identifiable, Hashable, Sendable {
    /// The `call_sessions.id`, which is already a UUID — so CallKit's own
    /// identifier is the call's identifier, and a ring and its cancellation
    /// can never disagree about which call they mean.
    let id: UUID
    let callID: String
    let workspaceID: String
    let workspaceName: String?
    let caller: String
    let channel: CallChannel
    let avatarURL: String?
    let expiresAt: Date?

    var hasVideo: Bool { channel == .video }

    init?(push: [AnyHashable: Any]) {
        guard let callID = push["call_id"] as? String,
              let uuid = UUID(uuidString: callID),
              let workspaceID = push["workspace_id"] as? String
        else { return nil }

        self.id = uuid
        self.callID = callID
        self.workspaceID = workspaceID
        self.workspaceName = (push["workspace_name"] as? String)?.nonEmpty
        self.caller = (push["caller"] as? String)?.nonEmpty ?? IncomingCall.unknownCaller
        self.channel = CallChannel(rawValue: (push["channel"] as? String) ?? "") ?? .audio
        self.avatarURL = (push["avatar_url"] as? String)?.nonEmpty
        if let expires = push["expires_at"] as? Double {
            self.expiresAt = Date(timeIntervalSince1970: expires)
        } else if let expires = push["expires_at"] as? Int {
            self.expiresAt = Date(timeIntervalSince1970: Double(expires))
        } else {
            self.expiresAt = nil
        }
    }

    /// Only used when the server sent no name at all, which it tries hard not
    /// to. Not localized: this string is handed to CallKit before the app has
    /// restored anything, including the operator's language choice.
    static let unknownCaller = "Visitor"
}

/// What a cancel push carries. Deliberately tiny — it has one job.
struct CallCancellation: Sendable {
    let id: UUID
    let reason: CallEndReason

    init?(push: [AnyHashable: Any]) {
        guard let callID = push["call_id"] as? String,
              let uuid = UUID(uuidString: callID)
        else { return nil }
        self.id = uuid
        self.reason = CallEndReason(rawValue: (push["reason"] as? String) ?? "") ?? .ended
    }
}

extension String {
    var nonEmpty: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
