import Foundation

/// Who is currently answering a conversation.
///
/// Read from `metadata.ai_state` with a fallback to the top-level `ai_state`,
/// which is exactly the order `InboxPage.tsx` uses — both fields exist and the
/// nested one is authoritative.
enum AIState: String, Sendable {
    /// The AI owns the thread and is replying on its own.
    case aiManaged = "ai_managed"
    /// The AI has handed back and is waiting for a person.
    case needsHuman = "needs_human"
    /// A person has taken over.
    case humanActive = "human_active"

    static func resolve(_ conversation: Conversation) -> AIState? {
        let raw = conversation.aiStateValue
        guard let raw, !raw.isEmpty else { return nil }
        return AIState(rawValue: raw)
    }
}

/// Which composer controls a conversation should offer right now.
///
/// Two independent questions decide this, and both have to say yes:
///
/// 1. Does the workspace's plan include the capability at all?
/// 2. Is a person actually the one replying?
///
/// The second is the important one. While the AI owns a thread the operator is
/// steering it, not talking to the visitor — the web replaces the whole
/// composer with its guidance composer for exactly this reason. Sending a file
/// or a voice note into a conversation the AI is answering would put content
/// in front of the visitor that the AI has no idea about.
struct ComposerCapabilities: Sendable, Equatable {
    let canAttach: Bool
    let canRecordVoice: Bool
    let canUseEmoji: Bool
    /// True while the AI still owns the thread, so the UI can explain why the
    /// controls are absent rather than just hiding them.
    let isAIManaged: Bool

    var hasAnyControl: Bool { canAttach || canRecordVoice || canUseEmoji }

    static func resolve(conversation: Conversation, entitlements: Entitlements?) -> ComposerCapabilities {
        let aiManaged = AIState.resolve(conversation) == .aiManaged

        // Fail-closed on the plan: an unresolved snapshot shows nothing rather
        // than offering a control that would fail on use.
        let plan = { (key: String) in entitlements?.featureEnabled(key) == true }

        return ComposerCapabilities(
            canAttach: !aiManaged && plan("widget_attachments"),
            canRecordVoice: !aiManaged && plan("widget_voice_notes"),
            canUseEmoji: !aiManaged && plan("widget_emoji"),
            isAIManaged: aiManaged
        )
    }
}
