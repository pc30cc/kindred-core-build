import SwiftUI
import Observation

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
            await load(workspaceID: workspaceID, peerID: peerID, appState: appState)
        } catch APIError.unauthorized {
            await appState.handleUnauthorized()
        } catch {
            sendFailed = true
        }
    }
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
            .safeAreaInset(edge: .bottom) { composer }
            .navigationTitle(colleague.displayName)
            .navigationBarTitleDisplayMode(.inline)
            .task(id: colleague.userId) {
                await model.load(
                    workspaceID: workspaceID, peerID: colleague.userId, appState: appState
                )
            }
            // The console polls this thread every ten seconds; so does this.
            // A colleague answering while you are looking at the screen should
            // not need a pull to appear.
            .task(id: colleague.userId) {
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(10))
                    guard !Task.isCancelled else { return }
                    await model.poll(workspaceID: workspaceID, peerID: colleague.userId)
                }
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

        case .loaded(let messages):
            if messages.isEmpty {
                EmptyStateView(
                    systemImage: "bubble.left.and.bubble.right",
                    title: Str.colleagueThreadEmpty(language),
                    message: ""
                )
            } else {
                PinnedScrollView(conversationKey: colleague.userId, revision: messages.count) {
                    LazyVStack(spacing: Theme.Space.xs) {
                        ForEach(messages) { message in
                            TeamMessageRow(
                                message: message,
                                isOutgoing: message.senderId == (model.me ?? ""),
                                colleague: colleague,
                                language: language,
                                locale: locale
                            )
                        }
                    }
                    .padding(.horizontal, Theme.screenInset)
                    .padding(.vertical, Theme.Space.md)
                }
                .simultaneousGesture(TapGesture().onEnded { isWriting = false })
            }
        }
    }

    private var composer: some View {
        @Bindable var model = model

        return VStack(spacing: Theme.Space.xs) {
            if model.sendFailed {
                Text(Str.saveFailed(language))
                    .font(Theme.Typo.meta)
                    .foregroundStyle(Theme.Palette.danger)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            HStack(alignment: .bottom, spacing: Theme.Space.xs) {
                TextField(Str.messagePlaceholder(language), text: $model.draft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...5)
                    .focused($isWriting)
                    .padding(.horizontal, Theme.Space.sm)
                    .padding(.vertical, Theme.Space.sm - 1)

                Button {
                    isWriting = false
                    Task {
                        await model.send(
                            workspaceID: workspaceID, peerID: colleague.userId, appState: appState
                        )
                    }
                } label: {
                    Group {
                        if model.isSending {
                            ProgressView().tint(.white)
                        } else {
                            Image(systemName: "arrow.up")
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(.white)
                        }
                    }
                    .frame(width: 34, height: 34)
                    .background(Circle().fill(canSend ? Theme.Palette.brand : Theme.Palette.brand.opacity(0.35)))
                }
                .disabled(!canSend)
                .accessibilityLabel(Str.send(language))
            }
            .padding(Theme.Space.xs)
            .background(Capsule().fill(Theme.Palette.surface))
        }
        .padding(.horizontal, Theme.screenInset)
        .padding(.vertical, Theme.Space.sm)
        .background(.bar)
    }

    private var canSend: Bool {
        !model.isSending && !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

private struct TeamMessageRow: View {
    let message: TeamMessage
    let isOutgoing: Bool
    let colleague: Colleague
    let language: Language
    let locale: Locale

    var body: some View {
        VStack(alignment: isOutgoing ? .trailing : .leading, spacing: Theme.Space.xxs) {
            HStack(alignment: .bottom, spacing: Theme.Space.xs) {
                if isOutgoing { Spacer(minLength: Theme.Space.xl) }

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

                if !isOutgoing { Spacer(minLength: Theme.Space.xl) }
            }

            Text(Format.bubbleTime(message.createdAt, locale: locale))
                .font(.caption2)
                .foregroundStyle(Theme.Palette.labelTertiary)
                .padding(.horizontal, Theme.Space.xs)
                .environment(\.layoutDirection, language.layoutDirection)
        }
        // Same rule as the visitor transcript: the side is physical, so it
        // does not swap when the interface turns around.
        .environment(\.layoutDirection, .leftToRight)
    }
}
