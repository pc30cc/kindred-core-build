import SwiftUI

// The mailbox, as the Android app shows it: the folder on screen and whose
// mailbox it is in the bar, the folders behind its ☰, a switcher when a Gmail
// and a Yahoo are both connected, All / Unread / Starred, rows of three lines
// with their stars, and a Compose button in the corner.

/// Where a mail thread is opened from: the thread, the mailbox it is in, and
/// the folder it was listed in.
struct EmailThreadRef: Hashable, Sendable {
    let id: String
    var provider: String?
    var folder: String?
}

/// A mail being written: new, or answering a thread.
struct EmailComposeRequest: Identifiable, Hashable, Sendable {
    let id = UUID()
    var sourceThreadID: String?
    var mode: EmailReplyMode?
    var provider: String?
}

struct EmailInboxView: View {
    /// The workspace's mailbox model, owned by the inbox so the strip's count
    /// and this screen are one and the same.
    let model: EmailInboxModel
    /// The mailbox to show; nil for the one shown last (or the first).
    var provider: String?

    @Environment(AppState.self) private var appState
    @Environment(\.locale) private var locale
    @State private var isSearching = false
    @State private var showsFolders = false
    @State private var composing: EmailComposeRequest?
    @FocusState private var searchFocused: Bool

    private var language: Language { appState.language }
    private var workspaceID: String? { appState.selectedWorkspace?.id }

    private var title: String {
        EmailStr.folderName(language, model.folder) ?? model.shownFolder?.name ?? Str.emailInbox(language)
    }

    var body: some View {
        @Bindable var model = model

        ZStack(alignment: .bottomTrailing) {
            VStack(spacing: 0) {
                if isSearching {
                    searchField
                }
                if model.mailboxes.count > 1 {
                    mailboxSwitcher
                }
                if !model.notConnected {
                    filters
                }
                if model.syncing, !model.refreshing, case .loaded = model.state {
                    ProgressView()
                        .progressViewStyle(.linear)
                        .frame(height: 2)
                        .accessibilityIdentifier(A11y.emailSyncing)
                }
                content
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }

            if !model.notConnected {
                composeButton
            }
        }
        .background(Theme.Palette.background)
        .overlay {
            EmailFolderDrawer(
                isPresented: $showsFolders,
                model: model,
                language: language
            )
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                // Two lines, the way a mail client names what it is showing:
                // which folder, and whose mailbox.
                VStack(spacing: 0) {
                    Text(title)
                        .font(.app(.headline))
                        .foregroundStyle(Theme.Palette.label)
                        .lineLimit(1)
                    if let address = model.address, !address.isEmpty {
                        Text(address)
                            .font(.app(.caption2))
                            .foregroundStyle(Theme.Palette.labelSecondary)
                            .lineLimit(1)
                            .environment(\.layoutDirection, .leftToRight)
                    }
                }
            }
            ToolbarItemGroup(placement: .topBarTrailing) {
                if !model.notConnected {
                    Button {
                        withAnimation(Theme.Motion.standard) { showsFolders = true }
                    } label: {
                        Image(systemName: "line.3.horizontal")
                    }
                    .accessibilityLabel(EmailStr.folders(language))
                    .accessibilityIdentifier(A11y.emailFolders)
                }
                Button {
                    withAnimation(Theme.Motion.standard) {
                        isSearching.toggle()
                        if !isSearching { model.query = "" }
                    }
                } label: {
                    Image(systemName: "magnifyingglass")
                }
                .accessibilityLabel(Str.search(language))
            }
        }
        .task(id: "\(workspaceID ?? "-")|\(provider ?? "-")") {
            model.language = language
            model.onUnauthorized = { [appState] in await appState.handleUnauthorized() }
            guard let workspaceID else { return }
            await model.bind(workspaceID, provider: provider)
        }
        // Live while in front of the operator — a new mail, a change on
        // another device — through the inbox that owns the model, which
        // listens for the strip's count anyway.
        .onChange(of: language) { _, now in model.language = now }
        .mailSentNotice(model.sentCount, language: language)
        .sheet(item: $composing) { request in
            EmailComposeView(request: request, inbox: model)
        }
    }

    // MARK: Pieces

    private var searchField: some View {
        @Bindable var model = model
        return HStack(spacing: Theme.Space.sm) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(Theme.Palette.labelTertiary)
            TextField(Str.search(language), text: $model.query)
                .focused($searchFocused)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            if !model.query.isEmpty {
                Button {
                    model.query = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(Theme.Palette.labelTertiary)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, Theme.Space.md)
        .frame(height: 38)
        .background(Capsule().fill(Theme.Palette.surfaceElevated))
        .padding(.horizontal, Theme.screenInset)
        .padding(.top, Theme.Space.sm)
        .onAppear { searchFocused = true }
    }

    /// One button per mailbox when a Gmail and a Yahoo are both connected,
    /// each with its own unread count, the way a mail client lists its accounts.
    private var mailboxSwitcher: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Theme.Space.xs) {
                ForEach(model.mailboxes, id: \.provider) { box in
                    EmailChip(
                        label: box.address ?? box.provider,
                        count: box.unread.flatMap { $0 > 0 ? $0 : nil },
                        selected: box.provider == (model.provider ?? model.mailboxes.first?.provider),
                        language: language,
                        latin: true
                    ) {
                        Task { await model.selectMailbox(box.provider) }
                    }
                    .accessibilityIdentifier(A11y.emailMailbox(box.provider))
                }
            }
            .padding(.horizontal, Theme.screenInset)
        }
        .padding(.top, Theme.Space.sm)
    }

    /// Three views of the folder on screen: everything, what is unread, what
    /// is starred (not offered inside Starred itself).
    private var filters: some View {
        let shownUnread = model.mailboxes.first { $0.provider == (model.provider ?? model.mailboxes.first?.provider) }?.unread
        let unread = model.folder == EmailMailFolder.inbox ? shownUnread : model.shownFolder?.unread
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Theme.Space.xs) {
                ForEach(EmailListFilter.allCases.filter { !($0 == .starred && model.folder == "starred") }, id: \.self) { option in
                    EmailChip(
                        label: label(of: option),
                        count: option == .unread ? unread.flatMap { $0 > 0 ? $0 : nil } : nil,
                        selected: option == model.filter,
                        language: language
                    ) {
                        Task { await model.selectFilter(option) }
                    }
                    .accessibilityIdentifier(A11y.emailFilter(option.rawValue))
                }
            }
            .padding(.horizontal, Theme.screenInset)
        }
        .padding(.vertical, Theme.Space.sm)
    }

    private func label(of filter: EmailListFilter) -> String {
        switch filter {
        case .all: EmailStr.filterAll(language)
        case .unread: EmailStr.folderUnread(language)
        case .starred: EmailStr.folderStarred(language)
        }
    }

    @ViewBuilder
    private var content: some View {
        switch model.state {
        case .loading:
            MailLoading(text: EmailStr.loadingMail(language))

        case .failed(let message):
            ErrorStateView(
                title: Str.offlineTitle(language),
                message: message,
                retryTitle: Str.retry(language),
                onRetry: { Task { await model.retry() } }
            )

        case .loaded(let threads):
            if threads.isEmpty {
                emptyState
                    .refreshable { await model.refresh() }
            } else {
                list(threads)
            }
        }
    }

    /// Three different empties, and they are three different pieces of news:
    /// no mailbox has been connected, the mailbox is empty, or the search
    /// found nothing in it.
    private var emptyState: some View {
        let searching = !model.query.trimmingCharacters(in: .whitespaces).isEmpty
        let title: String
        let message: String
        if model.notConnected {
            title = Str.emailNotConnectedTitle(language)
            message = Str.emailNotConnectedBody(language)
        } else if searching {
            title = Str.noResults(language)
            message = ""
        } else if model.folder != EmailMailFolder.inbox {
            title = EmailStr.folderEmpty(language)
            message = ""
        } else {
            title = Str.emailEmptyTitle(language)
            message = Str.emailEmptyBody(language)
        }
        let empty = EmptyStateView(
            systemImage: searching ? "magnifyingglass" : "envelope",
            title: title,
            message: message
        )
        return ScrollView {
            if model.notConnected {
                empty.accessibilityIdentifier(A11y.emailNotConnected)
            } else {
                empty.accessibilityIdentifier(A11y.emailEmpty)
            }
        }
    }

    private func list(_ threads: [EmailThreadSummary]) -> some View {
        List {
            ForEach(Array(threads.enumerated()), id: \.element.id) { index, thread in
                ZStack {
                    NavigationLink(value: InboxRoute.emailThread(
                        EmailThreadRef(id: thread.id, provider: model.provider, folder: model.folder)
                    )) { EmptyView() }
                        .opacity(0)
                    EmailThreadRow(
                        thread: thread,
                        mailbox: model.address,
                        language: language,
                        locale: locale,
                        folder: model.folder,
                        labelNames: model.labelNames,
                        onToggleStar: { Task { await model.toggleStar(thread.id) } }
                    )
                }
                .listRowInsets(EdgeInsets(top: 0, leading: Theme.Space.sm, bottom: 0, trailing: Theme.Space.sm))
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
                .contextMenu {
                    let unread = thread.isRead != true
                    Button {
                        Task { await model.toggleRead(thread.id) }
                    } label: {
                        Label(unread ? EmailStr.markRead(language) : EmailStr.markUnread(language), systemImage: "envelope")
                    }
                    Button {
                        Task { await model.toggleStar(thread.id) }
                    } label: {
                        Label(thread.isStarred == true ? EmailStr.unstar(language) : EmailStr.star(language), systemImage: "star")
                    }
                }
                .accessibilityIdentifier(A11y.emailRow(thread.id))
                // The next page as the end comes into view, not when it is
                // reached: the rows are there before the thumb is.
                .onAppear {
                    if index >= threads.count - 5, model.hasMore {
                        Task { await model.loadMore() }
                    }
                }
            }
            if model.loadingMore {
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .padding(Theme.Space.lg)
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
            }
            // Room under the last row for the compose button.
            Color.clear
                .frame(height: 72)
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .refreshable { await model.refresh() }
        .accessibilityIdentifier(A11y.emailList)
    }

    /// A new mail, from wherever the list is — the button every mail client
    /// keeps in this corner.
    private var composeButton: some View {
        Button {
            composing = EmailComposeRequest(sourceThreadID: nil, mode: nil, provider: model.provider)
        } label: {
            Label(EmailStr.compose(language), systemImage: "square.and.pencil")
                .font(.app(.body, .semibold))
                .padding(.horizontal, Theme.Space.lg)
                .frame(height: 52)
                .foregroundStyle(.white)
                .background(Capsule().fill(Theme.Palette.brand))
                .shadow(color: .black.opacity(0.18), radius: 8, x: 0, y: 4)
        }
        .buttonStyle(.plain)
        .padding(.trailing, Theme.screenInset)
        .padding(.bottom, Theme.Space.lg)
        .accessibilityIdentifier(A11y.emailCompose)
    }
}

// MARK: - Row

/// One thread: who, what about, the last line — and its star, which is a
/// button of its own rather than something to open the thread for.
///
/// Mail is laid out left to right in every language of the app, as mail
/// clients lay it out: the face on the left, the star on the right, the lines
/// standing on the left — each in its own word order.
struct EmailThreadRow: View {
    let thread: EmailThreadSummary
    let mailbox: String?
    let language: Language
    let locale: Locale
    var folder: String = EmailMailFolder.inbox
    var labelNames: [String: String] = [:]
    var onToggleStar: () -> Void = {}

    private var unread: Bool { thread.isRead != true }
    private var starred: Bool { thread.isStarred == true }

    /// Who, by name: «Google», not «"Google" <no-reply@accounts.google.com>».
    private var others: [MailName] {
        let all = (thread.participants ?? []).map { MailName.parse($0.email) }
        let filtered = all.filter { name in !(mailbox.map { EmailAddressing.same(name.email, $0) } ?? false) }
        return filtered.isEmpty ? all : filtered
    }

    private var people: String {
        let names = others.map(\.display).joined(separator: language.listSeparator)
        // Sent and Drafts are about whom a mail is to, as every mail client says there.
        let addressed = folder == "sent" || folder == "drafts"
        return addressed && !names.isEmpty ? "\(EmailStr.to(language)): \u{2068}\(names)\u{2069}" : names
    }

    private var labels: [String] {
        Array((thread.labels ?? [])
            .filter { "label:\($0)" != folder }
            .compactMap { labelNames[$0] }
            .prefix(3))
    }

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Space.md) {
            // Keyed on the address, as the reader keys the same sender's face.
            MailAvatar(address: others.first?.email ?? people)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: Theme.Space.xs) {
                    if unread {
                        Circle()
                            .fill(Theme.Palette.brand)
                            .frame(width: 8, height: 8)
                    }
                    if folder == "drafts" {
                        Text(EmailStr.draft(language))
                            .font(.app(.subheadline, .semibold))
                            .foregroundStyle(Theme.Palette.danger)
                            .lineLimit(1)
                    }
                    Text(people)
                        .font(.app(.subheadline, unread ? .bold : .medium))
                        .foregroundStyle(Theme.Palette.label)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(Format.listTimestamp(thread.lastMessageAt, locale: locale))
                        .font(.app(.caption, unread ? .semibold : .regular))
                        .foregroundStyle(unread ? Theme.Palette.brand : Theme.Palette.labelTertiary)
                        .lineLimit(1)
                        .fixedSize()
                }
                Text(thread.subject.flatMap { $0.isEmpty ? nil : $0 } ?? Str.emailNoSubject(language))
                    .font(.app(.subheadline, unread ? .semibold : .regular))
                    .foregroundStyle(unread ? Theme.Palette.label : Theme.Palette.labelSecondary)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let snippet = thread.lastMessageSnippet, !snippet.isEmpty {
                    Text(snippet)
                        .font(.app(.footnote))
                        .foregroundStyle(Theme.Palette.labelTertiary)
                        .lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                // The mailbox's own labels, by the names the mailbox gave
                // them, except the one being looked at.
                if !labels.isEmpty {
                    HStack(spacing: Theme.Space.xs) {
                        ForEach(labels, id: \.self) { label in
                            StatusPill(text: label, tint: Theme.Palette.labelSecondary)
                        }
                    }
                    .padding(.top, Theme.Space.xxs)
                }
            }

            Button(action: onToggleStar) {
                Image(systemName: starred ? "star.fill" : "star")
                    .font(.system(size: 18))
                    .foregroundStyle(starred ? Theme.Palette.warning : Theme.Palette.labelTertiary)
                    .frame(width: 36, height: 36)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(starred ? EmailStr.unstar(language) : EmailStr.star(language))
            .accessibilityIdentifier(A11y.emailStar(thread.id))
        }
        .padding(.vertical, Theme.Space.md)
        .padding(.leading, Theme.Space.md)
        .padding(.trailing, Theme.Space.xs)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.xl, style: .continuous)
                .fill(unread ? Theme.Palette.surface : Color.clear)
        )
        .contentShape(Rectangle())
        .environment(\.layoutDirection, .leftToRight)
    }
}

/// Who a mail is from, as a face: a circle in a colour of the address's own
/// — the same sender is always the same colour, on every phone — with a
/// person in it. Not initials, which this app does not draw anywhere.
struct MailAvatar: View {
    let address: String
    var size: CGFloat = Theme.Size.avatarSmall

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let hue = Double(MailHue.of(address)) / 360
        let dark = colorScheme == .dark
        Circle()
            .fill(Color(hsl: hue, saturation: dark ? 0.35 : 0.55, lightness: dark ? 0.30 : 0.88))
            .frame(width: size, height: size)
            .overlay {
                Image(systemName: "person.fill")
                    .font(.system(size: size * 0.5))
                    .foregroundStyle(Color(hsl: hue, saturation: dark ? 0.60 : 0.55, lightness: dark ? 0.82 : 0.32))
            }
            .accessibilityHidden(true)
    }
}

extension Color {
    /// HSL, as the Android app and the web write their pastel faces.
    init(hsl hue: Double, saturation s: Double, lightness l: Double) {
        let v = l + s * min(l, 1 - l)
        let sv = v == 0 ? 0 : 2 * (1 - l / v)
        self.init(hue: hue, saturation: sv, brightness: v)
    }
}

/// A filter or a mailbox, as a pill: filled when chosen, with its count.
struct EmailChip: View {
    let label: String
    var count: Int?
    let selected: Bool
    let language: Language
    var latin = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: Theme.Space.xs) {
                if selected {
                    Image(systemName: "checkmark")
                        .font(.system(size: 11, weight: .bold))
                }
                Text(label)
                    .font(.app(.footnote, selected ? .semibold : .medium))
                    .lineLimit(1)
                    .environment(\.layoutDirection, latin ? .leftToRight : language.layoutDirection)
                if let count {
                    Text(Format.number(count, language: language))
                        .font(.app(.caption2, .semibold))
                }
            }
            .padding(.horizontal, Theme.Space.md)
            .frame(height: 32)
            .foregroundStyle(selected ? Theme.Palette.brand : Theme.Palette.labelSecondary)
            .background(
                Capsule().fill(selected ? Theme.Palette.brand.opacity(0.14) : Theme.Palette.surfaceElevated)
            )
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }
}

/// Mail on its way: the app's loader and a line saying what it is waiting
/// for. A mailbox is read live from Gmail and can take a few seconds.
struct MailLoading: View {
    let text: String

    var body: some View {
        VStack(spacing: Theme.Space.md) {
            ProgressView()
                .controlSize(.large)
            Text(text)
                .font(.app(.subheadline))
                .foregroundStyle(Theme.Palette.labelSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(A11y.emailLoading)
    }
}

// MARK: - Folders

/// A mailbox's folders, the way a mail client keeps them behind its ☰: the
/// mailbox on top (and the others, when a Gmail and a Yahoo are both
/// connected), then Inbox, Starred, Important, Sent, Drafts, All mail, Spam
/// and Trash — as many as the mailbox has — then its own labels by name, each
/// with the number a mail client puts there. It slides in from the reading
/// side, which in Persian is the right.
struct EmailFolderDrawer: View {
    @Binding var isPresented: Bool
    let model: EmailInboxModel
    let language: Language

    private var shown: EmailMailbox? {
        model.mailboxes.first { $0.provider == model.provider } ?? model.mailboxes.first
    }

    var body: some View {
        ZStack(alignment: .leading) {
            if isPresented {
                Color.black.opacity(0.32)
                    .ignoresSafeArea()
                    .onTapGesture { close() }
                    .transition(.opacity)
                    .accessibilityHidden(true)

                panel
                    .transition(.move(edge: .leading))
            }
        }
        .animation(Theme.Motion.standard, value: isPresented)
        .onChange(of: isPresented) { _, open in
            // Read again each time it opens: its counts are the ones to trust.
            if open { Task { await model.refreshFolders() } }
        }
    }

    private var panel: some View {
        let system = model.folders.filter { !$0.isLabel }
        let labels = model.folders.filter(\.isLabel)
        return ScrollView {
            VStack(alignment: .leading, spacing: 2) {
                header
                if model.mailboxes.count > 1 {
                    section(EmailStr.mailboxes(language))
                    ForEach(model.mailboxes, id: \.provider) { box in
                        row(
                            icon: "envelope",
                            label: box.address ?? providerName(box.provider),
                            count: box.unread.flatMap { $0 > 0 ? $0 : nil },
                            selected: box.provider == shown?.provider,
                            latin: true
                        ) {
                            Task { await model.selectMailbox(box.provider) }
                        }
                        .accessibilityIdentifier(A11y.emailMailbox(box.provider))
                    }
                    Divider().padding(.vertical, Theme.Space.sm)
                }
                if model.folders.isEmpty {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, Theme.Space.xl)
                }
                ForEach(system) { folder in
                    row(
                        icon: icon(of: folder.id),
                        label: EmailStr.folderName(language, folder.id) ?? folder.id,
                        count: folder.count,
                        selected: folder.id == model.folder
                    ) {
                        Task { await model.selectFolder(folder.id) }
                    }
                    .accessibilityIdentifier(A11y.emailMailFolder(folder.id))
                }
                if !labels.isEmpty {
                    Divider().padding(.vertical, Theme.Space.sm)
                    section(EmailStr.labels(language))
                    ForEach(labels) { folder in
                        row(
                            icon: "tag",
                            label: folder.name ?? String(folder.id.dropFirst("label:".count)),
                            count: folder.count,
                            selected: folder.id == model.folder
                        ) {
                            Task { await model.selectFolder(folder.id) }
                        }
                        .accessibilityIdentifier(A11y.emailMailFolder(folder.id))
                    }
                }
            }
            .padding(.horizontal, Theme.Space.sm)
            .padding(.bottom, Theme.Space.xl)
        }
        .frame(width: 300)
        .frame(maxHeight: .infinity)
        .background(Theme.Palette.background.ignoresSafeArea())
        .accessibilityIdentifier(A11y.emailDrawer)
        .accessibilityAddTraits(.isModal)
    }

    private var header: some View {
        HStack(spacing: Theme.Space.md) {
            MailAvatar(address: shown?.address ?? shown?.provider ?? "mail", size: 40)
            VStack(alignment: .leading, spacing: 1) {
                Text(providerName(shown?.provider))
                    .font(.app(.headline))
                    .foregroundStyle(Theme.Palette.label)
                if let address = shown?.address, !address.isEmpty {
                    Text(address)
                        .font(.app(.caption))
                        .foregroundStyle(Theme.Palette.labelTertiary)
                        .lineLimit(1)
                        .environment(\.layoutDirection, .leftToRight)
                }
            }
        }
        .padding(.horizontal, Theme.Space.md)
        .padding(.top, Theme.Space.xl)
        .padding(.bottom, Theme.Space.md)
    }

    private func section(_ title: String) -> some View {
        Text(title)
            .font(.app(.footnote, .semibold))
            .foregroundStyle(Theme.Palette.labelTertiary)
            .padding(.horizontal, Theme.Space.md)
            .padding(.top, Theme.Space.sm)
            .padding(.bottom, Theme.Space.xs)
    }

    private func row(
        icon: String, label: String, count: Int?, selected: Bool, latin: Bool = false, action: @escaping () -> Void
    ) -> some View {
        Button {
            action()
            close()
        } label: {
            HStack(spacing: Theme.Space.md) {
                Image(systemName: icon)
                    .font(.system(size: 17))
                    .frame(width: 24)
                Text(label)
                    .font(.app(.body, count != nil ? .semibold : .regular))
                    .lineLimit(1)
                    .environment(\.layoutDirection, latin ? .leftToRight : language.layoutDirection)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let count {
                    Text(Format.number(count, language: language))
                        .font(.app(.subheadline, .semibold))
                }
            }
            .foregroundStyle(selected ? Theme.Palette.brand : Theme.Palette.label)
            .padding(.horizontal, Theme.Space.md)
            .frame(minHeight: 48)
            .background(
                Capsule().fill(selected ? Theme.Palette.brand.opacity(0.14) : Color.clear)
            )
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }

    private func close() {
        withAnimation(Theme.Motion.standard) { isPresented = false }
    }

    private func icon(of id: String) -> String {
        switch id {
        case "inbox": "tray"
        case "starred": "star"
        case "important": "bookmark"
        case "sent": "paperplane"
        case "drafts": "doc"
        case "all": "tray.full"
        case "spam": "exclamationmark.octagon"
        case "trash": "trash"
        default: "envelope"
        }
    }

    private func providerName(_ provider: String?) -> String {
        provider == "yahoo" ? "Yahoo Mail" : "Gmail"
    }
}

// MARK: - Sent

/// «Sent», for a moment, on the screen the composer closes onto — the
/// Android app's toast. `count` is the mailbox's `sentCount`: each new value
/// is one mail gone.
struct MailSentNotice: ViewModifier {
    let count: Int
    let language: Language

    @State private var shown = false
    @State private var hide: Task<Void, Never>?

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .top) {
                if shown {
                    Label(EmailStr.sent(language), systemImage: "checkmark.circle.fill")
                        .font(.app(.subheadline, .semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, Theme.Space.lg)
                        .padding(.vertical, Theme.Space.sm)
                        .background(Capsule().fill(Color.black.opacity(0.82)))
                        .padding(.top, Theme.Space.sm)
                        .transition(.move(edge: .top).combined(with: .opacity))
                        .accessibilityHidden(true)
                }
            }
            .onChange(of: count) { _, _ in
                withAnimation(Theme.Motion.standard) { shown = true }
                hide?.cancel()
                hide = Task {
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    guard !Task.isCancelled else { return }
                    withAnimation(Theme.Motion.standard) { shown = false }
                }
            }
    }
}

extension View {
    func mailSentNotice(_ count: Int, language: Language) -> some View {
        modifier(MailSentNotice(count: count, language: language))
    }
}
