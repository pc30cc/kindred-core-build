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
            .navigationTitle(Str.tabInbox(language))
            // Inline, not large. A large title plus its own empty navigation
            // bar, the search field and the filter put roughly 230pt of chrome
            // above the first conversation — a quarter of the screen before
            // any content. Inline gives that back to the list.
            .navigationBarTitleDisplayMode(.inline)
            // `.searchable` gives the real system search bar: it tucks under
            // the large title, animates on focus and handles the cancel
            // button, all mirrored correctly under RTL.
            .searchable(
                text: $model.searchText,
                placement: .navigationBarDrawer(displayMode: .always),
                prompt: Str.search(language)
            )
            .floatingTabBarInset()
            .refreshable {
                await model.refresh(workspaceID: workspaceID, appState: appState)
            }
            .task(id: reloadKey) {
                model.load(workspaceID: workspaceID, appState: appState)
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
            FilterPicker(selection: $model.filter, language: language)
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

                            ConversationRow(conversation: conversation, language: language, locale: locale)
                        }
                        .listRowInsets(rowInsets)
                        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                            swipeAction(for: conversation)
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
    let language: Language
    let locale: Locale

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
                size: Theme.Size.avatarMedium
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

                if conversation.hasUnread || conversation.status == .resolved {
                    HStack(spacing: Theme.Space.sm) {
                        if conversation.status == .resolved {
                            StatusPill(text: Str.filterResolved(language), tint: Theme.Palette.success)
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
