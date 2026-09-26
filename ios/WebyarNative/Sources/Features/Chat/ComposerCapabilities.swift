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
/// One question decides this: is a person actually the one replying? While
/// the AI owns a thread the operator is steering it, not talking to the
/// visitor — the web replaces the whole composer with its guidance composer
/// for exactly this reason. Sending a file or a voice note into a conversation
/// the AI is answering would put content in front of the visitor that the AI
/// has no idea about.
///
/// The plan is not asked. Its `widget_attachments`, `widget_voice_notes` and
/// `widget_emoji` keys (and every other `widget_*` key) govern the
/// customer-facing website widget, not the operator's composer — the web and
/// the desktop apps offer these tools whatever the plan says about the widget.
struct ComposerCapabilities: Sendable, Equatable {
    let canAttach: Bool
    let canRecordVoice: Bool
    let canUseEmoji: Bool
    /// True while the AI still owns the thread, so the UI can explain why the
    /// controls are absent rather than just hiding them.
    let isAIManaged: Bool

    var hasAnyControl: Bool { canAttach || canRecordVoice || canUseEmoji }

    /// An internal thread between operators: no AI and no visitor, so every tool.
    static let team = ComposerCapabilities(canAttach: true, canRecordVoice: true, canUseEmoji: true, isAIManaged: false)

    static func resolve(conversation: Conversation) -> ComposerCapabilities {
        let aiManaged = AIState.resolve(conversation) == .aiManaged
        return ComposerCapabilities(
            canAttach: !aiManaged,
            canRecordVoice: !aiManaged,
            canUseEmoji: !aiManaged,
            isAIManaged: aiManaged
        )
    }
}
