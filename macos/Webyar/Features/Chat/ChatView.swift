import SwiftUI
import UniformTypeIdentifiers

/// The detail column of the inbox: the open thread, or a quiet placeholder.
struct ChatView: View {
    let inbox: InboxModel
    @Environment(AppModel.self) private var app

    var body: some View {
        if let chat = inbox.chat {
            ThreadView(chat: chat)
                .id(chat.id)
        } else {
            VStack(spacing: 18) {
                EmptyState(systemImage: "bubble.left.and.text.bubble.right", title: app.strings["noConversationSelected"], message: app.strings["noConversationSelectedBody"])
                CampaignCard(placement: "chat_empty").frame(width: 420)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Palette.chatBackground)
        }
    }
}

/// One thread: the header with the conversation's actions in the toolbar,
/// the messages with their files, the glass reply box, and the details
/// inspector beside it.
struct ThreadView: View {
    let chat: ChatModel
    @Environment(AppModel.self) private var app
    @State private var dropping = false
    /// The whole thread area, details included: the details only show beside a
    /// thread that has room for both, as on Windows (wider than 820).
    @State private var width: CGFloat = 1200

    var body: some View {
        MessagesView(chat: chat)
            .background(Palette.chatBackground)
            .safeAreaInset(edge: .top, spacing: 0) {
                VStack(spacing: 0) {
                ThreadHeader(chat: chat, width: width)
                if let notice = chat.notice {
                    Banner(severity: notice.severity, message: notice.message,
                           actionTitle: notice.retry ? app.strings["retry"] : nil,
                           action: notice.retry ? { chat.retryFailed() } : nil,
                           onClose: { chat.notice = nil })
                        .padding(.horizontal, 14)
                        .padding(.top, 8)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                ComposerView(chat: chat)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 14)
                    .padding(.top, 6)
            }
            .overlay {
                if dropping {
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .strokeBorder(Palette.brand, style: StrokeStyle(lineWidth: 2, dash: [8, 6]))
                        .background(Palette.brand.opacity(0.06), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                        .overlay(Label(app.strings["attachFile"], systemImage: "paperclip").appFont(15, .semibold).foregroundStyle(Palette.brand))
                        .padding(12)
                        .allowsHitTesting(false)
                }
            }
            .onDrop(of: [.fileURL], isTargeted: $dropping) { providers in
                guard !chat.aiMode, let p = providers.first else { return false }
                _ = p.loadObject(ofClass: URL.self) { url, _ in
                    if let url { Task { @MainActor in chat.attach(url: url) } }
                }
                return true
            }
            .animation(.smooth(duration: 0.2), value: chat.notice)
            .inspector(isPresented: Binding(get: { app.settings.detailsOpen && width > 820 }, set: { app.settings.detailsOpen = $0; app.saveSettings() })) {
                DetailsPanel(chat: chat)
                    .inspectorColumnWidth(min: 260, ideal: 290, max: 380)
            }
            .background {
                GeometryReader { g in
                    Color.clear
                        .onAppear { width = g.size.width }
                        .onChange(of: g.size.width) { _, w in width = w }
                }
            }
    }
}

// MARK: - Header

struct ThreadHeader: View {
    let chat: ChatModel
    /// The thread area's width: the action labels fold into icons when it is narrow.
    var width: CGFloat
    @Environment(AppModel.self) private var app

    var body: some View {
        let s = app.strings
        let c = chat.conversation
        HStack(spacing: 12) {
            AvatarView(name: c?.contacts?.name, email: c?.contacts?.email, os: c?.visitorOs, countryCode: c?.visitorCountryCode,
                       imageURL: c?.contacts?.avatarUrl, size: 40, presence: c?.status)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(c.map { Display.conversationName($0, s) } ?? s["unknownVisitor"]).appFont(14.5, .bold).lineLimit(1)
                    if let c { chips(c, s) }
                }
                if let c {
                    let sub = [c.contacts?.email, app.assigneeName(c.assignedTo)].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
                    Text(sub).appFont(11.5).foregroundStyle(Palette.text2).lineLimit(1)
                }
            }
            .layoutPriority(1)
            Spacer(minLength: 8)
            if let c { actions(c, s) }
            Button {
                app.settings.detailsOpen.toggle()
                app.saveSettings()
            } label: {
                Image(systemName: "sidebar.trailing").frame(width: 18, height: 18)
            }
            .glassButton()
            .buttonBorderShape(.circle)
            .help(s["details"])
            .keyboardShortcut("i", modifiers: [.command, .option])
            .disabled(width <= 820)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .glassCard(18)
        .padding(.horizontal, 12)
        .padding(.top, 8)
    }

    @ViewBuilder private func chips(_ c: Conversation, _ s: Strings) -> some View {
        let st = Palette.status(c.status)
        Chip(text: Display.statusLabel(c.status, s), foreground: st.0, background: st.1)
        if [ConversationPriority.high, ConversationPriority.urgent, ConversationPriority.low].contains(c.priority ?? "") {
            let p = Palette.priority(c.priority)
            Chip(text: Display.priorityLabel(c.priority, s), foreground: p.0, background: p.1)
        }
        if c.isAiManaged {
            Chip(text: s["navInboxAi"], foreground: Palette.ai, background: Palette.aiSoft, systemImage: "sparkles")
        }
    }

    @ViewBuilder private func actions(_ c: Conversation, _ s: Strings) -> some View {
        let wide = width > 900
        // No calls while the AI has the visitor, and only what the plan allows.
        let calls = app.config.callsEnabled && !c.isResolved && !c.isAiManaged
        GlassGroup(spacing: 6) {
            HStack(spacing: 6) {
                if calls && app.plan.voiceCalls {
                    Button { CallCoordinator.shared.start(app: app, conversation: c, channel: "audio") } label: {
                        Image(systemName: "phone").frame(width: 18, height: 18)
                    }
                    .glassButton()
                    .buttonBorderShape(.circle)
                    .help(s["voiceCall"])
                }
                if calls && app.plan.videoCalls {
                    Button { CallCoordinator.shared.start(app: app, conversation: c, channel: "video") } label: {
                        Image(systemName: "video").frame(width: 18, height: 18)
                    }
                    .glassButton()
                    .buttonBorderShape(.circle)
                    .help(s["videoCall"])
                }
                if !c.isResolved && (c.isAiManaged || c.assignedTo != app.user?.id) && app.user != nil {
                    Button { chat.assignToMe() } label: {
                        Label(c.isAiManaged ? s["takeOver"] : s["assignToMe"], systemImage: c.isAiManaged ? "person.wave.2" : "person.badge.plus")
                            .labelStyle(AdaptiveLabelStyle(showTitle: wide))
                    }
                    .glassButton()
                    .help(c.isAiManaged ? s["takeOver"] : s["assignToMe"])
                    .disabled(chat.busy)
                }
                Button { chat.toggleStatus() } label: {
                    Label(c.isResolved ? s["reopen"] : s["markResolved"], systemImage: c.isResolved ? "arrow.uturn.backward" : "checkmark")
                        .labelStyle(AdaptiveLabelStyle(showTitle: wide))
                }
                .prominentButton(tint: c.isResolved ? Palette.brand : Palette.success)
                .help(c.isResolved ? s["reopen"] : s["markResolved"])
                .disabled(chat.busy)
                .keyboardShortcut("e", modifiers: [.command, .shift])
                ConversationMenu(chat: chat, conversation: c)
            }
        }
    }
}

/// Icon and title, or the icon alone when there is no room.
struct AdaptiveLabelStyle: LabelStyle {
    var showTitle: Bool
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 6) {
            configuration.icon
            if showTitle { configuration.title }
        }
    }
}

/// Priority, transfer and unassign — the "more" menu.
struct ConversationMenu: View {
    let chat: ChatModel
    let conversation: Conversation
    @Environment(AppModel.self) private var app
    @State private var members: [WorkspaceMember] = []

    var body: some View {
        let s = app.strings
        let c = conversation
        Menu {
            Menu {
                ForEach(ConversationPriority.all, id: \.self) { p in
                    Toggle(Display.priorityLabel(p, s), isOn: Binding(get: { (c.priority ?? ConversationPriority.normal) == p }, set: { _ in chat.setPriority(p) }))
                }
            } label: { Label(s["changePriority"], systemImage: "flag") }
            Menu {
                let active = members.filter { $0.suspendedAt == nil }
                if active.isEmpty { Text(s["noResults"]) }
                ForEach(active) { m in
                    Toggle(m.displayName, isOn: Binding(get: { m.userId == c.assignedTo }, set: { _ in chat.transfer(to: m.userId) }))
                }
            } label: { Label(s["transferConversation"], systemImage: "arrow.left.arrow.right") }
            if c.assignedTo != nil {
                Button { chat.unassign() } label: { Label(s["unassigned"], systemImage: "person.crop.circle.badge.xmark") }
            }
        } label: {
            Image(systemName: "ellipsis").frame(width: 18, height: 18)
        }
        .menuIndicator(.hidden)
        .glassButton()
        .buttonBorderShape(.circle)
        .fixedSize()
        .help(s["conversationActions"])
        .task { members = (try? await app.loadMembers()) ?? [] }
    }
}

// MARK: - Messages

struct MessagesView: View {
    let chat: ChatModel
    @Environment(AppModel.self) private var app

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 2) {
                    ForEach(chat.rows) { row in
                        MessageRowView(row: row, conversation: chat.conversation)
                            .id(row.id)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 12)
                // Bubbles sit left/right physically, as the web thread; text inside follows its own direction.
                .environment(\.layoutDirection, .leftToRight)
            }
            .defaultScrollAnchor(.bottom)
            .overlay { if chat.loading && chat.rows.isEmpty { ProgressView() } }
            .onChange(of: chat.rows.last?.id) { _, id in
                if let id { withAnimation(.smooth(duration: 0.25)) { proxy.scrollTo(id, anchor: .bottom) } }
            }
        }
    }
}

struct MessageRowView: View {
    let row: ChatRow
    let conversation: Conversation?
    @Environment(AppModel.self) private var app

    var body: some View {
        switch row.side {
        case .day:
            HStack(spacing: 12) {
                line
                Text(row.body).appFont(11, .semibold).foregroundStyle(Palette.text3)
                line
            }
            .padding(.top, 14)
            .padding(.bottom, 8)
        case .system:
            Text(row.body)
                .appFont(11.5)
                .foregroundStyle(Palette.text2)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 12)
                .padding(.vertical, 5)
                .glassCapsule()
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity)
        case .incoming:
            HStack(alignment: .bottom, spacing: 10) {
                avatarSlot {
                    AvatarView(name: row.avatarName, email: conversation?.contacts?.email, os: conversation?.visitorOs,
                               imageURL: row.avatarURL, size: 30)
                }
                bubbleStack(outgoing: false)
                Spacer(minLength: 60)
            }
        case .outgoing:
            HStack(alignment: .bottom, spacing: 10) {
                Spacer(minLength: 60)
                bubbleStack(outgoing: true)
                avatarSlot {
                    AvatarView(name: row.avatarName, imageURL: row.avatarURL, size: 30, kind: row.isAi ? .ai : .operator)
                }
            }
            .opacity(row.pending ? 0.6 : 1)
        }
    }

    private var line: some View { Rectangle().fill(Palette.line).frame(height: 1) }

    @ViewBuilder private func avatarSlot<A: View>(@ViewBuilder _ avatar: () -> A) -> some View {
        ZStack {
            if row.showAvatar { avatar() }
        }
        .frame(width: 30)
        .padding(.bottom, row.showMeta ? 20 : 0)
    }

    private func bubbleStack(outgoing: Bool) -> some View {
        VStack(alignment: outgoing ? .trailing : .leading, spacing: 4) {
            if outgoing && row.isAi {
                Label(row.senderName, systemImage: "sparkles").appFont(10.5, .semibold).foregroundStyle(Palette.ai).padding(.horizontal, 8)
            }
            ForEach(row.attachments) { a in
                AttachmentView(attachment: a, outgoing: outgoing)
            }
            if !row.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                bubble(outgoing: outgoing)
            }
            if row.showMeta {
                HStack(spacing: 4) {
                    if row.failed { Image(systemName: "exclamationmark.circle.fill").foregroundStyle(Palette.danger) }
                    if row.pending { Image(systemName: "clock").font(.system(size: 9)) }
                    Text(row.meta)
                }
                .appFont(10.5)
                .foregroundStyle(row.failed ? Palette.danger : Palette.text3)
                .padding(.horizontal, 8)
                .padding(.bottom, 4)
            }
        }
        .frame(maxWidth: 560, alignment: outgoing ? .trailing : .leading)
    }

    private func bubble(outgoing: Bool) -> some View {
        let shape = UnevenRoundedRectangle(topLeadingRadius: 18, bottomLeadingRadius: outgoing ? 18 : 6, bottomTrailingRadius: outgoing ? 6 : 18, topTrailingRadius: 18, style: .continuous)
        let rtl = Display.isRightToLeft(firstStrong(row.body))
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
    private func firstStrong(_ s: String) -> String {
        for ch in s where ch.isLetter { return String(ch) }
        return ""
    }
}

// MARK: - Attachments

struct AttachmentView: View {
    let attachment: AttachmentInfo
    let outgoing: Bool
    @Environment(AppModel.self) private var app
    @State private var image: NSImage?

    var body: some View {
        Group {
            if attachment.isImage {
                photo
            } else if attachment.isAudio {
                AudioPlayerView(attachment: attachment, outgoing: outgoing)
            } else {
                file
            }
        }
        .contextMenu {
            Button(app.strings["openFile"]) { open() }
            Button(app.strings["save"] + "…") { Task { await AttachmentStore.shared.save(attachment) } }
        }
    }

    private var photo: some View {
        let size = fit(image?.size)
        return Button(action: open) {
            ZStack {
                RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Palette.elevated)
                if let image {
                    Image(nsImage: image).resizable().scaledToFill()
                } else {
                    Image(systemName: "photo").font(.system(size: 22)).foregroundStyle(Palette.text3)
                }
            }
            .frame(width: size.width, height: size.height)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Palette.bubbleIncomingBorder, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .task(id: attachment.id) {
            if let cached = AttachmentStore.shared.cachedImage(attachment.id) { image = cached; return }
            image = await AttachmentStore.shared.image(attachment.id)
        }
    }

    /// A fixed box in the photo's own proportions, at most 320 either way.
    private func fit(_ s: CGSize?) -> CGSize {
        guard let s, s.width > 0, s.height > 0 else { return CGSize(width: 240, height: 180) }
        let scale = min(1, min(320 / s.width, 320 / s.height))
        return CGSize(width: max(120, (s.width * scale).rounded()), height: max(90, (s.height * scale).rounded()))
    }

    private var file: some View {
        Button(action: open) {
            HStack(spacing: 12) {
                Image(systemName: attachment.systemImage)
                    .font(.system(size: 17))
                    .foregroundStyle(outgoing ? Color.white : Palette.brand)
                    .frame(width: 42, height: 42)
                    .background(outgoing ? Color.white.opacity(0.2) : Palette.brandSoft, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text(attachment.fileName).appFont(12.5, .semibold).lineLimit(1).truncationMode(.middle)
                    if !attachment.sizeText.isEmpty { Text(attachment.sizeText).appFont(11).opacity(0.7) }
                }
                Spacer(minLength: 4)
                Image(systemName: "arrow.down.circle").font(.system(size: 15))
            }
            .foregroundStyle(outgoing ? Color.white : Palette.text)
            .padding(10)
            .frame(width: 272)
            .background {
                let shape = RoundedRectangle(cornerRadius: 14, style: .continuous)
                if outgoing { shape.fill(Palette.bubbleOutgoing) } else { shape.fill(Palette.bubbleIncoming).overlay(shape.strokeBorder(Palette.bubbleIncomingBorder, lineWidth: 1)) }
            }
        }
        .buttonStyle(.plain)
    }

    private func open() {
        Task {
            do { try await AttachmentStore.shared.open(attachment) } catch { Log.error("open attachment", error) }
        }
    }
}
