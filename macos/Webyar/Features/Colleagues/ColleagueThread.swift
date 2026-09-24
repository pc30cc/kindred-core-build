import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// The detail column of the colleagues page: the chat with one colleague,
/// or a quiet placeholder until one is picked.
struct ColleagueThread: View {
    let model: ColleaguesModel
    @Environment(AppModel.self) private var app

    var body: some View {
        if let peer = model.peer {
            TeamThreadView(model: model, peer: peer)
                .id(peer.userId)
        } else {
            EmptyState(systemImage: "person.2", title: app.strings["noColleagueSelected"], message: app.strings["noColleagueSelectedBody"])
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Palette.chatBackground)
        }
    }
}

/// One colleague: who they are and their presence in the toolbar, the
/// messages with their files, and the glass composer card — the same bubbles
/// and card as the visitor thread.
struct TeamThreadView: View {
    let model: ColleaguesModel
    let peer: Colleague
    @Environment(AppModel.self) private var app
    @State private var dropping = false

    var body: some View {
        TeamMessagesView(model: model, peer: peer)
            .background(Palette.chatBackground)
            .safeAreaInset(edge: .top, spacing: 0) {
                VStack(spacing: 0) {
                    headerBar
                    noticeBar
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                TeamComposer(model: model)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 14)
                    .padding(.top, 6)
            }
            .overlay { dropOverlay }
            .onDrop(of: [.fileURL], isTargeted: $dropping) { providers in drop(providers) }
            .animation(.smooth(duration: 0.2), value: model.notice)
    }

    /// Who, and how to reach them: a glass bar over the thread, like the visitor thread's.
    private var headerBar: some View {
        HStack(spacing: 12) {
            ColleagueHeader(peer: peer, presence: model.presence(of: peer.userId))
            Spacer(minLength: 8)
            if !(peer.email ?? "").isEmpty {
                Button { model.mail() } label: { Image(systemName: "envelope").frame(width: 18, height: 18) }
                    .glassButton()
                    .buttonBorderShape(.circle)
                    .help(app.strings["contactSendEmail"])
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .glassCard(18)
        .padding(.horizontal, 12)
        .padding(.top, 8)
    }

    @ViewBuilder private var noticeBar: some View {
        if let notice = model.notice {
            let s = app.strings
            Banner(severity: .error, message: notice.message,
                   actionTitle: notice.micSettings ? s["openWindowsSettings"] : nil,
                   action: notice.micSettings ? { model.openMicrophoneSettings() } : nil,
                   onClose: { model.notice = nil })
                .padding(.horizontal, 14)
                .padding(.top, 8)
                .transition(.move(edge: .top).combined(with: .opacity))
        }
    }

    @ViewBuilder private var dropOverlay: some View {
        if dropping {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(Palette.brand, style: StrokeStyle(lineWidth: 2, dash: [8, 6]))
                .background(Palette.brand.opacity(0.06), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .overlay(Label(app.strings["attachFile"], systemImage: "paperclip").appFont(15, .semibold).foregroundStyle(Palette.brand))
                .padding(12)
                .allowsHitTesting(false)
        }
    }

    /// A file dropped on the thread goes into the card, like a picked one (when the plan allows files).
    private func drop(_ providers: [NSItemProvider]) -> Bool {
        guard app.plan.attachments, !model.recorder.isRecording, let p = providers.first else { return false }
        let target = model
        _ = p.loadObject(ofClass: URL.self) { url, _ in
            if let url { Task { @MainActor in target.attach(url: url) } }
        }
        return true
    }
}

// MARK: - Header

struct ColleagueHeader: View {
    let peer: Colleague
    let presence: String
    @Environment(AppModel.self) private var app

    var body: some View {
        let s = app.strings
        let role = ColleaguesModel.roleLabel(peer.role, s)
        HStack(spacing: 10) {
            AvatarView(name: peer.displayName, imageURL: peer.avatarUrl, size: 32, kind: .operator, presence: presence)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(peer.displayName).appFont(13.5, .bold).lineLimit(1)
                    if !role.isEmpty { Chip(text: role) }
                }
                HStack(spacing: 5) {
                    Circle().fill(dotColor).frame(width: 7, height: 7)
                    Text(app.presenceLabel(presence)).appFont(11).foregroundStyle(Palette.text2).lineLimit(1)
                    if let mail = peer.email, !mail.isEmpty {
                        Text("· " + mail)
                            .appFont(11)
                            .foregroundStyle(Palette.text3)
                            .lineLimit(1)
                            .textSelection(.enabled)
                            .environment(\.layoutDirection, .leftToRight)
                    }
                }
            }
        }
    }

    private var dotColor: Color {
        switch presence {
        case PresenceState.active: return Palette.success
        case PresenceState.away: return Palette.warning
        default: return Palette.text3
        }
    }
}

// MARK: - Messages

struct TeamMessagesView: View {
    let model: ColleaguesModel
    let peer: Colleague
    @Environment(AppModel.self) private var app

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 2) {
                    ForEach(model.rows) { row in
                        TeamMessageRow(row: row, peer: peer)
                            .id(row.id)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 12)
                // Bubbles sit left/right physically, as the web thread; text inside follows its own direction.
                .environment(\.layoutDirection, .leftToRight)
            }
            .defaultScrollAnchor(.bottom)
            .overlay { emptyOverlay }
            .onChange(of: model.rows.last?.id) { _, id in
                if let id { withAnimation(.smooth(duration: 0.25)) { proxy.scrollTo(id, anchor: .bottom) } }
            }
        }
    }

    @ViewBuilder private var emptyOverlay: some View {
        if model.rows.isEmpty {
            if model.threadLoading {
                ProgressView()
            } else {
                VStack(spacing: 10) {
                    Image(systemName: "bubble.left.and.bubble.right")
                        .font(.system(size: 22))
                        .foregroundStyle(Palette.text3)
                        .frame(width: 64, height: 64)
                        .background(Palette.elevated, in: RoundedRectangle(cornerRadius: 17, style: .continuous))
                    Text(app.strings["colleagueThreadEmpty"])
                        .appFont(12.5)
                        .foregroundStyle(Palette.text2)
                        .multilineTextAlignment(.center)
                }
                .padding(24)
            }
        }
    }
}

/// A bubble from me (end side, no avatar) or from the colleague (their
/// avatar under the last bubble of a run), or the line between days.
struct TeamMessageRow: View {
    let row: ChatRow
    let peer: Colleague
    @Environment(AppModel.self) private var app

    var body: some View {
        switch row.side {
        case .day:
            HStack(spacing: 12) {
                line
                Text(row.body)
                    .appFont(11, .semibold)
                    .foregroundStyle(Palette.text3)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 3)
                    .background(Palette.elevated, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                line
            }
            .padding(.top, 14)
            .padding(.bottom, 8)
        case .incoming:
            HStack(alignment: .bottom, spacing: 10) {
                ZStack {
                    if row.showAvatar {
                        AvatarView(name: peer.displayName, imageURL: peer.avatarUrl, size: 30, kind: .operator)
                    }
                }
                .frame(width: 30)
                .padding(.bottom, row.showMeta ? 20 : 0)
                bubbleStack(outgoing: false)
                Spacer(minLength: 60)
            }
        case .outgoing:
            HStack(alignment: .bottom, spacing: 10) {
                Spacer(minLength: 60)
                bubbleStack(outgoing: true)
            }
            .opacity(row.pending ? 0.6 : 1)
        case .system:
            EmptyView()
        }
    }

    private var line: some View { Rectangle().fill(Palette.line).frame(height: 1) }

    private func bubbleStack(outgoing: Bool) -> some View {
        VStack(alignment: outgoing ? .trailing : .leading, spacing: 4) {
            ForEach(row.attachments) { a in
                AttachmentView(attachment: a, outgoing: outgoing)
            }
            if !row.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                bubble(outgoing: outgoing)
            }
            if row.showMeta {
                HStack(spacing: 4) {
                    if row.pending { Image(systemName: "clock").font(.system(size: 9)) }
                    Text(row.meta)
                }
                .appFont(10.5)
                .foregroundStyle(Palette.text3)
                .padding(.horizontal, 8)
                .padding(.bottom, 4)
            }
        }
        .frame(maxWidth: 520, alignment: outgoing ? .trailing : .leading)
    }

    private func bubble(outgoing: Bool) -> some View {
        let shape = UnevenRoundedRectangle(topLeadingRadius: 18, bottomLeadingRadius: outgoing ? 18 : 6, bottomTrailingRadius: outgoing ? 6 : 18, topTrailingRadius: 18, style: .continuous)
        let rtl = Display.isRightToLeft(Self.firstStrong(row.body))
        return Text(row.body)
            .appFont(13.5)
            .lineSpacing(3)
            .textSelection(.enabled)
            .multilineTextAlignment(rtl ? .trailing : .leading)
            .environment(\.layoutDirection, rtl ? .rightToLeft : .leftToRight)
            .foregroundStyle(outgoing ? Color.white : Palette.text)
            .padding(.horizontal, 14)
            .padding(.top, 8)
            .padding(.bottom, 9)
            .background {
                if outgoing {
                    shape.fill(Palette.bubbleOutgoing)
                } else {
                    shape.fill(Palette.bubbleIncoming).overlay(shape.strokeBorder(Palette.bubbleIncomingBorder, lineWidth: 1))
                }
            }
            .contextMenu {
                Button(app.strings["copy"]) {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(row.body, forType: .string)
                }
            }
    }

    /// The first letter that has a direction decides how a message lays out.
    private static func firstStrong(_ s: String) -> String {
        for ch in s where ch.isLetter { return String(ch) }
        return ""
    }
}

// MARK: - Composer

/// The same card as the visitor thread: text on top; files, emoji, the
/// hint, voice recording and Send below. Files, voice notes and emoji
/// follow the plan, as in the iOS team thread.
struct TeamComposer: View {
    let model: ColleaguesModel
    @Environment(AppModel.self) private var app
    @FocusState private var focused: Bool
    @State private var showEmoji = false
    @State private var picking = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let file = model.pendingFile {
                PendingFileChip(name: file.name, mime: file.mime, data: file.data) { model.clearPendingFile() }
                    .padding([.horizontal, .top], 10)
            }
            if model.recorder.isRecording {
                recordBar
            } else {
                editor
            }
            tools
        }
        .glassCard(20, tint: focused ? Palette.brand.opacity(0.05) : nil)
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(focused ? Palette.brand.opacity(0.55) : .clear, lineWidth: 1.2))
        .animation(.smooth(duration: 0.18), value: focused)
        .fileImporter(isPresented: $picking, allowedContentTypes: [.item]) { result in
            if case .success(let url) = result { model.attach(url: url) }
            focused = true
        }
        .onAppear { focused = true }
        .onChange(of: model.recorder.isRecording) { _, on in
            if !on { focused = true }
        }
    }

    private var editor: some View {
        let draft = Binding<String>(get: { model.draft }, set: { model.draft = $0 })
        return TextField(app.strings["messagePlaceholder"], text: draft, axis: .vertical)
            .textFieldStyle(.plain)
            .appFont(14)
            .lineLimit(1...8)
            .focused($focused)
            .padding(.horizontal, 16)
            .padding(.top, 13)
            .padding(.bottom, 6)
            .onKeyPress(.return, phases: .down) { press in
                // Enter sends; Shift+Enter starts a new line.
                if press.modifiers.contains(.shift) || press.modifiers.contains(.option) {
                    model.draft += "\n"
                    return .handled
                }
                model.send()
                return .handled
            }
    }

    private var recordBar: some View {
        let elapsed = model.recorder.elapsed
        return HStack(spacing: 10) {
            Circle().fill(Palette.danger).frame(width: 10, height: 10)
                .opacity(Int(elapsed * 2) % 2 == 0 ? 1 : 0.25)
            Text(Self.timeText(elapsed)).appFont(14, .semibold).monospacedDigit()
                .environment(\.layoutDirection, .leftToRight)
            Text(app.strings["voiceRecording"]).appFont(12.5).foregroundStyle(Palette.text2).lineLimit(1)
            Spacer()
        }
        .padding(.horizontal, 16)
        .frame(minHeight: 46)
        .onChange(of: Int(elapsed)) { _, secs in
            // Voice notes are short: five minutes at most.
            if secs >= 300 { model.stopRecording(keep: true) }
        }
    }

    private var tools: some View {
        let s = app.strings
        let plan = app.plan
        let recording = model.recorder.isRecording
        return HStack(spacing: 2) {
            if plan.attachments {
                tool("paperclip", s["attachFile"]) { picking = true }
                    .disabled(recording)
            }
            if plan.emoji {
                tool("face.smiling", s["emoji"]) { showEmoji.toggle() }
                    .disabled(recording)
                    .popover(isPresented: $showEmoji, arrowEdge: .top) {
                        EmojiGrid { e in
                            model.draft += e
                            showEmoji = false
                            focused = true
                        }
                    }
            }
            Spacer(minLength: 8)
            if !recording {
                Text(s["composerHint"]).appFont(11).foregroundStyle(Palette.text3).lineLimit(1)
                    .padding(.horizontal, 6)
            }
            if recording {
                tool("trash", s["voiceDiscard"], tint: Palette.danger) { model.stopRecording(keep: false) }
            }
            if plan.voiceNotes {
                tool(recording ? "stop.fill" : "mic", s[recording ? "voiceStop" : "voiceRecord"],
                     tint: recording ? Palette.danger : nil) { model.toggleRecording() }
            }
            sendButton
        }
        .padding(.horizontal, 8)
        .padding(.bottom, 8)
    }

    private var sendButton: some View {
        let s = app.strings
        return Button { model.send() } label: {
            Image(systemName: "paperplane.fill")
                .font(.system(size: 14, weight: .semibold))
                .scaleEffect(x: s.isRightToLeft ? -1 : 1)
                .frame(width: 22, height: 22)
        }
        .prominentButton(tint: Palette.brand)
        .buttonBorderShape(.circle)
        .controlSize(.large)
        .disabled(!model.canSend)
        .help(s["send"])
        .padding(.leading, 4)
    }

    private func tool(_ icon: String, _ help: String, tint: Color? = nil, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon).font(.system(size: 15)).frame(width: 30, height: 30).contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .foregroundStyle(tint ?? Palette.text2)
        .help(help)
    }

    private static func timeText(_ t: TimeInterval) -> String {
        let s = Int(t)
        return "\(s / 60):" + String(format: "%02d", s % 60)
    }
}
