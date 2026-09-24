import SwiftUI
import UniformTypeIdentifiers

/// The reply box: one glass card — text on top, tools and the send button
/// below, as in the web console and the Windows app. On a thread the AI is
/// answering, the operator does not write to the visitor directly: the AI
/// says it, in the specialist's voice or its own (say-now), and only the
/// voice picker sits beside the text.
struct ComposerView: View {
    let chat: ChatModel
    @Environment(AppModel.self) private var app
    @FocusState private var focused: Bool
    @State private var showEmoji = false
    @State private var showShortcuts = false
    @State private var shortcutQuery = ""
    @State private var picking = false

    var body: some View {
        @Bindable var chat = chat
        let s = app.strings
        let plan = app.plan
        let ai = chat.aiMode
        VStack(alignment: .leading, spacing: 0) {
            if let file = chat.pendingFile {
                PendingFileChip(name: file.name, mime: file.mime, data: file.data) { chat.pendingFile = nil }
                    .padding([.horizontal, .top], 10)
            }
            if chat.recorder.isRecording {
                HStack(spacing: 10) {
                    Circle().fill(Palette.danger).frame(width: 10, height: 10)
                        .opacity(Int(chat.recorder.elapsed * 2) % 2 == 0 ? 1 : 0.25)
                    Text(timeText(chat.recorder.elapsed)).appFont(14, .semibold).monospacedDigit()
                        .environment(\.layoutDirection, .leftToRight)
                    Text(s["voiceRecording"]).appFont(12.5).foregroundStyle(Palette.text2).lineLimit(1)
                    Spacer()
                }
                .padding(.horizontal, 16)
                .frame(minHeight: 46)
                .onChange(of: Int(chat.recorder.elapsed)) { _, secs in
                    // Voice notes are short; stop well before the upload cap.
                    if secs >= 300 { chat.stopRecording(keep: true) }
                }
            } else {
                TextField(s[ai ? "sayNowPlaceholder" : "messagePlaceholder"], text: $chat.draft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .appFont(14)
                    .lineLimit(1...8)
                    .focused($focused)
                    .padding(.horizontal, 16)
                    .padding(.top, 13)
                    .padding(.bottom, 6)
                    .onKeyPress(.return, phases: .down) { press in
                        // Enter sends; Shift+Enter starts a new line, as in the web console.
                        if press.modifiers.contains(.shift) || press.modifiers.contains(.option) {
                            chat.draft += "\n"
                            return .handled
                        }
                        chat.send()
                        return .handled
                    }
                    .onChange(of: chat.draft) { _, text in
                        // A "/" at the start opens the saved replies, as in the web console.
                        if !ai, text.hasPrefix("/"), !text.contains(" "), text.count <= 24 {
                            shortcutQuery = String(text.dropFirst())
                            showShortcuts = true
                        }
                    }
            }
            HStack(spacing: 2) {
                if ai {
                    Menu {
                        Picker("", selection: $chat.voice) {
                            Label(s["sayNowVoiceSpecialist"], systemImage: "person.wave.2").tag("specialist")
                            Label(s["sayNowVoiceAssistant"], systemImage: "sparkles").tag("assistant")
                        }
                        .pickerStyle(.inline)
                    } label: {
                        Label(s[chat.voice == "assistant" ? "sayNowVoiceAssistant" : "sayNowVoiceSpecialist"],
                              systemImage: chat.voice == "assistant" ? "sparkles" : "person.wave.2")
                            .appFont(12, .semibold)
                    }
                    .menuStyle(.button)
                    .buttonStyle(.plain)
                    .foregroundStyle(Palette.ai)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(Palette.aiSoft, in: Capsule())
                    .fixedSize()
                    .help(s["sayNowVoice"])
                } else {
                    if plan.attachments {
                        tool("paperclip", s["attachFile"]) { picking = true }
                            .disabled(chat.recorder.isRecording)
                    }
                    if plan.emoji {
                        tool("face.smiling", s["emoji"]) { showEmoji.toggle() }
                            .disabled(chat.recorder.isRecording)
                            .popover(isPresented: $showEmoji, arrowEdge: .top) {
                                EmojiGrid { e in
                                    chat.draft += e
                                    showEmoji = false
                                    focused = true
                                }
                            }
                    }
                    tool("text.bubble", s["shortcuts"]) {
                        shortcutQuery = ""
                        showShortcuts.toggle()
                    }
                    .disabled(chat.recorder.isRecording)
                    .popover(isPresented: $showShortcuts, arrowEdge: .top) {
                        SavedRepliesPicker(chat: chat, query: $shortcutQuery) {
                            showShortcuts = false
                            focused = true
                        }
                        .environment(app)
                        .appEnvironment(app)
                    }
                }
                Spacer(minLength: 8)
                if !chat.recorder.isRecording {
                    Text(ai ? s["sayNowHint"] : s["composerHint"]).appFont(11).foregroundStyle(Palette.text3).lineLimit(1)
                        .padding(.horizontal, 6)
                }
                if chat.recorder.isRecording {
                    tool("trash", s["voiceDiscard"], tint: Palette.danger) { chat.stopRecording(keep: false) }
                }
                if !ai && plan.voiceNotes {
                    tool(chat.recorder.isRecording ? "stop.fill" : "mic", s[chat.recorder.isRecording ? "voiceStop" : "voiceRecord"],
                         tint: chat.recorder.isRecording ? Palette.danger : nil) { chat.toggleRecording() }
                }
                Button { chat.send() } label: {
                    Image(systemName: ai ? "sparkles" : "paperplane.fill")
                        .font(.system(size: 14, weight: .semibold))
                        .scaleEffect(x: s.isRightToLeft && !ai ? -1 : 1)
                        .frame(width: 22, height: 22)
                }
                .prominentButton(tint: ai ? Palette.ai : Palette.brand)
                .buttonBorderShape(.circle)
                .controlSize(.large)
                .disabled(!chat.canSend || chat.busy)
                .help(s[ai ? "sayNowAction" : "send"])
                .padding(.leading, 4)
            }
            .padding(.horizontal, 8)
            .padding(.bottom, 8)
        }
        .glassCard(20, tint: focused ? Palette.brand.opacity(0.05) : nil)
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(focused ? Palette.brand.opacity(0.55) : .clear, lineWidth: 1.2))
        .animation(.smooth(duration: 0.18), value: focused)
        .fileImporter(isPresented: $picking, allowedContentTypes: [.item]) { result in
            if case .success(let url) = result { chat.attach(url: url) }
            focused = true
        }
        .onPasteCommand(of: [.fileURL, .png, .tiff]) { providers in paste(providers) }
        .onAppear { focused = true }
    }

    private func tool(_ icon: String, _ help: String, tint: Color? = nil, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon).font(.system(size: 15)).frame(width: 30, height: 30).contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .foregroundStyle(tint ?? Palette.text2)
        .help(help)
    }

    private func timeText(_ t: TimeInterval) -> String {
        let s = Int(t)
        return "\(s / 60):" + String(format: "%02d", s % 60)
    }

    /// A file or an image pasted into the box goes into the card, like a picked one.
    private func paste(_ providers: [NSItemProvider]) {
        guard !chat.aiMode, let p = providers.first else { return }
        if p.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
            _ = p.loadObject(ofClass: URL.self) { url, _ in
                if let url { Task { @MainActor in chat.attach(url: url) } }
            }
        } else if p.canLoadObject(ofClass: NSImage.self) {
            _ = p.loadObject(ofClass: NSImage.self) { image, _ in
                guard let image = image as? NSImage, let tiff = image.tiffRepresentation,
                      let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else { return }
                Task { @MainActor in chat.attach(name: "image.png", mime: "image/png", data: png) }
            }
        }
    }
}

/// The file about to go out, inside the card until Send; a photo shows its thumbnail.
struct PendingFileChip: View {
    let name: String
    let mime: String
    let data: Data
    let onRemove: () -> Void
    @Environment(AppModel.self) private var app

    var body: some View {
        HStack(spacing: 10) {
            ZStack {
                RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Palette.brandSoft)
                if mime.hasPrefix("image/"), let image = NSImage(data: data) {
                    Image(nsImage: image).resizable().scaledToFill()
                } else {
                    Image(systemName: mime.hasPrefix("audio/") ? "waveform" : mime.hasPrefix("video/") ? "film" : "doc")
                        .foregroundStyle(Palette.brand)
                }
            }
            .frame(width: 44, height: 44)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(name).appFont(12.5, .semibold).lineLimit(1).truncationMode(.middle)
                Text(Display.fileSize(Int64(data.count), app.strings)).appFont(11).foregroundStyle(Palette.text3)
            }
            .frame(maxWidth: 280, alignment: .leading)
            Button(action: onRemove) { Image(systemName: "xmark").font(.system(size: 10, weight: .bold)) }
                .buttonStyle(.borderless)
                .foregroundStyle(Palette.text2)
        }
        .padding(6)
        .background(Palette.surface2, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Palette.line, lineWidth: 1))
    }
}

/// The replies an operator reaches for most, in the order a support desk uses them.
struct EmojiGrid: View {
    static let emojis = [
        "😊", "🙂", "😀", "😁", "😂", "🤣", "😉", "😍", "🥰", "😘",
        "🤗", "🤔", "😅", "😇", "😎", "🥳", "😢", "😔", "😮", "🙏",
        "👍", "👎", "👌", "👏", "🙌", "💪", "🤝", "✌️", "👋", "✅",
        "❌", "⭐", "🔥", "🎉", "❤️", "💙", "💯", "📦", "📞", "📧",
        "⏰", "📍", "💳", "🛒", "🚚", "🎁", "📌", "📝", "⚠️", "ℹ️",
    ]
    var pick: (String) -> Void

    var body: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.fixed(30), spacing: 2), count: 10), spacing: 2) {
            ForEach(Self.emojis, id: \.self) { e in
                Button { pick(e) } label: { Text(e).font(.system(size: 20)).frame(width: 30, height: 30) }
                    .buttonStyle(.borderless)
            }
        }
        .padding(10)
    }
}

/// Saved replies: search, pick, and the text lands in the box.
struct SavedRepliesPicker: View {
    let chat: ChatModel
    @Binding var query: String
    var done: () -> Void
    @Environment(AppModel.self) private var app
    @State private var items: [CannedResponse] = []
    @State private var failed = false
    @State private var loaded = false

    var body: some View {
        let s = app.strings
        VStack(alignment: .leading, spacing: 8) {
            SearchField(prompt: s["searchShortcuts"], text: $query)
            if loaded && (items.isEmpty || failed) {
                Text(failed ? s["shortcutsUnavailableTitle"] : s["shortcutsEmptyTitle"])
                    .appFont(12.5).foregroundStyle(Palette.text2).padding(8)
            }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    ForEach(items) { r in
                        Button {
                            chat.useCanned(r)
                            done()
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 8) {
                                    Text(r.title).appFont(13, .semibold)
                                    Text(r.shortcut).appFont(11.5).foregroundStyle(Palette.brand)
                                }
                                Text(Display.oneLine(r.body)).appFont(12).foregroundStyle(Palette.text2).lineLimit(1)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.vertical, 6)
                            .padding(.horizontal, 8)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .frame(maxHeight: 300)
        }
        .padding(12)
        .frame(width: 360)
        .task(id: query) {
            try? await Task.sleep(nanoseconds: 200_000_000)
            do {
                items = try await chat.cannedResponses(query)
                failed = false
            } catch {
                Log.error("saved replies", error)
                items = []
                failed = true
            }
            loaded = true
        }
    }
}
