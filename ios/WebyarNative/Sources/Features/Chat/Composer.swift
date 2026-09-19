import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

/// The message field, its send button, and whichever extra controls the plan
/// and the conversation's state allow.
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
    /// Shown in place of the controls while the AI is answering.
    let aiNotice: String
    let onSend: () -> Void
    /// Hands back a file the operator picked or recorded, ready to upload.
    let onAttach: (Data, String, String) -> Void

    @State private var isShowingEmoji = false
    @State private var photoItem: PhotosPickerItem?
    @State private var isShowingPhotos = false
    @State private var isShowingDocuments = false
    @State private var pulse = false
    @State private var recorder = VoiceRecorder()
    @State private var problem: String?
    /// So a tap anywhere on the rounded field opens the keyboard, not only a
    /// tap that happens to land on the text itself.
    @FocusState private var isWriting: Bool

    /// The types the server will accept. Offering more than this only moves
    /// the rejection from the picker to the upload.
    private static let allowedDocuments: [UTType] = [.pdf, .plainText, .png, .jpeg, .webP, .gif]
    private static let maximumBytes = 25 * 1024 * 1024

    var body: some View {
        VStack(spacing: Theme.Space.sm) {
            if capabilities.isAIManaged {
                aiBanner
            }

            if recorder.isRecording {
                recordingBar
            } else {
                HStack(alignment: .bottom, spacing: Theme.Space.xs) {
                    if capabilities.canAttach || capabilities.canUseEmoji {
                        controls
                    }

                    field
                }
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
            matching: .any(of: [.images, .videos])
        )
        .fileImporter(
            isPresented: $isShowingDocuments,
            allowedContentTypes: Self.allowedDocuments
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
    }

    // MARK: - Recording

    /// Replaces the whole composer while recording, the way every messenger
    /// does: there is nothing else to do until the note is sent or thrown
    /// away, and a field you cannot type into is worse than no field.
    private var recordingBar: some View {
        HStack(spacing: Theme.Space.md) {
            Button {
                recorder.cancel()
            } label: {
                Image(systemName: "trash")
                    .font(.system(size: 16))
                    .foregroundStyle(Theme.Palette.danger)
                    .frame(width: 38, height: 38)
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
            .frame(maxWidth: .infinity, alignment: .leading)

            Button {
                if let data = recorder.finish() {
                    onAttach(data, recorder.fileName, recorder.mimeType)
                } else {
                    recorder.cancel()
                }
            } label: {
                Image(systemName: "arrow.up")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 38, height: 38)
                    .background(Circle().fill(Theme.Palette.brand))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(sendLabel)
        }
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
        guard data.count <= Self.maximumBytes else {
            problem = Str.fileTooLarge(language)
            return
        }
        // `PhotosPickerItem` reports the type it will hand over, which is not
        // always the type in the library — a HEIC photo transcodes on the way
        // out. Whatever it actually is has to be one the server takes.
        let type = item.supportedContentTypes.first { Self.mime(for: $0) != nil }
        guard let type, let mime = Self.mime(for: type) else {
            problem = Str.fileTypeNotAllowed(language)
            return
        }
        onAttach(data, "photo.\(type.preferredFilenameExtension ?? "jpg")", mime)
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
        guard data.count <= Self.maximumBytes else {
            problem = Str.fileTooLarge(language)
            return
        }
        guard let type = UTType(filenameExtension: url.pathExtension),
              let mime = Self.mime(for: type) else {
            problem = Str.fileTypeNotAllowed(language)
            return
        }
        onAttach(data, url.lastPathComponent, mime)
    }

    /// The server's allowed list, spelled the way it spells it. Anything not
    /// here is refused before a byte is uploaded.
    private static func mime(for type: UTType) -> String? {
        if type.conforms(to: .png) { return "image/png" }
        if type.conforms(to: .jpeg) { return "image/jpeg" }
        if type.conforms(to: .webP) { return "image/webp" }
        if type.conforms(to: .gif) { return "image/gif" }
        if type.conforms(to: .pdf) { return "application/pdf" }
        if type.conforms(to: .plainText) { return "text/plain" }
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
        isWriting ? 0 : Theme.Space.xs - ScreenInsets.bottom
    }

    /// Says why the composer is plain right now.
    private var aiBanner: some View {
        HStack(spacing: Theme.Space.sm) {
            Image(systemName: "sparkles")
                .font(.caption)
                .foregroundStyle(Theme.Palette.brand)

            Text(aiNotice)
                .font(.caption)
                .foregroundStyle(Theme.Palette.labelSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .multilineTextAlignment(.leading)
        }
        .padding(.horizontal, Theme.Space.md)
        .padding(.vertical, Theme.Space.sm)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                .fill(Theme.Palette.brand.opacity(0.10))
        )
    }

    private var controls: some View {
        HStack(spacing: Theme.Space.xxs) {
            if capabilities.canAttach {
                // A menu rather than a single picker: a photo and a document
                // come from two different system pickers, and guessing which
                // one somebody meant gets it wrong half the time.
                Menu {
                    Button {
                        isShowingPhotos = true
                    } label: {
                        Label(Str.sendPhoto(language), systemImage: "photo")
                    }
                    Button {
                        isShowingDocuments = true
                    } label: {
                        Label(Str.sendDocument(language), systemImage: "doc")
                    }
                } label: {
                    ComposerButtonLabel(icon: "paperclip")
                }
                .accessibilityLabel(Str.attachFile(language))
                .disabled(isSending)
            }
            if capabilities.canUseEmoji {
                ComposerButton(
                    icon: isShowingEmoji ? "keyboard" : "face.smiling",
                    label: Str.emoji(language)
                ) {
                    isShowingEmoji.toggle()
                }
            }
        }
    }

    /// The field, with the two controls that act on what is in it sitting
    /// inside its own rounded edge — which is where every messenger puts
    /// them, and what keeps the bar one object instead of three.
    private var field: some View {
        HStack(alignment: .bottom, spacing: Theme.Space.xxs) {
            ZStack(alignment: .leading) {
                if text.isEmpty {
                    Text(placeholder)
                        .font(.body)
                        .foregroundStyle(Theme.Palette.labelTertiary)
                        .allowsHitTesting(false)
                }

                TextField("", text: $text, axis: .vertical)
                    .font(.body)
                    .lineLimit(1...6)
                    .focused($isWriting)
            }
            .padding(.leading, Theme.Space.md)
            .padding(.vertical, Theme.Space.sm + 1)
            .frame(maxWidth: .infinity, alignment: .leading)

            if capabilities.canRecordVoice {
                inFieldButton(icon: "mic.fill", label: Str.voiceNote(language)) {
                    Task { await recorder.start() }
                }
                .disabled(isSending)
            }

            sendButton
        }
        .padding(Theme.Space.xxs)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.xl, style: .continuous)
                .fill(Theme.Palette.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.xl, style: .continuous)
                .strokeBorder(Theme.Palette.separator.opacity(0.6), lineWidth: 0.5)
        )
        // The whole pill is the tap target. Tapping the padding beside the
        // text used to do nothing at all, which reads as a field that will
        // not open.
        .contentShape(RoundedRectangle(cornerRadius: Theme.Radius.xl, style: .continuous))
        .onTapGesture { isWriting = true }
    }

    /// A control that lives inside the field: smaller than the ones outside
    /// it, and tinted rather than filled, so the send button stays the only
    /// solid thing in the bar.
    private func inFieldButton(
        icon: String,
        label: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 15))
                .foregroundStyle(Theme.Palette.labelSecondary)
                .frame(width: 34, height: 34)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    private var sendButton: some View {
        Button(action: onSend) {
            Group {
                if isSending {
                    ProgressView().tint(.white)
                } else {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 17, weight: .bold))
                        .foregroundStyle(.white)
                }
            }
            .frame(width: 34, height: 34)
            .background(Circle().fill(Theme.Palette.brand.opacity(canSend ? 1 : 0.35)))
        }
        .buttonStyle(.plain)
        .disabled(!canSend)
        .accessibilityLabel(sendLabel)
        .animation(Theme.Motion.standard, value: canSend)
    }
}

/// One of the small round controls beside the field.
struct ComposerButton: View {
    let icon: String
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ComposerButtonLabel(icon: icon)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

/// The same target and the same glyph, without a button around it — for the
/// paperclip, which opens a menu rather than doing one thing.
struct ComposerButtonLabel: View {
    let icon: String

    var body: some View {
        Image(systemName: icon)
            .font(.system(size: 19))
            .foregroundStyle(Theme.Palette.labelSecondary)
            .frame(width: Theme.Size.minTouchTarget - 6, height: Theme.Size.minTouchTarget)
            .contentShape(Rectangle())
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
