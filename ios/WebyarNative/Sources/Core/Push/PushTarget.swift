import Foundation

/// Where a notification wants to take the operator.
///
/// Read from the payload's identifiers and nothing else: the payload is a
/// routing hint, never authority. Every destination is then fetched as the
/// operator who is signed in, who may no longer be allowed to see it — in
/// which case the inbox is where they are left.
enum PushTarget: Equatable, Hashable, Sendable {
    /// A customer conversation: a message, a note, an assignment, a handoff.
    case conversation(workspaceID: String, conversationID: String)
    /// A colleague's team-chat thread.
    case colleague(workspaceID: String, peerID: String)
    /// A thread in the shared email inbox.
    case email(workspaceID: String, threadID: String)

    var workspaceID: String {
        switch self {
        case .conversation(let workspaceID, _), .colleague(let workspaceID, _), .email(let workspaceID, _):
            workspaceID
        }
    }

    /// One value per destination, for `.task(id:)`.
    var key: String {
        switch self {
        case .conversation(let workspace, let id): "c|\(workspace)|\(id)"
        case .colleague(let workspace, let peer): "t|\(workspace)|\(peer)"
        case .email(let workspace, let thread): "e|\(workspace)|\(thread)"
        }
    }

    /// The shapes `server/services/push/dispatch.ts` sends. A diagnostic
    /// from Super Admin (`type: test`) goes nowhere, and neither does a
    /// payload this build cannot place.
    init?(userInfo info: [AnyHashable: Any]) {
        func value(_ key: String) -> String? {
            guard let text = info[key] as? String, !text.isEmpty else { return nil }
            return text
        }
        guard value("type") != "test", let workspaceID = value("workspaceId") else { return nil }
        if let peer = value("teamPeerId") {
            self = .colleague(workspaceID: workspaceID, peerID: peer)
        } else if let thread = value("emailThreadId") {
            self = .email(workspaceID: workspaceID, threadID: thread)
        } else if let conversation = value("conversationId") {
            self = .conversation(workspaceID: workspaceID, conversationID: conversation)
        } else {
            return nil
        }
    }
}
