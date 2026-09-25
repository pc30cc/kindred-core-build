import SwiftUI

/// The conversation list, as in the web console and the Windows app: avatar
/// with the visitor's OS and flag, name, last message, time, AI and priority
/// marks, and the unread count.
struct InboxList: View {
    let model: InboxModel
    let route: Route
    @Environment(AppModel.self) private var app

    var body: some View {
        @Bindable var model = model
        let s = app.strings
        let list = model.visible
        VStack(spacing: 0) {
            header
            SearchField(prompt: s["search"], text: $model.search)
                .padding(.horizontal, 12)
                .padding(.bottom, 8)
            ZStack {
                ScrollViewReader { proxy in
                    List {
                        ForEach(list) { c in
                            ConversationRow(conversation: c, selected: c.id == model.selectedId)
                                .onTapGesture { model.select(c.id) }
                                .listRowSeparator(.hidden)
                                .listRowInsets(EdgeInsets(top: 2, leading: 6, bottom: 2, trailing: 6))
                        }
                    }
                    .listStyle(.inset)
                    .scrollContentBackground(.hidden)
                    .animation(.smooth(duration: 0.2), value: list.map(\.id))
                    .arrowKeyPicking(list.map(\.id), selected: model.selectedId, proxy: proxy, select: { model.select($0) })
                }

                if model.loading && list.isEmpty {
                    ProgressView().controlSize(.regular)
                } else if list.isEmpty {
                    EmptyState(systemImage: "tray", title: s["inboxEmptyTitle"], message: s["inboxEmptyBody"])
                }
            }
            if let error = model.error {
                Banner(severity: .warning, message: error, actionTitle: s["retry"], action: { model.refresh() })
                    .padding(8)
            }
            CampaignCard(placement: "inbox_list").padding(8)
        }
        .onAppear { model.show(route) }
        .onChange(of: route) { _, r in model.show(r) }
        .onChange(of: app.pendingConversation) { _, id in
            if let id {
                app.pendingConversation = nil
                model.open(id)
            }
        }
        .onAppear {
            if let id = app.pendingConversation {
                app.pendingConversation = nil
                model.open(id)
            }
        }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Text(model.title).appFont(20, .bold).lineLimit(1)
            if model.unreadConversations > 0 {
                Chip(text: app.strings.number(model.unreadConversations), foreground: Palette.brand, background: Palette.brandSoft)
            }
            Spacer()
            Button { model.refresh() } label: { Image(systemName: "arrow.clockwise") }
                .buttonStyle(.borderless)
                .help(app.strings["refresh"])
                .keyboardShortcut("r", modifiers: .command)
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 8)
    }
}

struct ConversationRow: View {
    let conversation: Conversation
    var selected = false
    @Environment(AppModel.self) private var app

    var body: some View {
        let c = conversation
        let s = app.strings
        let unread = max(0, c.unreadCount ?? 0)
        let urgent = c.priority == ConversationPriority.high || c.priority == ConversationPriority.urgent
        HStack(alignment: .center, spacing: 12) {
            AvatarView(name: c.contacts?.name, email: c.contacts?.email, os: c.visitorOs, countryCode: c.visitorCountryCode,
                       imageURL: c.contacts?.avatarUrl, size: 44, presence: c.status)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    Text(Display.conversationName(c, s))
                        .appFont(13.5, unread > 0 ? .bold : .semibold)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    if let when = c.lastActivity {
                        TimelineView(.periodic(from: .now, by: 60)) { ctx in
                            Text(Display.listStamp(when, now: ctx.date, s)).appFont(11).foregroundStyle(Palette.text3)
                        }
                    }
                }
                HStack(spacing: 6) {
                    Text(Display.preview(c.lastMessage, s))
                        .appFont(12.5)
                        .foregroundStyle(unread > 0 ? Palette.text : Palette.text2)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    if c.isAiManaged {
                        Image(systemName: "sparkles").font(.system(size: 9, weight: .bold)).foregroundStyle(Palette.ai)
                            .padding(.horizontal, 6).padding(.vertical, 2.5)
                            .background(Palette.aiSoft, in: Capsule())
                    }
                    if urgent {
                        Chip(text: Display.priorityLabel(c.priority, s), foreground: Palette.danger, background: Palette.dangerSoft)
                    }
                    if unread > 0 {
                        Text(Digits.localize(unread > 99 ? "99+" : String(unread), s.language))
                            .appFont(10.5, .bold)
                            .foregroundStyle(.white)
                            .padding(.horizontal, 6)
                            .frame(minWidth: 20, minHeight: 20)
                            .background(Palette.brand, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                    }
                }
            }
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 2)
        .selectableRow(selected)
    }
}
