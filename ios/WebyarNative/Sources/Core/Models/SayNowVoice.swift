import Foundation

/// Whose voice the AI writes in when it delivers an operator's message.
///
/// The distinction is the visitor's, not the operator's: the same sentence
/// reads differently coming from a person on the team than from the
/// assistant, and on a thread the AI is already answering the operator is
/// choosing which of those the visitor should believe they are talking to.
enum SayNowVoice: String, CaseIterable, Identifiable, Sendable {
    /// Written as one of the humans on the team.
    case specialist
    /// Written as the assistant, openly.
    case assistant

    var id: String { rawValue }

    var icon: String {
        switch self {
        case .specialist: "person.wave.2.fill"
        case .assistant: "sparkles"
        }
    }

    func title(_ l: Language) -> String {
        switch self {
        case .specialist: Str.sayNowVoiceSpecialist(l)
        case .assistant: Str.sayNowVoiceAssistant(l)
        }
    }
}
