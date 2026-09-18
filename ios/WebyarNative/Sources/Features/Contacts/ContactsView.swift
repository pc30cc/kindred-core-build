import SwiftUI
import Observation

@MainActor
@Observable
final class ContactsViewModel {
    private(set) var state: LoadState<[Contact]> = .loading
    var searchText = ""

    private let api: any WebyarAPI

    init(api: any WebyarAPI = Backend.current) {
        self.api = api
    }

    var visible: [Contact] {
        guard let all = state.value else { return [] }
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !query.isEmpty else { return all }
        return all.filter { contact in
            [contact.name, contact.email, contact.phone, contact.visitorCode]
                .contains { $0?.lowercased().contains(query) == true }
        }
    }

    func load(workspaceID: String?, appState: AppState) async {
        guard let workspaceID else {
            state = .loaded([])
            return
        }
        do {
            state = .loaded(try await api.contacts(workspaceID: workspaceID))
        } catch APIError.unauthorized {
            await appState.handleUnauthorized()
        } catch let error as APIError {
            state = .failed(error)
        } catch {
            state = .failed(.transport)
        }
    }

    func refresh(workspaceID: String?, appState: AppState) async {
        guard let workspaceID else { return }
        do {
            state = .loaded(try await api.contacts(workspaceID: workspaceID))
        } catch APIError.unauthorized {
            await appState.handleUnauthorized()
        } catch {
            // Keep the list we have.
        }
    }
}

struct ContactsView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.locale) private var locale
    @State private var model = ContactsViewModel()

    private var language: Language { appState.language }
    private var workspaceID: String? { appState.selectedWorkspace?.id }

    var body: some View {
        @Bindable var model = model

        content
            .navigationTitle(Str.tabContacts(language))
            .navigationBarTitleDisplayMode(.inline)
            .searchable(
                text: $model.searchText,
                placement: .navigationBarDrawer(displayMode: .always),
                prompt: Str.search(language)
            )
            .floatingTabBarInset()
            .refreshable {
                await model.refresh(workspaceID: workspaceID, appState: appState)
            }
            .task(id: workspaceID) {
                await model.load(workspaceID: workspaceID, appState: appState)
            }
    }

    @ViewBuilder
    private var content: some View {
        switch model.state {
        case .loading:
            List(0..<10, id: \.self) { _ in
                ContactRowSkeleton()
            }
            .listStyle(.plain)
            .disabled(true)

        case .failed:
            ScrollView {
                ErrorStateView(
                    title: Str.offlineTitle(language),
                    message: Str.offlineBody(language),
                    retryTitle: Str.retry(language),
                    onRetry: { Task { await model.load(workspaceID: workspaceID, appState: appState) } }
                )
            }

        case .loaded:
            if model.visible.isEmpty {
                ScrollView {
                    EmptyStateView(
                        systemImage: model.searchText.isEmpty ? "person.2" : "magnifyingglass",
                        title: model.searchText.isEmpty
                            ? Str.contactsEmptyTitle(language)
                            : Str.noResults(language),
                        message: model.searchText.isEmpty ? Str.contactsEmptyBody(language) : ""
                    )
                }
                .scrollBounceBehavior(.basedOnSize)
            } else {
                List(model.visible) { contact in
                    NavigationLink(value: contact) {
                        ContactRow(contact: contact, language: language)
                    }
                }
                .listStyle(.plain)
                .navigationDestination(for: Contact.self) { contact in
                    ContactDetailView(contact: contact)
                }
            }
        }
    }
}

/// A contact in the list: avatar, name, and the best secondary identifier we
/// have. The secondary line is omitted entirely rather than shown blank, so a
/// row never carries an empty second line.
struct ContactRow: View {
    let contact: Contact
    let language: Language

    private var displayName: String {
        Format.contactName(
            name: contact.name,
            email: contact.email,
            visitorCode: contact.visitorCode,
            language: language
        )
    }

    private var secondary: String? {
        if let email = contact.email, !email.isEmpty { return email }
        if let phone = contact.phone, !phone.isEmpty { return phone }
        return nil
    }

    var body: some View {
        HStack(spacing: Theme.Space.md) {
            Avatar(name: displayName, imageURL: contact.avatarURL, size: Theme.Size.avatarSmall + 6)

            VStack(alignment: .leading, spacing: Theme.Space.xxs) {
                Text(displayName)
                    .font(Theme.Typo.rowTitle)
                    .foregroundStyle(Theme.Palette.label)
                    .lineLimit(1)

                if let secondary {
                    Text(secondary)
                        .font(Theme.Typo.rowSubtitle)
                        .foregroundStyle(Theme.Palette.labelSecondary)
                        .lineLimit(1)
                        // An address or a phone number is an LTR string in
                        // every language.
                        .environment(\.layoutDirection, .leftToRight)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .padding(.vertical, Theme.Space.xs)
    }
}

struct ContactRowSkeleton: View {
    var body: some View {
        HStack(spacing: Theme.Space.md) {
            Circle()
                .fill(Theme.Palette.surfaceElevated)
                .frame(width: Theme.Size.avatarSmall + 6, height: Theme.Size.avatarSmall + 6)

            VStack(alignment: .leading, spacing: Theme.Space.sm) {
                RoundedRectangle(cornerRadius: Theme.Radius.sm)
                    .fill(Theme.Palette.surfaceElevated)
                    .frame(width: 130, height: 13)
                RoundedRectangle(cornerRadius: Theme.Radius.sm)
                    .fill(Theme.Palette.surfaceElevated)
                    .frame(width: 180, height: 11)
            }
        }
        .padding(.vertical, Theme.Space.xs)
        .redacted(reason: .placeholder)
        .accessibilityHidden(true)
    }
}
