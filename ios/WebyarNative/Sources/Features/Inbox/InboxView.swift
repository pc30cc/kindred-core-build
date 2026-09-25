import SwiftUI

/// Where the inbox's own navigation stack can go besides a conversation.
enum InboxRoute: Hashable { case email, colleagues }

struct InboxView: View {
    /// The tab's navigation stack, so the title menu can push the mailbox.
    @Binding var path: NavigationPath

    /// Whether this tab is the one being looked at.
    ///
    /// A `TabView` keeps every tab alive, so "the inbox is on screen" is not
    /// something the inbox can tell from its own state. It has to be told,
    /// and the notification primer is why: it belongs to this screen but
    /// presents over whatever the app is showing.
    var isSelectedTab: Bool = true

    @Environment(AppState.self) private var appState
    @Environment(PromotionCenter.self) private var promotions
    @Environment(\.locale) private var locale
    @State private var model = InboxViewModel()
    @State private var isSearching = false
    @State private var isFiltering = false

    @State private var push = PushController.shared
    @State private var isAskingAboutNotifications = false

    private var language: Language { appState.language }
    private var workspaceID: String? { appState.selectedWorkspace?.id }

    var body: some View {
        @Bindable var model = model

        content
            // The screen's name sits on the leading edge rather than centred —
            // right in Persian, left in English, which is where the console
            // puts it — and it is also the button that opens the list of every
            // inbox this plan grants. An empty centred title keeps the bar
            // from drawing a second one over it.
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { inboxMenu }
                toolbarButtons
            }
            .floatingTabBarInset()
            .sheet(isPresented: $isFiltering) {
                InboxFilterSheet(filter: $model.fieldFilter, language: language)
            }
            .refreshable {
                await model.refresh(workspaceID: workspaceID, appState: appState)
            }
            .task(id: reloadKey) {
                model.load(workspaceID: workspaceID, appState: appState)
            }
            // Realtime events, pushes and the return to the foreground read
            // the list again; without realtime it is polled while on screen.
            // Ends by itself when the workspace changes or the view goes.
            .task(id: workspaceID) {
                await model.listen(workspaceID: workspaceID)
            }
            .onChange(of: isSelectedTab && path.isEmpty, initial: true) { _, onScreen in
                model.isOnScreen = onScreen
            }
            .task(id: workspaceID) {
                await model.loadChannels(workspaceID: workspaceID)
            }
            // Only the inbox offers one, and only once the list is real —
            // a promotion over a skeleton is a promotion over nothing.
            .task(id: "\(workspaceID ?? "-")|\(content.isLoaded)") {
                guard content.isLoaded else { return }
                promotions.offerFullScreen(for: appState)
            }
            // A plan can drop the queue that is currently selected — switching
            // workspace is the ordinary way that happens.
            .onChange(of: appState.inboxFilters) { _, available in
                model.reconcileFilter(with: available)
            }
            // Notifications, asked for here rather than at launch.
            //
            // This is the first screen where the question means anything: the
            // operator is signed in, they are looking at the conversations
            // they would be told about, and iOS has not been asked yet. The
            // one system prompt an app ever gets is not spent until somebody
            // says yes to this.
            .task(id: "primer|\(content.isLoaded)|\(path.isEmpty)|\(isSelectedTab)") {
                guard content.isLoaded,
                      // Only while the inbox is what is actually on screen.
                      // It owns this sheet but stays alive under whatever is
                      // pushed on top of it AND under every other tab, so
                      // without both of these the question arrives over a
                      // chat, or over Settings — which is where it was found,
                      // presenting itself on top of the profile editor.
                      path.isEmpty,
                      isSelectedTab,
                      !NotificationPrimer.isSuppressed,
                      !NotificationPrimer.hasBeenShown else { return }
                await push.refreshAuthorization()
                guard push.authorization == .notDetermined else { return }
                // After the promotion has had its turn, so the two never land
                // on top of each other.
                try? await Task.sleep(for: .seconds(1.2))
                guard !Task.isCancelled else { return }
                isAskingAboutNotifications = true
            }
            .sheet(isPresented: $isAskingAboutNotifications) {
                NotificationPrimerView(
                    language: language,
                    onAllow: {
                        NotificationPrimer.markShown()
                        isAskingAboutNotifications = false
                        Task { await push.requestAuthorization() }
                    },
                    onDismiss: {
                        // Marked either way: declining our own sheet twice a
                        // day would be its own kind of rude, and Settings →
                        // Notifications is where it lives from now on.
                        NotificationPrimer.markShown()
                        isAskingAboutNotifications = false
                    }
                )
            }
            // A tapped notification, once there is a stack to push onto. The
            // tap can arrive while the app is still launching — before this
            // view exists at all — so the controller records it and the inbox
            // acts on it when it can.
            .task(id: pendingOpenKey) {
                await openPendingConversation()
            }
    }

    /// Changes when a notification asks for a conversation, and when the list
    /// it would have to be found in has finished loading.
    private var pendingOpenKey: String {
        "\(push.pendingOpen?.conversationID ?? "-")|\(content.isLoaded)"
    }

    /// What the list can show for the workspace on screen — never another's.
    private var content: LoadState<[Conversation]> {
        model.content(for: workspaceID)
    }

    /// Takes the operator to the conversation a banner was about.
    ///
    /// The notification carries identifiers and nothing else. The loaded list
    /// is looked in first, then any list saved on this phone, and only then
    /// is that one conversation asked for — never every queue in turn. If the
    /// server no longer shows it to this operator, the inbox is still the
    /// right place to be left, which beats a dead end or a blank screen.
    private func openPendingConversation() async {
        guard let target = push.pendingOpen else { return }

        if appState.selectedWorkspace?.id != target.workspaceID,
           let workspace = appState.workspaces.first(where: { $0.id == target.workspaceID }) {
            appState.select(workspace)
            // The list reloads on the workspace change; nothing to push at
            // yet. The key includes `isLoaded`, so this runs again.
            return
        }

        guard content.isLoaded, let workspaceID else { return }
        _ = push.takePendingOpen()
        let found: Conversation?
        if let listed = model.conversation(id: target.conversationID) {
            found = listed
        } else {
            found = await SyncCoordinator.shared.conversation(id: target.conversationID, workspaceID: workspaceID)
        }
        guard let conversation = found, conversation.workspaceId == appState.selectedWorkspace?.id else { return }
        path.append(conversation)
    }

    /// Any change to this reloads the list: switching filter, switching
    /// workspace, or signing in as somebody else.
    private var reloadKey: String {
        "\(workspaceID ?? "-")|\(model.filter.rawValue)"
    }

    @ViewBuilder
    private var content: some View {
        // One list across every state, with the queue filter as its first real
        // row and the search field above that, out of sight until the list is
        // pulled down.
        //
        // The filter rides in the list rather than in a top safe-area inset:
        // an inset there occupies the navigation bar's large-title space and
        // silently swallowed the "Inbox" title. Keeping it here also means it
        // stays reachable when the list is empty — otherwise an operator who
        // filtered into an empty queue would have no way back out.
        SearchableList(
            text: $model.searchText,
            prompt: Str.search(language),
            resetToken: reloadKey,
            isSearching: $isSearching
        ) {
            if let creative = promotions.banner(for: appState) {
                PromoBanner(
                    creative: creative,
                    language: language,
                    onDismiss: { promotions.dismissBanner() }
                )
                .listRowInsets(filterInsets)
                .listRowSeparator(.hidden)
            }

            FilterPicker(
                selection: $model.filter,
                filters: appState.inboxChips,
                counts: model.counts,
                language: language
            )
                .listRowInsets(filterInsets)
                .listRowSeparator(.hidden)

            if content.isLoaded, model.syncStatus.isOffline {
                OfflineNotice(text: Str.offlineSavedCopy(language))
                    .listRowInsets(filterInsets)
                    .listRowSeparator(.hidden)
            }

            switch content {
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
                let rows = model.visible(in: workspaceID)
                if rows.isEmpty {
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
                    ForEach(rows) { conversation in
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
                        .accessibilityIdentifier(A11y.conversationRow(conversation.id))
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
        .navigationDestination(for: Conversation.self) { conversation in
            ChatView(conversation: conversation)
        }
        .navigationDestination(for: InboxRoute.self) { route in
            switch route {
            case .email: EmailInboxView()
            case .colleagues: ColleaguesView()
            }
        }
    }

    /// The screen's title, and the menu of every inbox behind it.
    ///
    /// The strip above the list keeps the two queues an operator moves between
    /// all day; everything else — the AI handover queue, Resolved, Spam, and
    /// the mailbox — lives here, which is how the console arranges it too.
    private var inboxMenu: some View {
        Menu {
            // The queues, then the channels the workspace actually runs, then
            // the two inboxes that are their own screens. A `Picker` would
            // draw the checkmark for us but only over one set of values, and
            // these are three sets that behave as one list — so the mark is
            // put where it belongs by hand.
            Section {
                ForEach(appState.inboxFilters) { filter in
                    Button {
                        model.open(filter)
                    } label: {
                        Label(
                            filter.title(language),
                            systemImage: isCurrent(filter) ? "checkmark" : filter.icon
                        )
                    }
                }
            }

            if !model.channels.isEmpty {
                Section(Str.otherInboxes(language)) {
                    ForEach(model.channels) { channel in
                        Button {
                            model.open(channel)
                        } label: {
                            Label(
                                channel.title(language),
                                systemImage: model.channel == channel ? "checkmark" : channel.icon
                            )
                        }
                    }
                }
            }

            Section {
                if appState.colleaguesVisible {
                    Button {
                        path.append(InboxRoute.colleagues)
                    } label: {
                        Label(Str.colleagues(language), systemImage: "person.2")
                    }
                }
                if appState.emailInboxVisible {
                    Button {
                        path.append(InboxRoute.email)
                    } label: {
                        Label(Str.emailInbox(language), systemImage: "envelope")
                    }
                }
            }
        } label: {
            HStack(spacing: Theme.Space.xs) {
                Text(model.channel?.title(language) ?? model.filter.headerTitle(language))
                    .font(.headline)
                    .foregroundStyle(Theme.Palette.label)
                Image(systemName: "chevron.down")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(Theme.Palette.labelSecondary)
            }
            .contentShape(Rectangle())
        }
        .accessibilityLabel(Str.allInboxes(language))
        .accessibilityIdentifier(A11y.inboxTitleMenu)
    }

    @ToolbarContentBuilder
    private var toolbarButtons: some ToolbarContent {
        ToolbarItemGroup(placement: .topBarTrailing) {
            Button {
                isFiltering = true
            } label: {
                // A filled funnel when something is filtering, so the state is
                // visible without opening the sheet to find out.
                Image(systemName: model.fieldFilter.isEmpty
                      ? "line.3.horizontal.decrease.circle"
                      : "line.3.horizontal.decrease.circle.fill")
            }
            .accessibilityLabel(Str.filters(language))
            .accessibilityIdentifier(A11y.inboxFilter)

            Button {
                // Toggles: the magnifier is the only way in and the only way out,
                // so a second tap has to close what the first opened.
                isSearching.toggle()
            } label: {
                Image(systemName: "magnifyingglass")
            }
            .accessibilityLabel(Str.search(language))
            .accessibilityIdentifier(A11y.inboxSearch)
        }
    }

    /// A queue is current only when no channel is laid over it.
    private func isCurrent(_ filter: InboxFilter) -> Bool {
        model.channel == nil && model.filter == filter
    }

    /// The row the list rests on, leaving the search field just above the fold.

    private var filterInsets: EdgeInsets {
        EdgeInsets(
            top: Theme.Space.xs,
            leading: Theme.screenInset,
            bottom: Theme.Space.md,
            trailing: Theme.screenInset
        )
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
        error.text(language)
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

    /// The one line under the name.
    ///
    /// Three things can be there, in this order. A system notice is rebuilt
    /// from its metadata, because the body the server froze into the row is
    /// English. An attachment-only message has no body at all and has to be
    /// described. Everything else is the message itself, and a thread with no
    /// messages falls back to its subject.
    private var preview: String {
        let last = conversation.lastMessage

        if let text = SystemMessage.text(last?.systemMeta, language: language) {
            return text
        }

        if let kind = last?.attachmentKind, !kind.isEmpty,
           Format.preview(last?.body).isEmpty {
            return SystemMessage.attachmentPreview(
                kind: kind,
                isMe: last?.senderType == "agent",
                name: last?.senderName ?? conversation.contact?.name,
                language: language
            )
        }

        let body = Format.preview(last?.body)
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
