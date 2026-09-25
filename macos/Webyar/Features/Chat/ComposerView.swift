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
                TextField(s[ai ? "sayNowPlaceholder" : "composerPlaceholder"], text: $chat.draft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .appFont(14)
                    .lineLimit(1...8)
                    .readingSide(s.isRightToLeft)
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
                if ai {
                    Button { chat.send() } label: {
                        Image(systemName: "sparkles")
                            .font(.system(size: 14, weight: .semibold))
                            .frame(width: 22, height: 22)
                    }
                    .prominentButton(tint: Palette.ai)
                    .buttonBorderShape(.circle)
                    .controlSize(.large)
                    .disabled(!chat.canSend || chat.busy)
                    .help(s["sayNowAction"])
                    .padding(.leading, 4)
                } else {
                    SplitSendButton(action: chat.sendAction, enabled: chat.canSend && !chat.busy && !chat.recorder.isRecording,
                                    send: { chat.send() },
                                    choose: { a in
                                        chat.sendAction = a
                                        // Picking an action with a reply ready sends it at once, as on the web.
                                        if chat.canSend && !chat.busy && !chat.recorder.isRecording { chat.send(then: a) }
                                    })
                        .padding(.leading, 4)
                }
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

    /// A file or an image pasted into the box goes into the card, like a picked one (when files are allowed).
    private func paste(_ providers: [NSItemProvider]) {
        guard !chat.aiMode, app.plan.attachments, let p = providers.first else { return }
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

/// The web inbox's split Send: the main half sends and then does the chosen
/// action (nothing, wait for the customer, or resolve); the chevron picks it.
struct SplitSendButton: View {
    let action: PostSendAction
    let enabled: Bool
    let send: () -> Void
    var choose: ((PostSendAction) -> Void)? = nil
    @Environment(AppModel.self) private var app
    @State private var hovering = false

    static func icon(_ a: PostSendAction) -> String {
        switch a {
        case .none: return "paperplane.fill"
        case .waitForCustomer: return "clock.fill"
        case .resolve: return "checkmark.circle.fill"
        }
    }

    static func key(_ a: PostSendAction) -> String {
        switch a {
        case .none: return "sendOnly"
        case .waitForCustomer: return "sendAndWait"
        case .resolve: return "sendAndResolve"
        }
    }

    var body: some View {
        let s = app.strings
        HStack(spacing: 0) {
            Button(action: send) {
                HStack(spacing: 6) {
                    Image(systemName: Self.icon(action))
                        .font(.system(size: 12.5, weight: .semibold))
                        .scaleEffect(x: action == .none && s.isRightToLeft ? -1 : 1)
                    Text(s[Self.key(action) + "Short"]).appFont(12.5, .semibold).lineLimit(1)
                }
                .padding(.leading, 13)
                .padding(.trailing, choose == nil ? 14 : 10)
                .frame(height: 34)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!enabled)
            .help("\(s[Self.key(action)]) — \(s[Self.key(action) + "Hint"])")
            if let choose { menu(choose, s) }
        }
        .foregroundStyle(.white)
        .background(
            Capsule().fill(LinearGradient(colors: [Palette.brand.opacity(hovering && enabled ? 0.92 : 1), Palette.brand],
                                          startPoint: .top, endPoint: .bottom))
        )
        .clipShape(Capsule())
        .shadow(color: Palette.brand.opacity(enabled ? 0.28 : 0), radius: 4, y: 2)
        .opacity(enabled ? 1 : 0.55)
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.12), value: enabled)
    }

    @ViewBuilder private func menu(_ choose: @escaping (PostSendAction) -> Void, _ s: Strings) -> some View {
        Rectangle().fill(Color.white.opacity(0.3)).frame(width: 1, height: 18)
        Menu {
            Section(s["sendActions"]) {
                ForEach(PostSendAction.allCases) { a in
                    Button { choose(a) } label: {
                        Label(s[Self.key(a)], systemImage: a == action ? "checkmark" : Self.icon(a))
                    }
                    .help(s[Self.key(a) + "Hint"])
                }
            }
        } label: {
            Image(systemName: "chevron.up")
                .font(.system(size: 10, weight: .bold))
                .frame(width: 28, height: 34)
                .contentShape(Rectangle())
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .help(s["sendActions"])
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
