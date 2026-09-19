import SwiftUI
import Observation

// The mailbox. Reached from the inbox's own title menu, because that is what
// the operator means by "my other inbox" — not a fourth tab along the bottom.
//
// It is deliberately a different screen from the chat inbox rather than
// another queue inside it: these are email threads with subjects, recipients
// and quoted trails, not conversations with a visitor, and the server keeps
// them on a separate surface for exactly that reason.

@MainActor
@Observable
final class EmailInboxViewModel {
    private(set) var state: LoadState<[EmailThreadSummary]> = .loading
    /// Whose mailbox this is. Decorative — a failure never becomes an error
    /// state, it just leaves the caption off.
    private(set) var mailbox: String?
    /// Set when the workspace has the module but no mailbox connected yet,
    /// which is a thing to explain rather than an error to retry.
    private(set) var notConnected = false
    var searchText = ""

    private let api: any WebyarAPI

    init(api: any WebyarAPI = Backend.current) {
        self.api = api
    }

    /// Filtered here rather than on the server, the same way the chat inbox
    /// filters its own list, so "matches" means the same thing on both
    /// screens. The server's `q=` would search the whole mailbox; this
    /// searches what is on screen.
    var visible: [EmailThreadSummary] {
        guard let all = state.value else { return [] }
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !query.isEmpty else { return all }
        return all.filter { thread in
            let haystack = [thread.subject, thread.lastMessageSnippet]
                + (thread.participants ?? []).map(\.email)
            return haystack.contains { $0?.lowercased().contains(query) == true }
        }
    }

    func load(workspaceID: String?, appState: AppState) async {
        guard let workspaceID else {
            state = .loaded([])
            return
        }
        do {
            let threads = try await api.emailThreads(workspaceID: workspaceID, search: nil)
            state = .loaded(threads)
            notConnected = false
        } catch APIError.unauthorized {
            await appState.handleUnauthorized()
        } catch APIError.server(let status, let message) where status == 409 || message == "email_not_connected" {
            // 409 is the server saying the mailbox has never been connected.
            notConnected = true
            state = .loaded([])
        } catch let error as APIError {
            state = .failed(error)
        } catch {
            state = .failed(.transport)
        }
        // Double-unwrapped: the call is both failable and optional, and a
        // mailbox we could not name is the same as no caption.
        mailbox = ((try? await api.gmailConnection(workspaceID: workspaceID)) ?? nil)?.emailAddress
    }

    func refresh(workspaceID: String?, appState: AppState) async {
        guard let workspaceID, let threads = try? await api.emailThreads(workspaceID: workspaceID, search: nil)
        else { return }
        state = .loaded(threads)
    }

    /// Unbolds the row as soon as its thread opens, rather than at the next
    /// refresh. Only the row: opening the thread is what tells the server it
    /// was read, and saying so twice would be two requests for one act.
    func markReadLocally(_ threadID: String) {
        replace(threadID) { EmailThreadSummary(
            id: $0.id, provider: $0.provider, subject: $0.subject, participants: $0.participants,
            lastMessageAt: $0.lastMessageAt, isRead: true, isStarred: $0.isStarred,
            labels: $0.labels, lastMessageSnippet: $0.lastMessageSnippet
        ) }
    }

    private func replace(_ id: String, _ transform: (EmailThreadSummary) -> EmailThreadSummary) {
        guard var all = state.value, let index = all.firstIndex(where: { $0.id == id }) else { return }
        all[index] = transform(all[index])
        state = .loaded(all)
    }
}

struct EmailInboxView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.locale) private var locale
    @State private var model = EmailInboxViewModel()
    @State private var isSearching = false

    private var language: Language { appState.language }
    private var workspaceID: String? { appState.selectedWorkspace?.id }

    var body: some View {
        @Bindable var model = model

        content
            .navigationTitle(Str.emailInbox(language))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                // Two lines, the way a mail client names the mailbox it is
                // showing: what this screen is, and whose it is.
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 0) {
                        Text(Str.emailInbox(language))
                            .font(.headline)
                            .foregroundStyle(Theme.Palette.label)
                        if let mailbox = model.mailbox, !mailbox.isEmpty {
                            Text(mailbox)
                                .font(.caption2)
                                .foregroundStyle(Theme.Palette.labelSecondary)
                                .lineLimit(1)
                        }
                    }
                }

                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        isSearching = true
                    } label: {
                        Image(systemName: "magnifyingglass")
                    }
                    .accessibilityLabel(Str.search(language))
                }
            }
            .refreshable {
                await model.refresh(workspaceID: workspaceID, appState: appState)
            }
            .task(id: workspaceID) {
                await model.load(workspaceID: workspaceID, appState: appState)
            }
    }

    @ViewBuilder
    private var content: some View {
        @Bindable var model = model

        SearchRestingList(
            text: $model.searchText,
            prompt: Str.search(language),
            anchorID: Self.restAnchor,
            resetToken: workspaceID ?? "-",
            isReady: model.state.isLoaded,
            isSearching: $isSearching
        ) {
            switch model.state {
            case .loading:
                ForEach(0..<8, id: \.self) { _ in
                    ContactRowSkeleton()
                        .measuredListRow()
                }

            case .failed:
                ErrorStateView(
                    title: Str.offlineTitle(language),
                    message: Str.offlineBody(language),
                    retryTitle: Str.retry(language),
                    onRetry: { Task { await model.load(workspaceID: workspaceID, appState: appState) } }
                )
                .listRowInsets(EdgeInsets())
                .listRowSeparator(.hidden)
                .measuredListRow()

            case .loaded:
                if model.visible.isEmpty {
                    EmptyStateView(
                        systemImage: model.notConnected ? "envelope.badge.shield.half.filled" : "envelope",
                        title: model.notConnected
                            ? Str.emailNotConnectedTitle(language)
                            : (model.searchText.isEmpty ? Str.emailEmptyTitle(language) : Str.noResults(language)),
                        message: model.notConnected
                            ? Str.emailNotConnectedBody(language)
                            : (model.searchText.isEmpty ? Str.emailEmptyBody(language) : "")
                    )
                    .id(Self.restAnchor)
                    .listRowInsets(EdgeInsets())
                    .listRowSeparator(.hidden)
                    .measuredListRow()
                } else {
                    ForEach(Array(model.visible.enumerated()), id: \.element.id) { index, thread in
                        NavigationLink(value: thread) {
                            EmailThreadRow(
                                thread: thread,
                                mailbox: model.mailbox,
                                language: language,
                                locale: locale
                            )
                        }
                        .id(index == 0 ? Self.restAnchor : thread.id)
                        .measuredListRow()
                    }
                }
            }
        }
        .navigationDestination(for: EmailThreadSummary.self) { thread in
            EmailThreadView(thread: thread, mailbox: model.mailbox)
                .onAppear { model.markReadLocally(thread.id) }
        }
    }

    private static let restAnchor = "email.top"
}

/// One thread in the list: who it is with, what it is about, and the last line
/// of it — the same three things the conversation rows carry.
struct EmailThreadRow: View {
    let thread: EmailThreadSummary
    let mailbox: String?
    let language: Language
    let locale: Locale

    private var unread: Bool { thread.isRead != true }

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Space.md) {
            Avatar(
                name: thread.people(excluding: mailbox),
                imageURL: nil,
                size: Theme.Size.avatarSmall
            )

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: Theme.Space.xs) {
                    Text(thread.people(excluding: mailbox))
                        .font(Theme.Typo.rowTitle)
                        // An unread thread is heavier, which is the one
                        // difference Mail leans on and it is enough.
                        .fontWeight(unread ? .bold : .semibold)
                        .foregroundStyle(Theme.Palette.label)
                        .lineLimit(1)

                    if thread.isStarred == true {
                        Image(systemName: "star.fill")
                            .font(.system(size: 10))
                            .foregroundStyle(.yellow)
                    }

                    Spacer(minLength: Theme.Space.xs)

                    Text(Format.listTimestamp(thread.lastMessageAt, locale: locale))
                        .font(Theme.Typo.meta)
                        .foregroundStyle(Theme.Palette.labelTertiary)
                }

                Text(thread.subject?.isEmpty == false ? thread.subject! : Str.emailNoSubject(language))
                    .font(Theme.Typo.rowSubtitle)
                    .foregroundStyle(unread ? Theme.Palette.label : Theme.Palette.labelSecondary)
                    .lineLimit(1)

                if let snippet = thread.lastMessageSnippet, !snippet.isEmpty {
                    Text(snippet)
                        .font(Theme.Typo.rowSubtitle)
                        .foregroundStyle(Theme.Palette.labelSecondary)
                        .lineLimit(2)
                }
            }
        }
        .padding(.vertical, Theme.Space.xxs)
    }
}
