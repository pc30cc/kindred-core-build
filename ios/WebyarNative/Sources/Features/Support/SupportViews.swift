import SwiftUI

// Settings → Online support (docs/PLATFORM_SUPPORT.md): one row in Settings,
// the chat it opens, and the conversations that ended — the same three
// screens as the Android app.

// MARK: - Settings

/// Settings → Online support: one row, into the chat with the platform's
/// team — whether it is there now, and how much of what it wrote is unread.
/// Offline, the same row: a message is delivered all the same.
struct SupportSettingsSection: View {
    let status: SupportStatus
    let language: Language

    var body: some View {
        Section {
            NavigationLink(value: SettingsRoute.support) {
                HStack(spacing: Theme.Space.md) {
                    SupportTeamMark(online: nil, avatarURL: nil, size: 36)

                    VStack(alignment: .leading, spacing: Theme.Space.xxs) {
                        Text(SupportStr.chat(language))
                            .font(.app(.body))
                            .foregroundStyle(Theme.Palette.label)
                            .lineLimit(1)
                        SupportPresenceLine(online: status.online, language: language)
                    }

                    Spacer(minLength: Theme.Space.sm)

                    if status.unread > 0 {
                        UnreadBadge(count: status.unread)
                    }
                }
                .padding(.vertical, Theme.Space.xxs)
                .accessibilityElement(children: .combine)
                .accessibilityValue(status.unread > 0 ? SupportStr.unread(language, status.unread) : "")
            }
            .accessibilityIdentifier(A11y.settingsSupportChat)
        } header: {
            Text(SupportStr.section(language))
        }
    }
}

// MARK: - The chat

/// The support chat: the conversation that is open — or, with none open, a
/// page as fresh as the very first. Conversations that ended are on their
/// own screen, behind the bar's "Closed" button, not here.
///
/// At the bottom, the composer. When the conversation on screen ends, nothing
/// more is written to it: the composer gives way to the end and a button that
/// starts a new conversation. While nobody is online a banner says so, with
/// the team's hours; a message is delivered all the same.
struct SupportChatView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.scenePhase) private var scenePhase
    @State private var model = SupportChatModel()
    @FocusState private var isWriting: Bool

    private var language: Language { appState.language }

    var body: some View {
        VStack(spacing: 0) {
            if let status = model.status, status.shown, !status.online {
                SupportOfflineBanner(status: status, language: language)
            }
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(Theme.Palette.background)
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom, spacing: 0) { bottom }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                SupportBarTitle(
                    title: model.status?.teamName ?? SupportStr.title(language),
                    subtitle: nil,
                    online: model.status?.online,
                    avatarURL: model.status?.teamAvatar,
                    showsMark: true,
                    language: language
                )
            }
            ToolbarItem(placement: .topBarTrailing) {
                if !(model.content?.closed.isEmpty ?? true) {
                    NavigationLink(value: SettingsRoute.supportClosed) {
                        Label(SupportStr.closedAction(language), systemImage: "clock.arrow.circlepath")
                            .labelStyle(.titleAndIcon)
                            .font(.app(.subheadline, .medium))
                    }
                    .accessibilityIdentifier(A11y.supportClosedButton)
                }
            }
        }
        .task {
            model.language = language
            model.onUnauthorized = { [appState] in await appState.handleUnauthorized() }
            model.isRealtimeUp = { SyncCoordinator.shared.teamRealtimeConnected }
            await model.open(workspaceID: appState.selectedWorkspace?.id)
        }
        // Read only while in front of the operator — "unread" is cleared here
        // — with the team's news as it comes, and a poll in case the channel
        // is down. Backgrounded, nothing runs: APNs is the way in from there.
        .task(id: scenePhase == .active) {
            guard scenePhase == .active else { return }
            await model.follow(SyncCoordinator.shared.supportSignals())
        }
        // On screen, the team's next reply needs no banner, and the ones
        // already on the lock screen have done their job.
        .onAppear {
            PushController.shared.viewingSupport = true
            PushController.clearDeliveredSupport()
        }
        .onDisappear { PushController.shared.viewingSupport = false }
        .onChange(of: language) { _, now in model.language = now }
        .onChange(of: model.focusRequest) { _, _ in isWriting = true }
        .alert(
            model.notice ?? "",
            isPresented: Binding(get: { model.notice != nil }, set: { if !$0 { model.notice = nil } })
        ) {
            Button(Str.ok(language), role: .cancel) { model.notice = nil }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch model.state {
        case .loading:
            ProgressView()

        case .failed(let message):
            ErrorStateView(
                title: Str.offlineTitle(language),
                message: message,
                retryTitle: Str.retry(language),
                onRetry: { Task { await model.refresh() } }
            )

        case .loaded(let content):
            if content.isEmpty {
                EmptyStateView(
                    systemImage: "bubble.left.and.text.bubble.right",
                    title: SupportStr.greeting(language),
                    message: SupportStr.greetingBody(language)
                )
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier(A11y.supportGreeting)
                .contentShape(Rectangle())
                .onTapGesture { isWriting = false }
            } else {
                SupportTranscript(
                    conversations: content.shown.map { [$0] } ?? [],
                    items: content.shownItems,
                    pending: content.pending,
                    language: language,
                    ratingBusy: model.rater.busy,
                    scrollKey: "support",
                    onRetry: { model.retry($0) },
                    onRate: { id, score, comment in Task { await model.rate(id, score: score, comment: comment) } }
                )
                .simultaneousGesture(TapGesture().onEnded { isWriting = false })
            }
        }
    }

    @ViewBuilder
    private var bottom: some View {
        if let content = model.content {
            switch content.composer {
            case .ended:
                SupportEndedPanel(conversation: content.shown, language: language) {
                    model.startNewConversation()
                }
            case .fresh, .active:
                composer
            }
        }
    }

    /// The app's own composer: text, a photo or a document — 2 MB, the six
    /// types the endpoint takes — and nothing else: no voice note, no emoji,
    /// no saved replies.
    private var composer: some View {
        @Bindable var model = model
        return Composer(
            text: $model.draft,
            placeholder: Str.messagePlaceholder(language),
            sendLabel: Str.send(language),
            canSend: !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            isSending: false,
            capabilities: .support,
            language: language,
            isWriting: $isWriting,
            onSend: { model.send() },
            onAttach: { data, name, mime in model.sendFile(data: data, fileName: name, mimeType: mime) },
            shortcuts: nil,
            attachments: .support
        )
    }
}

// MARK: - Closed conversations

/// What a closed conversation is called: its first words, or a plain name.
func supportClosedTitle(_ preview: String?, language: Language) -> String {
    guard let preview, !preview.trimmingCharacters(in: .whitespaces).isEmpty else {
        return SupportStr.conversationUntitled(language)
    }
    return preview
}

/// «حل شد · یکشنبه ۵ مهر»: how and when it ended.
func supportClosedSubtitle(_ conversation: SupportConversation, language: Language, locale: Locale) -> String {
    let word = SupportStr.statusWord(language, status: conversation.status)
    guard let at = conversation.endedAt ?? conversation.createdAt else { return word }
    return "\(word) · \(Format.dayHeader(at, locale: locale))"
}

/// The conversations that ended, the one that ended last first: each by its
/// first words, how and when it ended, and its stars — or a nudge to give
/// them. A tap reads it back.
struct SupportClosedListView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.locale) private var locale
    @Environment(\.scenePhase) private var scenePhase
    @State private var model = SupportArchiveModel()

    private var language: Language { appState.language }

    var body: some View {
        Group {
            switch model.state {
            case .loading:
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            case .failed(let message):
                ErrorStateView(
                    title: Str.offlineTitle(language),
                    message: message,
                    retryTitle: Str.retry(language),
                    onRetry: { Task { await model.load() } }
                )
            case .loaded:
                if model.closed.isEmpty {
                    EmptyStateView(systemImage: "tray", title: SupportStr.closedEmpty(language), message: "")
                        .frame(maxHeight: .infinity)
                } else {
                    List(model.closed) { conversation in
                        NavigationLink(value: SettingsRoute.supportClosedConversation(conversation.id)) {
                            SupportClosedRow(
                                conversation: conversation,
                                title: supportClosedTitle(model.preview(conversation.id), language: language),
                                subtitle: supportClosedSubtitle(conversation, language: language, locale: locale),
                                language: language
                            )
                        }
                        .accessibilityIdentifier(A11y.supportClosedRow(conversation.id))
                    }
                    .listStyle(.insetGrouped)
                    .accessibilityIdentifier(A11y.supportClosedList)
                }
            }
        }
        .background(Theme.Palette.background)
        .navigationTitle(SupportStr.closedTitle(language))
        .navigationBarTitleDisplayMode(.inline)
        .task {
            model.language = language
            model.onUnauthorized = { [appState] in await appState.handleUnauthorized() }
            // Every time it comes back on screen: a conversation just rated
            // there shows its stars here.
            await model.load()
        }
        .task(id: scenePhase == .active) {
            guard scenePhase == .active else { return }
            await model.follow(SyncCoordinator.shared.supportSignals())
        }
    }
}

private struct SupportClosedRow: View {
    let conversation: SupportConversation
    let title: String
    let subtitle: String
    let language: Language

    private var resolved: Bool { conversation.status != SupportConversation.closed }

    var body: some View {
        HStack(spacing: Theme.Space.md) {
            Image(systemName: resolved ? "checkmark.circle.fill" : "clock.arrow.circlepath")
                .font(.system(size: 18))
                .foregroundStyle(resolved ? SupportLook.online : Theme.Palette.labelSecondary)
                .frame(width: 36, height: 36)
                .background(Circle().fill(Theme.Palette.surfaceElevated))

            VStack(alignment: .leading, spacing: Theme.Space.xxs) {
                Text(title)
                    .font(.app(.body))
                    .foregroundStyle(Theme.Palette.label)
                    .lineLimit(1)
                Text(subtitle)
                    .font(.app(.footnote))
                    .foregroundStyle(Theme.Palette.labelSecondary)
                    .lineLimit(1)
            }

            Spacer(minLength: Theme.Space.sm)

            if let given = conversation.rating {
                HStack(spacing: 2) {
                    Image(systemName: "star.fill")
                        .font(.app(.footnote))
                        .foregroundStyle(SupportLook.star)
                    Text(Format.number(given.score, language: language))
                        .font(.app(.footnote, .semibold))
                        .foregroundStyle(Theme.Palette.label)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(SupportStr.stars(language, given.score))
            } else if conversation.canRate {
                Text(SupportStr.rateAction(language))
                    .font(.app(.footnote, .semibold))
                    .foregroundStyle(Theme.Palette.brand)
            }
        }
        .padding(.vertical, Theme.Space.xxs)
        .accessibilityElement(children: .combine)
    }
}

/// One closed conversation, read back: its messages, how it ended, and its
/// rating — given, or still to give. Nothing is written here.
struct SupportClosedConversationView: View {
    let conversationID: String

    @Environment(AppState.self) private var appState
    @Environment(\.locale) private var locale
    @Environment(\.scenePhase) private var scenePhase
    @State private var model = SupportArchiveModel()

    private var language: Language { appState.language }

    var body: some View {
        Group {
            switch model.state {
            case .loading:
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            case .failed(let message):
                ErrorStateView(
                    title: Str.offlineTitle(language),
                    message: message,
                    retryTitle: Str.retry(language),
                    onRetry: { Task { await model.load() } }
                )
            case .loaded:
                if let conversation = model.conversation(conversationID) {
                    SupportTranscript(
                        conversations: [conversation],
                        items: model.items(of: conversationID),
                        pending: [],
                        language: language,
                        ratingBusy: model.rater.busy,
                        scrollKey: "support-\(conversationID)",
                        onRetry: { _ in },
                        onRate: { id, score, comment in Task { await model.rate(id, score: score, comment: comment) } }
                    )
                } else {
                    EmptyStateView(systemImage: "tray", title: SupportStr.closedEmpty(language), message: "")
                        .frame(maxHeight: .infinity)
                }
            }
        }
        .background(Theme.Palette.background)
        .scrollDismissesKeyboard(.interactively)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                SupportBarTitle(
                    title: supportClosedTitle(model.preview(conversationID), language: language),
                    subtitle: model.conversation(conversationID).map {
                        supportClosedSubtitle($0, language: language, locale: locale)
                    },
                    language: language
                )
            }
        }
        .task {
            model.language = language
            model.onUnauthorized = { [appState] in await appState.handleUnauthorized() }
            await model.open()
        }
        .task(id: scenePhase == .active) {
            guard scenePhase == .active else { return }
            await model.follow(SyncCoordinator.shared.supportSignals())
        }
        .alert(
            model.notice ?? "",
            isPresented: Binding(get: { model.notice != nil }, set: { if !$0 { model.notice = nil } })
        ) {
            Button(Str.ok(language), role: .cancel) { model.notice = nil }
        }
    }
}
