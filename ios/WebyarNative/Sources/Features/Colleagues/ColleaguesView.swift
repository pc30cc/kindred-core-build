import SwiftUI
import Observation

// The internal inbox: operators talking to each other, not to visitors.
//
// The console keeps it inside the Inbox under "Internal inbox", and so does
// this — it is reached from the same switcher. It is a different shape from a
// conversation though: no contact, no queue, no status, just a colleague and a
// thread with them, which is why it is its own screen rather than another
// filter over the same list.

@MainActor
@Observable
final class ColleaguesViewModel {
    private(set) var state: LoadState<[Colleague]> = .loading
    var searchText = ""

    private let api: any WebyarAPI

    init(api: any WebyarAPI = Backend.current) {
        self.api = api
    }

    var visible: [Colleague] {
        guard let all = state.value else { return [] }
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !query.isEmpty else { return all }
        return all.filter { colleague in
            [colleague.fullName, colleague.email]
                .contains { $0?.lowercased().contains(query) == true }
        }
    }

    func load(workspaceID: String?, appState: AppState) async {
        guard let workspaceID else {
            state = .loaded([])
            return
        }
        do {
            state = .loaded(try await api.colleagues(workspaceID: workspaceID).colleagues)
        } catch APIError.unauthorized {
            await appState.handleUnauthorized()
        } catch let error as APIError {
            state = .failed(error)
        } catch {
            state = .failed(.transport)
        }
    }

    func refresh(workspaceID: String?) async {
        guard let workspaceID,
              let colleagues = try? await api.colleagues(workspaceID: workspaceID).colleagues
        else { return }
        state = .loaded(colleagues)
    }

    /// Clears the badge as the thread opens, rather than one refresh later.
    func markRead(_ userID: String) {
        guard var all = state.value, let index = all.firstIndex(where: { $0.userId == userID })
        else { return }
        let old = all[index]
        all[index] = Colleague(
            userId: old.userId, role: old.role, fullName: old.fullName, email: old.email,
            avatarURL: old.avatarURL, unread: 0, lastMessage: old.lastMessage
        )
        state = .loaded(all)
    }
}

struct ColleaguesView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.locale) private var locale
    @State private var model = ColleaguesViewModel()
    @State private var isSearching = false

    private var language: Language { appState.language }
    private var workspaceID: String? { appState.selectedWorkspace?.id }

    var body: some View {
        @Bindable var model = model

        content
            .navigationTitle(Str.colleagues(language))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        isSearching = true
                    } label: {
                        Image(systemName: "magnifyingglass")
                    }
                    .accessibilityLabel(Str.search(language))
                }
            }
            .refreshable { await model.refresh(workspaceID: workspaceID) }
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
                    ContactRowSkeleton().measuredListRow()
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
                        systemImage: model.searchText.isEmpty ? "person.2" : "magnifyingglass",
                        title: model.searchText.isEmpty
                            ? Str.colleaguesEmptyTitle(language)
                            : Str.noResults(language),
                        message: model.searchText.isEmpty ? Str.colleaguesEmptyBody(language) : ""
                    )
                    .id(Self.restAnchor)
                    .listRowInsets(EdgeInsets())
                    .listRowSeparator(.hidden)
                    .measuredListRow()
                } else {
                    ForEach(Array(model.visible.enumerated()), id: \.element.id) { index, colleague in
                        NavigationLink(value: colleague) {
                            ColleagueRow(colleague: colleague, language: language, locale: locale)
                        }
                        .id(index == 0 ? Self.restAnchor : colleague.id)
                        .measuredListRow()
                    }
                }
            }
        }
        .navigationDestination(for: Colleague.self) { colleague in
            TeamThreadView(colleague: colleague)
                .onAppear { model.markRead(colleague.userId) }
        }
    }

    private static let restAnchor = "colleagues.top"
}

struct ColleagueRow: View {
    let colleague: Colleague
    let language: Language
    let locale: Locale

    private var unread: Int { colleague.unread ?? 0 }

    var body: some View {
        HStack(spacing: Theme.Space.md) {
            Avatar(
                name: colleague.displayName,
                imageURL: colleague.avatarURL,
                size: Theme.Size.avatarSmall
            )

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: Theme.Space.xs) {
                    Text(colleague.displayName)
                        .font(Theme.Typo.rowTitle)
                        .foregroundStyle(Theme.Palette.label)
                        .lineLimit(1)

                    Spacer(minLength: Theme.Space.xs)

                    if let at = colleague.lastMessage?.createdAt {
                        Text(Format.listTimestamp(at, locale: locale))
                            .font(Theme.Typo.meta)
                            .foregroundStyle(Theme.Palette.labelTertiary)
                    }
                }

                HStack(spacing: Theme.Space.xs) {
                    Text(preview)
                        .font(Theme.Typo.rowSubtitle)
                        .foregroundStyle(Theme.Palette.labelSecondary)
                        .lineLimit(1)

                    Spacer(minLength: Theme.Space.xs)

                    if unread > 0 {
                        Text(Format.number(unread, language: language))
                            .font(Theme.Typo.metaEmphasis)
                            .foregroundStyle(.white)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 1)
                            .background(Capsule().fill(Theme.Palette.brand))
                    }
                }
            }
        }
        .padding(.vertical, Theme.Space.xxs)
    }

    /// An attachment-only message has no body, so it is named by what it is —
    /// the same rule the conversation rows follow.
    private var preview: String {
        guard let last = colleague.lastMessage else { return "" }
        if let body = last.body, !body.trimmingCharacters(in: .whitespaces).isEmpty { return body }
        switch last.attachmentKind {
        case "image": return Str.photo(language)
        case "audio": return Str.voiceNote(language)
        case "video": return Str.videoFile(language)
        case "file": return Str.file(language)
        default: return ""
        }
    }
}
