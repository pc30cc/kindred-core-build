import SwiftUI
import Observation

/// What the composer does on a thread the AI is answering.
///
/// It sends. The operator writes what the visitor should be told, the AI puts
/// it in words, and it goes — there is no second mode to pick, because on an
/// AI-answered thread this is the only thing the composer could sensibly mean.
/// An operator who wants to write to the visitor themselves takes the thread
/// over from the header menu, and then the composer is an ordinary composer
/// again.
///
/// The console has more here — private guidance, scopes, an "answer now"
/// nudge. Those are desktop controls: they need a second text area and three
/// pickers to sit beside it, and stacking that over a phone keyboard buys an
/// operator nothing they would use between two visitor messages.
///
/// So the only choice left is whose voice it lands in, and it lives inside the
/// field with the send button rather than in a bar above it.
@MainActor
@Observable
final class SayNowModel {

    /// Whose voice the AI writes in. Remembered for the session because an
    /// operator who picked one is almost always about to pick it again.
    var voice: SayNowVoice = .specialist

    private(set) var isSending = false
    /// The last outcome worth putting in front of the operator.
    var notice: String?

    private let conversationID: String
    private let api: any WebyarAPI

    init(conversationID: String, api: any WebyarAPI = Backend.current) {
        self.conversationID = conversationID
        self.api = api
    }

    /// Returns true when the server took it, so the composer knows whether to
    /// clear the draft — a draft cleared after a failure is a sentence the
    /// operator has to write again from memory.
    func send(_ body: String, language: Language) async -> Bool {
        let text = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isSending else { return false }
        isSending = true
        defer { isSending = false }
        do {
            try await api.aiSayNow(conversationID: conversationID, body: text, voice: voice)
            notice = Str.sayNowSent(language)
            return true
        } catch {
            notice = Str.sayNowFailed(language)
            return false
        }
    }
}

/// The voice control that sits inside the composer field.
///
/// A `Menu` on a plain glyph-and-label button, sized to the other in-field
/// controls: the same shape iOS uses wherever a field carries a choice about
/// what it is about to do. It is not a segmented control and not a bar,
/// because either of those would be a row of chrome the operator reads once
/// and then has to look past for the rest of the conversation.
struct SayNowVoiceButton: View {
    @Bindable var model: SayNowModel
    let language: Language

    var body: some View {
        Menu {
            // A picker inside the menu draws the checkmark itself and reads
            // the selection out correctly to VoiceOver, which is the whole
            // reason to prefer it over three Buttons here.
            Picker("", selection: $model.voice) {
                ForEach(SayNowVoice.allCases) { voice in
                    Label(voice.title(language), systemImage: voice.icon).tag(voice)
                }
            }
        } label: {
            Image(systemName: model.voice.icon)
                .font(.system(size: 15))
                .foregroundStyle(Theme.Palette.brand)
                .frame(width: 34, height: 34)
                .contentShape(Rectangle())
        }
        .disabled(model.isSending)
        // Spoken as one thing: what this picks, and what it is currently set
        // to. The visual is a glyph, so without this it announces nothing.
        .accessibilityLabel(Str.sayNowVoice(language))
        .accessibilityValue(model.voice.title(language))
        .accessibilityIdentifier(A11y.sayNowVoice)
    }
}
