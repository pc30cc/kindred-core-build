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
    /// The platform's support team answered (`support_reply`): the support
    /// chat in Settings. `workspaceID` is only where the server filed the
    /// notification — support is the same chat from every workspace — and
    /// `threadID` is the conversation, in the team's workspace.
    case support(workspaceID: String, threadID: String)

    var workspaceID: String {
        switch self {
        case .conversation(let workspaceID, _), .colleague(let workspaceID, _), .email(let workspaceID, _),
             .support(let workspaceID, _):
            workspaceID
        }
    }

    /// Opened in Settings, whatever workspace is open: nothing to switch to.
    var isSupport: Bool {
        if case .support = self { return true }
        return false
    }

    /// One value per destination, for `.task(id:)`.
    var key: String {
        switch self {
        case .conversation(let workspace, let id): "c|\(workspace)|\(id)"
        case .colleague(let workspace, let peer): "t|\(workspace)|\(peer)"
        case .email(let workspace, let thread): "e|\(workspace)|\(thread)"
        case .support(let workspace, let thread): "s|\(workspace)|\(thread)"
        }
    }

    /// The shapes `server/services/push/dispatch.ts` sends — the same ones the
    /// Android app reads: a colleague's message names the colleague
    /// (`peerId`), an email or a support reply names its thread
    /// (`threadId`), everything else names a conversation. A diagnostic from Super Admin (`type: test`)
    /// goes nowhere, and neither does a payload this build cannot place — a
    /// callback request, which has no screen on this phone.
    init?(userInfo info: [AnyHashable: Any]) {
        func value(_ key: String) -> String? {
            guard let text = info[key] as? String, !text.isEmpty else { return nil }
            return text
        }
        let type = value("type")
        guard type != "test", let workspaceID = value("workspaceId") else { return nil }
        if type == "team_message" {
            guard let peer = value("peerId") else { return nil }
            self = .colleague(workspaceID: workspaceID, peerID: peer)
        } else if type == "email_message" {
            guard let thread = value("threadId") else { return nil }
            self = .email(workspaceID: workspaceID, threadID: thread)
        } else if type == "support_reply" {
            guard let thread = value("threadId") else { return nil }
            self = .support(workspaceID: workspaceID, threadID: thread)
        } else if let conversation = value("conversationId") {
            self = .conversation(workspaceID: workspaceID, conversationID: conversation)
        } else {
            return nil
        }
    }
}
