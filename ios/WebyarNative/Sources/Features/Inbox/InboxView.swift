import SwiftUI

struct InboxView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.locale) private var locale
    @State private var model = InboxViewModel()

    private var language: Language { appState.language }
    private var workspaceID: String? { appState.selectedWorkspace?.id }

    var body: some View {
        @Bindable var model = model

        content
            // No title at all. The screen is reached from a tab that already
            // says "Inbox", so repeating it costs a whole navigation bar's
            // worth of height to say something the operator just tapped.
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            // `.automatic` rather than `.always`: the search field stays out
            // of the way and comes down when the list is pulled, which is how
            // Mail and Messages behave. `.always` pinned it permanently above
            // the first row, spending 52pt on a control most sessions never
            // use.
            .searchable(
                text: $model.searchText,
                placement: .navigationBarDrawer(displayMode: .automatic),
                prompt: Str.search(language)
            )
            .floatingTabBarInset()
            .refreshable {
                await model.refresh(workspaceID: workspaceID, appState: appState)
            }
            .task(id: reloadKey) {
                model.load(workspaceID: workspaceID, appState: appState)
            }
            // A plan can drop the queue that is currently selected — switching
            // workspace is the ordinary way that happens.
            .onChange(of: appState.inboxFilters) { _, available in
                model.reconcileFilter(with: available)
            }
    }

    /// Any change to this reloads the list: switching filter, switching
    /// workspace, or signing in as somebody else.
    private var reloadKey: String {
        "\(workspaceID ?? "-")|\(model.filter.rawValue)"
    }

    @ViewBuilder
    private var content: some View {
        // One List across every state, with the filter always its first row.
        //
        // The filter rides in the list rather than in a top safe-area inset:
        // an inset there occupies the navigation bar's large-title space and
        // silently swallowed the "Inbox" title. Keeping it here also means it
        // stays reachable when the list is empty — otherwise an operator who
        // filtered into an empty queue would have no way back out.
        List {
            FilterPicker(
                selection: $model.filter,
                filters: appState.inboxFilters,
                counts: model.counts,
                language: language
            )
                .listRowInsets(EdgeInsets(
                    top: Theme.Space.xs,
                    leading: Theme.screenInset,
                    bottom: Theme.Space.md,
                    trailing: Theme.screenInset
                ))
                .listRowSeparator(.hidden)

            switch model.state {
            case .loading:
                // A skeleton rather than a bare spinner: the row rhythm is
                // already on screen, so the real content does not shift
                // anything when it lands.
                ForEach(0..<8, id: \.self) { _ in
                    ConversationRowSkeleton()
                        .listRowInsets(rowInsets)
                }

            case .failed(let error):
                ErrorStateView(
                    title: Str.offlineTitle(language),
                    message: errorMessage(error),
                    retryTitle: Str.retry(language),
                    onRetry: { model.load(workspaceID: workspaceID, appState: appState) }
                )
                .listRowInsets(EdgeInsets())
                .listRowSeparator(.hidden)

            case .loaded:
                if model.visible.isEmpty {
                    EmptyStateView(
                        systemImage: model.searchText.isEmpty ? "tray" : "magnifyingglass",
                        title: model.searchText.isEmpty
                            ? Str.inboxEmptyTitle(language)
                            : Str.noResults(language),
                        message: model.searchText.isEmpty
                            ? Str.inboxEmptyBody(language)
                            : ""
                    )
                    .listRowInsets(EdgeInsets())
                    .listRowSeparator(.hidden)
                } else {
                    ForEach(model.visible) { conversation in
                        ZStack {
                            // A NavigationLink inside a List draws its own
                            // chevron and highlight; overlaying it with zero
                            // opacity keeps that behaviour while letting the
                            // row be laid out exactly as designed.
                            NavigationLink(value: conversation) { EmptyView() }
                                .opacity(0)

                            ConversationRow(
                                conversation: conversation,
                                visitor: model.visitor(for: conversation),
                                language: language,
                                locale: locale,
                                currentUserID: appState.session.user?.id
                            )
                        }
                        .listRowInsets(rowInsets)
                        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                            swipeAction(for: conversation)
                        }
                        .swipeActions(edge: .leading, allowsFullSwipe: false) {
                            claimAction(for: conversation)
                        }
                    }
                }
            }
        }
        .listStyle(.plain)
        .navigationDestination(for: Conversation.self) { conversation in
            ChatView(conversation: conversation)
        }
    }

    private var rowInsets: EdgeInsets {
        EdgeInsets(
            top: Theme.Space.md,
            leading: Theme.screenInset,
            bottom: Theme.Space.md,
            trailing: Theme.screenInset
        )
    }

    @ViewBuilder
    private func swipeAction(for conversation: Conversation) -> some View {
        if conversation.status == .resolved || conversation.status == .closed {
            Button {
                Task { await model.setStatus(.open, for: conversation, appState: appState) }
            } label: {
                Label(Str.reopen(language), systemImage: "arrow.uturn.backward")
            }
            .tint(Theme.Palette.brand)
        } else {
            Button {
                Task { await model.setStatus(.resolved, for: conversation, appState: appState) }
            } label: {
                Label(Str.markResolved(language), systemImage: "checkmark")
            }
            .tint(Theme.Palette.success)
        }
    }

    /// Taking a thread is a leading-edge action and never a full swipe: it is
    /// not undoable the way resolving is, so it asks for a deliberate gesture.
    @ViewBuilder
    private func claimAction(for conversation: Conversation) -> some View {
        if conversation.assignedTo == nil {
            Button {
                Task { await model.claim(conversation, workspaceID: workspaceID, appState: appState) }
            } label: {
                Label(Str.claim(language), systemImage: "person.crop.circle.badge.checkmark")
            }
            .tint(Theme.Palette.brand)
        }
    }

    private func errorMessage(_ error: APIError) -> String {
        switch error {
        case .transport: Str.offlineBody(language)
        case .server(_, let message): message ?? Str.offlineBody(language)
        case .decoding, .unauthorized: Str.offlineBody(language)
        }
    }
}

// MARK: - Row

/// One conversation in the list.
///
/// The layout is a fixed avatar gutter and then a two-line text column, so
/// every name in the list starts on the same vertical line and every preview
/// sits directly under its own name. The timestamp is pinned to the trailing
/// edge of the first line and given a fixed layout priority, so a long name
/// truncates instead of pushing the time off screen.
struct ConversationRow: View {
    let conversation: Conversation
    /// Device and country behind this thread, when the server knew them.
    var visitor: VisitorProfile?
    let language: Language
    let locale: Locale
    /// Who is signed in, so a thread assigned to them can say so. Assignment
    /// to somebody else is deliberately not labelled — on a phone that is
    /// noise, and the operator's own queue is what they came for.
    var currentUserID: String?

    private var isMine: Bool {
        guard let assigned = conversation.assignedTo, let currentUserID else { return false }
        return assigned == currentUserID
    }

    /// The third line only exists when it has something to say.
    private var hasFooter: Bool {
        conversation.hasUnread
            || conversation.status == .resolved
            || conversation.priority?.isElevated == true
            || isMine
    }

    private var displayName: String {
        Format.contactName(
            name: conversation.contact?.name,
            email: conversation.contact?.email,
            visitorCode: conversation.contact?.visitorCode,
            language: language
        )
    }

    private var preview: String {
        let body = Format.preview(conversation.lastMessage?.body)
        return body.isEmpty ? Format.preview(conversation.subject) : body
    }

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Space.md) {
            Avatar(
                name: displayName,
                imageURL: conversation.contact?.avatarURL,
                size: Theme.Size.avatarMedium,
                os: visitor?.device?.os,
                device: visitor?.device?.device,
                countryCode: visitor?.geo?.countryCode
            )

            VStack(alignment: .leading, spacing: Theme.Space.xs) {
                HStack(alignment: .firstTextBaseline, spacing: Theme.Space.sm) {
                    Text(displayName)
                        .font(Theme.Typo.rowTitle)
                        .foregroundStyle(Theme.Palette.label)
                        .lineLimit(1)

                    Spacer(minLength: Theme.Space.xs)

                    Text(Format.listTimestamp(conversation.lastActivity, locale: locale))
                        .font(Theme.Typo.meta)
                        .foregroundStyle(Theme.Palette.labelSecondary)
                        // The time is short and must never be the thing that
                        // gets truncated.
                        .layoutPriority(1)
                        .fixedSize(horizontal: true, vertical: false)
                }

                if !preview.isEmpty {
                    Text(preview)
                        .font(Theme.Typo.rowSubtitle)
                        .foregroundStyle(Theme.Palette.labelSecondary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                if hasFooter {
                    HStack(spacing: Theme.Space.sm) {
                        if let priority = conversation.priority, priority.isElevated {
                            StatusPill(
                                text: priority == .urgent
                                    ? Str.priorityUrgent(language)
                                    : Str.priorityHigh(language),
                                tint: priority == .urgent ? Theme.Palette.danger : Theme.Palette.warning
                            )
                        }
                        if conversation.status == .resolved {
                            StatusPill(text: Str.filterResolved(language), tint: Theme.Palette.success)
                        }
                        if isMine {
                            StatusPill(text: Str.assignedToYou(language), tint: Theme.Palette.brand)
                        }
                        Spacer(minLength: 0)
                        if let count = conversation.unreadCount, count > 0 {
                            UnreadBadge(count: count)
                        }
                    }
                    .padding(.top, Theme.Space.xxs)
                }
            }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// The loading placeholder. Its shapes match the real row's metrics exactly,
/// which is what stops the list from jumping when the data arrives.
struct ConversationRowSkeleton: View {
    var body: some View {
        HStack(alignment: .top, spacing: Theme.Space.md) {
            Circle()
                .fill(Theme.Palette.surfaceElevated)
                .frame(width: Theme.Size.avatarMedium, height: Theme.Size.avatarMedium)

            VStack(alignment: .leading, spacing: Theme.Space.sm) {
                RoundedRectangle(cornerRadius: Theme.Radius.sm)
                    .fill(Theme.Palette.surfaceElevated)
                    .frame(width: 140, height: 13)

                RoundedRectangle(cornerRadius: Theme.Radius.sm)
                    .fill(Theme.Palette.surfaceElevated)
                    .frame(maxWidth: .infinity)
                    .frame(height: 11)

                RoundedRectangle(cornerRadius: Theme.Radius.sm)
                    .fill(Theme.Palette.surfaceElevated)
                    .frame(width: 200, height: 11)
            }
        }
        .redacted(reason: .placeholder)
        .accessibilityHidden(true)
    }
}
