import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

/// The message field, its send button, and whichever extra controls the
/// conversation's state allows.
///
/// When the AI owns the thread the controls are not merely disabled but
/// replaced by a line saying so. A greyed-out paperclip invites tapping and
/// explains nothing; a sentence explains the state in the place the operator
/// is already looking.
struct Composer: View {
    @Binding var text: String
    let placeholder: String
    let sendLabel: String
    let canSend: Bool
    let isSending: Bool
    let capabilities: ComposerCapabilities
    let language: Language
    /// Present when the AI is answering this thread.
    ///
    /// The composer used to carry a sentence here explaining why its controls
    /// were plain while the AI answered. True and useless: what the operator
    /// wants in that moment is to say something to the visitor, and the AI is
    /// the thing standing between them.
    ///
    /// So the same field does that. Nothing is added above it — no mode bar,
    /// no second text area — only the placeholder changes and a voice picker
    /// joins the controls already inside the field. A thread with no AI
    /// passes nothing and the composer is exactly what it always was.
    var sayNow: SayNowModel?
    /// Whether the field has the keyboard.
    ///
    /// Owned by the screen rather than by this view: tapping the transcript
    /// has to put it down, and the transcript is not in here.
    @FocusState.Binding var isWriting: Bool
    let onSend: () -> Void
    /// Hands back a file the operator picked or recorded, ready to upload.
    let onAttach: (Data, String, String) -> Void
    /// The saved replies this composer can reach, and what to fill their
    /// placeholders from. Nil where there is nothing sensible to fill them
    /// with — the internal thread has no visitor, so `{{contact.name}}` there
    /// would only ever resolve to itself.
    var shortcuts: ShortcutSource?
    /// What may be attached, and how big. The chats take the workspace's
    /// attachments; the support chat takes fewer kinds and smaller files.
    var attachments: ComposerAttachmentRules = .chat

    @State private var isShowingEmoji = false
    @State private var isShowingShortcuts = false
    /// Replies spliced into this draft, with the text each one contributed,
    /// to be recorded once the draft is actually sent.
    @State private var usedShortcuts: [(id: String, snippet: String)] = []
    @State private var photoItem: PhotosPickerItem?
    @State private var isShowingPhotos = false
    @State private var isShowingDocuments = false
    @State private var pulse = false
    @State private var recorder = VoiceRecorder()
    @State private var problem: String?
    /// The first "Send with AI" on this phone asks before anything leaves.
    @State private var isAskingAIConsent = false


    var body: some View {
        VStack(spacing: Theme.Space.sm) {
            if recorder.isRecording {
                recordingBar
            } else {
                field
            }

            if isShowingEmoji, capabilities.canUseEmoji {
                EmojiStrip { emoji in
                    text.append(emoji)
                }
                .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
        }
        .padding(.horizontal, Theme.screenInset)
        .padding(.top, Theme.Space.xs)
        .padding(.bottom, bottomGap)
        .background(.bar)
        .animation(Theme.Motion.standard, value: isShowingEmoji)
        .animation(Theme.Motion.standard, value: capabilities)
        .animation(Theme.Motion.standard, value: recorder.isRecording)
        .photosPicker(
            isPresented: $isShowingPhotos,
            selection: $photoItem,
            // Photos only: no conversation takes a video file, and a picked
            // video would be read whole into memory before being refused.
            matching: .images
        )
        .fileImporter(
            isPresented: $isShowingDocuments,
            allowedContentTypes: attachments.documentTypes
        ) { result in
            handlePickedDocument(result)
        }
        .onChange(of: photoItem) { _, item in
            guard let item else { return }
            Task { await handlePickedPhoto(item) }
        }
        .onChange(of: recorder.failure) { _, failure in
            switch failure {
            case .permissionDenied: problem = Str.microphoneDenied(language)
            case .unavailable: problem = Str.recordingFailed(language)
            case nil: break
            }
        }
        .alert(problem ?? "", isPresented: Binding(
            get: { problem != nil },
            set: { if !$0 { problem = nil } }
        )) {
            Button(Str.ok(language), role: .cancel) {}
        }
        .sheet(isPresented: $isShowingShortcuts) {
            if let shortcuts {
                CannedResponsePicker(
                    language: language,
                    workspaceID: shortcuts.workspaceID,
                    context: shortcuts.context,
                    onPick: insertShortcut
                )
            }
        }
    }

    // MARK: - Saved replies

    /// Splices a reply in at the end of the draft.
    ///
    /// The console inserts at the caret; a `TextField` does not lend its caret
    /// out, so this appends — which is what the operator meant in every case
    /// but one, since the reason to open the picker is that the draft is empty
    /// or nearly so. The spacing rule is the web's: a newline when the draft
    /// already has text that does not end in whitespace.
    private func insertShortcut(_ expanded: String, _ id: String) {
        if text.isEmpty {
            text = expanded
        } else if text.last?.isWhitespace == true {
            text += expanded
        } else {
            text += "\n" + expanded
        }
        usedShortcuts.append((id: id, snippet: expanded))
        isWriting = true
    }

    /// Records a use only for a reply whose text actually survived into the
    /// message that went out — the same rule the console applies. Something
    /// pasted in and then deleted was never used.
    private func flushShortcutUses() {
        guard let shortcuts, !usedShortcuts.isEmpty else { return }
        let sent = text
        var recorded: Set<String> = []
        for used in usedShortcuts where sent.contains(used.snippet) {
            // Once per reply, however many times it was spliced in.
            guard recorded.insert(used.id).inserted else { continue }
            shortcuts.onUsed(used.id)
        }
        usedShortcuts = []
    }

    // MARK: - Recording

    /// Replaces the whole composer while recording, the way every messenger
    /// does: there is nothing else to do until the note is sent or thrown
    /// away, and a field you cannot type into is worse than no field.
    ///
    /// It replaces what is *inside* the pill, not the pill. Recording used to
    /// drop the pill altogether and lay a bare row out at a different height
    /// with a 38pt button in it, so the composer changed shape under the
    /// thumb that had just tapped the microphone.
    private var recordingBar: some View {
        HStack(spacing: 0) {
            Button {
                recorder.cancel()
            } label: {
                ComposerGlyph(icon: "trash", tint: Theme.Palette.danger)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Str.discard(language))

            HStack(spacing: Theme.Space.sm) {
                Circle()
                    .fill(Theme.Palette.danger)
                    .frame(width: 8, height: 8)
                    .opacity(pulse ? 0.3 : 1)
                    .animation(.easeInOut(duration: 0.7).repeatForever(), value: pulse)

                Text(Format.voiceTime(recorder.seconds, locale: language.locale))
                    .font(Theme.Typo.rowTitle)
                    .monospacedDigit()
                    .foregroundStyle(Theme.Palette.label)

                Text(Str.recording(language))
                    .font(Theme.Typo.meta)
                    .foregroundStyle(Theme.Palette.labelSecondary)
            }
            .padding(.horizontal, Theme.Space.xs)
            .frame(maxWidth: .infinity, alignment: .leading)

            SendButton(isEnabled: true, label: sendLabel) {
                if let data = recorder.finish() {
                    onAttach(data, recorder.fileName, recorder.mimeType)
                } else {
                    recorder.cancel()
                }
            }
        }
        .composerPill()
        .onAppear { pulse = true }
        .onDisappear { pulse = false }
    }

    // MARK: - Picking

    private func handlePickedPhoto(_ item: PhotosPickerItem) async {
        defer { photoItem = nil }
        guard let data = try? await item.loadTransferable(type: Data.self) else {
            problem = Str.attachmentFailed(language)
            return
        }
        if attachments.fitsPhotos {
            // A camera photo is a HEIC of several megabytes: drawn again as a
            // JPEG small enough to go, rather than refused.
            guard let fitted = await PhotoFitter.jpeg(data, maxBytes: attachments.maximumBytes) else {
                problem = attachments.tooLarge(language)
                return
            }
            onAttach(fitted, "photo.jpg", "image/jpeg")
            return
        }
        // The bytes are the item's own first type. One the server takes, at a
        // size it takes, goes as it is — a GIF stays animated, a PNG keeps its
        // transparency. Anything else — a HEIC, which is every camera photo by
        // default, or a picture over the limit — is drawn again as a JPEG.
        if let type = item.supportedContentTypes.first, let mime = mime(for: type),
           data.count <= attachments.maximumBytes {
            onAttach(data, "photo.\(type.preferredFilenameExtension ?? "jpg")", mime)
            return
        }
        guard let fitted = await PhotoFitter.jpeg(data, maxBytes: attachments.maximumBytes) else {
            problem = attachments.tooLarge(language)
            return
        }
        onAttach(fitted, "photo.jpg", "image/jpeg")
    }

    private func handlePickedDocument(_ result: Result<URL, Error>) {
        guard case .success(let url) = result else { return }
        // A file from another app arrives outside our sandbox; the read has to
        // happen inside a security scope or it comes back empty.
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }

        guard let data = try? Data(contentsOf: url) else {
            problem = Str.attachmentFailed(language)
            return
        }
        guard data.count <= attachments.maximumBytes else {
            problem = attachments.tooLarge(language)
            return
        }
        guard let type = UTType(filenameExtension: url.pathExtension),
              let mime = mime(for: type) else {
            problem = Str.fileTypeNotAllowed(language)
            return
        }
        onAttach(data, url.lastPathComponent, mime)
    }

    /// The server's allowed list, spelled the way it spells it. Anything not
    /// here is refused before a byte is uploaded.
    private func mime(for type: UTType) -> String? {
        if type.conforms(to: .png) { return "image/png" }
        if type.conforms(to: .jpeg) { return "image/jpeg" }
        if type.conforms(to: .webP) { return "image/webp" }
        if type.conforms(to: .gif) { return "image/gif" }
        if type.conforms(to: .pdf) { return "application/pdf" }
        if type.conforms(to: .plainText) { return "text/plain" }
        guard attachments.acceptsAudio else { return nil }
        if type.conforms(to: .mpeg4Audio) { return "audio/mp4" }
        if type.conforms(to: .mp3) { return "audio/mpeg" }
        if type.conforms(to: .wav) { return "audio/wav" }
        return nil
    }

    /// How far the bar sits above the bottom edge.
    ///
    /// A bottom safe-area inset parks its content above the home indicator,
    /// which leaves the field floating a centimetre up the screen with
    /// nothing under it. The tab bar had the same problem and was solved the
    /// same way: pull most of that inset back so the bar sits as low as the
    /// indicator allows.
    ///
    /// With the keyboard up there is no indicator to clear — the keyboard is
    /// the bottom of the screen — so the gap goes to nothing and the bar
    /// rests directly on the keys.
    private var bottomGap: CGFloat {
        isWriting ? 0 : Theme.Size.floatingBarBottomGap - ScreenInsets.bottom
    }

    // MARK: - What the one field is for right now

    /// The say-now model, but only while the AI is actually answering.
    ///
    /// Every read below goes through this rather than `sayNow` directly: a
    /// thread the AI does not own must behave as it always did even if a
    /// model was handed in.
    private var activeSayNow: SayNowModel? {
        guard let sayNow, capabilities.isAIManaged else { return nil }
        return sayNow
    }

    private var effectivePlaceholder: String {
        activeSayNow == nil ? placeholder : Str.sayNowPlaceholder(language)
    }

    private var effectiveSendLabel: String {
        activeSayNow == nil ? sendLabel : Str.sayNowAction(language)
    }

    private var effectiveIsSending: Bool {
        activeSayNow?.isSending ?? isSending
    }

    private var effectiveCanSend: Bool {
        guard let active = activeSayNow else { return canSend }
        return !active.isSending && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Sends whatever this thread means by sending.
    private func performSend() {
        guard let active = activeSayNow else {
            // Before `onSend`, which clears the draft: the rule is "did this
            // reply's text survive into what went out", and after the clear
            // there is nothing left to ask that of.
            flushShortcutUses()
            onSend()
            return
        }
        guard AIConsent.hasAgreed else {
            isAskingAIConsent = true
            return
        }
        sendWithAI(active)
    }

    private func sendWithAI(_ active: SayNowModel) {
        let body = text
        Task {
            if await active.send(body, language: language) { text = "" }
        }
    }

    /// Everything the composer is, in one pill.
    ///
    /// The auxiliary controls used to sit outside it, which made the composer
    /// a row of loose glyphs next to a field rather than one object. They are
    /// inside now, at the leading edge, in the order an operator reaches for
    /// them — and the microphone last, so it is the one touching the text.
    @ViewBuilder
    private var field: some View {
        if let active = activeSayNow {
            aiCard(active)
        } else {
            HStack(alignment: .bottom, spacing: 0) {
                leadingControls
                textArea
                sendButton
            }
            .composerPill()
            .onTapGesture { isWriting = true }
        }
    }

    /// The composer on a thread the AI is answering, as the Mac app draws it:
    /// one card, the operator's words on top and, under them, a tool row with
    /// whose voice they will land in, a line saying what happens to them, and
    /// the AI's own send — a purple circle with its sparkles.
    ///
    /// Nothing above it: no bar, no second field. The card is the one place
    /// the operator writes, whoever is answering.
    private func aiCard(_ active: SayNowModel) -> some View {
        let shape = RoundedRectangle(cornerRadius: 20, style: .continuous)
        return VStack(alignment: .leading, spacing: 0) {
            textArea
                .padding(.horizontal, Theme.Space.sm)
                .padding(.top, Theme.Space.xs)

            HStack(alignment: .center, spacing: Theme.Space.sm) {
                SayNowVoiceButton(model: active, language: language)

                Text(Str.sayNowHint(language))
                    .font(.app(.caption2))
                    .foregroundStyle(Theme.Palette.labelTertiary)
                    .lineLimit(2)
                    .minimumScaleFactor(0.85)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityHidden(true)

                SendButton(
                    isEnabled: effectiveCanSend,
                    isSending: effectiveIsSending,
                    label: effectiveSendLabel,
                    icon: "sparkles",
                    tint: Theme.Palette.ai,
                    action: performSend
                )
            }
            .padding(.leading, Theme.Space.sm)
            .padding(.trailing, Theme.Space.xs)
            .padding(.bottom, Theme.Space.xs)
        }
        // The Mac's focus treatment: while the card has the keyboard it takes
        // a faint wash of the brand's blue over its fill and a blue ring;
        // otherwise a hairline edge. One background, the wash over the fill —
        // a second `.background` would draw it underneath, out of sight.
        .background {
            shape.fill(Theme.Palette.surface)
                .overlay(shape.fill(Theme.Palette.brand.opacity(isWriting ? 0.05 : 0)))
        }
        .overlay(
            shape.strokeBorder(
                isWriting ? Theme.Palette.brand.opacity(0.55) : Theme.Palette.separator.opacity(0.6),
                lineWidth: isWriting ? 1.2 : 0.5
            )
        )
        .contentShape(shape)
        .animation(.smooth(duration: 0.18), value: isWriting)
        .onTapGesture { isWriting = true }
        .alert(AIConsentStr.title(language), isPresented: $isAskingAIConsent) {
            Button(AIConsentStr.allow(language)) {
                AIConsent.agree()
                sendWithAI(active)
            }
            Button(Str.cancel(language), role: .cancel) {}
        } message: {
            Text(AIConsentStr.body(language))
        }
    }

    /// The controls before the text.
    ///
    /// All of them are about putting something into a message to the visitor.
    /// On a thread the AI answers there is no such message — the operator's
    /// words are rewritten before they go — so that composer is a card of its
    /// own (`aiCard`), with the one control that does belong there: which
    /// voice the words land in.
    @ViewBuilder
    private var leadingControls: some View {
        if capabilities.canAttach {
            // A menu rather than a single picker: a photo and a document
            // come from two different system pickers, and guessing which
            // one somebody meant gets it wrong half the time.
            Menu {
                Button {
                    isShowingPhotos = true
                } label: {
                    Label(attachments.photosOnly ? Str.photo(language) : Str.sendPhoto(language), systemImage: "photo")
                }
                Button {
                    isShowingDocuments = true
                } label: {
                    Label(Str.sendDocument(language), systemImage: "doc")
                }
            } label: {
                ComposerGlyph(icon: "paperclip")
            }
            .accessibilityLabel(Str.attachFile(language))
            .accessibilityIdentifier(A11y.attachButton)
            .disabled(isSending)
        }

        if shortcuts != nil {
            // The console's lightning bolt, and for the same reason: a
            // saved reply is the fastest thing in the composer.
            ComposerGlyphButton(icon: "bolt", label: Str.shortcuts(language)) {
                isShowingEmoji = false
                isShowingShortcuts = true
            }
            .accessibilityIdentifier(A11y.shortcutsButton)
        }

        if capabilities.canUseEmoji {
            ComposerGlyphButton(
                icon: isShowingEmoji ? "keyboard" : "face.smiling",
                label: Str.emoji(language),
                isActive: isShowingEmoji
            ) {
                isShowingEmoji.toggle()
            }
        }

        if capabilities.canRecordVoice {
            // Last, so it is the control touching the text: a voice note
            // is an alternative to typing rather than something added to
            // what was typed.
            // `mic`, not `mic.fill`: the paperclip, the bolt and the
            // face beside it are all outlines, and a single solid glyph
            // among them reads as the one that is already switched on.
            ComposerGlyphButton(icon: "mic", label: Str.voiceNote(language)) {
                Task { await recorder.start() }
            }
            .disabled(isSending)
        }
    }

    private var textArea: some View {
        ZStack(alignment: .leading) {
            if text.isEmpty {
                Text(effectivePlaceholder)
                    .font(.app(.body))
                    .foregroundStyle(Theme.Palette.labelTertiary)
                    .allowsHitTesting(false)
            }

            TextField("", text: $text, axis: .vertical)
                .accessibilityIdentifier(A11y.composerField)
                .font(.app(.body))
                .lineLimit(1...6)
                .focused($isWriting)
        }
        // Enough to clear the glyph beside it without opening a gap; the
        // pill's own inset supplies the rest when there is no glyph.
        .padding(.leading, Theme.Space.xs)
        .padding(.trailing, Theme.Space.xs)
        // Sized to match the buttons beside it. A taller text side pushes
        // them down against the pill's edge, which reads as two controls
        // falling out of it rather than one field containing them.
        .padding(.vertical, Theme.Space.sm - 1)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var sendButton: some View {
        SendButton(
            isEnabled: effectiveCanSend,
            isSending: effectiveIsSending,
            label: effectiveSendLabel,
            action: performSend
        )
    }
}

/// What a composer lets the operator attach.
struct ComposerAttachmentRules: Sendable {
    /// Photos only from the library, no videos.
    var photosOnly = false
    /// What the document picker offers. More than the server takes only
    /// moves the refusal from the picker to the upload.
    var documentTypes: [UTType] = [.pdf, .plainText, .png, .jpeg, .webP, .gif]
    var maximumBytes = 25 * 1024 * 1024
    /// Voice notes and audio files.
    var acceptsAudio = true
    /// A photo is re-drawn as a JPEG that fits `maximumBytes` instead of
    /// being refused for its size.
    var fitsPhotos = false
    /// What to say about a file over `maximumBytes`.
    var tooLarge: @Sendable (Language) -> String = { Str.fileTooLarge($0) }

    /// The workspace's chats.
    static let chat = ComposerAttachmentRules()

    /// Settings → Online support: PNG, JPEG, WebP, GIF, PDF or plain text,
    /// at most 2 MB (docs/PLATFORM_SUPPORT.md).
    static let support = ComposerAttachmentRules(
        photosOnly: true,
        maximumBytes: SupportLimits.maxFileBytes,
        acceptsAudio: false,
        fitsPhotos: true,
        tooLarge: { SupportStr.fileTooLarge($0) }
    )
}

/// Re-draws a photo as a JPEG under a size, off the main thread: the longest
/// side brought down to what a screen shows, then the quality stepped down
/// until it fits. Nil when the bytes are not a picture, or nothing fits.
enum PhotoFitter {
    static func jpeg(_ data: Data, maxBytes: Int) async -> Data? {
        await Task.detached(priority: .userInitiated) {
            for side in [2048, 1600, 1280] {
                guard let image = AttachmentPreviews.downsample(data, maxPixel: side) else { return nil }
                for quality in [0.82, 0.7, 0.55] {
                    if let encoded = image.jpegData(compressionQuality: quality), encoded.count <= maxBytes {
                        return encoded
                    }
                }
            }
            return nil
        }.value
    }
}

/// A compact row of the emoji an operator actually reaches for.
///
/// A full picker is a screen of its own; this covers the handful that appear
/// in support replies and keeps the composer in one place.
struct EmojiStrip: View {
    let onPick: (String) -> Void

    private let emoji = ["👍", "🙏", "😊", "🎉", "✅", "❤️", "😅", "🔥", "👌", "🙌", "😔", "⏳"]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Theme.Space.xs) {
                ForEach(emoji, id: \.self) { character in
                    Button {
                        onPick(character)
                    } label: {
                        Text(character)
                            .font(.system(size: 26))
                            .frame(width: Theme.Size.minTouchTarget, height: Theme.Size.minTouchTarget)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, Theme.Space.xxs)
        }
        // Emoji are not mirrored, and neither is the order they are offered in.
        .environment(\.layoutDirection, .leftToRight)
        .frame(height: Theme.Size.minTouchTarget)
    }
}
