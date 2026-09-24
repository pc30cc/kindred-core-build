import SwiftUI
import Observation

@MainActor
@Observable
final class EmailThreadViewModel {
    private(set) var state: LoadState<[EmailMessageView]> = .loading
    private(set) var thread: EmailThreadSummary?
    private(set) var isSending = false
    private(set) var sendFailed = false
    var draft = ""

    private let api: any WebyarAPI

    init(api: any WebyarAPI = Backend.current) {
        self.api = api
    }

    var isStarred: Bool { thread?.isStarred == true }

    /// Who a reply goes to.
    ///
    /// The last person who wrote in, which is what "reply" means to everyone
    /// who has ever used a mail client. Falling back to the thread's
    /// participants covers a thread we only ever sent to.
    func recipients(mailbox: String?) -> [String] {
        if let inbound = state.value?.last(where: { !$0.isOutbound }),
           let from = inbound.fromAddress, !from.isEmpty {
            return [from]
        }
        let all = (thread?.participants ?? []).map(\.email)
        guard let mailbox else { return all }
        return all.filter { $0.caseInsensitiveCompare(mailbox) != .orderedSame }
    }

    func load(threadID: String, workspaceID: String?, appState: AppState) async {
        guard let workspaceID else {
            state = .loaded([])
            return
        }
        do {
            let response = try await api.emailThread(workspaceID: workspaceID, threadID: threadID)
            thread = response.thread
            state = .loaded(response.messages)
            // Opening a thread is what reading it means.
            try? await api.setEmailThreadRead(workspaceID: workspaceID, threadID: threadID, isRead: true)
        } catch APIError.unauthorized {
            await appState.handleUnauthorized()
        } catch let error as APIError {
            state = .failed(error)
        } catch {
            state = .failed(.transport)
        }
    }

    func toggleStar(workspaceID: String?) {
        guard let workspaceID, let thread else { return }
        let next = !(thread.isStarred == true)
        self.thread = EmailThreadSummary(
            id: thread.id, provider: thread.provider, subject: thread.subject,
            participants: thread.participants, lastMessageAt: thread.lastMessageAt,
            isRead: thread.isRead, isStarred: next, labels: thread.labels,
            lastMessageSnippet: thread.lastMessageSnippet
        )
        Task { try? await api.setEmailThreadStarred(workspaceID: workspaceID, threadID: thread.id, starred: next) }
    }

    func markUnread(workspaceID: String?) {
        guard let workspaceID, let id = thread?.id else { return }
        Task { try? await api.setEmailThreadRead(workspaceID: workspaceID, threadID: id, isRead: false) }
    }

    /// Sends the reply and reloads, so the trail shows what was actually
    /// recorded rather than an optimistic copy of it.
    func send(workspaceID: String?, mailbox: String?, appState: AppState) async {
        let body = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty, !isSending, let workspaceID, let thread else { return }
        let to = recipients(mailbox: mailbox)
        guard !to.isEmpty else {
            sendFailed = true
            return
        }

        isSending = true
        sendFailed = false
        defer { isSending = false }
        do {
            // The server rewrites the subject from the thread when it is given
            // a `thread_id`, so what goes up here is only a fallback.
            try await api.sendEmail(
                workspaceID: workspaceID,
                threadID: thread.id,
                to: to,
                subject: thread.subject ?? "",
                body: body
            )
            draft = ""
            await load(threadID: thread.id, workspaceID: workspaceID, appState: appState)
        } catch APIError.unauthorized {
            await appState.handleUnauthorized()
        } catch {
            sendFailed = true
        }
    }
}

/// One email thread: the subject, the trail, and a box to answer it.
struct EmailThreadView: View {
    let thread: EmailThreadSummary
    let mailbox: String?

    @Environment(AppState.self) private var appState
    @Environment(\.locale) private var locale
    @State private var model = EmailThreadViewModel()
    @FocusState private var isWriting: Bool

    private var language: Language { appState.language }
    private var workspaceID: String? { appState.selectedWorkspace?.id }

    private var subject: String {
        let value = model.thread?.subject ?? thread.subject
        return value?.isEmpty == false ? value! : Str.emailNoSubject(language)
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Theme.Space.md) {
                Text(subject)
                    .font(.app(.title3, weight: .semibold))
                    .foregroundStyle(Theme.Palette.label)
                    .frame(maxWidth: .infinity, alignment: .leading)

                switch model.state {
                case .loading:
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, Theme.Space.xxl)

                case .failed:
                    ErrorStateView(
                        title: Str.offlineTitle(language),
                        message: Str.offlineBody(language),
                        retryTitle: Str.retry(language),
                        onRetry: { Task { await reload() } }
                    )

                case .loaded(let messages):
                    ForEach(messages) { message in
                        EmailMessageCard(message: message, language: language, locale: locale)
                    }
                }
            }
            .padding(Theme.screenInset)
        }
        .background(Theme.Palette.background)
        .scrollDismissesKeyboard(.interactively)
        .simultaneousGesture(TapGesture().onEnded { isWriting = false })
        .safeAreaInset(edge: .bottom) { replyBar }
        .navigationTitle(Str.emailInbox(language))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button {
                        model.toggleStar(workspaceID: workspaceID)
                    } label: {
                        Label(Str.emailStar(language), systemImage: model.isStarred ? "star.slash" : "star")
                    }
                    Button {
                        model.markUnread(workspaceID: workspaceID)
                    } label: {
                        Label(Str.emailMarkUnread(language), systemImage: "envelope.badge")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
            }
        }
        .task(id: thread.id) { await reload() }
    }

    private func reload() async {
        await model.load(threadID: thread.id, workspaceID: workspaceID, appState: appState)
    }

    /// The same shape as the chat composer — a pill with the send button
    /// inside it — so answering a mail feels like answering anything else.
    private var replyBar: some View {
        @Bindable var model = model

        return VStack(spacing: Theme.Space.xs) {
            if model.sendFailed {
                Text(Str.emailSendFailed(language))
                    .font(Theme.Typo.meta)
                    .foregroundStyle(Theme.Palette.danger)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            PlainComposer(
                text: $model.draft,
                placeholder: Str.emailReplyPlaceholder(language),
                sendLabel: Str.emailSend(language),
                isEnabled: canSend,
                isSending: model.isSending,
                isWriting: $isWriting
            ) {
                isWriting = false
                Task { await model.send(workspaceID: workspaceID, mailbox: mailbox, appState: appState) }
            }
        }
        .padding(.horizontal, Theme.screenInset)
        .padding(.top, Theme.Space.sm)
        .padding(.bottom, Theme.Space.sm)
        .background(.bar)
    }

    private var canSend: Bool {
        !model.isSending && !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

/// One message in the trail.
private struct EmailMessageCard: View {
    let message: EmailMessageView
    let language: Language
    let locale: Locale

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.sm) {
            HStack(spacing: Theme.Space.sm) {
                Avatar(
                    name: message.fromAddress ?? "?",
                    imageURL: nil,
                    size: Theme.Size.avatarSmall - 4
                )

                VStack(alignment: .leading, spacing: 0) {
                    Text(message.fromAddress ?? "")
                        .font(Theme.Typo.rowTitle)
                        .foregroundStyle(Theme.Palette.label)
                        .lineLimit(1)

                    Text(Format.listTimestamp(message.sentAt, locale: locale))
                        .font(Theme.Typo.meta)
                        .foregroundStyle(Theme.Palette.labelTertiary)
                }

                Spacer(minLength: 0)

                // A reply that never left is the one thing worth calling out
                // in the trail; everything else the operator can read for
                // themselves.
                if message.deliveryStatus == "failed" {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.Palette.danger)
                }
            }

            Text(message.displayBody)
                .font(Theme.Typo.message)
                .foregroundStyle(Theme.Palette.label)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)

            if let attachments = message.attachments, !attachments.isEmpty {
                ForEach(attachments) { attachment in
                    Label(
                        attachment.filename ?? Str.file(language),
                        systemImage: "paperclip"
                    )
                    .font(Theme.Typo.meta)
                    .foregroundStyle(Theme.Palette.labelSecondary)
                }
            }
        }
        .padding(Theme.Space.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                .fill(message.isOutbound ? Theme.Palette.brand.opacity(0.08) : Theme.Palette.surface)
        )
    }
}
