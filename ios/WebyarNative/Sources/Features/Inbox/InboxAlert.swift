import SwiftUI
import Observation

/// Whether something is waiting in the inbox that the operator has not
/// looked at.
///
/// A dot, not a number, and the difference is the whole design. A number
/// would have to answer "unread in which queue — mine, or the workspace's?",
/// and answering it means asking the server for counts every time a message
/// lands: `GET /api/conversations/inbox-counts` is four exact counts plus a
/// membership check, per message. From another tab there is exactly one
/// question worth answering — "is somebody waiting for me?" — and the push
/// that already arrives answers it for nothing.
///
/// So this reads the doorbell and never opens the door. No request, no
/// query, no row.
@MainActor
@Observable
final class InboxAlert {

    private(set) var isRinging = false

    init() {
        #if DEBUG
        // Staging, for the one state that cannot be reached from outside the
        // app: the sample backend has no socket, and no test can make a
        // visitor write. Same shape as `-WebyarHoldLaunch` — Debug-only,
        // off unless asked for by launch argument, and physically absent
        // from a Release build, which has no sample backend either.
        isRinging = ProcessInfo.processInfo.arguments.contains("-WebyarInboxDot")
        #endif
    }

    /// A push landed on the workspace inbox channel.
    ///
    /// `isLookingAtInbox` is passed in rather than read from here because
    /// the tab bar's selection belongs to the shell, and a signal that knew
    /// about navigation would be two things at once.
    func note(_ push: LivePush, isLookingAtInbox: Bool) {
        guard push.type == "message" else { return }
        // Only a visitor. The operator's own reply comes back over this
        // channel too, and so does the AI's — neither is somebody waiting.
        guard push.senderType == "contact" else { return }
        // Not while the list is on screen: the row updates itself, and a dot
        // on the tab you are already reading is a dot about nothing.
        guard !isLookingAtInbox else { return }
        // Nor for the thread that is open right now. Same rule the
        // notification banner follows (`PushController.presentation`), for
        // the same reason: it is already being read.
        guard push.conversationID == nil || push.conversationID != PushController.shared.viewing else {
            return
        }
        isRinging = true
    }

    /// The operator opened the inbox. Whatever was waiting is now in front
    /// of them.
    func clear() {
        isRinging = false
    }
}
