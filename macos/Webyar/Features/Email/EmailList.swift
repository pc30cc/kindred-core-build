import SwiftUI

/// The mailbox: folders, search, and the threads — sender, subject, the
/// first line, when, a star, and bold while unread.
struct EmailList: View {
    let model: EmailModel
    @Environment(AppModel.self) private var app

    var body: some View {
        @Bindable var model = model
        let s = app.strings
        VStack(spacing: 0) {
            header
            SearchField(prompt: s["emailSearch"], text: $model.search)
                .onChange(of: model.search) { _, _ in model.searchChanged() }
                .padding(.horizontal, 12)
                .padding(.bottom, 8)
            // A segmented control keeps its order in either direction; read right to left, it starts on the right.
            Picker("", selection: $model.folder) {
                ForEach(s.isRightToLeft ? EmailFolder.allCases.reversed() : EmailFolder.allCases, id: \.self) { f in
                    Text(folderTitle(f)).tag(f)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(.horizontal, 12)
            .padding(.bottom, 8)
            Divider()
            ZStack {
                List(selection: Binding(get: { model.selectedId }, set: { model.select($0) })) {
                    ForEach(model.threads) { t in
                        EmailRow(thread: t, me: model.connection?.emailAddress, model: model)
                            .tag(t.id)
                            .listRowSeparator(.hidden)
                            .listRowInsets(EdgeInsets(top: 1, leading: 6, bottom: 1, trailing: 6))
                    }
                    if model.nextBefore != nil && !model.threads.isEmpty {
                        HStack {
                            Spacer()
                            if model.loadingMore {
                                ProgressView().controlSize(.small)
                            } else {
                                Button(s["emailLoadMore"]) { model.loadMore() }.buttonStyle(.link)
                            }
                            Spacer()
                        }
                        .padding(.vertical, 8)
                        .listRowSeparator(.hidden)
                        .onAppear { model.loadMore() }
                    }
                }
                .listStyle(.inset)
                .scrollContentBackground(.hidden)
                .animation(.smooth(duration: 0.2), value: model.threads.map(\.id))
                placeholder
            }
            if let error = model.error {
                Banner(severity: .warning, message: error, actionTitle: s["retry"], action: { model.refresh() })
                    .padding(8)
            }
        }
        .onAppear { model.start() }
    }

    private func folderTitle(_ f: EmailFolder) -> String {
        switch f {
        case .all: app.strings["emailFolderAll"]
        case .unread: app.strings["emailFolderUnread"]
        case .starred: app.strings["emailFolderStarred"]
        }
    }

    private var header: some View {
        let s = app.strings
        return VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 8) {
                Text(s["emailInbox"]).appFont(20, .bold)
                if model.unreadCount > 0 {
                    Chip(text: s.number(model.unreadCount), foreground: Palette.brand, background: Palette.brandSoft)
                }
                Spacer()
                Button { model.refresh() } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.borderless)
                    .help(s["refresh"])
                    .keyboardShortcut("r", modifiers: .command)
                Button { model.composing = true } label: { Image(systemName: "square.and.pencil") }
                    .buttonStyle(.borderless)
                    .help(s["newEmail"])
                    .keyboardShortcut("n", modifiers: .command)
            }
            if let address = model.connection?.emailAddress, !address.isEmpty {
                Label(s.get("emailConnectedAs", "email", address), systemImage: "checkmark.seal.fill")
                    .appFont(11)
                    .foregroundStyle(Palette.text2)
                    .labelStyle(.titleAndIcon)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 8)
    }

    @ViewBuilder private var placeholder: some View {
        let s = app.strings
        if model.loading && model.threads.isEmpty {
            ProgressView()
        } else if model.threads.isEmpty && model.error == nil {
            if model.notConnected {
                EmptyState(systemImage: "envelope.badge.shield.half.filled", title: s["emailNotConnectedTitle"], message: s["emailNotConnectedBody"])
            } else {
                EmptyState(systemImage: model.folder == .starred ? "star" : "tray", title: s["emailEmptyTitle"], message: s["emailEmptyBody"])
            }
        }
    }
}

struct EmailRow: View {
    let thread: EmailThreadSummary
    let me: String?
    let model: EmailModel
    @Environment(AppModel.self) private var app

    /// The other side of the thread: who wrote to us, or who we wrote to.
    private var counterpart: EmailAddress? {
        let others = thread.participants.filter { $0.email.lowercased() != me?.lowercased() }
        return others.first ?? thread.participants.first
    }

    var body: some View {
        let s = app.strings
        let who = counterpart
        let unread = thread.unread
        HStack(alignment: .top, spacing: 11) {
            ZStack(alignment: .topLeading) {
                AvatarView(name: who?.name ?? who?.email, email: who?.email, size: 38)
                if unread {
                    Circle().fill(Palette.brand).frame(width: 9, height: 9)
                        .overlay(Circle().strokeBorder(Palette.surface, lineWidth: 1.5))
                        .offset(x: -3, y: -1)
                }
            }
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(who?.display ?? s["emailNoSubject"])
                        .appFont(13, unread ? .bold : .semibold)
                        .lineLimit(1)
                    let extra = max(0, thread.participants.count - 2)
                    if extra > 0 { Text("+\(s.number(extra))").appFont(11).foregroundStyle(Palette.text3) }
                    Spacer(minLength: 4)
                    if let at = thread.lastMessageAt {
                        Text(Display.listStamp(at, s)).appFont(11).foregroundStyle(unread ? Palette.brand : Palette.text3)
                    }
                }
                HStack(spacing: 6) {
                    Text(subjectText)
                        .appFont(12.5, unread ? .semibold : .regular)
                        .foregroundStyle(Palette.text)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    Button { model.toggleStar(thread.id) } label: {
                        Image(systemName: thread.starred ? "star.fill" : "star")
                            .font(.system(size: 11))
                            .foregroundStyle(thread.starred ? Color.yellow : Palette.text3)
                    }
                    .buttonStyle(.borderless)
                    .help(s["emailStar"])
                }
                if let snippet = thread.lastMessageSnippet, !snippet.isEmpty {
                    Text(Display.oneLine(snippet)).appFont(11.5).foregroundStyle(Palette.text2).lineLimit(2)
                }
                let labels = visibleLabels
                if !labels.isEmpty {
                    HStack(spacing: 4) {
                        ForEach(labels.prefix(3), id: \.self) { Chip(text: $0) }
                    }
                    .padding(.top, 2)
                }
            }
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 4)
        .contentShape(Rectangle())
        .contextMenu {
            Button(unread ? s["emailMarkRead"] : s["emailMarkUnread"]) { model.setRead(thread.id, unread) }
            Button(thread.starred ? s["emailUnstar"] : s["emailStar"]) { model.toggleStar(thread.id) }
        }
    }

    private var subjectText: String {
        let t = (thread.subject ?? "").trimmingCharacters(in: .whitespaces)
        return t.isEmpty ? app.strings["emailNoSubject"] : t
    }

    /// The provider's own labels, without the system ones every thread carries.
    private var visibleLabels: [String] {
        let system: Set<String> = ["INBOX", "UNREAD", "IMPORTANT", "SENT", "STARRED", "CATEGORY_PERSONAL", "CATEGORY_UPDATES",
                                   "CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_FORUMS", "DRAFT", "SPAM", "TRASH"]
        return (thread.labels ?? []).filter { !system.contains($0.uppercased()) && !$0.hasPrefix("Label_") }
    }
}
