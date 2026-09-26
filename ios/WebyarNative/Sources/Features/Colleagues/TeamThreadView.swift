import SwiftUI
import Observation

/// One day's worth of an internal thread, so the transcript can be broken up
/// the same way the visitor one is.
struct TeamMessageDay: Identifiable, Sendable {
    let id: Date
    let messages: [TeamMessage]
}

@MainActor
@Observable
final class TeamThreadViewModel {
    private(set) var state: LoadState<[TeamMessage]> = .loading
    /// Our own id, as the server reports it — which is how a message is known
    /// to be ours. Trusting the session's user id instead would be one more
    /// thing that can drift.
    private(set) var me: String?
    private(set) var isSending = false
    private(set) var sendFailed = false
    var draft = ""

    private let api: any WebyarAPI

    init(api: any WebyarAPI = Backend.current) {
        self.api = api
    }

    /// The same grouping the visitor transcript uses, including dropping a
    /// message with no timestamp: there is no day to file it under, and
    /// guessing one would put it in the wrong place rather than nowhere.
    func days(calendar: Calendar) -> [TeamMessageDay] {
        guard let messages = state.value else { return [] }
        let dated = messages
            .filter { $0.createdAt != nil }
            .sorted { ($0.createdAt ?? .distantPast) < ($1.createdAt ?? .distantPast) }

        var groups: [Date: [TeamMessage]] = [:]
        for message in dated {
            guard let created = message.createdAt else { continue }
            groups[calendar.startOfDay(for: created), default: []].append(message)
        }
        return groups.keys.sorted().map { TeamMessageDay(id: $0, messages: groups[$0] ?? []) }
    }

    func load(workspaceID: String?, peerID: String, appState: AppState) async {
        guard let workspaceID else {
            state = .loaded([])
            return
        }
        do {
            let response = try await api.teamThread(workspaceID: workspaceID, peerID: peerID)
            me = response.me
            state = .loaded(response.messages)
            try? await api.markTeamThreadRead(workspaceID: workspaceID, peerID: peerID)
        } catch APIError.unauthorized {
            await appState.handleUnauthorized()
        } catch let error as APIError {
            state = .failed(error)
        } catch {
            state = .failed(.transport)
        }
    }

    /// Quietly, without blanking the thread — this runs on a timer.
    func poll(workspaceID: String?, peerID: String) async {
        guard let workspaceID, !isSending,
              let response = try? await api.teamThread(workspaceID: workspaceID, peerID: peerID)
        else { return }
        me = response.me
        state = .loaded(response.messages)
    }

    func send(workspaceID: String?, peerID: String, appState: AppState) async {
        let body = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty, !isSending, let workspaceID else { return }

        isSending = true
        sendFailed = false
        defer { isSending = false }
        do {
            try await api.sendTeamMessage(
                workspaceID: workspaceID, recipientID: peerID, body: body, attachmentID: nil
            )
            draft = ""
            await reload(workspaceID: workspaceID, peerID: peerID, appState: appState)
        } catch APIError.unauthorized {
            await appState.handleUnauthorized()
        } catch {
            sendFailed = true
        }
    }

    /// A photo, a document or a voice note.
    ///
    /// Two steps, like the visitor chat: reserve a row and push the bytes,
    /// then hand the id to the message. The reservation carries no
    /// conversation — an internal file belongs to the workspace and to the
    /// operator who uploaded it, and the server checks both before it will
    /// let the message reference it.
    func sendAttachment(
        data: Data,
        fileName: String,
        mimeType: String,
        workspaceID: String?,
        peerID: String,
        appState: AppState
    ) async {
        guard !isSending, let workspaceID else { return }
        isSending = true
        sendFailed = false
        defer { isSending = false }
        do {
            let attachmentID = try await api.uploadAttachment(
                conversationID: nil,
                workspaceID: workspaceID,
                fileName: fileName,
                mimeType: mimeType,
                data: data
            )
            try await api.sendTeamMessage(
                workspaceID: workspaceID, recipientID: peerID, body: "", attachmentID: attachmentID
            )
            await reload(workspaceID: workspaceID, peerID: peerID, appState: appState)
        } catch APIError.unauthorized {
            await appState.handleUnauthorized()
        } catch {
            sendFailed = true
        }
    }

    /// Re-reads the thread without blanking it.
    ///
    /// `load` sets `.loading`, which after a send would throw the transcript
    /// away and put a spinner where the operator's own message just appeared.
    private func reload(workspaceID: String, peerID: String, appState: AppState) async {
        do {
            let response = try await api.teamThread(workspaceID: workspaceID, peerID: peerID)
            me = response.me
            state = .loaded(response.messages)
        } catch APIError.unauthorized {
            await appState.handleUnauthorized()
        } catch {
            // The message went; only the refresh failed. The ten-second poll
            // will pick it up.
        }
    }

    func dismissSendError() { sendFailed = false }
}

/// One colleague's thread. The same transcript rules as the visitor chat —
/// us on the right, them on the left, in every language — so the two screens
/// read the same way round.
struct TeamThreadView: View {
    let colleague: Colleague

    @Environment(AppState.self) private var appState
    @Environment(\.locale) private var locale
    @State private var model = TeamThreadViewModel()
    @FocusState private var isWriting: Bool

    private var language: Language { appState.language }
    private var workspaceID: String? { appState.selectedWorkspace?.id }

    var body: some View {
        transcript
            .background(Theme.Palette.background)
            .scrollDismissesKeyboard(.interactively)
            // `spacing: 0`, like the visitor chat: the default leaves a gap
            // between the transcript and the composer that the bar's own
            // material then shows through.
            .safeAreaInset(edge: .bottom, spacing: 0) { composer }
            .navigationTitle(colleague.displayName)
            .navigationBarTitleDisplayMode(.inline)
            .task(id: colleague.userId) {
                await model.load(
                    workspaceID: workspaceID, peerID: colleague.userId, appState: appState
                )
            }
            // The console polls this thread every ten seconds; so does this.
            // A colleague answering while you are looking at the screen should
            // not need a pull to appear. Team messages have no realtime channel
            // of their own on the server, so this stays a poll — but only while
            // the app is in front of the operator.
            .task(id: colleague.userId) {
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(10))
                    guard !Task.isCancelled else { return }
                    guard SyncCoordinator.shared.isForeground else { continue }
                    await model.poll(workspaceID: workspaceID, peerID: colleague.userId)
                }
            }
            // Back from the background: read at once, not up to ten seconds later.
            .task(id: colleague.userId) {
                for await event in SyncCoordinator.shared.events() where event == .resync {
                    await model.poll(workspaceID: workspaceID, peerID: colleague.userId)
                }
            }
            .alert(
                Str.offlineTitle(language),
                isPresented: Binding(
                    get: { model.sendFailed },
                    set: { if !$0 { model.dismissSendError() } }
                )
            ) {
                Button(Str.cancel(language), role: .cancel) { model.dismissSendError() }
            } message: {
                Text(Str.offlineBody(language))
            }
    }

    @ViewBuilder
    private var transcript: some View {
        switch model.state {
        case .loading:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)

        case .failed:
            ErrorStateView(
                title: Str.offlineTitle(language),
                message: Str.offlineBody(language),
                retryTitle: Str.retry(language),
                onRetry: {
                    Task {
                        await model.load(
                            workspaceID: workspaceID, peerID: colleague.userId, appState: appState
                        )
                    }
                }
            )

        case .loaded:
            let days = model.days(calendar: calendar)
            if days.isEmpty {
                EmptyStateView(
                    systemImage: "bubble.left.and.bubble.right",
                    title: Str.colleagueThreadEmpty(language),
                    message: ""
                )
                .frame(maxHeight: .infinity)
            } else {
                PinnedScrollView(
                    conversationKey: colleague.userId,
                    revision: revisionOf(days)
                ) {
                    LazyVStack(spacing: Theme.Space.xxs) {
                        ForEach(days) { day in
                            Section {
                                ForEach(Array(day.messages.enumerated()), id: \.element.id) { index, message in
                                    TeamMessageRow(
                                        message: message,
                                        isOutgoing: message.senderId == (model.me ?? ""),
                                        // One face at the foot of a run, the
                                        // same rule the visitor transcript
                                        // follows.
                                        showsAvatar: Self.endsRun(
                                            day.messages, at: index, me: model.me ?? ""
                                        ),
                                        colleague: colleague,
                                        language: language,
                                        locale: locale
                                    )
                                }
                            } header: {
                                DayHeader(text: Format.dayHeader(day.id, locale: locale))
                            }
                        }
                    }
                    .padding(.horizontal, Theme.screenInset)
                    .padding(.vertical, Theme.Space.md)
                }
                .simultaneousGesture(TapGesture().onEnded { isWriting = false })
            }
        }
    }

    /// A run ends when the next message is from the other person.
    private static func endsRun(_ messages: [TeamMessage], at index: Int, me: String) -> Bool {
        guard index + 1 < messages.count else { return true }
        return (messages[index + 1].senderId == me) != (messages[index].senderId == me)
    }

    /// Enough to notice a new or changed message without depending on the
    /// count alone, which a replaced message leaves untouched.
    private func revisionOf(_ days: [TeamMessageDay]) -> Int {
        var hasher = Hasher()
        hasher.combine(days.reduce(0) { $0 + $1.messages.count })
        hasher.combine(days.last?.messages.last?.id ?? "")
        return hasher.finalize()
    }

    /// The same composer the visitor chat uses.
    ///
    /// It used to be a hand-rolled field and send button, which is why the
    /// internal inbox could only ever send words: no paperclip, no voice note,
    /// no emoji, no saved replies. There was never a reason for the two
    /// screens to be different — a colleague is a person you send a screenshot
    /// to more often than a visitor is — and the difference only meant one of
    /// them got every improvement and the other got none.
    private var composer: some View {
        @Bindable var model = model

        return Composer(
            text: $model.draft,
            placeholder: Str.messagePlaceholder(language),
            sendLabel: Str.send(language),
            canSend: canSend,
            isSending: model.isSending,
            capabilities: capabilities,
            language: language,
            // No AI ever owns an internal thread, so this is never shown.
            isWriting: $isWriting,
            onSend: {
                Task {
                    await model.send(
                        workspaceID: workspaceID, peerID: colleague.userId, appState: appState
                    )
                }
            },
            onAttach: { data, name, mime in
                Task {
                    await model.sendAttachment(
                        data: data, fileName: name, mimeType: mime,
                        workspaceID: workspaceID, peerID: colleague.userId, appState: appState
                    )
                }
            },
            // No saved replies here. They are written to answer a visitor —
            // "thanks for getting in touch", "let me look into that" — and
            // the reader in this thread is a colleague. Offering them meant
            // offering a drawer of the wrong register, and the one they
            // would reach for most, the greeting, is the one with
            // `{{contact.name}}` in it, which has nothing to resolve to.
            shortcuts: nil
        )
    }

    /// Every composer tool: an internal thread has no AI to hand over to, and
    /// the plan's `widget_*` keys govern the customer-facing website widget,
    /// not what operators send each other.
    private var capabilities: ComposerCapabilities { .team }


    private var calendar: Calendar { Format.workingCalendar(locale) }

    private var canSend: Bool {
        !model.isSending && !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

private struct TeamMessageRow: View {
    let message: TeamMessage
    let isOutgoing: Bool
    let showsAvatar: Bool
    let colleague: Colleague
    let language: Language
    let locale: Locale

    @Environment(AppState.self) private var appState

    private var size: CGFloat { Theme.Size.avatarSmall - 4 }

    /// Keeps the gutter whether or not a face is drawn, so every bubble in a
    /// run starts on the same line instead of stepping in and out.
    @ViewBuilder
    private var avatarSlot: some View {
        Group {
            if showsAvatar {
                if isOutgoing {
                    Avatar(
                        name: appState.session.user?.displayName ?? "—",
                        imageURL: appState.myAvatarURL,
                        size: size
                    )
                } else {
                    Avatar(name: colleague.displayName, imageURL: colleague.avatarURL, size: size)
                }
            } else {
                Color.clear
            }
        }
        .frame(width: size, height: size)
    }

    var body: some View {
        VStack(alignment: isOutgoing ? .trailing : .leading, spacing: Theme.Space.xxs) {
            HStack(alignment: .bottom, spacing: Theme.Space.xs) {
                if isOutgoing { Spacer(minLength: Theme.Space.xl) }
                if !isOutgoing { avatarSlot }

                VStack(alignment: isOutgoing ? .trailing : .leading, spacing: Theme.Space.xxs) {
                    if let attachment = message.attachment {
                        AttachmentView(
                            attachment: attachment,
                            isOutgoing: isOutgoing,
                            language: language,
                            hasBeak: (message.body ?? "").isEmpty
                        )
                        .environment(\.layoutDirection, language.layoutDirection)
                    }

                    if let body = message.body, !body.trimmingCharacters(in: .whitespaces).isEmpty {
                        Text(body)
                            .font(Theme.Typo.message)
                            .foregroundStyle(isOutgoing
                                ? Theme.Palette.bubbleOutgoingText
                                : Theme.Palette.bubbleIncomingText)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.horizontal, Theme.Space.md)
                            .padding(.vertical, Theme.Space.sm + 2)
                            .environment(\.layoutDirection, language.layoutDirection)
                            .chatBubble(
                                isOutgoing ? Theme.Palette.bubbleOutgoing : Theme.Palette.bubbleIncoming,
                                hasBeak: true,
                                pointsRight: isOutgoing
                            )
                            .textSelection(.enabled)
                    }
                }

                if isOutgoing { avatarSlot }
                if !isOutgoing { Spacer(minLength: Theme.Space.xl) }
            }

            // Only under the last bubble of a run: a timestamp on every line
            // of a three-line reply is noise, the same as a repeated face.
            if showsAvatar {
                Text(Format.bubbleTime(message.createdAt, locale: locale))
                    .font(.caption2)
                    .foregroundStyle(Theme.Palette.labelTertiary)
                    .padding(.horizontal, size + Theme.Space.sm)
                    .environment(\.layoutDirection, language.layoutDirection)
            }
        }
        // Same rule as the visitor transcript: the side is physical, so it
        // does not swap when the interface turns around.
        .environment(\.layoutDirection, .leftToRight)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(A11y.messageRow(message.id))
    }
}
